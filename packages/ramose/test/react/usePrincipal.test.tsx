/**
 * usePrincipal(db) → { eid, class, loading }: one db.principal() on mount,
 * cancelled on unmount, re-read when the session generation advances.
 */

import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as Ramose from "../../src/db/index.ts";
import { RamoseProvider, useDb, usePrincipal } from "../../src/react/index.ts";
import { registerDom, Todos } from "./harness.tsx";
import { fakePeer } from "./peer.ts";

registerDom();

const wrapperFor = (
  peer: ReturnType<typeof fakePeer>,
  url = "https://peer.example.com",
) =>
  ({ children }: { children?: ReactNode }) => (
    <RamoseProvider url={url} fetch={peer.fetch} webSocket={peer.webSocket}>
      {children}
    </RamoseProvider>
  );

const peerWith = (principal: { eid: number | null; class: string }) =>
  fakePeer({
    http: (call) =>
      call.method === "GET" && new URL(call.url).pathname.endsWith("/info")
        ? { body: { db: "todos", t: 2, principal } }
        : { body: { t: 1, txEid: 1, tempids: {}, datoms: 0 } },
  });

describe("usePrincipal", () => {
  test("loading then { eid, class }", async () => {
    const peer = peerWith({ eid: 7, class: "member" });
    const { result, unmount } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return usePrincipal(db);
      },
      { wrapper: wrapperFor(peer) },
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.eid).toBeUndefined();
    expect(result.current.class).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eid as number | null | undefined).toBe(7);
    expect(result.current.class).toBe("member");
    unmount();
  });

  test("eid: null is a settled answer, not loading", async () => {
    const peer = peerWith({ eid: null, class: "viewer" });
    const { result, unmount } = renderHook(
      () => usePrincipal(useDb("todos", Todos)),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eid).toBeNull();
    expect(result.current.class).toBe("viewer");
    unmount();
  });

  test("onError fires and loading clears when /info has no principal", async () => {
    const seen: unknown[] = [];
    const peer = fakePeer();
    const { result, unmount } = renderHook(
      () =>
        usePrincipal(useDb("todos", Todos), {
          onError: (e) => seen.push(e),
        }),
      { wrapper: wrapperFor(peer) },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(seen).toHaveLength(1);
    expect((seen[0] as { _tag: string })._tag).toBe("InternalError");
    unmount();
  });

  test("unmount cancels the in-flight load", async () => {
    let release!: (value: { body: unknown }) => void;
    const held = new Promise<{ body: unknown }>((res) => {
      release = res;
    });
    const peer = fakePeer({
      http: (call) =>
        call.method === "GET" && new URL(call.url).pathname.endsWith("/info")
          ? held
          : { body: { t: 1, txEid: 1, tempids: {}, datoms: 0 } },
    });
    const { result, unmount } = renderHook(
      () => usePrincipal(useDb("todos", Todos)),
      { wrapper: wrapperFor(peer) },
    );
    expect(result.current.loading).toBe(true);
    unmount();

    const noisy = console.error;
    const complaints: unknown[] = [];
    console.error = (...args: unknown[]) => complaints.push(args);
    try {
      await act(async () => {
        release({ body: { db: "todos", t: 2, principal: { eid: 1, class: "owner" } } });
        await held;
        await Bun.sleep(10);
      });
    } finally {
      console.error = noisy;
    }
    expect(complaints).toEqual([]);
  });

  test("needs no provider when given a db", async () => {
    const peer = peerWith({ eid: 3, class: "owner" });
    const client = Ramose.connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
    });
    const db = client.db("todos", Todos);
    const { result, unmount } = renderHook(() => usePrincipal(db));
    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.eid as number | null | undefined).toBe(3);
      expect(result.current.class).toBe("owner");
    } finally {
      unmount();
      await client.close();
    }
  });
});
