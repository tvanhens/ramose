/**
 * The `useLiveQuery` contract. Session current-view reads run on the overlay;
 * pinned `asOf` still rides the peer. The subscription form needs no db.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { pipe } from "effect/Function";
import * as Ramose from "../../src/db/index.ts";
import * as Schema from "effect/Schema";
import { memo, type ReactNode, StrictMode } from "react";
import { render, renderHook, waitFor } from "@testing-library/react";
import { type Answer, scriptedPeer } from "./peer.ts";
import { catalogWorld, snapshotOf, txSnap } from "../overlay-seed.ts";
import { useLiveQuery } from "../../src/react/index.ts";
import { seamOf } from "../../src/react/seam.ts";

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

/** `Read` without the stable `refetch` — what tests assert on. */
const snap = (r: {
  readonly data: unknown;
  readonly error: unknown;
  readonly status: string;
  readonly isLoading: boolean;
  readonly t: number | undefined;
}) => ({
  data: r.data,
  error: r.error,
  status: r.status,
  isLoading: r.isLoading,
  t: r.t,
});

/** `.ids()` rows — `{ id }` with a branded number cell. */
const ids = (...ns: number[]) =>
  ns.map((id) => ({ id: id as Ramose.Eid<typeof Todo> }));

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
  const peer = scriptedPeer({ answer: (frame) => respond(frame) });
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

/** Count shared raw standing reads (`seam.liveRaw`), not finalized `db.live`. */
const spyRawLive = (db: Ramose.ReadDb) => {
  let calls = 0;
  let closed = 0;
  const seam = seamOf(db);
  if (seam?.liveRaw === undefined) {
    throw new Error("spyRawLive: db has no liveRaw seam");
  }
  const orig = seam.liveRaw;
  (seam as { liveRaw: typeof orig }).liveRaw = ((query) => {
    calls += 1;
    const sub = orig(query);
    const innerClose = sub.close.bind(sub);
    sub.close = () => {
      closed += 1;
      innerClose();
    };
    return sub;
  }) as typeof orig;
  return {
    get calls() {
      return calls;
    },
    get closed() {
      return closed;
    },
  };
};

/** Session overlay client: first sync dumps `world.datoms`. */
const overlaySetup = (world: { t: number; datoms: unknown[] }) => {
  let respond: Answer = (frame) =>
    frame.op === "sync"
      ? { body: { t: world.t, datoms: world.datoms } }
      : { body: { t: world.t, result: [] } };
  const peer = scriptedPeer({
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

describe("useLiveQuery (query form)", () => {
  test("the first emission populates data at the world basis", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      expect(snap(result.current)).toEqual({
        data: undefined,
        error: undefined,
        status: "loading",
        isLoading: true,
        t: undefined,
      });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(result.current.t).toBe(world.t);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.status).toBe("success");
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a tx frame re-runs, updates data, and moves t", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.data).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
      expect(result.current.t).toBe(two.t);
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
          useLiveQuery(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

      const extra = txSnap(
        await world.conn.transact([{ ":db/id": "t2", ":ramose/type": ":todo", ":todo/title": "t2" }]),
      );
      peer.push({ op: "tx", t: extra.t, datoms: extra.datoms });
      await waitFor(() => expect(result.current.t).toBe(extra.t));

      rerender({ query: oneTodo });
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      expect(result.current.t).toBeDefined();
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
          useLiveQuery(db, query),
        { initialProps: { query: allTodos } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

      rerender({ query: oneTodo });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
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
      const { result } = renderHook(() => useLiveQuery(view, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(3)));
      expect((qFrames()[0]!.asOf as number)).toBe(5);

      // the pinned stream has completed; a later tx is nobody's news
      await settle();
      peer.push({ op: "tx", t: 9, datoms: [] });
      await settle();
      expect(qFrames().length).toBe(1);
      expect(result.current.data).toEqual(ids(3));
      expect(result.current.t).toBe(5);
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
        ({ t }: { t: number }) => useLiveQuery(db.asOf(t), allTodos),
        { initialProps: { t: 5 } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(5)));

      rerender({ t: 5 });
      rerender({ t: 5 });
      await settle();
      // still the one subscription: one live pass, one q frame
      expect(qFrames()).toHaveLength(1);
      expect(result.current.data).toEqual(ids(5));
      expect(result.current.t).toBe(5);
      expect(result.current.error).toBeUndefined();

      // a different coordinate is a different view: tear down, re-subscribe
      rerender({ t: 6 });
      await waitFor(() => expect(result.current.data).toEqual(ids(6)));
      expect(qFrames()).toHaveLength(2);
      expect(qFrames().at(-1)!.asOf as number).toBe(6);
      expect(result.current.t).toBe(6);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("a terminal Unauthorized sets error and keeps the last rows", async () => {
    const world = await todoWorld(1);
    const { db, peer, answer, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

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
      expect(result.current.data).toEqual(ids(...world.eids));
    } finally {
      await close();
    }
  });

  test("retry() re-subscribes after a terminal Unauthorized", async () => {
    const world = await todoWorld(1);
    const { db, peer, answer, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(spy.calls).toBe(1);

      answer((frame) =>
        frame.op === "sync"
          ? { status: 401, body: { error: "token expired" } }
          : { body: { t: world.t, result: [] } },
      );
      peer.drop();
      await waitFor(() => expect(result.current.error).toBeDefined());

      answer((frame) =>
        frame.op === "sync"
          ? { body: { t: world.t, datoms: world.datoms } }
          : { body: { t: world.t, result: [] } },
      );
      result.current.retry();
      await waitFor(() => expect(result.current.error).toBeUndefined());
      expect(result.current.data).toEqual(ids(...world.eids));
      expect(result.current.status).toBe("success");
      expect(spy.calls).toBe(2);
    } finally {
      await close();
    }
  });

  test("a later live generation re-subscribes after a terminal Unauthorized", async () => {
    const world = await todoWorld(1);
    const { db, peer, answer, close } = overlaySetup(world);
    try {
      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

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

      answer((frame) =>
        frame.op === "sync"
          ? { body: { t: world.t, datoms: world.datoms } }
          : { body: { t: world.t, result: [] } },
      );
      // drop the spent socket, then a one-shot reconnects — new generation, live
      peer.drop();
      await db.query(allTodos);
      await waitFor(() => expect(result.current.error).toBeUndefined());
      expect(result.current.data).toEqual(ids(...world.eids));
    } finally {
      await close();
    }
  });

  test("unmount interrupts — the peer sees no re-run on the next tick", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    try {
      const { result, unmount } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

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
      const first = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(first.result.current.data).toEqual(ids(...world.eids)));
      first.unmount();

      const { result } = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.data).toEqual(ids(world.eids[0]!, two.tempids.t1)),
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
      const { result } = renderHook(() => useLiveQuery(db, allTodos), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      await settle();

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(result.current.data).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
      expect(result.current.t).toBe(two.t);
      await settle();
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("changing an inline value resubscribes", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(n)),
        { initialProps: { n: 1 } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      expect(spy.calls).toBe(1);

      rerender({ n: 2 });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(result.current.error).toBeUndefined();
      expect(spy.calls).toBe(2);
    } finally {
      await close();
    }
  });

  test("inline-value useLiveQuery(db, q) with a stable closed-over local does not blank rows", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    try {
      const { result, rerender } = renderHook(
        ({ title }: { title: string }) =>
          useLiveQuery(db, Ramose.Query.from(Todo).where({ title }).ids()),
        { initialProps: { title: "t0" } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      const held = result.current.data;

      rerender({ title: "t0" });
      rerender({ title: "t0" });
      await settle();
      expect(result.current.data).toBe(held);
      expect(result.current.t).toBe(world.t);
      expect(result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("changing an inline literal changes the AST key and resubscribes", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result, rerender } = renderHook(
        ({ title }: { title: string }) =>
          useLiveQuery(db, Ramose.Query.from(Todo).where({ title }).ids()),
        { initialProps: { title: "t0" } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      expect(spy.calls).toBe(1);

      rerender({ title: "t1" });
      expect(result.current.data).toBeUndefined();
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[1]!)));
      expect(spy.calls).toBe(2);
      expect(result.current.t).toBeDefined();
    } finally {
      await close();
    }
  });

  test("a render-fresh equivalent query does not re-subscribe", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result, rerender } = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).ids()),
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(spy.calls).toBe(1);

      rerender();
      rerender();
      await settle();
      expect(spy.calls).toBe(1);
      expect(result.current.t).toBe(world.t);
    } finally {
      await close();
    }
  });

  test("a ReadDb double without liveRaw does not re-finalize already-shaped rows", async () => {
    const shaped = ids(7);
    const one = ids(7)[0]!;
    const live = (value: unknown): Ramose.Subscription<unknown> => ({
      subscribe(onValue) {
        onValue(value);
        return () => {};
      },
      async *[Symbol.asyncIterator]() {
        yield value;
      },
      close() {},
    });
    // no DB_SEAM / liveRaw — `live()` already returns the query's terminal
    const db = {
      name: "todos",
      schema: Todos,
      live: (query: Ramose.QueryObject) =>
        query.take === "one" ? live(one) : live(shaped),
    } as unknown as Ramose.ReadDb<typeof Todos>;

    const rows = renderHook(() => useLiveQuery(db, allTodos));
    await waitFor(() => expect(rows.result.current.data).toEqual(shaped));
    expect(rows.result.current.data).not.toEqual([undefined]);

    const taken = renderHook(() => useLiveQuery(db, allTodos.one()));
    await waitFor(() => expect(taken.result.current.data).toEqual(one));
    expect(taken.result.current.data).not.toBeUndefined();
  });
});

describe("useLiveQuery shared subscription cache", () => {
  test("permuted where-objects share one live subscription", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    const id = world.eids[0]!;
    try {
      const a = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).where({ title: "t0", id }).ids()),
      );
      const b = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).where({ id, title: "t0" }).ids()),
      );
      await waitFor(() => expect(a.result.current.data).toEqual(ids(id)));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(id)));
      expect(spy.calls).toBe(1);
      expect(a.result.current.data).toEqual(b.result.current.data);
    } finally {
      await close();
    }
  });

  test("two hooks with equal lowered AST share one subscription", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const a = renderHook(() => useLiveQuery(db, allTodos));
      const b = renderHook(() => useLiveQuery(db, Ramose.Query.from(Todo).ids()));
      await waitFor(() => expect(a.result.current.data).toEqual(ids(...world.eids)));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(...world.eids)));
      expect(spy.calls).toBe(1);
      expect(a.result.current.data).toEqual(b.result.current.data);

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(a.result.current.data).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );
      expect(b.result.current.data).toEqual(a.result.current.data);
      expect(a.result.current.t).toBe(two.t);
      expect(b.result.current.t).toBe(two.t);
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("different inline values do not share; unmount of one does not close the other", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const one = renderHook(() => useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(1)));
      const two = renderHook(() => useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(2)));
      await waitFor(() => expect(one.result.current.data).toEqual(ids(world.eids[0]!)));
      await waitFor(() => expect(two.result.current.data).toEqual(ids(world.eids[0]!)));
      expect(spy.calls).toBe(2);
      expect(one.result.current.data).not.toBe(two.result.current.data);

      one.unmount();
      await settle();
      expect(spy.closed).toBe(1);

      const extra = txSnap(
        await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]),
      );
      peer.push({ op: "tx", t: extra.t, datoms: extra.datoms });
      await waitFor(() =>
        expect(two.result.current.data).toEqual(ids(world.eids[0]!, extra.tempids.t1)),
      );
      expect(spy.closed).toBe(1);

      two.unmount();
      await settle();
      expect(spy.closed).toBe(2);
    } finally {
      await close();
    }
  });

  test("last unmount of a shared query closes the standing subscription", async () => {
    const world = await todoWorld(1);
    const { db, peer, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const a = renderHook(() => useLiveQuery(db, allTodos));
      const b = renderHook(() => useLiveQuery(db, allTodos));
      await waitFor(() => expect(a.result.current.data).toEqual(ids(...world.eids)));
      expect(spy.calls).toBe(1);

      a.unmount();
      await settle();
      expect(spy.closed).toBe(0);

      const two = txSnap(await world.conn.transact([{ ":db/id": "t1", ":ramose/type": ":todo", ":todo/title": "t1" }]));
      peer.push({ op: "tx", t: two.t, datoms: two.datoms });
      await waitFor(() =>
        expect(b.result.current.data).toEqual(ids(world.eids[0]!, two.tempids.t1)),
      );

      b.unmount();
      await settle();
      expect(spy.closed).toBe(1);
      const frames = peer.frames.length;
      peer.push({ op: "tx", t: two.t + 1, datoms: [] });
      await settle();
      expect(peer.frames.length).toBe(frames);
    } finally {
      await close();
    }
  });

  test("a single-row change re-renders only that row's memo child", async () => {
    const titled = Ramose.Query.from(Todo);
    const world = await todoWorld(2);
    const { db, peer, close } = overlaySetup(world);
    const renders: number[] = [];
    const Row = memo(function Row({
      row,
    }: {
      row: { readonly id: number; readonly title: string };
    }) {
      renders.push(row.id);
      return <div>{row.title}</div>;
    });
    function List() {
      const { data } = useLiveQuery(db, titled);
      return (
        <>
          {data?.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </>
      );
    }
    try {
      render(<List />);
      await waitFor(() => expect(renders.length).toBeGreaterThanOrEqual(2));
      const initial = [...renders];
      expect(new Set(initial)).toEqual(new Set(world.eids));
      renders.length = 0;

      const change = txSnap(
        await world.conn.transact([
          { ":db/id": world.eids[0]!, ":todo/title": "changed" },
        ]),
      );
      peer.push({ op: "tx", t: change.t, datoms: change.datoms });
      await waitFor(() => expect(renders.length).toBeGreaterThan(0));
      expect(renders).toEqual([world.eids[0]!]);
    } finally {
      await close();
    }
  });

  test("a single key change does not warn; sustained churn does", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(n)),
        { initialProps: { n: 1 } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      expect(warnings).toHaveLength(0);

      rerender({ n: 2 });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(warnings).toHaveLength(0);

      // three consecutive renders with distinct keys — the Date.now() footgun
      rerender({ n: 1 });
      rerender({ n: 2 });
      rerender({ n: 1 });
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![0])).toContain(
        "useLiveQuery subscription key changed between renders",
      );
    } finally {
      console.warn = orig;
      await close();
    }
  });

  test("one() and limit(1) share a subscription; each keeps its own shape (one first)", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    const take = Ramose.Query.from(Todo).ids().one();
    const limited = Ramose.Query.from(Todo).ids().limit(1);
    try {
      const a = renderHook(() => useLiveQuery(db, take));
      const b = renderHook(() => useLiveQuery(db, limited));
      await waitFor(() => expect(a.result.current.data).toEqual(ids(world.eids[0]!)[0]));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(world.eids[0]!)));
      expect(Array.isArray(a.result.current.data)).toBe(false);
      expect(Array.isArray(b.result.current.data)).toBe(true);
      expect(spy.calls).toBe(1);
      expect(a.result.current.error).toBeUndefined();
      expect(b.result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("one() and limit(1) share a subscription; each keeps its own shape (limit first)", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    const take = Ramose.Query.from(Todo).ids().one();
    const limited = Ramose.Query.from(Todo).ids().limit(1);
    try {
      const b = renderHook(() => useLiveQuery(db, limited));
      const a = renderHook(() => useLiveQuery(db, take));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(world.eids[0]!)));
      await waitFor(() => expect(a.result.current.data).toEqual(ids(world.eids[0]!)[0]));
      expect(Array.isArray(a.result.current.data)).toBe(false);
      expect(Array.isArray(b.result.current.data)).toBe(true);
      expect(spy.calls).toBe(1);
      expect(a.result.current.error).toBeUndefined();
      expect(b.result.current.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("oneOrFail() raises only in its own hook (oneOrFail first)", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    const fail = Ramose.Query.from(Todo).ids().oneOrFail();
    const limited = Ramose.Query.from(Todo).ids().limit(2);
    try {
      const a = renderHook(() => useLiveQuery(db, fail));
      const b = renderHook(() => useLiveQuery(db, limited));
      await waitFor(() => expect(a.result.current.error).toBeDefined());
      expect((a.result.current.error as { _tag: string })._tag).toBe("NotOne");
      await waitFor(() => expect(b.result.current.data).toEqual(ids(...world.eids)));
      expect(Array.isArray(b.result.current.data)).toBe(true);
      expect(b.result.current.error).toBeUndefined();
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("oneOrFail() raises only in its own hook (limit first)", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    const fail = Ramose.Query.from(Todo).ids().oneOrFail();
    const limited = Ramose.Query.from(Todo).ids().limit(2);
    try {
      const b = renderHook(() => useLiveQuery(db, limited));
      const a = renderHook(() => useLiveQuery(db, fail));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(...world.eids)));
      await waitFor(() => expect(a.result.current.error).toBeDefined());
      expect((a.result.current.error as { _tag: string })._tag).toBe("NotOne");
      expect(Array.isArray(b.result.current.data)).toBe(true);
      expect(b.result.current.error).toBeUndefined();
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("two independently built identical inline queries share one subscription", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const a = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(1)),
      );
      const b = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(1)),
      );
      await waitFor(() => expect(a.result.current.data).toEqual(ids(world.eids[0]!)));
      await waitFor(() => expect(b.result.current.data).toEqual(ids(world.eids[0]!)));
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("dev-mode warns when an impure generator body keys on a stale AST", async () => {
    let n = 0;
    const q = Ramose.Query.q(() =>
      pipe(Ramose.Query.entities(Todo), Ramose.Query.limit((n += 1))),
    );
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      renderHook(() => useLiveQuery(db, q));
      await waitFor(() =>
        expect(
          warnings.some((w) => String(w[0]).includes("query body is not pure")),
        ).toBe(true),
      );
    } finally {
      console.warn = orig;
      await close();
    }
  });

  test("an inline unlowerable query does not resubscribe per render", async () => {
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result, rerender } = renderHook(() =>
        useLiveQuery(db, Ramose.Query.from(Todo).after(null)),
      );
      await waitFor(() => expect(result.current.error).toBeDefined());
      expect((result.current.error as { _tag: string })._tag).toBe(
        "InvalidRequest",
      );
      expect(spy.calls).toBe(1);
      rerender();
      rerender();
      await settle();
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("a throwing lowering does not resubscribe per render", async () => {
    const broken = Ramose.Query.q(() => Ramose.Query.entities(Todo)).after(null);
    const world = await todoWorld(1);
    const { db, close } = overlaySetup(world);
    const spy = spyRawLive(db);
    try {
      const { result, rerender } = renderHook(() => useLiveQuery(db, broken));
      await waitFor(() => expect(result.current.error).toBeDefined());
      expect((result.current.error as { _tag: string })._tag).toBe(
        "InvalidRequest",
      );
      expect(spy.calls).toBe(1);
      rerender();
      rerender();
      await settle();
      expect(spy.calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("a single inline-value change does not warn", async () => {
    const world = await todoWorld(2);
    const { db, close } = overlaySetup(world);
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const { result, rerender } = renderHook(
        ({ n }: { n: number }) => useLiveQuery(db, Ramose.Query.from(Todo).ids().limit(n)),
        { initialProps: { n: 1 } },
      );
      await waitFor(() => expect(result.current.data).toEqual(ids(world.eids[0]!)));
      rerender({ n: 2 });
      await waitFor(() => expect(result.current.data).toEqual(ids(...world.eids)));
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = orig;
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

describe("useLiveQuery (subscription form)", () => {
  test("drains any subscription — no db, no provider", async () => {
    const sub = immediate(["a", "b", "c"]);
    const { result } = renderHook(() => useLiveQuery(sub));
    await waitFor(() => expect(result.current.data).toBe("c"));
    expect(result.current.t).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  test("re-subscribes when the subscription identity changes", async () => {
    const first = immediate([1]);
    const second = immediate([2]);
    const { result, rerender } = renderHook(
      ({ sub }: { sub: Ramose.Subscription<number> }) => useLiveQuery(sub),
      { initialProps: { sub: first } },
    );
    await waitFor(() => expect(result.current.data).toBe(1));

    rerender({ sub: second });
    await waitFor(() => expect(result.current.data).toBe(2));
    expect(result.current.t).toBeUndefined();
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
      ({ sub }: { sub: Ramose.Subscription<string> }) => useLiveQuery(sub),
      { initialProps: { sub: first } },
    );
    await waitFor(() => expect(result.current.data).toBe("A"));

    rerender({ sub: second });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.t).toBeUndefined();

    later[0]?.("B");
    await waitFor(() => expect(result.current.data).toBe("B"));
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
    const first = renderHook(() => useLiveQuery(sub));
    await waitFor(() => expect(first.result.current.data).toBe("a"));
    first.unmount();
    expect(closed).toBe(0);

    const second = renderHook(() => useLiveQuery(sub));
    await waitFor(() => expect(second.result.current.data).toBe("a"));
    second.unmount();
    expect(closed).toBe(0);
  });
});
