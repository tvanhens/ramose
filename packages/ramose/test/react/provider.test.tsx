/**
 * The provider contract:
 *
 * - `useRamose` outside a provider throws, and the message says what to do.
 * - `useDb` identity is stable across renders and changes with `name`.
 * - A provider prop change closes the old client (the fake peer records the
 *   close on the session socket the old client had opened).
 * - StrictMode's mount → close → mount ends with an open client.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import * as Ramose from "../../src/db/index.ts";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import { type ReactNode, StrictMode, useEffect } from "react";
import { render, renderHook, waitFor } from "@testing-library/react";
import { fakePeer, type FakePeer } from "./peer.ts";
import { RamoseProvider, useDb, useRamose } from "../../src/react/index.ts";

// imports are hoisted, so this runs after them but before any test renders —
// which is enough: nothing above touches `document` at import time. The
// unregister keeps happy-dom's globals out of the rest of the bun test run;
// the guard keeps this file indifferent to which hook test file ran before.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
});
const Todos = Ramose.Catalog({ todo: Todo });
const titles = Ramose.Query.q(() =>
  pipe(Ramose.Query.entities(Todo), Ramose.Query.select({ title: Todo.title })),
);

const providerProps = (peer: FakePeer, url = "https://peer.example.com") => ({
  url,
  fetch: peer.fetch,
  webSocket: peer.webSocket,
});

/** Runs one read per `db`, so the client opens its session socket. */
const ReadOnce = () => {
  const db = useDb("todos", Todos);
  useEffect(() => {
    // a q on a closed client rejects (StrictMode's churn) — that is the
    // provider's job to recover from, not this probe's job to observe
    db.q(titles).catch(() => {});
  }, [db]);
  return null;
};

describe("useRamose", () => {
  test("outside a provider it throws, and the message names RamoseProvider", () => {
    const noisy = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useRamose())).toThrow(/RamoseProvider/);
      expect(() => renderHook(() => useRamose())).toThrow(/useRamose/);
    } finally {
      console.error = noisy;
    }
  });
});

describe("useDb", () => {
  test("identity is stable across renders, and changes with name", () => {
    const peer = fakePeer();
    const wrapper = ({ children }: { children?: ReactNode }) => (
      <RamoseProvider {...providerProps(peer)}>{children}</RamoseProvider>
    );

    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useDb(name, Todos),
      { wrapper, initialProps: { name: "todos" } },
    );

    const first = result.current;
    rerender({ name: "todos" });
    expect(result.current).toBe(first);

    rerender({ name: "other" });
    expect(result.current).not.toBe(first);
  });
});

describe("RamoseProvider", () => {
  test("a prop change closes the old client and connects the new one", async () => {
    const peer = fakePeer();
    const ui = (url: string) => (
      <RamoseProvider {...providerProps(peer, url)}>
        <ReadOnce />
      </RamoseProvider>
    );

    const { rerender } = render(ui("https://a.example.com"));
    await waitFor(() => expect(peer.sockets.length).toBe(1));
    expect(peer.sockets[0]!.url).toContain("a.example.com");
    expect(peer.sockets[0]!.closed).toBe(false);

    rerender(ui("https://b.example.com"));
    await waitFor(() => expect(peer.sockets[0]!.closed).toBe(true));
    await waitFor(() => expect(peer.sockets.length).toBe(2));
    expect(peer.sockets[1]!.url).toContain("b.example.com");
    expect(peer.sockets[1]!.closed).toBe(false);
  });

  test("a token identity change closes the old client too", async () => {
    const peer = fakePeer();
    const ui = (source: Ramose.TokenSource) => (
      <RamoseProvider {...providerProps(peer)} token={source}>
        <ReadOnce />
      </RamoseProvider>
    );

    const { rerender } = render(ui(Ramose.token.static("a")));
    await waitFor(() => expect(peer.sockets.length).toBe(1));
    expect(peer.sockets[0]!.url).toContain("token=a");

    rerender(ui(Ramose.token.static("b")));
    await waitFor(() => expect(peer.sockets[0]!.closed).toBe(true));
    await waitFor(() => expect(peer.sockets.length).toBe(2));
    expect(peer.sockets[1]!.url).toContain("token=b");
    expect(peer.sockets[1]!.closed).toBe(false);
  });

  test("unmount closes the client", async () => {
    const peer = fakePeer();
    const { unmount } = render(
      <RamoseProvider {...providerProps(peer)}>
        <ReadOnce />
      </RamoseProvider>,
    );
    await waitFor(() => expect(peer.sockets.length).toBe(1));

    unmount();
    expect(peer.sockets[0]!.closed).toBe(true);
  });

  test("StrictMode double-mount ends with an open client", async () => {
    const peer = fakePeer();
    const seen: Ramose.Client[] = [];
    const Probe = () => {
      const client = useRamose();
      if (seen[seen.length - 1] !== client) seen.push(client);
      return <ReadOnce />;
    };

    render(
      <StrictMode>
        <RamoseProvider {...providerProps(peer)}>
          <Probe />
        </RamoseProvider>
      </StrictMode>,
    );

    // the client the tree ended with answers a read — the proof it is open,
    // because a read on a closed client fails rather than falling back
    await waitFor(async () => {
      const client = seen[seen.length - 1]!;
      const rows = await client.db("todos", Todos).q(titles);
      expect(rows).toEqual([]);
    });

    // and the StrictMode churn left exactly one live socket behind
    await waitFor(() =>
      expect(peer.sockets.filter((s) => !s.closed).length).toBe(1),
    );
  });
});
