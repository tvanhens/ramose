/**
 * The useTransact contract:
 *
 * - a successful `run` resolves the value, and `pending` flips
 *   true → false around it;
 * - a failing `run` calls `onError` with the tagged error and lands the
 *   same value on `error`;
 * - `error` clears on the next successful run, and on `clearError`;
 * - concurrent runs settle independently: the last settler wins `error`;
 * - an unmounted component touches no state when a late run settles, but
 *   `onError` still fires (the toast host outlives the form);
 * - `errorMessage` is `e.message ?? e._tag ?? String(e)`.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { Unauthorized } from "../../src/db/index.ts";
import { act, renderHook } from "@testing-library/react";
import { errorMessage, useTransact } from "../../src/react/index.ts";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

/** A promise the test settles by hand, so `pending` can be observed mid-run. */
const gate = <A,>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("useTransact", () => {
  test("success resolves the value and pending flips true → false", async () => {
    const { result } = renderHook(() => useTransact());
    expect(result.current.pending).toBe(false);

    const g = gate<number>();
    let outcome!: Promise<number | undefined>;
    act(() => {
      outcome = result.current.run(g.promise);
    });
    expect(result.current.pending).toBe(true);

    g.resolve(42);
    const value = await act(() => outcome);
    expect(value).toBe(42);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test("pending counts concurrent runs", async () => {
    const { result } = renderHook(() => useTransact());

    const a = gate<void>();
    const b = gate<void>();
    let ranA!: Promise<void>;
    let ranB!: Promise<void>;
    act(() => {
      ranA = result.current.run(a.promise);
      ranB = result.current.run(b.promise);
    });
    expect(result.current.pending).toBe(true);

    a.resolve();
    await act(() => ranA);
    expect(result.current.pending).toBe(true);

    b.resolve();
    await act(() => ranB);
    expect(result.current.pending).toBe(false);
  });

  test("failure calls onError with the Unauthorized instance and sets error", async () => {
    const denied = new Unauthorized({
      message: "retract denied on :issue/status",
      code: "policy",
      attr: ":issue/status",
    });
    const seen: unknown[] = [];
    const { result } = renderHook(() =>
      useTransact({ onError: (e) => seen.push(e) }),
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(Promise.reject(denied));
    });

    expect(outcome).toBeUndefined();
    expect(seen).toEqual([denied]);
    expect(result.current.error).toBe(denied);
    expect(result.current.pending).toBe(false);
  });

  test("void run(rejected) does not become unhandledrejection", async () => {
    const denied = new Unauthorized({ message: "no" });
    const rejections: unknown[] = [];
    const onWindow = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    const onProcess = (reason: unknown) => {
      rejections.push(reason);
    };
    window.addEventListener("unhandledrejection", onWindow);
    process.on("unhandledRejection", onProcess);
    const { result } = renderHook(() => useTransact());
    try {
      await act(async () => {
        void result.current.run(Promise.reject(denied));
      });
      await Bun.sleep(20);
      expect(result.current.error).toBe(denied);
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
  });

  test("run(() => Promise) thunk form resolves and records error", async () => {
    const denied = new Unauthorized({ message: "thunk" });
    const { result } = renderHook(() => useTransact());

    let value: unknown;
    await act(async () => {
      value = await result.current.run(() => Promise.resolve(7));
    });
    expect(value).toBe(7);
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      value = await result.current.run(() => Promise.reject(denied));
    });
    expect(value).toBeUndefined();
    expect(result.current.error).toBe(denied);
  });

  test("error clears on the next successful run, and on clearError", async () => {
    const denied = new Unauthorized({ message: "no" });
    const { result } = renderHook(() => useTransact());

    await act(async () => {
      await result.current.run(Promise.reject(denied));
    });
    expect(result.current.error).toBe(denied);

    await act(async () => {
      await result.current.run(Promise.resolve("ok"));
    });
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      await result.current.run(Promise.reject(denied));
    });
    expect(result.current.error).toBe(denied);
    act(() => result.current.clearError());
    expect(result.current.error).toBeUndefined();
  });

  test("the last settler wins error: a late failure re-sets it after a success cleared it", async () => {
    const denied = new Unauthorized({ message: "late denial" });
    const { result } = renderHook(() => useTransact());

    const g = gate<void>();
    let ranA!: Promise<void>;
    act(() => {
      ranA = result.current.run(
        g.promise.then(() => Promise.reject(denied)),
      );
    });

    await act(async () => {
      await result.current.run(Promise.resolve("ok"));
    });
    expect(result.current.error).toBeUndefined();

    g.resolve();
    await act(async () => {
      await ranA;
    });
    expect(result.current.error).toBe(denied);
    expect(result.current.pending).toBe(false);
  });

  test("a run settling after unmount touches no state", async () => {
    const { result, unmount } = renderHook(() => useTransact());

    const g = gate<string>();
    let outcome!: Promise<string | undefined>;
    act(() => {
      outcome = result.current.run(g.promise);
    });
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve("late");
      expect(await outcome).toBe("late");
    } finally {
      console.error = noisy;
    }
    expect(complaints).toEqual([]);
  });

  test("a failure settling after unmount still fires onError, without touching state", async () => {
    const denied = new Unauthorized({ message: "denied after navigate-away" });
    const seen: unknown[] = [];
    const { result, unmount } = renderHook(() =>
      useTransact({ onError: (e) => seen.push(e) }),
    );

    const g = gate<void>();
    let outcome!: Promise<void>;
    act(() => {
      outcome = result.current.run(g.promise.then(() => Promise.reject(denied)));
    });
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve();
      await outcome;
    } finally {
      console.error = noisy;
    }
    expect(seen).toEqual([denied]);
    expect(complaints).toEqual([]);
  });
});

describe("errorMessage", () => {
  test("a DbError's message wins", () => {
    const denied = new Unauthorized({
      message: "retract denied on :issue/status",
    });
    expect(errorMessage(denied)).toBe("retract denied on :issue/status");
  });

  test("a _tag-only error falls back to the tag", () => {
    expect(errorMessage({ _tag: "TxRejected" })).toBe("TxRejected");
  });

  test("anything else goes through String", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(7)).toBe("7");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });
});
