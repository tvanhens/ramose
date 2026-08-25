/**
 * `useConnectionStatus` — provider-scoped and per-db, from session signals.
 */

import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import * as Ramose from "../../src/db/index.ts";
import {
  useConnectionStatus,
  useDb,
} from "../../src/react/index.ts";
import { registerDom, titles, Todos, wrapperFor } from "./harness.tsx";
import { fakePeer } from "./peer.ts";

registerDom();

describe("useConnectionStatus (per-db)", () => {
  test("is connecting until the first handshake, then live", async () => {
    const peer = fakePeer();
    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        const status = useConnectionStatus(db);
        return { db, status };
      },
      { wrapper: wrapperFor(peer) },
    );

    expect(result.current.status).toBe("connecting");
    await result.current.db.query(titles);
    await waitFor(() => expect(result.current.status).toBe("live"));
  });

  test("a drop is reconnecting; the next read is live again", async () => {
    const peer = fakePeer();
    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return { db, status: useConnectionStatus(db) };
      },
      { wrapper: wrapperFor(peer) },
    );
    await result.current.db.query(titles);
    await waitFor(() => expect(result.current.status).toBe("live"));

    peer.drop();
    await waitFor(() => expect(result.current.status).toBe("reconnecting"));

    await result.current.db.query(titles);
    await waitFor(() => expect(result.current.status).toBe("live"));
  });

  test("needs no provider when given a db", async () => {
    const peer = fakePeer();
    const client = Ramose.connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
    });
    const db = client.db("todos", Todos);
    try {
      const { result } = renderHook(() => useConnectionStatus(db));
      expect(result.current).toBe("connecting");
      await db.query(titles);
      await waitFor(() => expect(result.current).toBe("live"));
    } finally {
      await client.close();
    }
  });

  test("a hand-rolled ReadDb without a seam is offline", () => {
    const db = {
      name: "todos",
      schema: Todos,
    } as unknown as Ramose.ReadDb<typeof Todos>;
    const { result } = renderHook(() => useConnectionStatus(db));
    expect(result.current).toBe("offline");
  });

  test("client.close() is closed", async () => {
    const peer = fakePeer();
    const client = Ramose.connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
    });
    const db = client.db("todos", Todos);
    const { result } = renderHook(() => useConnectionStatus(db));
    await db.query(titles);
    await waitFor(() => expect(result.current).toBe("live"));
    await client.close();
    await waitFor(() => expect(result.current).toBe("closed"));
  });
});

describe("useConnectionStatus (provider-scoped)", () => {
  test("rolls up the nearest client's sessions", async () => {
    const peer = fakePeer();
    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return { db, status: useConnectionStatus() };
      },
      { wrapper: wrapperFor(peer) },
    );
    expect(result.current.status).toBe("connecting");
    await result.current.db.query(titles);
    await waitFor(() => expect(result.current.status).toBe("live"));
  });

  test("outside a provider it throws, and the message names RamoseProvider", () => {
    const noisy = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useConnectionStatus())).toThrow(
        /RamoseProvider/,
      );
    } finally {
      console.error = noisy;
    }
  });
});
