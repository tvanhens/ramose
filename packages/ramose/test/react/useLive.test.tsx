/**
 * The `useLive` contract, over the fake peer:
 *
 * - The first emission populates `rows`; `ticks` stays 0.
 * - A `t` tick re-runs the query, updates `rows`, and increments `ticks`.
 * - Changing the query resets to the blank state and re-subscribes.
 * - Teardown's interrupt is not an error: after a query change or an
 *   unmount, `error` stays `undefined`.
 * - Over `db.asOf(t)` the stream completes; the last `rows` stay and
 *   completion is not an error.
 * - The view is structural: an inline `db.asOf(t)` keeps one subscription
 *   per `t` — equal views never re-subscribe, a new `t` does.
 * - A terminal `Unauthorized` lands in `error`; the last `rows` stay.
 * - Unmount interrupts: the peer sees no re-run on the next tick.
 * - StrictMode's mount → unmount → mount subscribes exactly once at steady
 *   state.
 * - The stream form needs no db (and no provider) at all.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import * as Ramose from "../../src/db/index.ts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type ReactNode, StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { type Answer, fakePeer } from "./peer.ts";
import { useLive } from "../../src/react/index.ts";

// imports are hoisted, so this runs after them but before any test renders —
// which is enough: nothing above touches `document` at import time. The
// unregister keeps happy-dom's globals out of the rest of the bun test run.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
});
const Todos = Ramose.Catalog({ todo: Todo });

/** No `.select`, so rows are entity ids — the peer's `[[eid], …]` unwrapped. */
const allTodos = Ramose.query(Todo);
const oneTodo = Ramose.query(Todo).limit(1);

/** Every pass is a handful of microtasks; a beat is plenty. */
const settle = (ms = 25) => Bun.sleep(ms);

/** Entity ids as the shape the rows carry — `Eid` is `{ id }`, as data. */
const ids = (...ns: number[]): readonly Ramose.Eid[] =>
  ns.map((id) => ({ id }));

/** One client over one fake peer, with a swappable frame answer. */
const setup = () => {
  let respond: Answer = () => ({ body: { t: 1, result: [[1]] } });
  const peer = fakePeer({ answer: (frame) => respond(frame) });
  const client = Ramose.connect({
    url: "https://peer.example.com",
    fetch: peer.fetch,
    webSocket: peer.webSocket,
  });
  return {
    peer,
    db: client.db("todos", Todos),
    close: () => client.close(),
    answer: (next: Answer) => {
      respond = next;
    },
    qFrames: () => peer.frames.filter((f) => f.op === "q"),
  };
};

describe("useLive (query form)", () => {
  test("the first emission populates rows; ticks stays 0", async () => {
    const { db, close } = setup();
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      expect(result.current).toEqual({
        rows: undefined,
        error: undefined,
        ticks: 0,
      });
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a t tick re-runs, updates rows, and increments ticks", async () => {
    const { db, peer, answer, close } = setup();
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));

      answer(() => ({ body: { t: 2, result: [[1], [2]] } }));
      peer.push({ op: "t", t: 2 });
      await waitFor(() => expect(result.current.rows).toEqual(ids(1, 2)));
      expect(result.current.ticks).toBe(1);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("changing the query resets state and re-subscribes", async () => {
    const { db, peer, answer, qFrames, close } = setup();
    try {
      const { result, rerender } = renderHook(
        ({ query }: { query: Ramose.QueryInput<readonly Ramose.Eid[]> }) =>
          useLive(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));

      // move the basis so `ticks` is non-zero — the reset must clear it
      answer(() => ({ body: { t: 2, result: [[1], [2]] } }));
      peer.push({ op: "t", t: 2 });
      await waitFor(() => expect(result.current.ticks).toBe(1));

      // hold the next answer, so the reset is observable before rows return
      answer(() => undefined);
      rerender({ query: oneTodo });
      await waitFor(() =>
        expect(result.current).toEqual({
          rows: undefined,
          error: undefined,
          ticks: 0,
        }),
      );

      // the re-subscription sent the *new* query
      const held = qFrames().at(-1)!;
      expect((held.query as { limit?: number }).limit).toBe(1);

      // answer the held frame: the fresh subscription's first emission
      peer.push({ id: held.id, body: { t: 2, result: [[7]] } });
      await waitFor(() => expect(result.current.rows).toEqual(ids(7)));
      expect(result.current.ticks).toBe(0);
    } finally {
      await close();
    }
  });

  test("teardown's interrupt never lands on error — not after a query change, not after unmount", async () => {
    const { db, close } = setup();
    try {
      const { result, rerender, unmount } = renderHook(
        ({ query }: { query: Ramose.QueryInput<readonly Ramose.Eid[]> }) =>
          useLive(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));

      // the old subscription's interrupt lands *after* the new one reset —
      // it must not stamp an Interrupt cause onto the fresh state
      rerender({ query: oneTodo });
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));
      await settle();
      expect(result.current.error).toBeUndefined();

      unmount();
      await settle();
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("over db.asOf(t) the stream completes and the last rows stay", async () => {
    const { db, peer, answer, qFrames, close } = setup();
    try {
      answer(() => ({ body: { t: 5, result: [[3]] } }));
      const view = db.asOf(5);
      const { result } = renderHook(() => useLive(view, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(3)));
      expect((qFrames()[0]!.asOf as number)).toBe(5);

      // the pinned stream has completed; a later tick is nobody's news
      await settle();
      peer.push({ op: "t", t: 9 });
      await settle();
      expect(qFrames().length).toBe(1);
      expect(result.current.rows).toEqual(ids(3));
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("one subscription per view: equal inline asOf views never re-subscribe, a new t does", async () => {
    const { db, answer, qFrames, close } = setup();
    try {
      answer((frame) => ({
        body: { t: frame.asOf as number, result: [[frame.asOf as number]] },
      }));
      const { result, rerender } = renderHook(
        // built inline on purpose: a new view object every render, same t
        ({ t }: { t: number }) => useLive(db.asOf(t), allTodos),
        { initialProps: { t: 5 } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(5)));

      rerender({ t: 5 });
      rerender({ t: 5 });
      await settle();
      // still the one subscription: one live pass, one q frame
      expect(qFrames()).toHaveLength(1);
      expect(result.current.rows).toEqual(ids(5));
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();

      // a different coordinate is a different view: tear down, re-subscribe
      rerender({ t: 6 });
      await waitFor(() => expect(result.current.rows).toEqual(ids(6)));
      expect(qFrames()).toHaveLength(2);
      expect(qFrames().at(-1)!.asOf as number).toBe(6);
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a terminal Unauthorized sets error and keeps the last rows", async () => {
    const { db, peer, answer, close } = setup();
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));

      answer(() => ({ status: 401, body: { error: "token expired" } }));
      peer.push({ op: "t", t: 2 });
      await waitFor(() => expect(result.current.error).toBeDefined());

      const failure = Cause.findErrorOption(result.current.error!);
      expect(Option.isSome(failure)).toBe(true);
      expect((Option.getOrThrow(failure) as { _tag: string })._tag).toBe(
        "Unauthorized",
      );
      expect(result.current.rows).toEqual(ids(1));
    } finally {
      await close();
    }
  });

  test("unmount interrupts — the peer sees no re-run on the next tick", async () => {
    const { db, peer, qFrames, close } = setup();
    try {
      const { result, unmount } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));

      unmount();
      await settle();
      const before = qFrames().length;
      peer.push({ op: "t", t: 2 });
      await settle();
      expect(qFrames().length).toBe(before);
    } finally {
      await close();
    }
  });

  test("StrictMode double-mount subscribes exactly once at steady state", async () => {
    const { db, peer, answer, qFrames, close } = setup();
    try {
      const wrapper = ({ children }: { children?: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      );
      const { result } = renderHook(() => useLive(db, allTodos), { wrapper });
      await waitFor(() => expect(result.current.rows).toEqual(ids(1)));
      await settle(); // let the first mount's interrupted fiber wind down

      // one tick → exactly one re-run: only the second mount is subscribed
      const before = qFrames().length;
      answer(() => ({ body: { t: 2, result: [[1], [2]] } }));
      peer.push({ op: "t", t: 2 });
      await waitFor(() => expect(result.current.rows).toEqual(ids(1, 2)));
      expect(result.current.ticks).toBe(1);
      await settle();
      expect(qFrames().length).toBe(before + 1);
      // the first mount's interrupt landed mid-churn and left no error
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe("useLive (stream form)", () => {
  test("drains any stream — no db, no provider", async () => {
    const stream = Stream.make("a", "b", "c");
    const { result } = renderHook(() => useLive(stream));
    await waitFor(() => expect(result.current.rows).toBe("c"));
    // three emissions: two after the first
    expect(result.current.ticks).toBe(2);
    expect(result.current.error).toBeUndefined();
  });

  test("an interrupt cause is teardown, not news — error stays undefined", async () => {
    // `catchCause` in Effect 4 recovers from interruption too; the hook must
    // not surface an Interrupt as a terminal failure
    const stream: Stream.Stream<number> = Stream.failCause(Cause.interrupt());
    const { result } = renderHook(() => useLive(stream));
    await settle();
    expect(result.current.error).toBeUndefined();
    expect(result.current.rows).toBeUndefined();
  });

  test("re-subscribes when the stream identity changes", async () => {
    const first: Stream.Stream<number> = Stream.make(1);
    const second: Stream.Stream<number> = Stream.make(2);
    const { result, rerender } = renderHook(
      ({ stream }: { stream: Stream.Stream<number> }) => useLive(stream),
      { initialProps: { stream: first } },
    );
    await waitFor(() => expect(result.current.rows).toBe(1));

    rerender({ stream: second });
    await waitFor(() => expect(result.current.rows).toBe(2));
    expect(result.current.ticks).toBe(0);
  });
});
