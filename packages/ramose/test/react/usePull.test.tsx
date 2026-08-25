/**
 * `useLivePull` — a live `db.livePull` as `Read`. `usePull` is the one-shot twin.
 *
 * Session current-view pulls run on the overlay. Pinned `asOf` still rides
 * the peer. Subject identity is structural.
 */

import { describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import type * as Ramose from "../../src/db/index.ts";
import { registerDom, sleep, Todo, Todos, wrapperFor } from "./harness.tsx";
import { fakePeer, type Frame } from "./peer.ts";
import { catalogWorld, snapshotOf, txSnap } from "../overlay-seed.ts";
import { useDb, useLivePull, usePull } from "../../src/react/index.ts";

registerDom();

const shape = { title: Todo.title };

const todoWorld = async () => {
  const conn = await catalogWorld(Todos);
  const a = txSnap(
    await conn.transact([
      { ":db/id": "a", ":todo/title": "A", ":todo/slug": "a" },
    ]),
  );
  const b = txSnap(
    await conn.transact([
      { ":db/id": "b", ":todo/title": "other", ":todo/slug": "b" },
    ]),
  );
  return {
    conn,
    a: a.tempids.a,
    b: b.tempids.b,
    ...(await snapshotOf(conn)),
  };
};

const overlayPeer = (world: { t: number; datoms: unknown[] }) =>
  fakePeer({
    answer: (frame: Frame) =>
      frame.op === "sync"
        ? { body: { t: world.t, datoms: world.datoms } }
        : { body: { t: world.t, result: null } },
    http: () => ({ body: { t: world.t, txEid: 1, tempids: {}, datoms: 1 } }),
  });

describe("useLivePull", () => {
  test("first emission, a tx re-emission, and a retract's null", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const ada = world.a;
    const { result } = renderHook(
      () => useLivePull(useDb("todos", Todos), ada, shape),
      { wrapper: wrapperFor(peer) },
    );

    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));
    expect(result.current.t).toBe(world.t);

    const renamed = txSnap(
      await world.conn.transact([{ ":db/id": world.a, ":todo/title": "B" }]),
    );
    peer.push({ op: "tx", t: renamed.t, datoms: renamed.datoms });
    await waitFor(() => expect(result.current.data).toEqual({ title: "B" }));
    expect(result.current.t).toBe(renamed.t);

    const gone = txSnap(
      await world.conn.transact([[":db/retractEntity", world.a]]),
    );
    peer.push({ op: "tx", t: gone.t, datoms: gone.datoms });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.t).toBe(gone.t);
    expect(result.current.error).toBeUndefined();
  });

  test("a render-fresh inline pattern holds one subscription", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const { result, rerender } = renderHook(
      () =>
        useLivePull(useDb("todos", Todos), world.a, { title: Todo.title }),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));
    rerender();
    rerender();
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(0);
    expect(result.current.data).toEqual({ title: "A" });
  });

  test("the subject is structural: equal literals hold one subscription, a new subject re-subscribes", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useLivePull(useDb("todos", Todos), id, shape),
      { wrapper: wrapperFor(peer), initialProps: { id: world.a } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));

    rerender({ id: world.a });
    rerender({ id: world.a });
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(0);

    rerender({ id: world.b });
    await waitFor(() => expect(result.current.data).toEqual({ title: "other" }));
    expect(peer.frameOps("pull")).toHaveLength(0);
  });

  test("subject A → B blanks before B lands on a delayed pull", async () => {
    const peer = fakePeer({
      answer: (frame: Frame) => {
        if (frame.op === "pull") {
          const eid = frame.eid as number;
          if (eid === 18) {
            return { delay: 40, body: { t: 3, result: { title: "B" } } };
          }
          return { body: { t: 3, result: { title: "A" } } };
        }
        return { body: { t: 3, result: [] } };
      },
    });
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useLivePull(useDb("todos", Todos).asOf(3), id, shape),
      { wrapper: wrapperFor(peer), initialProps: { id: 17 } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));

    rerender({ id: 18 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual({ title: "B" }));
    expect(result.current.t).toBe(3);
  });

  test("both spellings of a lookup ref are one subject", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const { result, rerender } = renderHook(
      ({ byRef }: { byRef: boolean }) =>
        useLivePull(
          useDb("todos", Todos),
          byRef ? [Todo.slug, "a"] : [":todo/slug", "a"],
          shape,
        ),
      { wrapper: wrapperFor(peer), initialProps: { byRef: true } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));

    rerender({ byRef: false });
    await sleep(20);
    expect(result.current.data).toEqual({ title: "A" });
    expect(peer.frameOps("pull")).toHaveLength(0);
  });

  test("a pinned view emits once, completes, and keeps its rows", async () => {
    const state = { t: 5, entity: { title: "then" } as unknown };
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "pull"
          ? { body: { t: state.t, result: state.entity } }
          : { body: { t: state.t, result: [] } },
    });
    const { result, rerender } = renderHook(
      () => useLivePull(useDb("todos", Todos).asOf(3), 17, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "then" }));

    rerender();
    peer.push({ op: "tx", t: 99, datoms: [] });
    await sleep(20);
    expect(result.current.data).toEqual({ title: "then" });
    expect(result.current.error).toBeUndefined();
    expect(peer.frameOps("pull")).toHaveLength(1);
    expect(peer.frameOps("pull")[0]!.asOf).toBe(3);
  });

  test("a terminal refusal lands in error, over the last rows", async () => {
    const world = await todoWorld();
    let refuse = false;
    const peer = fakePeer({
      answer: (frame: Frame) => {
        if (refuse && frame.op === "sync") {
          return { status: 401, body: { error: "no" } };
        }
        if (frame.op === "sync") {
          return { body: { t: world.t, datoms: world.datoms } };
        }
        return { body: { t: world.t, result: null } };
      },
    });
    const { result } = renderHook(
      () => useLivePull(useDb("todos", Todos), world.a, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));

    refuse = true;
    peer.drop();
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data).toEqual({ title: "A" });
    expect((result.current.error as { _tag?: string })._tag).toBe(
      "Unauthorized",
    );
  });

  test("explicit unmount/remount still receives updates", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const first = renderHook(
      () => useLivePull(useDb("todos", Todos), world.a, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(first.result.current.data).toEqual({ title: "A" }));
    first.unmount();

    const { result } = renderHook(
      () => useLivePull(useDb("todos", Todos), world.a, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));

    const renamed = txSnap(
      await world.conn.transact([{ ":db/id": world.a, ":todo/title": "B" }]),
    );
    peer.push({ op: "tx", t: renamed.t, datoms: renamed.datoms });
    await waitFor(() => expect(result.current.data).toEqual({ title: "B" }));
  });

  test("StrictMode holds exactly one subscription at steady state", async () => {
    const world = await todoWorld();
    const peer = overlayPeer(world);
    const { result } = renderHook(
      () => useLivePull(useDb("todos", Todos), world.a, shape),
      {
        wrapper: ({ children }) => (
          <StrictMode>{wrapperFor(peer)({ children })}</StrictMode>
        ),
      },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));
    await sleep(20);

    const renamed = txSnap(
      await world.conn.transact([{ ":db/id": world.a, ":todo/title": "B" }]),
    );
    peer.push({ op: "tx", t: renamed.t, datoms: renamed.datoms });
    await waitFor(() => expect(result.current.data).toEqual({ title: "B" }));
    await sleep(20);
    expect(result.current.t).toBe(renamed.t);
    expect(result.current.error).toBeUndefined();
  });
});

describe("usePull (one-shot)", () => {
  test("one pull per view: data lands, equal inline views never re-run", async () => {
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "pull"
          ? { body: { t: frame.asOf ?? 3, result: { title: "A" } } }
          : { body: { t: 3, result: [] } },
    });
    const { result, rerender } = renderHook(
      () => usePull(useDb("todos", Todos).asOf(3), 17, shape),
      { wrapper: wrapperFor(peer) },
    );
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));
    expect(result.current.t).toBe(3);
    expect(result.current.status).toBe("success");
    rerender();
    rerender();
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(1);
  });

  test("a render-fresh inline pattern does not re-run after the first result", async () => {
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "pull"
          ? { body: { t: 3, result: { title: "A" } } }
          : { body: { t: 3, result: [] } },
    });
    const { result, rerender } = renderHook(
      () =>
        usePull(useDb("todos", Todos).asOf(3), 17, { title: Todo.title }),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "A" }));
    rerender();
    rerender();
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(1);
  });

  test("refetch re-issues the pull", async () => {
    let n = 0;
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "pull"
          ? { body: { t: 3, result: { title: `v${++n}` } } }
          : { body: { t: 3, result: [] } },
    });
    const { result } = renderHook(
      () => usePull(useDb("todos", Todos).asOf(3), 17, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual({ title: "v1" }));
    result.current.refetch();
    await waitFor(() => expect(result.current.data).toEqual({ title: "v2" }));
    expect(peer.frameOps("pull")).toHaveLength(2);
  });
});
