/**
 * The useTransact contract:
 *
 * - a successful `run` resolves `Exit.succeed`, and `pending` flips
 *   true → false around it;
 * - a failing `run` calls `onError` with the failure's error (the
 *   `Unauthorized` instance itself, not a cause wrapper) and lands the same
 *   value on `error`;
 * - a defect lands the squashed defect itself, not a Cause wrapper;
 * - `error` clears on the next successful run, and on `clearError`;
 * - concurrent runs settle independently: the last settler wins `error`;
 * - an unmounted component touches no state when a late run settles, but
 *   `onError` still fires (the toast host outlives the form);
 * - `errorMessage` is `e.message ?? e._tag ?? String(e)`.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { Unauthorized } from "../../src/db/index.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { act, renderHook } from "@testing-library/react";
import { errorMessage, useTransact } from "../../src/react/index.ts";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

/** A promise the test settles by hand, so `pending` can be observed mid-run. */
const gate = <A,>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("useTransact", () => {
  test("success resolves Exit.succeed and pending flips true → false", async () => {
    const { result } = renderHook(() => useTransact());
    expect(result.current.pending).toBe(false);

    const g = gate<number>();
    let outcome!: Promise<Exit.Exit<number, never>>;
    act(() => {
      outcome = result.current.run(Effect.promise(() => g.promise));
    });
    expect(result.current.pending).toBe(true);

    g.resolve(42);
    const exit = await act(() => outcome);
    expect(exit).toEqual(Exit.succeed(42));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test("pending counts concurrent runs", async () => {
    const { result } = renderHook(() => useTransact());

    const a = gate<void>();
    const b = gate<void>();
    let ranA!: Promise<Exit.Exit<void, never>>;
    let ranB!: Promise<Exit.Exit<void, never>>;
    act(() => {
      ranA = result.current.run(Effect.promise(() => a.promise));
      ranB = result.current.run(Effect.promise(() => b.promise));
    });
    expect(result.current.pending).toBe(true);

    a.resolve();
    await act(() => ranA);
    expect(result.current.pending).toBe(true); // b still in flight

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

    let exit!: Exit.Exit<never, Unauthorized>;
    await act(async () => {
      exit = await result.current.run(Effect.fail(denied));
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen).toEqual([denied]);
    expect(seen[0]).toBe(denied); // the instance itself, not a cause wrapper
    expect(result.current.error).toBe(denied);
    expect(result.current.pending).toBe(false);
  });

  test("a defect lands the squashed defect on error and onError", async () => {
    const seen: unknown[] = [];
    const { result } = renderHook(() =>
      useTransact({ onError: (e) => seen.push(e) }),
    );

    let exit!: Exit.Exit<never, never>;
    await act(async () => {
      exit = await result.current.run(Effect.die("boom"));
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen).toEqual(["boom"]); // the defect itself, not a Cause wrapper
    expect(result.current.error).toBe("boom");
  });

  test("error clears on the next successful run, and on clearError", async () => {
    const denied = new Unauthorized({ message: "no" });
    const { result } = renderHook(() => useTransact());

    await act(async () => {
      await result.current.run(Effect.fail(denied));
    });
    expect(result.current.error).toBe(denied);

    await act(async () => {
      await result.current.run(Effect.succeed("ok"));
    });
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      await result.current.run(Effect.fail(denied));
    });
    expect(result.current.error).toBe(denied);
    act(() => result.current.clearError());
    expect(result.current.error).toBeUndefined();
  });

  test("the last settler wins error: a late failure re-sets it after a success cleared it", async () => {
    const denied = new Unauthorized({ message: "late denial" });
    const { result } = renderHook(() => useTransact());

    // run A starts first and will fail — but only when the gate opens
    const g = gate<void>();
    let ranA!: Promise<Exit.Exit<void, Unauthorized>>;
    act(() => {
      ranA = result.current.run(
        Effect.promise(() => g.promise).pipe(
          Effect.andThen(Effect.fail(denied)),
        ),
      );
    });

    // run B starts later, settles first, and clears error
    await act(async () => {
      await result.current.run(Effect.succeed("ok"));
    });
    expect(result.current.error).toBeUndefined();

    // A settles last: its failure wins, start order notwithstanding
    g.resolve();
    await act(() => ranA);
    expect(result.current.error).toBe(denied);
    expect(result.current.pending).toBe(false);
  });

  test("a run settling after unmount touches no state", async () => {
    const { result, unmount } = renderHook(() => useTransact());

    const g = gate<string>();
    let outcome!: Promise<Exit.Exit<string, never>>;
    act(() => {
      outcome = result.current.run(Effect.promise(() => g.promise));
    });
    unmount();

    // any setState against the unmounted hook would surface here — as a
    // React warning through console.error, or as a thrown act() violation
    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve("late");
      const exit = await outcome;
      expect(exit).toEqual(Exit.succeed("late")); // the caller still gets the outcome
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
    let outcome!: Promise<Exit.Exit<void, Unauthorized>>;
    act(() => {
      outcome = result.current.run(
        Effect.promise(() => g.promise).pipe(
          Effect.andThen(Effect.fail(denied)),
        ),
      );
    });
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve();
      const exit = await outcome;
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      console.error = noisy;
    }
    expect(seen).toEqual([denied]); // the toast still happens
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
