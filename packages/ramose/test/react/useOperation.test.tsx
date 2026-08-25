/**
 * The useOperation contract:
 *
 * - a successful `run` resolves `{ ok: true, value }`, and `pending` flips
 *   true → false around it;
 * - a failing `run` resolves `{ ok: false, error }`, calls `onError` with
 *   the tagged error, and lands the same value on `error`;
 * - `error` clears on the next successful run, and on `clearError`;
 * - pending / error are per invocation key — two entities spinner
 *   independently;
 * - concurrent runs settle independently: the last settler wins `error`;
 * - an unmounted component touches no state when a late run settles, but
 *   `onError` still fires (the toast host outlives the form);
 * - `errorMessage` is `e.message ?? e._tag ?? String(e)`.
 */

import { describe, expect, test } from "bun:test";
import { Unauthorized } from "../../src/db/index.ts";
import type { Db, Operation, OpReport } from "../../src/db/index.ts";
import { act, renderHook } from "@testing-library/react";
import {
  errorMessage,
  useOperation,
  type RunResult,
} from "../../src/react/index.ts";
import { registerDom, Todo } from "./harness.tsx";

registerDom();

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

const report = (output: unknown = {}): OpReport<unknown> =>
  ({
    t: 1,
    txEid: 1,
    datomCount: 0,
    output,
    dbAfter: {},
  }) as OpReport<unknown>;

const fakeDb = (
  run: (operation: unknown, a: unknown, b?: unknown) => Promise<OpReport<unknown>>,
): Db => ({ run } as unknown as Db);

const bareOp = {
  _tag: "Operation",
  name: "todo/add",
  on: undefined,
} as unknown as Operation<string, { title: string }, { id: number }, undefined>;

const onOp = {
  _tag: "Operation",
  name: "todo/set-done",
  on: Todo,
} as unknown as Operation<
  string,
  { done: boolean },
  Record<string, never>,
  typeof Todo
>;

describe("useOperation", () => {
  test("success resolves { ok, value } and pending flips true → false", async () => {
    const g = gate<OpReport<unknown>>();
    const db = fakeDb(() => g.promise);
    const { result } = renderHook(() => useOperation(db, bareOp));
    expect(result.current.pending).toBe(false);

    let outcome!: Promise<RunResult<OpReport<unknown>>>;
    act(() => {
      outcome = result.current.run({ title: "x" });
    });
    expect(result.current.pending).toBe(true);

    const value = report({ id: 42 });
    g.resolve(value);
    const settled = await act(() => outcome);
    expect(settled).toEqual({ ok: true, value });
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test("pendingFor is per entity so two buttons spinner independently", async () => {
    const waits = new Map<number, ReturnType<typeof gate<OpReport<unknown>>>>();
    const db = fakeDb((_op, entity) => {
      const g = gate<OpReport<unknown>>();
      waits.set(entity as number, g);
      return g.promise;
    });
    const { result } = renderHook(() => useOperation(db, onOp));

    let ranA!: Promise<RunResult<OpReport<unknown>>>;
    let ranB!: Promise<RunResult<OpReport<unknown>>>;
    act(() => {
      ranA = result.current.run(1, { done: true });
      ranB = result.current.run(2, { done: false });
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.pendingFor(1)).toBe(true);
    expect(result.current.pendingFor(2)).toBe(true);
    expect(result.current.pendingFor(3)).toBe(false);

    waits.get(1)!.resolve(report());
    await act(() => ranA);
    expect(result.current.pendingFor(1)).toBe(false);
    expect(result.current.pendingFor(2)).toBe(true);
    expect(result.current.pending).toBe(true);

    waits.get(2)!.resolve(report());
    await act(() => ranB);
    expect(result.current.pending).toBe(false);
    expect(result.current.pendingFor(2)).toBe(false);
  });

  test("failure calls onError with the Unauthorized instance and sets error", async () => {
    const denied = new Unauthorized({
      message: "remove denied on :issue/status",
      code: "policy",
      attr: ":issue/status",
    });
    const seen: unknown[] = [];
    const db = fakeDb(() => Promise.reject(denied));
    const { result } = renderHook(() =>
      useOperation(db, onOp, { onError: (e) => seen.push(e) }),
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(7, { done: true });
    });

    expect(outcome).toEqual({ ok: false, error: denied });
    expect(seen).toEqual([denied]);
    expect(result.current.error).toBe(denied);
    expect(result.current.errorFor(7)).toBe(denied);
    expect(result.current.errorFor(8)).toBeUndefined();
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
    const db = fakeDb(() => Promise.reject(denied));
    const { result } = renderHook(() => useOperation(db, bareOp));
    try {
      await act(async () => {
        void result.current.run({ title: "x" });
      });
      await Bun.sleep(20);
      expect(result.current.error).toBe(denied);
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
  });

  test("error clears on the next successful run, and on clearError", async () => {
    const denied = new Unauthorized({ message: "no" });
    let fail = true;
    const db = fakeDb(() =>
      fail ? Promise.reject(denied) : Promise.resolve(report()),
    );
    const { result } = renderHook(() => useOperation(db, bareOp));

    await act(async () => {
      await result.current.run({ title: "x" });
    });
    expect(result.current.error).toBe(denied);

    fail = false;
    await act(async () => {
      await result.current.run({ title: "y" });
    });
    expect(result.current.error).toBeUndefined();

    fail = true;
    await act(async () => {
      await result.current.run({ title: "z" });
    });
    expect(result.current.error).toBe(denied);
    act(() => result.current.clearError());
    expect(result.current.error).toBeUndefined();
    expect(result.current.errorFor({ title: "z" })).toBeUndefined();
  });

  test("the last settler wins error: a late failure re-sets it after a success cleared it", async () => {
    const denied = new Unauthorized({ message: "late denial" });
    const g = gate<OpReport<unknown>>();
    let n = 0;
    const db = fakeDb(() => {
      n += 1;
      return n === 1
        ? g.promise.then(() => Promise.reject(denied))
        : Promise.resolve(report());
    });
    const { result } = renderHook(() => useOperation(db, onOp));

    let ranA!: Promise<RunResult<OpReport<Record<string, never>>>>;
    act(() => {
      ranA = result.current.run(1, { done: true });
    });

    await act(async () => {
      await result.current.run(2, { done: false });
    });
    expect(result.current.error).toBeUndefined();

    g.resolve(report());
    await act(async () => {
      await ranA;
    });
    expect(result.current.error).toBe(denied);
    expect(result.current.errorFor(1)).toBe(denied);
    expect(result.current.errorFor(2)).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  test("a run settling after unmount touches no state", async () => {
    const g = gate<OpReport<unknown>>();
    const db = fakeDb(() => g.promise);
    const { result, unmount } = renderHook(() => useOperation(db, bareOp));

    let outcome!: Promise<RunResult<OpReport<unknown>>>;
    act(() => {
      outcome = result.current.run({ title: "x" });
    });
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve(report());
      expect(await outcome).toEqual({ ok: true, value: report() });
    } finally {
      console.error = noisy;
    }
    expect(complaints).toEqual([]);
  });

  test("a failure settling after unmount still fires onError, without touching state", async () => {
    const denied = new Unauthorized({ message: "denied after navigate-away" });
    const seen: unknown[] = [];
    const g = gate<OpReport<unknown>>();
    const db = fakeDb(() => g.promise.then(() => Promise.reject(denied)));
    const { result, unmount } = renderHook(() =>
      useOperation(db, onOp, { onError: (e) => seen.push(e) }),
    );

    let outcome!: Promise<RunResult<OpReport<Record<string, never>>>>;
    act(() => {
      outcome = result.current.run(1, { done: true });
    });
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      g.resolve(report());
      await outcome;
    } finally {
      console.error = noisy;
    }
    expect(seen).toEqual([denied]);
    expect(complaints).toEqual([]);
  });

  test("contextual run passes entity then input to db.run", async () => {
    const calls: unknown[] = [];
    const db = fakeDb(async (operation, a, b) => {
      calls.push([operation, a, b]);
      return report();
    });
    const { result } = renderHook(() => useOperation(db, onOp));
    await act(async () => {
      await result.current.run(9, { done: true });
    });
    expect(calls).toEqual([[onOp, 9, { done: true }]]);
  });
});

describe("errorMessage", () => {
  test("a DbError's message wins", () => {
    const denied = new Unauthorized({
      message: "remove denied on :issue/status",
    });
    expect(errorMessage(denied)).toBe("remove denied on :issue/status");
  });

  test("a _tag-only error falls back to the tag", () => {
    expect(errorMessage({ _tag: "OperationRejected" })).toBe(
      "OperationRejected",
    );
  });

  test("anything else goes through String", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(7)).toBe("7");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });
});
