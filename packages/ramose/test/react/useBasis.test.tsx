/**
 * `useBasis` — where the basis is:
 *
 * - a live view reads `session.t` synchronously and again on every
 *   `{ op: "tx" }` / resync — no `GET /info` per tick;
 * - an `asOf(t)` view answers `t` on the first render, with no request and
 *   no socket;
 * - switching views re-answers, still without a request when pinned.
 */

import { describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { registerDom, Todos, titles, wrapperFor } from "./harness.tsx";
import { fakePeer, type Call } from "./peer.ts";
import { useBasis, useDb } from "../../src/react/index.ts";

registerDom();

const infoCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.url.includes("/info"));

describe("useBasis", () => {
  test("a live view reads session.t, then follows { op: tx } without /info per tick", async () => {
    const state = { t: 7 };
    const peer = fakePeer({
      answer: () => ({ body: { t: state.t, result: [] } }),
      http: (call) =>
        call.url.includes("/info")
          ? { body: { db: "todos", t: state.t } }
          : undefined,
    });

    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        // one read, so the session socket unsolicited frames ride is open
        useEffect(() => {
          db.query(titles).catch(() => {});
        }, [db]);
        return useBasis(db);
      },
      { wrapper: wrapperFor(peer) },
    );

    await waitFor(() => expect(result.current).toBe(7));
    const infos = infoCalls(peer.calls).length;

    state.t = 9;
    peer.push({ op: "tx", t: 9, datoms: [] });
    await waitFor(() => expect(result.current).toBe(9));
    expect(infoCalls(peer.calls).length).toBe(infos);
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
      answer: () => ({ body: { t: state.t, result: [] } }),
      http: (call) =>
        call.url.includes("/info")
          ? { body: { db: "todos", t: state.t } }
          : undefined,
    });
    const { result, rerender } = renderHook(
      ({ t }: { t: number | undefined }) => {
        const db = useDb("todos", Todos);
        useEffect(() => {
          if (t === undefined) db.query(titles).catch(() => {});
        }, [db, t]);
        return useBasis(t === undefined ? db : db.asOf(t));
      },
      { wrapper: wrapperFor(peer), initialProps: { t: 3 as number | undefined } },
    );
    expect(result.current).toBe(3);

    rerender({ t: 5 });
    await waitFor(() => expect(result.current).toBe(5));
    expect(peer.calls).toHaveLength(0);

    rerender({ t: undefined });
    await waitFor(() => expect(result.current).toBe(7));
  });

  test("a wake updates from session.t even while an initial /info is in flight", async () => {
    let released = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { t: 4 };
    const peer = fakePeer({
      answer: () => ({ body: { t: state.t, result: [] } }),
      http: async (call) => {
        if (call.url.includes("/info")) {
          const seen = state.t;
          if (!released) await hold;
          return { body: { db: "todos", t: seen } };
        }
        return { body: { t: 1, txEid: 1, tempids: {}, datoms: 0 } };
      },
    });

    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        useEffect(() => {
          db.query(titles).catch(() => {});
        }, [db]);
        return useBasis(db);
      },
      { wrapper: wrapperFor(peer) },
    );

    state.t = 5;
    peer.push({ op: "tx", t: 5, datoms: [] });
    await waitFor(() => expect(result.current).toBe(5));

    released = true;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(5);
  });
});
