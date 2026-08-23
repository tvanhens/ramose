/**
 * The `useLive` contract. Session current-view reads run on the overlay;
 * pinned `asOf` still rides the peer. The subscription form needs no db.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import * as Ramose from "../../src/db/index.ts";
import * as Schema from "effect/Schema";
import { type ReactNode, StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { type Answer, fakePeer } from "./peer.ts";
import { catalogWorld, snapshotOf, txSnap } from "../overlay-seed.ts";
import { useLive } from "../../src/react/index.ts";

// imports are hoisted, so this runs after them but before any test renders —
// which is enough: nothing above touches `document` at import time. The
// unregister keeps happy-dom's globals out of the rest of the bun test run.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

const Todo = Ramose.Entity("todo", {
  title: Ramose.Field(Schema.String),
});
const Todos = Ramose.Schema({ todo: Todo });

/** `.ids()` is today's cheap live-subscription shape — `{ id }` rows. */
const allTodos = Ramose.Query.from(Todo).ids();
const oneTodo = Ramose.Query.from(Todo).ids().limit(1);

/** Every pass is a handful of microtasks; a beat is plenty. */
const settle = (ms = 25) => Bun.sleep(ms);

/** Entity ids as the shape the rows carry — `Eid` is `{ id }`, as data. */
const ids = (...ns: number[]): readonly Ramose.Eid[] =>
  ns.map((id) => ({ id }));

const todoWorld = async (n: number) => {
  const conn = await catalogWorld(Todos);
  const eids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await conn.transact([
      { ":db/id": `t${i}`, ":todo/title": `t${i}` },
    ]);
    eids.push(r.tempids[`t${i}`]!);
  }
  return { conn, eids, ...(await snapshotOf(conn)) };
};

/** Pinned-view / peer-answer client (asOf still POSTs `q`). */
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

/** Session overlay client: first sync dumps `world.datoms`. */
const overlaySetup = (world: { t: number; datoms: unknown[] }) => {
  let respond: Answer = (frame) =>
    frame.op === "sync"
      ? { body: { t: world.t, datoms: world.datoms } }
      : { body: { t: world.t, result: [] } };
  const peer = fakePeer({
    answer: (frame) => respond(frame),
    http: () => ({ body: { t: world.t, txEid: 1, tempids: {}, datoms: 1 } }),
  });
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
  };
};

describe("useLive (query form)", () => {
  test("the first emission populates rows; ticks stays 0", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      expect(result.current).toEqual({
        rows: undefined,
        error: undefined,
        ticks: 0,
      });
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a tx frame re-runs, updates rows, and increments ticks", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.rows).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
      expect(result.current.ticks).toBe(1);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("changing the query resets state and re-subscribes", async () => {
    const world = await todoWorld(2);
    const { db, peer, close } = overlaySetup(world);
    try {
      const { result, rerender } = renderHook(
        ({ query }: { query: Ramose.QueryObject<{ readonly id: number }> }) =>
          useLive(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      const extra = txSnap(
        await world.conn.transact([{ ":db/id": "t2", ":todo/title": "t2" }]),
      );
      peer.push({ op: "tx", t: extra.t, datoms: extra.datoms });
      await waitFor(() => expect(result.current.ticks).toBe(1));

      rerender({ query: oneTodo });
      await waitFor(() => expect(result.current.rows).toEqual(ids(world.eids[0]!)));
      expect(result.current.ticks).toBe(0);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("teardown's interrupt never lands on error — not after a query change, not after unmount", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    try {
      const { result, rerender, unmount } = renderHook(
        ({ query }: { query: Ramose.QueryObject<{ readonly id: number }> }) =>
          useLive(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      rerender({ query: oneTodo });
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));
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

      // the pinned stream has completed; a later tx is nobody's news
      await settle();
      peer.push({ op: "tx", t: 9, datoms: [] });
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
    const world = await todoWorld(1);
    const { db, peer, answer, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      answer((frame) =>
        frame.op === "sync"
          ? { status: 401, body: { error: "token expired" } }
          : { body: { t: world.t, result: [] } },
      );
      peer.drop();
      await waitFor(() => expect(result.current.error).toBeDefined());

      expect((result.current.error as { _tag: string })._tag).toBe(
        "Unauthorized",
      );
      expect(result.current.rows).toEqual(ids(...world.eids));
    } finally {
      await close();
    }
  });

  test("unmount interrupts — the peer sees no re-run on the next tick", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const { result, unmount } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      unmount();
      await settle();
      const before = peer.frames.length;
      peer.push({ op: "tx", t: world.t + 1, datoms: [] });
      await settle();
      expect(peer.frames.length).toBe(before);
    } finally {
      await close();
    }
  });

  test("explicit unmount/remount of the query form still receives updates", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const first = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(first.result.current.rows).toEqual(ids(...world.eids)));
      first.unmount();

      const { result } = renderHook(() => useLive(db, allTodos));
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.rows).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
    } finally {
      await close();
    }
  });

  test("StrictMode double-mount subscribes exactly once at steady state", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const wrapper = ({ children }: { children?: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      );
      const { result } = renderHook(() => useLive(db, allTodos), { wrapper });
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));
      await settle();

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.rows).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
      expect(result.current.ticks).toBe(1);
      await settle();
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a params-only change re-runs without a new query object and does not blank rows", async () => {
    const p = Ramose.params({ n: Schema.Number });
    const limited = Ramose.Query.from(Todo).ids().limit(p.n);
    const object = limited;

    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    try {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useLive(db, limited, { n }),
        { initialProps: { n: 1 } },
      );
      await waitFor(() => expect(result.current.rows).toEqual(ids(world.eids[0]!)));

      rerender({ n: 2 });
      await waitFor(() => expect(result.current.rows).toEqual(ids(...world.eids)));
      expect(result.current.error).toBeUndefined();
      expect(limited).toBe(object);
    } finally {
      await close();
    }
  });
});

const immediate = <A,>(values: readonly A[]): Ramose.Subscription<A> => ({
  subscribe(onValue) {
    for (const value of values) onValue(value);
    return () => {};
  },
  async *[Symbol.asyncIterator]() {
    yield* values;
  },
  close() {},
});

describe("useLive (subscription form)", () => {
  test("drains any subscription — no db, no provider", async () => {
    const sub = immediate(["a", "b", "c"]);
    const { result } = renderHook(() => useLive(sub));
    await waitFor(() => expect(result.current.rows).toBe("c"));
    expect(result.current.ticks).toBe(2);
    expect(result.current.error).toBeUndefined();
  });

  test("re-subscribes when the subscription identity changes", async () => {
    const first = immediate([1]);
    const second = immediate([2]);
    const { result, rerender } = renderHook(
      ({ sub }: { sub: Ramose.Subscription<number> }) => useLive(sub),
      { initialProps: { sub: first } },
    );
    await waitFor(() => expect(result.current.rows).toBe(1));

    rerender({ sub: second });
    await waitFor(() => expect(result.current.rows).toBe(2));
    expect(result.current.ticks).toBe(0);
  });

  test("switching subscription identity blanks rows before the next emission", async () => {
    const first = immediate(["A"]);
    const later: ((value: string) => void)[] = [];
    const second: Ramose.Subscription<string> = {
      subscribe(onValue) {
        later.push(onValue);
        return () => {};
      },
      async *[Symbol.asyncIterator]() {},
      close() {},
    };
    const { result, rerender } = renderHook(
      ({ sub }: { sub: Ramose.Subscription<string> }) => useLive(sub),
      { initialProps: { sub: first } },
    );
    await waitFor(() => expect(result.current.rows).toBe("A"));

    rerender({ sub: second });
    expect(result.current.rows).toBeUndefined();
    expect(result.current.ticks).toBe(0);

    later[0]?.("B");
    await waitFor(() => expect(result.current.rows).toBe("B"));
  });

  test("unmount/remount of an external handle never close()s it", async () => {
    let closed = 0;
    const sub: Ramose.Subscription<string> = {
      subscribe(onValue) {
        onValue("a");
        return () => {};
      },
      async *[Symbol.asyncIterator]() {
        yield "a";
      },
      close() {
        closed += 1;
      },
    };
    const first = renderHook(() => useLive(sub));
    await waitFor(() => expect(first.result.current.rows).toBe("a"));
    first.unmount();
    expect(closed).toBe(0);

    const second = renderHook(() => useLive(sub));
    await waitFor(() => expect(second.result.current.rows).toBe("a"));
    second.unmount();
    expect(closed).toBe(0);
  });
});
