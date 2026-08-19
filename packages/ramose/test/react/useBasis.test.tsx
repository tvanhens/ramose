/**
 * `useBasis` — where the basis is:
 *
 * - a live view asks the peer (`GET /db/:name/info`) once on mount and again
 *   on every session tick;
 * - an `asOf(t)` view answers `t` on the first render, with no request and
 *   no socket;
 * - switching views re-answers, still without a request when pinned.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { useEffect } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { registerDom, Todos, titles, wrapperFor } from "./harness.tsx";
import { fakePeer, type Call } from "./peer.ts";
import { useBasis, useDb } from "../../src/react/index.ts";

registerDom();

const infoCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.url.includes("/info"));

describe("useBasis", () => {
  test("a live view asks the peer, then re-asks on every tick", async () => {
    const state = { t: 7 };
    const peer = fakePeer({
      http: (call) =>
        call.url.includes("/info")
          ? { body: { db: "todos", t: state.t } }
          : undefined,
    });

    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        // one read, so the session socket the ticks ride is open
        useEffect(() => {
          Effect.runPromise(db.q(titles)).catch(() => {});
        }, [db]);
        return useBasis(db);
      },
      { wrapper: wrapperFor(peer) },
    );

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(7));
    expect(infoCalls(peer.calls).length).toBeGreaterThan(0);

    state.t = 9;
    peer.push({ op: "t", t: 9 });
    await waitFor(() => expect(result.current).toBe(9));
  });

  test("an asOf view answers its t on the first render, with no request", () => {
    const peer = fakePeer();
    const { result, rerender } = renderHook(
      // inline on purpose: a new view object every render
      () => useBasis(useDb("todos", Todos).asOf(3)),
      { wrapper: wrapperFor(peer) },
    );

    expect(result.current).toBe(3);
    rerender();
    expect(result.current).toBe(3);
    expect(peer.calls).toHaveLength(0);
    expect(peer.frames).toHaveLength(0);
  });

  test("switching views re-answers — pinned coordinates still without a request", async () => {
    const state = { t: 7 };
    const peer = fakePeer({
      http: (call) =>
        call.url.includes("/info")
          ? { body: { db: "todos", t: state.t } }
          : undefined,
    });
    const { result, rerender } = renderHook(
      ({ t }: { t: number | undefined }) => {
        const db = useDb("todos", Todos);
        return useBasis(t === undefined ? db : db.asOf(t));
      },
      { wrapper: wrapperFor(peer), initialProps: { t: 3 as number | undefined } },
    );
    expect(result.current).toBe(3);

    rerender({ t: 5 });
    await waitFor(() => expect(result.current).toBe(5));
    expect(peer.calls).toHaveLength(0);

    // the live view is the one that asks
    rerender({ t: undefined });
    await waitFor(() => expect(result.current).toBe(7));
    expect(infoCalls(peer.calls)).toHaveLength(1);
  });
});
