/**
 * The Effect-native clients against a fake `fetch`: request shapes, headers,
 * the `@ripple/core` JSON transport in both directions, failures arriving as
 * tagged errors rather than thrown `Response`s — and the system client, whose
 * `create` / `connect` scope all of that to one `/db/:name` without a request.
 *
 * `RuntimeContext.phantom` is what satisfies the `RuntimeContext` requirement
 * every client method carries (it exists so the Binding/Http layers can read
 * bound Outputs at runtime; a client built from concrete values never touches
 * it).
 */

import { describe, expect, test } from "bun:test";
import { ValueTag } from "@ripple/core";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "../src/Client.ts";
import type { FetchLike } from "../src/Client.ts";
import type { DatabaseError } from "../src/DatabaseTypes.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that records what it was asked and answers with a canned reply. */
const recorder = (
  reply: (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> },
) => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const r = reply(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { calls, fetch };
};

const run = <A>(eff: Effect.Effect<A, DatabaseError, RuntimeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(RuntimeContext.phantom)));

const runFail = <A>(eff: Effect.Effect<A, DatabaseError, RuntimeContext>) =>
  Effect.runPromise(
    Effect.flip(eff).pipe(Effect.provide(RuntimeContext.phantom)),
  );

describe("routes and headers", () => {
  test("transact posts { tx } to /db/:name/transact and returns the ack", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 7, txEid: 13194139533319, tempids: { ada: 17 }, datoms: 3 },
    }));
    const db = Client.make({ url: "https://peer.example.com/", name: "movies", fetch });

    const ack = await run(db.transact([{ ":user/name": "Ada" }]));

    expect(calls[0].url).toBe("https://peer.example.com/db/movies/transact");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ tx: [{ ":user/name": "Ada" }] });
    expect(ack).toEqual({ t: 7, txEid: 13194139533319, tempids: { ada: 17 }, datoms: 3 });
  });

  test("a bearer token is sent when configured, and not when it is empty", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    await run(
      Client.make({
        url: "https://peer.example.com",
        name: "movies",
        token: Redacted.make("s3cret"),
        fetch,
      }).q("[:find ?e :where [?e :db/ident _]]"),
    );
    await run(Client.make({ url: "https://peer.example.com", name: "movies", token: "", fetch }).q("[]"));

    expect(calls[0].headers.authorization).toBe("Bearer s3cret");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  test("the db name is percent-encoded into the path", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    await run(Client.make({ url: "https://peer.example.com", name: "a.b-c_1", fetch }).info());
    expect(calls[0].url).toBe("https://peer.example.com/db/a.b-c_1/info");
  });

  test("health is peer-level, not database-scoped", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { ok: true, service: "ripple", stage: "dev", time: 1 },
    }));
    const health = await run(
      Client.make({ url: "https://peer.example.com", name: "movies", fetch }).health(),
    );
    expect(calls[0].url).toBe("https://peer.example.com/health");
    expect(health.ok).toBe(true);
  });

  test("extra headers ride along on every request", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    await run(
      Client.make({
        url: "https://peer.example.com",
        name: "movies",
        headers: { "x-ripple-replica-hint": "enam" },
        fetch,
      }).info(),
    );
    expect(calls[0].headers["x-ripple-replica-hint"]).toBe("enam");
  });
});

describe("reads", () => {
  test("q returns just the relation; query keeps t/root/explain and the meta headers", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 42, root: 9, result: [["Ada"]], explain: [{ clause: 0 }] },
      headers: {
        "x-ripple-ms": "3",
        "x-ripple-r2-gets": "0",
        "x-ripple-cache-hits": "2",
        "x-ripple-colo": "IAD",
        "x-ripple-replica-hint": "enam",
        "x-ripple-basis-t": "42",
        "x-ripple-basis-hit": "1",
        "x-ripple-basis-reason": "cached",
      },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });

    expect(await run(db.q<string[][]>("[:find ?n :where [?e :user/name ?n]]"))).toEqual([["Ada"]]);

    const r = await run(db.query("[:find ?n :where [?e :user/name ?n]]", [], { explain: true }));
    expect(r.t).toBe(42);
    expect(r.root).toBe(9);
    expect(r.explain).toEqual([{ clause: 0 }]);
    expect(r.meta).toEqual({
      ms: 3,
      r2Gets: 0,
      cacheHits: 2,
      colo: "IAD",
      replicaHint: "enam",
      basisT: 42,
      basisHit: true,
      basisReason: "cached",
      basisBehind: false,
    });
    expect(calls[1].body).toEqual({
      query: "[:find ?n :where [?e :user/name ?n]]",
      inputs: [],
      explain: true,
    });
  });

  test("minT becomes the x-ripple-min-t read fence", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    await run(db.q("[]", [], { minT: 42 }));
    await run(db.q("[]"));
    expect(calls[0].headers["x-ripple-min-t"]).toBe("42");
    expect(calls[1].headers["x-ripple-min-t"]).toBeUndefined();
  });

  test("pull and entity take the same read fence", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, result: null, entity: null } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    await run(db.pull(17, "[*]", { minT: 42 }));
    await run(db.pull(17, "[*]"));
    await run(db.entity(17, { minT: 42 }));
    await run(db.entity(17));
    expect(calls[0].headers["x-ripple-min-t"]).toBe("42");
    expect(calls[1].headers["x-ripple-min-t"]).toBeUndefined();
    expect(calls[2].headers["x-ripple-min-t"]).toBe("42");
    expect(calls[3].headers["x-ripple-min-t"]).toBeUndefined();
    // the fence is a header, never a body field
    expect(calls[0].body).toEqual({ eid: 17, pattern: "[*]" });
  });

  test("pull unwraps `result`", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, result: { ":user/name": "Ada" } } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    expect(await run(db.pull<Record<string, unknown>>(17, "[*]"))).toEqual({ ":user/name": "Ada" });
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/pull");
    expect(calls[0].body).toEqual({ eid: 17, pattern: "[*]" });
  });

  test("entity unwraps `entity`, and a null entity is undefined", async () => {
    const { calls, fetch } = recorder((call) => ({
      body: { t: 1, entity: call.url.endsWith("/99") ? null : { ":user/name": "Ada" } },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    expect(await run(db.entity(17))).toEqual({ ":user/name": "Ada" });
    expect(await run(db.entity(99))).toBeUndefined();
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/entity/17");
    expect(calls[0].method).toBe("GET");
  });

  test("info returns the raw report", async () => {
    const { fetch } = recorder(() => ({ body: { db: "movies", transactor: { t: 5 } } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    expect(await run(db.info())).toEqual({ db: "movies", transactor: { t: 5 } });
  });
});

describe("asOf / history views", () => {
  test("asOf pins the body's asOf and the entity query string", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [], entity: {} } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });

    await run(db.asOf(42).q("[]"));
    await run(db.asOf(42).entity(17));
    await run(db.asOf(42).pull(17, "[*]"));

    expect(calls[0].body).toEqual({ query: "[]", inputs: [], asOf: 42 });
    expect(calls[1].url).toBe("https://peer.example.com/db/movies/entity/17?asOf=42");
    expect(calls[2].body).toEqual({ eid: 17, pattern: "[*]", asOf: 42 });
  });

  test("history sets history: true and composes with asOf", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });

    await run(db.history().q("[]"));
    await run(db.asOf(7).history().q("[]"));

    expect(calls[0].body).toEqual({ query: "[]", inputs: [], history: true });
    expect(calls[1].body).toEqual({ query: "[]", inputs: [], asOf: 7, history: true });
  });

  test("a view does not mutate the client it came from", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const past = db.asOf(1);
    await run(db.q("[]"));
    await run(past.q("[]"));
    expect(calls[0].body).toEqual({ query: "[]", inputs: [] });
    expect(calls[1].body).toEqual({ query: "[]", inputs: [], asOf: 1 });
  });
});

describe("JSON transport", () => {
  test("Dates, byte arrays and uuids survive the round trip", async () => {
    // The fake peer echoes the query inputs back as the result, so what comes
    // out of `fromJson` is exactly what `toJson` put on the wire.
    const { calls, fetch } = recorder((call) => ({
      body: { t: 1, root: 0, result: (call.body as { inputs: unknown[] }).inputs },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const when = new Date("2026-08-16T00:00:00.000Z");
    const bytes = new Uint8Array([0, 1, 250]);

    const echoed = await run(
      db.q<unknown[]>("[:find ?e :in $ ?at ?blob :where [?e ?at ?blob]]", [when, bytes]),
    );

    // on the wire: tagged, JSON-safe
    expect(calls[0].body).toEqual({
      query: "[:find ?e :in $ ?at ?blob :where [?e ?at ?blob]]",
      inputs: [{ $inst: when.getTime() }, { $bytes: "AAH6" }],
    });
    // back off the wire: the original types
    expect(echoed[0]).toBeInstanceOf(Date);
    expect((echoed[0] as Date).getTime()).toBe(when.getTime());
    expect(echoed[1]).toBeInstanceOf(Uint8Array);
    expect([...(echoed[1] as Uint8Array)]).toEqual([0, 1, 250]);
  });

  test("a uuid-tagged value decodes back to its tagged form", async () => {
    const { fetch } = recorder(() => ({
      body: { t: 1, root: 0, result: [{ $uuid: "3F333DF6-90A4-4FDA-8DD3-9485D27CEE36" }] },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const [uuid] = await run(db.q<Record<string, unknown>[]>("[]"));
    expect(uuid).toEqual({ vt: ValueTag.Uuid, v: "3f333df6-90a4-4fda-8dd3-9485d27cee36" });
  });
});

describe("failures", () => {
  test("a rejected transaction fails with TxRejected, not a thrown Response", async () => {
    const { fetch } = recorder(() => ({
      status: 409,
      body: { error: "unique conflict", tag: "TxRejected", code: "tx/unique-conflict" },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const e = await runFail(db.transact([{ ":user/email": "ada@example.com" }]));
    expect(e._tag).toBe("TxRejected");
    expect(e.message).toBe("unique conflict");
  });

  test("a dead transactor fails with TransactorDead and its retry hint", async () => {
    const { fetch } = recorder(() => ({
      status: 503,
      body: { error: "transactor aborted", tag: "TransactorDead", retryAfterMs: 500 },
      headers: { "retry-after": "1" },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const e = await runFail(db.transact([]));
    expect(e._tag).toBe("TransactorDead");
    if (e._tag === "TransactorDead") expect(e.retryAfterMs).toBe(500);
  });

  test("a blown query budget fails with QueryBudgetExceeded", async () => {
    const { fetch } = recorder(() => ({
      status: 413,
      body: { error: "budget", code: "query/budget-exceeded", clause: "[?e ?a ?v]", cells: 9, limit: 8 },
    }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    const e = await runFail(db.q("[:find ?e ?a ?v :where [?e ?a ?v]]"));
    expect(e._tag).toBe("QueryBudgetExceeded");
    if (e._tag === "QueryBudgetExceeded") expect(e.limit).toBe(8);
  });

  test("a missing bearer token fails with Unauthorized", async () => {
    const { fetch } = recorder(() => ({ status: 401, body: { error: "unauthorized" } }));
    const db = Client.make({ url: "https://peer.example.com", name: "movies", fetch });
    expect((await runFail(db.info()))._tag).toBe("Unauthorized");
  });

  test("a transport failure fails with NetworkError and keeps the cause", async () => {
    const boom = new Error("connect ECONNREFUSED");
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: () => Promise.reject(boom),
    });
    const e = await runFail(db.info());
    expect(e._tag).toBe("NetworkError");
    if (e._tag === "NetworkError") expect(e.cause).toBe(boom);
  });

  test("a non-JSON error body still classifies by status", async () => {
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    const e = await runFail(db.info());
    expect(e._tag).toBe("Internal");
    expect(e.message).toBe("<html>502 Bad Gateway</html>");
  });
});


describe("system client (create / connect)", () => {
  const peer = (fetch: FetchLike) =>
    Client.makeSystem({
      url: "https://peer.example.com/",
      token: Redacted.make("s3cret"),
      headers: { "x-ripple-replica-hint": "enam" },
      fetch,
    });

  test("create scopes every route to /db/:name — and costs no request itself", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 1, root: 0, result: [], entity: { ":user/name": "Ada" } },
    }));
    const system = peer(fetch);

    const movies = await Effect.runPromise(system.create("movies"));
    // opening a database is arithmetic on a path: nothing has been sent yet
    expect(calls).toHaveLength(0);

    await run(movies.transact([{ ":user/name": "Ada" }]));
    await run(movies.q("[]"));
    await run(movies.entity(17));

    expect(calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/movies/transact",
      "https://peer.example.com/db/movies/query",
      "https://peer.example.com/db/movies/entity/17",
    ]);
  });

  test("connect is create — the same function, and the same requests", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    const system = peer(fetch);
    expect(system.connect).toBe(system.create);

    await run((await Effect.runPromise(system.create("movies"))).info());
    await run((await Effect.runPromise(system.connect("movies"))).info());

    expect(calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/movies/info",
      "https://peer.example.com/db/movies/info",
    ]);
  });

  test("every database shares the peer's fetch, token and headers", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    const system = peer(fetch);

    const a = await Effect.runPromise(system.create("a"));
    const b = await Effect.runPromise(system.create("b"));
    await run(a.info());
    await run(b.info());

    // one recorder saw both: `create` reuses the very same FetchLike object
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/a/info",
      "https://peer.example.com/db/b/info",
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer s3cret");
      expect(call.headers["x-ripple-replica-hint"]).toBe("enam");
    }
  });

  test("a valid name survives percent-encoding unchanged", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    await run((await Effect.runPromise(peer(fetch).create("a.b-c_1"))).info());
    expect(calls[0].url).toBe("https://peer.example.com/db/a.b-c_1/info");
  });

  describe("an invalid name fails the Effect with BadRequest", () => {
    for (const [label, name] of [
      ["empty", ""],
      ["leading dash", "-bad"],
      ["a slash", "a/b"],
      ["65 characters", "a".repeat(65)],
      ["traversal", "../etc"],
    ] as const) {
      test(label, async () => {
        const { calls, fetch } = recorder(() => ({ body: {} }));
        const system = peer(fetch);

        for (const eff of [system.create(name), system.connect(name)]) {
          const e = await runFail(eff);
          expect(e._tag).toBe("BadRequest");
          expect(e.message).toContain(JSON.stringify(name));
        }
        // the name never reached the peer
        expect(calls).toHaveLength(0);
      });
    }
  });

  test("the database it hands back composes with asOf / history", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    const movies = await Effect.runPromise(peer(fetch).create("movies"));

    await run(movies.asOf(7).q("[]"));
    await run(movies.history().pull(17, "[*]"));

    expect(calls[0].url).toBe("https://peer.example.com/db/movies/query");
    expect(calls[0].body).toEqual({ query: "[]", inputs: [], asOf: 7 });
    expect(calls[1].url).toBe("https://peer.example.com/db/movies/pull");
    expect(calls[1].body).toEqual({ eid: 17, pattern: "[*]", history: true });
  });

  test("privilege follows the system: the read half cannot transact, the write half cannot query", async () => {
    const { calls, fetch } = recorder(() => ({ body: { t: 1, root: 0, result: [] } }));
    const source = Client.systemSource({ url: "https://peer.example.com", fetch });

    const read = await Effect.runPromise(
      Client.makeReadSystemClient(source).create("movies"),
    );
    const write = await Effect.runPromise(
      Client.makeWriteSystemClient(source).create("movies"),
    );

    expect("transact" in read).toBe(false);
    expect("q" in write).toBe(false);

    await run(read.q("[]"));
    await run(write.transact([]));
    expect(calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/movies/query",
      "https://peer.example.com/db/movies/transact",
    ]);
  });

  test("health is the peer's, not a database's", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { ok: true, service: "ripple", stage: "dev", time: 1 },
    }));
    const health = await run(peer(fetch).health());
    expect(calls[0].url).toBe("https://peer.example.com/health");
    expect(calls[0].url).not.toContain("/db/");
    expect(health.ok).toBe(true);
  });
});
