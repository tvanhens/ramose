/**
 * `layer` → `Databases` → `Db`: what the client sends, on which wire, and
 * what it refuses to do.
 *
 * The load-bearing claims here are the ones the design rests on:
 * `ramose.db(name, catalog)` is pure, writes are HTTPS and reads are not,
 * `dbAfter` carries the min-`t` floor with no second round trip, the token is
 * re-read per transact, and a provisioning mistake is a defect rather than a
 * `DbError`.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { DbError } from "../src/db/internal.ts";
import { pipe } from "effect/Function";
import { Databases, layer, Query, schemaTx, seedWrite } from "../src/db/internal.ts";
import {
  client,
  scriptedPeer,
  httpsClient,
  runWithTestClock,
  type Call,
} from "./peer.ts";

import { Movie, Movies, User } from "./db/fixture.ts";

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

/** The two queries these tests run; only the transport is under test. */
const names = Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name })));
const eids = Query.q(() => Query.entities(User));

const ack = (t = 7, txEid = 13194139533319, datoms = 3) => ({
  t,
  txEid,
  tempids: { "tmp-1": 1001 },
  datoms,
});

describe("ramose.db(name, catalog) is pure", () => {
  test("naming a database costs no request and opens no socket", async () => {
    const peer = scriptedPeer();
    const c = client(peer);

    const db = c.ramose.db("movies", Movies);
    const other = c.ramose.db("other", Movies);
    void db.asOf(3);
    void db.history;

    expect(peer.calls).toEqual([]);
    expect(peer.sockets).toEqual([]);
    expect(db.name).toBe("movies");
    expect(db.schema).toBe(Movies);
    expect(other.name).toBe("other");
    await c.dispose();
  });

  test("a consumer that only transacts never opens a socket", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack() }) });
    const { databases, close } = httpsClient(peer);

    await run(seedWrite(
      databases.db("movies", Movies), function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );

    expect(peer.calls).toHaveLength(1);
    expect(peer.sockets).toEqual([]);
    close();
  });

  describe("an invalid name fails every operation with InvalidRequest", () => {
    for (const [label, name] of [
      ["empty", ""],
      ["leading dash", "-bad"],
      ["a slash", "a/b"],
      ["65 characters", "a".repeat(65)],
      ["traversal", "../etc"],
    ] as const) {
      test(label, async () => {
        const peer = scriptedPeer();
        const c = client(peer);
        const db = c.ramose.db(name, Movies);

        const operations: Array<Effect.Effect<unknown, DbError> | Promise<unknown>> = [
          db.query(names),
          db.pull(1, { name: User.name }),
          db.install(),
          seedWrite(db, function* (tx) {
            yield* tx.delete(1);
          }),
        ];
        for (const eff of operations) {
          const e = await runFail(eff);
          expect(e._tag).toBe("InvalidRequest");
          expect(e.message).toContain(JSON.stringify(name));
        }
        // the name never reached the peer
        expect(peer.calls).toEqual([]);
        expect(peer.sockets).toEqual([]);
        await c.dispose();
      });
    }
  });
});

describe("writes are HTTPS, reads are not", () => {
  test("transact posts { tx } to /db/:name/transact and reports back", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack(7, 42, 3) }) });
    const c = client(peer);

    const report = await run(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
        yield* ada.set(User.age, 36);
      }),
    );

    expect(peer.calls[0].url).toBe("https://peer.example.com/db/movies/transact");
    expect(peer.calls[0].method).toBe("POST");
    expect(peer.calls[0].body.tx).toEqual([
      [":db/add", "tmp-1", ":ramose/type", ":user"],
      [":db/add", "tmp-1", ":user/name", "Ada"],
      [":db/add", "tmp-1", ":user/age", 36],
    ]);
    expect(typeof peer.calls[0].body.clientTxId).toBe("string");
    expect(report.t).toBe(7);
    expect(report.txEid as number).toEqual(42);
    expect(report.datomCount).toBe(3);
    await c.dispose();
  });

  test("reads take the session socket when there is one", async () => {
    const peer = scriptedPeer({
      answer: () => ({ body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } }),
    });
    const c = client(peer);

    expect(
      await run(c.ramose.db("movies", Movies).query(names)),
    ).toEqual([]);

    expect(peer.calls).toEqual([]);
    expect(peer.frames[0]).toEqual({
      id: 1,
      op: "sync",
      from: 0,
    });
    await c.dispose();
  });

  test("with no socket at all, reads fall back to POST /query and /pull", async () => {
    const peer = scriptedPeer({
      http: (call: Call) =>
        call.url.endsWith("/query")
          ? { body: { t: 2, root: 2, result: [[1001]] } }
          : { body: { t: 2, result: { name: "Ada" } } },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);

    const rows = await db.query(eids);
    expect(rows as readonly { id: number }[]).toEqual([{ id: 1001 }]);
    expect(await db.pull(rows[0]!, { name: User.name })).toEqual({
      name: "Ada",
    });

    expect(peer.calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/movies/query",
      "https://peer.example.com/db/movies/pull",
    ]);
    close();
  });
});

describe("dbAfter is the read fence", () => {
  test("reads through it carry x-ramose-min-t / the frame's minT; the original does not", async () => {
    const peer = scriptedPeer({
      http: () => ({ body: ack(30) }),
      answer: () => ({ body: { t: 30, root: 30, result: [] } }),
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    const { dbAfter } = await run(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );

    await run(dbAfter.query(names));
    await db.query(names);

    expect(peer.frameOps("q")).toEqual([]);
    expect(peer.frameOps("sync")).toHaveLength(1);
    await c.dispose();
  });

  test("over HTTPS the same floor is the header", async () => {
    const peer = scriptedPeer({
      http: (call) =>
        call.url.endsWith("/transact")
          ? { body: ack(30) }
          : { body: { t: 30, root: 30, result: [] } },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);

    const { dbAfter } = await run(
      seedWrite(db, function* (tx) {
        yield* tx.delete(1);
      }),
    );
    await run(dbAfter.query(names));
    await db.query(names);

    expect(peer.calls[1].headers["x-ramose-min-t"]).toBe("30");
    expect(peer.calls[2].headers["x-ramose-min-t"]).toBeUndefined();
    close();
  });

  test("dbAfter is a Db, so it transacts too — and cannot read the past", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack(11) }) });
    const c = client(peer);
    const { dbAfter } = await run(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        yield* tx.delete(1);
      }),
    );
    expect("transact" in dbAfter).toBe(false);
    expect("transact" in dbAfter.effect).toBe(false);
    expect(typeof dbAfter.install).toBe("function");
    expect(typeof dbAfter.run).toBe("function");
    // asOf / history are pure narrowings with no write half
    expect("transact" in dbAfter.asOf(3)).toBe(false);
    expect("transact" in dbAfter.history).toBe(false);
    await c.dispose();
  });
});

describe("install", () => {
  test("is the catalog as one ordinary transaction, and is idempotent", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack(2) }) });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    const first = await db.install();
    const second = await db.install();

    expect(first.t).toBe(2);
    expect(second.t).toBe(2);
    const txs = peer.calls.filter((call) => call.url.endsWith("/transact"));
    expect(txs.map((call) => call.url)).toEqual([
      "https://peer.example.com/db/movies/transact",
      "https://peer.example.com/db/movies/transact",
    ]);
    // the same upsert both times — `:db/ident` is unique/identity
    expect(txs[0]!.body.tx).toEqual(schemaTx(Movies));
    expect(txs[1]!.body.tx).toEqual(txs[0]!.body.tx);
    expect(typeof txs[0]!.body.clientTxId).toBe("string");
    await c.dispose();
  });
});

describe("the token", () => {
  test("is re-read on every transact, and rides the socket handshake", async () => {
    let issued = 0;
    const peer = scriptedPeer({
      http: () => ({ body: ack() }),
      answer: () => ({ body: { t: 1, root: 1, result: [] } }),
    });
    const c = client(peer, {
      token: Effect.sync(() => Redacted.make(`token-${++issued}`)),
    });
    const db = c.ramose.db("movies", Movies);

    await run(seedWrite(db, function* (tx) { yield* tx.delete(1); }));
    await run(seedWrite(db, function* (tx) { yield* tx.delete(2); }));
    await db.query(names);

    expect(peer.calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer token-2",
      "Bearer token-3",
    ]);
    // the first transact opens the overlay socket (sync), then POSTs
    expect(peer.sockets[0].url).toBe(
      "wss://peer.example.com/db/movies/session?token=token-1",
    );
    await c.dispose();
  });

  test("an empty token is no token", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack() }) });
    const c = client(peer, { token: Effect.succeed(Redacted.make("")) });
    await run(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        yield* tx.delete(1);
      }),
    );
    expect(peer.calls[0].headers.authorization).toBeUndefined();
    await c.dispose();
  });
});

describe("provisioning mistakes are defects", () => {
  test("a malformed url dies rather than failing with a DbError", async () => {
    const peer = scriptedPeer();
    const runtime = ManagedRuntime.make(
      layer({ url: "peer.example.com", fetch: peer.fetch }),
    );
    const exit = await runtime.runPromiseExit(Databases);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(false); // a defect, not an error
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(String(Cause.squash(exit.cause))).toContain("malformed url");
    }
    await runtime.dispose();
  });

  test("a good url survives a trailing slash", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack() }) });
    const c = client(peer, { url: "https://peer.example.com/" });
    await run(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        yield* tx.delete(1);
      }),
    );
    expect(peer.calls[0].url).toBe(
      "https://peer.example.com/db/movies/transact",
    );
    await c.dispose();
  });
});

describe("failures arrive tagged, not thrown", () => {
  const failing = (status: number, body: unknown) =>
    scriptedPeer({ http: () => ({ status, body }) });

  test("a rejected transaction is TxRejected", async () => {
    const peer = failing(409, {
      error: "unique conflict",
      tag: "TxRejected",
      code: "tx/unique-conflict",
    });
    const c = client(peer);
    const e = await runFail(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        yield* tx.delete(1);
      }),
    );
    expect(e._tag).toBe("TxRejected");
    expect(e.message).toBe("unique conflict");
    await c.dispose();
  });

  test("a platform 500 is retried over a fresh connection, then succeeds", async () => {
    // A workers.dev host that has not learned the route answers 500
    // "Worker not found." — often pinned to one pooled socket, so the retry
    // must carry `Connection: close` to dial a different edge server.
    let n = 0;
    const peer = scriptedPeer({
      http: () => {
        n++;
        return n === 1
          ? { status: 500, body: { error: "Worker not found." } }
          : { body: ack() };
      },
    });
    const c = client(peer);
    await run(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );
    expect(n).toBe(2);
    expect(peer.calls[0].headers.connection).toBeUndefined();
    expect(peer.calls[1].headers.connection).toBe("close");
    await c.dispose();
  });

  test("a platform error relayed over the session socket is retried too", async () => {
    // A read that took the socket must not lose the resilience the HTTPS
    // path has: the peer relays "Worker not found" from a Durable Object
    // namespace that has not converged yet, and the next frame is fine.
    let n = 0;
    const peer = scriptedPeer({
      answer: () => {
        n++;
        return n === 1
          ? { status: 500, body: { error: "Worker not found." } }
          : { body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } };
      },
    });
    const c = client(peer);
    expect(await run(c.ramose.db("movies", Movies).asOf(2).query(names))).toEqual([
      { name: "Ada" },
    ]);
    expect(n).toBe(2);
    expect(peer.frameOps("q")).toHaveLength(2);
    expect(peer.calls).toEqual([]);
    await c.dispose();
  });

  test("a dead transactor is Unavailable with its retry hint", async () => {
    const peer = failing(503, {
      error: "transactor aborted",
      tag: "TransactorDead",
      retryAfterMs: 500,
    });
    const { databases, close } = httpsClient(peer);
    const e = await runFail(
      runWithTestClock(
        seedWrite(databases.db("movies", Movies), function* (tx) {
          yield* tx.delete(1);
        }),
      ),
    );
    expect(e._tag).toBe("Unavailable");
    if (e._tag === "Unavailable") expect(e.retryAfterMs).toBe(500);
    expect(peer.calls).toHaveLength(6);
    close();
  });

  test("a transport failure is NetworkError and keeps its cause", async () => {
    const boom = new Error("connect ECONNREFUSED");
    let attempts = 0;
    const { databases, close } = httpsClient({
      fetch: (() => {
        attempts++;
        return Promise.reject(boom);
      }) as unknown as typeof fetch,
    });
    const e = await runFail(
      runWithTestClock(
        seedWrite(databases.db("movies", Movies), function* (tx) {
          yield* tx.delete(1);
        }),
      ),
    );
    expect(e._tag).toBe("NetworkError");
    if (e._tag === "NetworkError") expect(e.cause).toBe(boom);
    expect(attempts).toBe(6);
    close();
  });

  test("a non-JSON error body still classifies by status", async () => {
    const peer = scriptedPeer();
    const c = client(peer, {
      fetch: (async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
        })) as unknown as typeof fetch,
    });
    const e = await runFail(c.ramose.db("movies", Movies).install());
    expect(e._tag).toBe("InternalError");
    expect(e.message).toBe("<html>502 Bad Gateway</html>");
    await c.dispose();
  });

  test("a body failure aborts before anything is sent", async () => {
    const peer = scriptedPeer({ http: () => ({ body: ack() }) });
    const c = client(peer);
    const e = await runFail(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
        return yield* Effect.fail("nope" as const);
      }),
    );
    expect(e).toBe("nope");
    expect(peer.calls).toEqual([]);
    await c.dispose();
  });
});

describe("the JSON transport", () => {
  test("Dates, byte arrays and uuids survive the round trip", async () => {
    const when = new Date("2026-08-16T00:00:00.000Z");
    const peer = scriptedPeer({
      http: () => ({ body: ack() }),
      answer: (frame) => ({
        body: {
          t: 1,
          root: 1,
          // echo the where-clause constants back as the relation
          result: [
            [(frame.query as { where: unknown[][] }).where[0][2]],
            [{ $uuid: "3F333DF6-90A4-4FDA-8DD3-9485D27CEE36" }],
          ],
        },
      }),
    });
    const c = client(peer);

    const rows: readonly unknown[] = await run(
      c.ramose
        .db("movies", Movies)
        .asOf(1)
        .query(Query.q(() => pipe(Query.entities(Movie), Query.is(Movie.released, when)))),
    );

    // on the wire: tagged, JSON-safe (pinned views still ride the socket)
    expect(peer.frameOps("q")[0].query).toEqual({
      find: ["?q0"],
      where: [["?q0", ":movie/released", { $inst: when.getTime() }]],
    });
    // back off the wire: the original types
    expect(rows[0]).toBeInstanceOf(Date);
    expect(rows[1]).toBe("3f333df6-90a4-4fda-8dd3-9485d27cee36");
    await c.dispose();
  });
});

describe("live needs the socket", () => {
  test("without one it is a defect, not a hung stream", async () => {
    const peer = scriptedPeer();
    const { databases, close } = httpsClient(peer);
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        databases
          .db("movies", Movies)
          .effect.live(names),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(String(Cause.squash(exit.cause))).toContain("db.live needs the session socket");
    }
    close();
  });

  test("a pinned view does not, so asOf still emits once over HTTPS", async () => {
    const peer = scriptedPeer({
      http: () => ({ body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } }),
    });
    const { databases, close } = httpsClient(peer);
    const rows = await Effect.runPromise(
      Stream.runCollect(
        databases.db("movies", Movies).asOf(1).effect.live(names),
      ),
    );
    expect(rows).toEqual([[{ name: "Ada" }]]);
    close();
  });
});
