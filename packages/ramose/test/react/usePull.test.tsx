/**
 * `usePull` — a standing `db.livePull` as `Live`:
 *
 * - the first emission populates `rows`; a tick that changes the projection
 *   re-emits and counts in `ticks`; a retract emits `null` and keeps standing;
 * - `subject` is compared structurally, so inline `{ id }` literals and both
 *   spellings of a lookup ref hold one subscription; a *different* subject
 *   resets and re-subscribes;
 * - over a pinned view the stream emits once and completes, and `rows` stay
 *   (completion is not an error);
 * - a terminal refusal lands in `error`, over the last `rows`;
 * - StrictMode's mount → unmount → mount holds exactly one subscription.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import type * as Ramose from "../../src/db/index.ts";
import { registerDom, sleep, Todo, Todos, wrapperFor } from "./harness.tsx";
import { fakePeer, type Frame } from "./peer.ts";
import { useDb, usePull } from "../../src/react/index.ts";

registerDom();

const shape = { title: Todo.title };
const ada: Ramose.Eid<typeof Todos> = { id: 17 };

/** A peer whose entity and basis the test moves under it. */
const peerAt = (state: { t: number; entity: unknown }) =>
  fakePeer({
    answer: (frame: Frame) =>
      frame.op === "pull"
        ? { body: { t: state.t, result: state.entity } }
        : { body: { t: state.t, result: [] } },
  });

describe("usePull", () => {
  test("first emission, a tick's re-emission, and a retract's null", async () => {
    const state = { t: 1, entity: { title: "A" } as unknown };
    const peer = peerAt(state);
    const { result } = renderHook(
      () => usePull(useDb("todos", Todos), ada, shape),
      { wrapper: wrapperFor(peer) },
    );

    await waitFor(() => expect(result.current.rows).toEqual({ title: "A" }));
    expect(result.current.ticks).toBe(0);

    state.t = 2;
    state.entity = { title: "B" };
    peer.push({ op: "t", t: 2 });
    await waitFor(() => expect(result.current.rows).toEqual({ title: "B" }));
    expect(result.current.ticks).toBe(1);

    // retracted: `null` is a legitimate emission, and the stream keeps standing
    state.t = 3;
    state.entity = null;
    peer.push({ op: "t", t: 3 });
    await waitFor(() => expect(result.current.rows).toBeNull());
    expect(result.current.ticks).toBe(2);
    expect(result.current.error).toBeUndefined();
  });

  test("the subject is structural: equal literals hold one subscription, a new subject re-subscribes", async () => {
    const state = { t: 1, entity: { title: "A" } as unknown };
    const peer = peerAt(state);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        usePull(useDb("todos", Todos), { id }, shape),
      { wrapper: wrapperFor(peer), initialProps: { id: 17 } },
    );
    await waitFor(() => expect(result.current.rows).toEqual({ title: "A" }));

    // fresh `{ id: 17 }` objects every render: still the one subscription
    rerender({ id: 17 });
    rerender({ id: 17 });
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(1);

    // a different entity is a different subscription, reset and re-run
    state.entity = { title: "other" };
    rerender({ id: 18 });
    expect(result.current.rows).toBeUndefined();
    await waitFor(() => expect(result.current.rows).toEqual({ title: "other" }));
    expect(peer.frameOps("pull").map((f) => f.eid)).toEqual([17, 18]);
  });

  test("both spellings of a lookup ref are one subject", async () => {
    const state = { t: 1, entity: { title: "A" } as unknown };
    const peer = peerAt(state);
    const { result, rerender } = renderHook(
      ({ byRef }: { byRef: boolean }) =>
        usePull(
          useDb("todos", Todos),
          byRef ? [Todo.slug, "a"] : [":todo/slug", "a"],
          shape,
        ),
      { wrapper: wrapperFor(peer), initialProps: { byRef: true } },
    );
    await waitFor(() => expect(result.current.rows).toEqual({ title: "A" }));

    rerender({ byRef: false });
    await sleep(20);
    expect(peer.frameOps("pull")).toHaveLength(1);
    expect(peer.frameOps("pull")[0]!.eid).toEqual([":todo/slug", "a"]);
  });

  test("a pinned view emits once, completes, and keeps its rows", async () => {
    const state = { t: 5, entity: { title: "then" } as unknown };
    const peer = peerAt(state);
    const { result, rerender } = renderHook(
      // inline `asOf`: a new object every render, the same view
      () => usePull(useDb("todos", Todos).asOf(3), ada, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.rows).toEqual({ title: "then" }));

    rerender();
    peer.push({ op: "t", t: 99 });
    await sleep(20);
    expect(result.current.rows).toEqual({ title: "then" });
    expect(result.current.error).toBeUndefined();
    expect(peer.frameOps("pull")).toHaveLength(1);
    expect(peer.frameOps("pull")[0]!.asOf).toBe(3);
  });

  test("a terminal refusal lands in error, over the last rows", async () => {
    const state = { t: 1, entity: { title: "A" } as unknown };
    let refuse = false;
    const peer = fakePeer({
      answer: (frame: Frame) => {
        if (frame.op !== "pull") return { body: { t: state.t, result: [] } };
        if (refuse) return { status: 401, body: { error: "no" } };
        return { body: { t: state.t, result: state.entity } };
      },
    });
    const { result } = renderHook(
      () => usePull(useDb("todos", Todos), ada, shape),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.rows).toEqual({ title: "A" }));

    refuse = true;
    peer.push({ op: "t", t: 2 });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.rows).toEqual({ title: "A" });
    const squashed = Cause.squash(result.current.error!) as { _tag?: string };
    expect(squashed._tag).toBe("Unauthorized");
  });

  test("StrictMode holds exactly one subscription at steady state", async () => {
    const state = { t: 1, entity: { title: "A" } as unknown };
    const peer = peerAt(state);
    const { result } = renderHook(
      () => usePull(useDb("todos", Todos), ada, shape),
      {
        wrapper: ({ children }) => (
          <StrictMode>{wrapperFor(peer)({ children })}</StrictMode>
        ),
      },
    );
    await waitFor(() => expect(result.current.rows).toEqual({ title: "A" }));
    await sleep(20);

    // one standing loop means one re-pull per tick
    const before = peer.frameOps("pull").length;
    state.t = 2;
    state.entity = { title: "B" };
    peer.push({ op: "t", t: 2 });
    await waitFor(() => expect(result.current.rows).toEqual({ title: "B" }));
    await sleep(20);
    expect(peer.frameOps("pull").length).toBe(before + 1);
  });
});
