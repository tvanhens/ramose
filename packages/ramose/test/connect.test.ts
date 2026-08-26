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
import { pipe } from "effect/Function";
import {
  connect,
  NetworkError,
  Operation,
  OperationsCoverageError,
  Query,
  Unauthorized,
  defineOperations,
  seedWrite,
} from "../src/db/internal.ts";
import * as Schema from "effect/Schema";
import { scriptedPeer, httpsClient, type ScriptedPeer } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;
const runFail = async <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<any> => {
  if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value));
  try {
    await value;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
};

const names = Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name })));

const ramose = (peer: ScriptedPeer) =>
  connect({
    url: "https://peer.example.com",
    fetch: peer.fetch,
    webSocket: peer.webSocket,
  });

describe("connect().db() is layer's client, without the runtime", () => {
  test("reads take the socket and writes take HTTPS, exactly as layer does", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } }),
      http: () => ({
        body: { t: 7, txEid: 42, tempids: { "tmp-1": 1001 }, datoms: 2 },
      }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);

    expect(await db.query(names)).toEqual([]);
    expect(peer.calls).toEqual([]);
    expect(peer.frames[0]).toEqual({
      id: 1,
      op: "sync",
      from: 0,
    });

    const report = await run(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );
    expect(peer.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://peer.example.com/db/movies/transact",
    ]);
    expect(report.t).toBe(7);
    await c.close();
  });

  test("db is pure: naming a database costs no request and opens no socket", async () => {
    const peer = scriptedPeer();
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
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);

    await run(c.db("movies", Movies).query(names));
    await run(c.db("other", Movies).query(names));
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
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);

    const doomed = runFail(c.db("movies", Movies).query(names));
    await c.close();

    expect((await doomed)._tag).toBe("NetworkError");
    expect(peer.sockets).toEqual([]);
  });

  test("a read after close fails — it does not fall back to POST", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);
    await db.query(names);

    await c.close();

    const onKnownName = await runFail(db.query(names));
    expect(onKnownName._tag).toBe("NetworkError");
    // a name first read after the close fails the same way
    const onFreshName = await runFail(c.db("fresh", Movies).query(names));
    expect(onFreshName._tag).toBe("NetworkError");
    expect(peer.calls).toEqual([]);
  });
});

describe("the promise / subscription surface", () => {
  test("a refused handshake rejects with Unauthorized, not NetworkError", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
      refuseUpgrades: 99,
      http: () => ({ status: 401, body: { error: "token expired" } }),
    });
    const c = connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      token: "stale",
    });
    try {
      await c.db("movies", Movies).query(names);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized)._tag).toBe("Unauthorized");
      expect((error as Unauthorized).name).toBe("Unauthorized");
      expect((error as Unauthorized).status).toBe(401);
      expect((error as { constructor?: { name?: string } }).constructor?.name).not.toBe(
        "FiberFailure",
      );
    }
    await c.close();
  });

  test("a failed q rejects with the tagged error, not a FiberFailure", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);
    await db.query(names);
    await c.close();
    try {
      await db.query(names);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError)._tag).toBe("NetworkError");
      expect((error as NetworkError).name).toBe("NetworkError");
      expect((error as { name?: string }).name).not.toBe("FiberFailure");
      expect((error as { constructor?: { name?: string } }).constructor?.name).not.toBe(
        "FiberFailure",
      );
    }
  });

  test("db.live is a subscription handle — subscribe / async iterate / close", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    const live = c.db("movies", Movies).live(names);
    expect(typeof live.subscribe).toBe("function");
    expect(typeof live.close).toBe("function");
    expect(typeof live[Symbol.asyncIterator]).toBe("function");
    expect("pipe" in live).toBe(false);

    const first = await new Promise<readonly { name: string }[]>((resolve, reject) => {
      live.subscribe(resolve, reject);
    });
    expect(first).toEqual([]);
    live.close();
    await c.close();
  });

  test("db.live close() stops emissions; for-await ends; onError is tagged", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    const db = c.db("movies", Movies);

    const live = db.live(names);
    const seen: unknown[] = [];
    live.subscribe((rows) => seen.push(rows));
    await Bun.sleep(20);
    expect(seen.length).toBe(1);
    live.close();
    peer.push({ op: "tx", t: 2, datoms: [] });
    await Bun.sleep(20);
    expect(seen.length).toBe(1);

    const iterate = db.live(names);
    const walked: unknown[] = [];
    const done = (async () => {
      for await (const rows of iterate) walked.push(rows);
    })();
    await Bun.sleep(20);
    iterate.close();
    await done;
    expect(walked.length).toBe(1);
    await c.close();
  });
});

describe("provisioning mistakes throw synchronously", () => {
  test("a malformed token object is a defect, not a silent anonymous connect", () => {
    const peer = scriptedPeer();
    expect(() =>
      connect({
        url: "https://peer.example.com",
        fetch: peer.fetch,
        token: { token: async () => "x" } as never,
      }),
    ).toThrow(/token must be/);
    expect(peer.calls).toEqual([]);
  });

  test("a malformed url throws from connect itself, before any request", () => {
    const peer = scriptedPeer();
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

describe("connect().checkOperations()", () => {
  const createUser = Operation(
    "user/create",
    { input: Schema.Struct({}), output: Schema.Struct({}) },
    () => ({}),
  );
  const setName = Operation(
    "user/set-name",
    { input: Schema.Struct({ name: Schema.String }), output: Schema.Struct({}) },
    () => ({}),
  );
  const operations = defineOperations(Movies, { createUser, setName });

  test("is a no-op when connect was not given a registry", async () => {
    const peer = scriptedPeer();
    const c = ramose(peer);
    await c.checkOperations();
    expect(peer.calls).toEqual([]);
    await c.close();
  });

  test("passes when /health lists every client-shipped id", async () => {
    const peer = scriptedPeer({
      http: () => ({
        body: { ok: true, operations: ["user/create", "user/set-name"] },
      }),
    });
    const c = connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      operations,
    });
    await c.checkOperations();
    expect(peer.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://peer.example.com/health",
    ]);
    await c.close();
  });

  test("fails with OperationsCoverageError when an id is missing", async () => {
    const peer = scriptedPeer({
      http: () => ({ body: { ok: true, operations: ["user/create"] } }),
    });
    const c = connect({
      url: "https://peer.example.com",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      operations,
    });
    const error = await runFail(c.checkOperations());
    expect(error).toBeInstanceOf(OperationsCoverageError);
    expect((error as OperationsCoverageError).missing).toEqual(["user/set-name"]);
    await c.close();
  });
});

describe("connectionStatus", () => {
  test("is connecting before a socket, live after a read, reconnecting after a drop", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = ramose(peer);
    expect(c.connectionStatus()).toBe("connecting");
    expect(c.connectionStatus("movies")).toBe("connecting");

    await c.db("movies", Movies).query(names);
    expect(c.connectionStatus()).toBe("live");
    expect(c.connectionStatus("movies")).toBe("live");
    expect(c.connectionStatus("other")).toBe("connecting");

    const seen: string[] = [];
    const off = c.onConnectionStatus((status) => {
      seen.push(status);
    }, "movies");
    peer.drop();
    await Bun.sleep(10);
    expect(c.connectionStatus("movies")).toBe("reconnecting");
    expect(seen).toContain("reconnecting");

    await c.db("movies", Movies).query(names);
    expect(c.connectionStatus("movies")).toBe("live");

    await c.close();
    expect(c.connectionStatus()).toBe("closed");
    off();
  });

  test("an HTTPS-only client is offline", () => {
    const { connectionStatus, close } = httpsClient(scriptedPeer());
    expect(connectionStatus()).toBe("offline");
    expect(connectionStatus("movies")).toBe("offline");
    close();
  });
});
