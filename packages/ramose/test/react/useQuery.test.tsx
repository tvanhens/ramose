/**
 * `useQuery` — the one-shot read as `Read`:
 *
 * - one `q` per view; a fresh-but-equal inline `db.asOf(t)` is not a re-run
 *   (and, transitively, not a render loop);
 * - a `t` change re-runs; the in-flight state is `loading: true` over the
 *   previous `data` (no flash to `undefined` on scrub);
 * - a slower answer to an older run is dropped — last-write-wins by issue
 *   order, not by resolution order;
 * - a terminal failure lands as the tagged error, with the last `data` kept.
 */

import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import {
  registerDom,
  sleep,
  Todo,
  Todos,
  titles,
  wrapperFor,
} from "./harness.tsx";
import { scriptedPeer, type Frame } from "./peer.ts";
import * as Ramose from "../../src/db/index.ts";
import { useDb, useQuery } from "../../src/react/index.ts";

registerDom();

/** Rows for one title, in the wire shape a select query comes back as. */
const rowsFor = (title: string) => [[{ title }]];

/** A peer whose `q` answers depend on the frame's `asOf` coordinate. */
const scrubPeer = (
  byAsOf: Record<number, { title: string; delay?: number; status?: number }>,
) =>
  scriptedPeer({
    answer: (frame: Frame) => {
      if (frame.op !== "q") return { body: { t: 1, result: [] } };
      const spec = byAsOf[frame.asOf as number];
      if (spec === undefined) return { body: { t: 1, result: [] } };
      if (spec.status !== undefined) {
        return { status: spec.status, body: { error: spec.title } };
      }
      return {
        body: { t: frame.asOf, result: rowsFor(spec.title) },
        ...(spec.delay !== undefined && { delay: spec.delay }),
      };
    },
  });

describe("useQuery", () => {
  test("one q per view: rows land, and equal inline views never re-run", async () => {
    const peer = scrubPeer({ 1: { title: "one" } });
    const { result, rerender } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        // built inline on purpose: a new object every render, same view
        return useQuery(db.asOf(1), titles);
      },
      { wrapper: wrapperFor(peer) },
    );

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ title: "one" }]);
    expect(result.current.t).toBe(1);
    expect(result.current.status).toBe("success");

    rerender();
    rerender();
    await sleep(20);
    expect(peer.frameOps("q")).toHaveLength(1);
  });

  test("a render-fresh factory query does not loop after the first result", async () => {
    const peer = scrubPeer({ 1: { title: "one" } });
    const byTitle = (title: string) =>
      Ramose.Query.from(Todo).where({ title }).select({ title: Todo.title });
    const { result, rerender } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return useQuery(db.asOf(1), byTitle("one"));
      },
      { wrapper: wrapperFor(peer) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ title: "one" }]);
    expect(peer.frameOps("q")).toHaveLength(1);

    rerender();
    rerender();
    await sleep(250);
    expect(peer.frameOps("q")).toHaveLength(1);
    expect(result.current.isLoading).toBe(false);
  });

  test("a scrub keeps the previous data while loading, and drops the stale slower answer", async () => {
    const peer = scrubPeer({
      1: { title: "one", delay: 80 },
      2: { title: "two" },
      3: { title: "three" },
    });
    const { result, rerender } = renderHook(
      ({ t }: { t: number }) => {
        const db = useDb("todos", Todos);
        return useQuery(db.asOf(t), titles);
      },
      { wrapper: wrapperFor(peer), initialProps: { t: 2 } },
    );
    await waitFor(() => expect(result.current.data).toEqual([{ title: "two" }]));

    // scrub to the slow coordinate: in flight over the old rows, no flash
    rerender({ t: 1 });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toEqual([{ title: "two" }]);

    // scrub again before it answers; the newer run wins
    rerender({ t: 3 });
    await waitFor(() =>
      expect(result.current.data).toEqual([{ title: "three" }]),
    );
    expect(result.current.isLoading).toBe(false);

    // ...and stays won when the slower answer finally arrives
    await sleep(120);
    expect(result.current.data).toEqual([{ title: "three" }]);
    expect(result.current.error).toBeUndefined();
    expect(peer.frameOps("q").map((f) => f.asOf)).toEqual([2, 1, 3]);
  });

  test("a terminal failure lands as the tagged error, over the last data", async () => {
    const peer = scrubPeer({
      2: { title: "two" },
      4: { title: "bad basis", status: 400 },
    });
    const { result, rerender } = renderHook(
      ({ t }: { t: number }) => {
        const db = useDb("todos", Todos);
        return useQuery(db.asOf(t), titles);
      },
      { wrapper: wrapperFor(peer), initialProps: { t: 2 } },
    );
    await waitFor(() => expect(result.current.data).toEqual([{ title: "two" }]));

    rerender({ t: 4 });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual([{ title: "two" }]);
    expect((result.current.error as { _tag?: string })._tag).toBe(
      "InvalidRequest",
    );

    // a new run clears the error
    rerender({ t: 2 });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.data).toEqual([{ title: "two" }]);
  });

  test("refetch re-issues the query", async () => {
    let n = 0;
    const peer = scriptedPeer({
      answer: (frame: Frame) => {
        if (frame.op !== "q") return { body: { t: 1, result: [] } };
        n += 1;
        return { body: { t: 1, result: [[{ title: `v${n}` }]] } };
      },
    });
    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return useQuery(db.asOf(1), titles);
      },
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.data).toEqual([{ title: "v1" }]));
    result.current.refetch();
    await waitFor(() => expect(result.current.data).toEqual([{ title: "v2" }]));
    expect(peer.frameOps("q")).toHaveLength(2);
  });
});
