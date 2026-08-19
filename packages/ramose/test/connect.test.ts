/**
 * `connect` — the promise-land handle over the factory `layer` uses.
 *
 * The claims worth pinning: `connect().db()` is the same client `layer`
 * builds (reads ride the socket, writes are HTTPS), `close()` closes the
 * recorded sockets and is idempotent, a read after `close()` fails rather
 * than falling back to POST, and a provisioning mistake throws synchronously
 * from `connect` — the same defect `layer` dies with.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { connect, query } from "../src/db/internal.ts";
import { fakePeer, type FakePeer } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runFail = <A, E>(eff: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(eff));

const names = query(User).select({ name: User.name });

const ramose = (peer: FakePeer) =>
  connect({
    url: "https://peer.example.com",
    fetch: peer.fetch,
    webSocket: peer.webSocket,
  });

describe("connect().db() is layer's client, without the runtime", () => {
  test("reads take the socket and writes take HTTPS, exactly as layer does", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } }),
      http: () => ({
        body: { t: 7, txEid: 42, tempids: { "tmp-1": 1001 }, datoms: 2 },
      }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);

    expect(await run(db.q(names))).toEqual([{ name: "Ada" }]);
    expect(peer.calls).toEqual([]);
    expect(peer.frames[0]).toEqual({
      id: 1,
      op: "q",
      query: expect.anything(),
      inputs: [],
    });

    const report = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );
    expect(peer.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://peer.example.com/db/movies/transact",
    ]);
    expect(report.t).toBe(7);
    await c.close();
  });

  test("db is pure: naming a database costs no request and opens no socket", async () => {
    const peer = fakePeer();
    const c = ramose(peer);

    const db = c.db("movies", Movies);
    void c.db("other", Movies);
    void db.asOf(3);
    void db.history;

    expect(peer.calls).toEqual([]);
    expect(peer.sockets).toEqual([]);
    await c.close();
  });
});

describe("close()", () => {
  test("closes every recorded socket, and closing twice is a no-op", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);

    await run(c.db("movies", Movies).q(names));
    await run(c.db("other", Movies).q(names));
    expect(peer.sockets.map((s) => s.closed)).toEqual([false, false]);

    await c.close();
    expect(peer.sockets.map((s) => s.closed)).toEqual([true, true]);

    await c.close();
    expect(peer.sockets).toHaveLength(2);
    expect(peer.sockets.map((s) => s.closed)).toEqual([true, true]);
  });

  test("close during the first read's connect opens no socket at all", async () => {
    // React StrictMode's mount → close → mount closes the client while the
    // first read's socket connect is still resolving its token/url; the
    // in-flight open must lose, or the socket leaks with no handle to close
    const peer = fakePeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);

    const doomed = runFail(c.db("movies", Movies).q(names));
    await c.close();

    expect((await doomed)._tag).toBe("NetworkError");
    expect(peer.sockets).toEqual([]);
  });

  test("a read after close fails — it does not fall back to POST", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);
    await run(db.q(names));

    await c.close();

    const onKnownName = await runFail(db.q(names));
    expect(onKnownName._tag).toBe("NetworkError");
    // a name first read after the close fails the same way
    const onFreshName = await runFail(c.db("fresh", Movies).q(names));
    expect(onFreshName._tag).toBe("NetworkError");
    expect(peer.calls).toEqual([]);
  });
});

describe("provisioning mistakes throw synchronously", () => {
  test("a malformed url throws from connect itself, before any request", () => {
    const peer = fakePeer();
    expect(() =>
      connect({ url: "peer.example.com", fetch: peer.fetch }),
    ).toThrow(/malformed url/);
    expect(peer.calls).toEqual([]);
    expect(peer.sockets).toEqual([]);
  });

  test("no fetch at all throws, and the message names connect", () => {
    const ambient = globalThis.fetch;
    // `typeof fetch` is "undefined" when the binding holds undefined
    globalThis.fetch = undefined as unknown as typeof fetch;
    try {
      expect(() => connect({ url: "https://peer.example.com" })).toThrow(
        /no global fetch.*Ramose\.connect/,
      );
    } finally {
      globalThis.fetch = ambient;
    }
  });
});
