/**
 * Typed schema surface against a fake `fetch` (request shapes) and an
 * in-process Connection peer (real create → ensure → transact → q → pull).
 */

import { describe, expect, test } from "bun:test";
import {
  Connection,
  QueryBudgetError,
  QueryError,
  QueryParseError,
  TxError,
  fromJson,
  pull,
  query,
  toJson,
} from "@ripple/core";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { FetchLike } from "../../src/Client.ts";
import { makeSystem as makeUntypedSystem, systemSource } from "../../src/Client.ts";
import {
  Eid,
  MissingPeer,
  SchemaEnsureError,
  fromReadWrite,
  fromWrite,
  isEid,
  makeReadSystemClient,
  makeSystem,
  makeWriteSystemClient,
  schemaTx,
  unsafeDatabase,
} from "../../src/schema/index.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(RuntimeContext.phantom)));

const runFail = <A, E>(eff: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(
    Effect.flip(eff).pipe(Effect.provide(RuntimeContext.phantom)),
  );

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const recorder = (
  reply: (call: Call) => {
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  },
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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** In-process peer: Connection per db name, same routes the untyped client speaks. */
const inProcessPeer = () => {
  const conns = new Map<string, Connection>();
  const connOf = async (name: string) => {
    let c = conns.get(name);
    if (!c) {
      c = await Connection.create();
      conns.set(name, c);
    }
    return c;
  };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/health") {
      return json({ ok: true, service: "ripple", stage: "test", time: Date.now() });
    }
    const m = /^\/db\/([^/]+)(\/.*)$/.exec(u.pathname);
    if (!m) return json({ error: "not found" }, 404);
    const name = decodeURIComponent(m[1]);
    const rest = m[2];
    const conn = await connOf(name);
    const body =
      init.body === undefined ? undefined : fromJson(JSON.parse(init.body));
    try {
      if (rest === "/transact" && init.method === "POST") {
        const tx = (body as { tx: unknown[] }).tx;
        const rep = await conn.transact(tx);
        return json({
          t: rep.t,
          txEid: rep.txEid,
          tempids: rep.tempids,
          datoms: rep.txData.length,
        });
      }
      if (rest === "/query" && init.method === "POST") {
        const b = body as {
          query: unknown;
          inputs?: unknown[];
          asOf?: number;
          history?: boolean;
        };
        let db = conn.db();
        if (typeof b.asOf === "number") db = db.asOf(b.asOf);
        if (b.history) db = db.history();
        const result = await query(db, b.query as object, b.inputs ?? []);
        return json(
          { t: db.effectiveT, root: db.effectiveT, result },
          200,
          { "x-ripple-basis-t": String(db.effectiveT) },
        );
      }
      if (rest === "/pull" && init.method === "POST") {
        const b = body as {
          eid: number | string | [string, unknown];
          pattern: unknown;
          asOf?: number;
          history?: boolean;
        };
        let db = conn.db();
        if (typeof b.asOf === "number") db = db.asOf(b.asOf);
        if (b.history) db = db.history();
        const eid =
          typeof b.eid === "number" ? b.eid : await db.entid(b.eid as never);
        if (eid === undefined) return json({ t: db.effectiveT, result: null });
        return json({ t: db.effectiveT, result: await pull(db, eid, b.pattern as never) });
      }
      if (rest === "/info" && init.method === "GET") {
        return json({ db: name, transactor: { t: conn.t } });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof TxError) {
        return json({ error: err.message, tag: "TxRejected", code: err.code }, 409);
      }
      if (err instanceof QueryBudgetError) {
        return json(
          {
            error: err.message,
            code: err.code,
            clause: err.clause,
            cells: err.cells,
            limit: err.limit,
          },
          413,
        );
      }
      if (err instanceof QueryParseError || err instanceof QueryError) {
        return json({ error: err.message }, 400);
      }
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
  return { fetch, conns };
};

/**
 * The same peer, with reads served from a basis pinned at `staleT` unless the
 * request's `x-ripple-min-t` asks for a newer one — which is what the real peer
 * does with the fence (`fetchBasisWithStats` in packages/worker/src/peer.ts).
 */
const fencedPeer = (staleT: number) => {
  const { fetch: inner, conns } = inProcessPeer();
  const fetch: FetchLike = (url, init) => {
    const fence = Number(init.headers["x-ripple-min-t"] ?? 0);
    const read = /\/(query|pull)$/.test(new URL(url).pathname);
    if (!read || init.body === undefined || fence > staleT) return inner(url, init);
    const body = { ...(JSON.parse(init.body) as object), asOf: staleT };
    return inner(url, { ...init, body: JSON.stringify(body) });
  };
  return { fetch, conns };
};

describe("request shapes (fake fetch)", () => {
  test("create validates the name before any request", async () => {
    const { calls, fetch } = recorder(() => ({ body: {} }));
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const e = await runFail(system.create("BAD NAME", Movies));
    expect(e._tag).toBe("BadRequest");
    expect(calls).toHaveLength(0);
  });

  test("create posts schemaTx as its own transact, then transact/q/pull hit the peer", async () => {
    const { calls, fetch } = recorder((call) => {
      if (call.url.endsWith("/transact")) {
        return { body: { t: 2, txEid: 1, tempids: { "tmp-1": 1001 }, datoms: 4 } };
      }
      if (call.url.endsWith("/query")) {
        return { body: { t: 2, root: 2, result: [[1001, "Ada"]] } };
      }
      if (call.url.endsWith("/pull")) {
        return { body: { t: 2, result: { name: "Ada", age: 36, friends: [] } } };
      }
      if (call.url.endsWith("/info")) {
        return { body: { db: "movies" } };
      }
      if (call.url.endsWith("/health")) {
        return { body: { ok: true, service: "ripple", stage: "dev", time: 1 } };
      }
      return { body: {} };
    });
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const db = await run(system.create("movies", Movies));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://peer.example.com/db/movies/transact");
    expect(calls[0].body).toEqual({ tx: schemaTx(Movies) });

    const ack = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        yield* ada.add(User.age, 36);
        yield* ada.add(Meta.source, "import");
      }),
    );
    expect(ack.t).toBe(2);
    expect(ack.tempids["tmp-1"]).toBe(1001);
    expect(calls[1].body).toEqual({
      tx: [
        [":db/add", "tmp-1", ":user/name", "Ada"],
        [":db/add", "tmp-1", ":user/age", 36],
        [":db/add", "tmp-1", ":meta/source", "import"],
      ],
    });

    const rows = await run(
      db.q((q) => q.where("?e", User.name, "?n").find("?e", "?n")),
    );
    expect(isEid(rows[0][0])).toBe(true);
    expect(rows[0][0].id).toBe(1001);
    expect(rows[0][1]).toBe("Ada");
    expect(calls[2].url).toBe("https://peer.example.com/db/movies/query");
    expect(calls[2].body).toEqual({
      query: { find: ["?e", "?n"], where: [["?e", ":user/name", "?n"]] },
      inputs: [],
    });

    const pulled = await run(
      rows[0][0].pull({
        name: User.name,
        age: User.age.optional,
        friends: User.friends.with({ name: User.name }),
      }),
    );
    expect(pulled).toEqual({ name: "Ada", age: 36, friends: [] });
    expect(calls[3].url).toBe("https://peer.example.com/db/movies/pull");
    expect(calls[3].body).toEqual({
      eid: 1001,
      pattern: [
        { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
        { kind: "attr", attr: ":user/age", reverse: false, as: "age" },
        {
          kind: "attr",
          attr: ":user/friends",
          reverse: false,
          as: "friends",
          sub: [{ kind: "attr", attr: ":user/name", reverse: false, as: "name" }],
        },
      ],
    });

    expect(await run(db.info())).toEqual({ db: "movies" });
    expect((await run(db.health())).ok).toBe(true);
    expect((await run(system.health())).ok).toBe(true);
  });

  test("eid.pull carries the read fence to the pull request's headers", async () => {
    const { calls, fetch } = recorder((call) =>
      call.url.endsWith("/query")
        ? { body: { t: 2, root: 2, result: [[1001]] } }
        : { body: { t: 2, txEid: 1, tempids: {}, datoms: 4, result: { name: "Ada" } } },
    );
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const db = await run(system.create("movies", Movies));
    const rows = await run(db.q((q) => q.where("?e", User.name, "?n").find("?e")));
    calls.length = 0;

    await run(rows[0][0].pull({ name: User.name }, { minT: 42 }));
    await run(rows[0][0].pull({ name: User.name }));

    expect(calls[0].url).toBe("https://peer.example.com/db/movies/pull");
    expect(calls[0].headers["x-ripple-min-t"]).toBe("42");
    expect(calls[1].headers["x-ripple-min-t"]).toBeUndefined();
  });

  test("ensure failure is SchemaEnsureError, not the raw DatabaseError", async () => {
    const { fetch } = recorder(() => ({
      status: 409,
      body: { error: "unique conflict", tag: "TxRejected", code: "tx/unique-conflict" },
    }));
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const e = await runFail(system.create("movies", Movies));
    expect(e._tag).toBe("SchemaEnsureError");
    expect(e).toBeInstanceOf(SchemaEnsureError);
    expect(e.message).toBe("unique conflict");
  });

  test("asOf / history pin the query body; transactWire / untyped submit as-is", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 3, txEid: 1, tempids: {}, datoms: 1, root: 3, result: [] },
    }));
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const db = await run(system.create("movies", Movies));
    calls.length = 0;

    await run(db.asOf(2).q((q) => q.where("?e", User.name, "?n").find("?n")));
    await run(db.history().q((q) => q.where("?e", User.name, "?n").find("?n")));
    expect(calls[0].body).toEqual({
      query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] },
      inputs: [],
      asOf: 2,
    });
    expect(calls[1].body).toEqual({
      query: { find: ["?n"], where: [["?e", ":user/name", "?n"]] },
      inputs: [],
      history: true,
    });

    await run(db.transactWire([{ ":user/name": "Ada" }]));
    await run(db.transactUntyped([{ ":user/name": "Bob" }]));
    expect(calls[2].body).toEqual({ tx: [{ ":user/name": "Ada" }] });
    expect(calls[3].body).toEqual({ tx: [{ ":user/name": "Bob" }] });
  });

  test("privilege: read has q and skips ensure; write has transact", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 1, txEid: 1, tempids: {}, datoms: 0, result: [], root: 1 },
    }));
    const source = systemSource({ url: "https://peer.example.com", fetch });
    const read = makeReadSystemClient(source);
    const write = makeWriteSystemClient(source);
    const r = await run(read.create("movies", Movies));
    expect("transact" in r).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/transact"))).toHaveLength(0);
    await run(r.q((q) => q.where("?e", User.name, "?n").find("?n")));

    const w = await run(write.create("movies", Movies));
    expect("q" in w).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/transact")).length).toBeGreaterThan(0);
    await run(
      w.transact(function* (tx) {
        const e = yield* tx.entity();
        yield* e.add(User.name, "Ada");
      }),
    );
  });

  test("fromReadWrite / fromWrite ensure the catalog", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 1, txEid: 1, tempids: {}, datoms: 0, result: [], root: 1 },
    }));
    const untyped = makeUntypedSystem({ url: "https://peer.example.com", fetch });
    const rw = fromReadWrite(untyped);
    const db = await run(rw.create("movies", Movies));
    expect(db.catalog).toBe(Movies);
    expect(calls.filter((c) => c.url.endsWith("/transact"))).toHaveLength(1);

    const write = fromWrite(untyped);
    await run(write.create("movies", Movies));
    expect(calls.filter((c) => c.url.endsWith("/transact"))).toHaveLength(2);
  });
});

describe("in-process peer", () => {
  test("create → gen transact → q Eid → pull :as / nested, asOf, history, catchTags", async () => {
    const { fetch } = inProcessPeer();
    const system = makeSystem({ url: "https://peer.local", fetch });
    const db = await run(system.create("movies", Movies));

    const ack = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        yield* ada.add(User.age, 36);
        yield* ada.add(Meta.source, "import");

        const alonzo = yield* tx.entity();
        yield* alonzo.add(User.name, "Alonzo");
        yield* alonzo.add(User.age, 40);
        yield* ada.add(User.friends, alonzo.id as never);
        yield* ada.add(User.bestFriend, alonzo.id as never);

        const arrival = yield* tx.entity();
        yield* arrival.add(Movie.title, "Arrival");
        yield* arrival.add(Movie.year, 2016);
      }),
    );
    expect(ack.t).toBeGreaterThan(1);

    const rows = await run(
      db.q((q) =>
        q.where("?e", User.name, "?n").options({ minT: ack.t }).find("?e", "?n"),
      ),
    );
    const adaRow = rows.find((r) => r[1] === "Ada");
    expect(adaRow).toBeDefined();
    expect(isEid(adaRow![0])).toBe(true);

    const pulled = await run(
      adaRow![0].pull({
        name: User.name,
        age: User.age.optional,
        source: Meta.source,
        bestFriend: User.bestFriend.optional.with({
          name: User.name,
          age: User.age.optional,
        }),
        friends: User.friends.with({
          name: User.name,
          age: User.age.optional,
        }),
      }),
    );
    expect(pulled).not.toBeNull();
    expect(pulled!.name).toBe("Ada");
    expect(pulled!.age).toBe(36);
    expect(pulled!.source).toBe("import");
    expect(pulled!.bestFriend?.name).toBe("Alonzo");
    expect(pulled!.friends.map((f) => f.name)).toEqual(["Alonzo"]);

    const requiredOnly = await run(adaRow![0].pull({ name: User.name }));
    expect(requiredOnly).toEqual({ name: "Ada" });

    const soup = await run(adaRow![0].pull([User.name, User.age] as const));
    expect(soup![":user/name"]).toBe("Ada");
    expect(soup![":user/age"]).toBe(36);

    const before = db.asOf(ack.t - 1);
    const pastRows = await run(
      before.q((q) => q.where("?e", User.name, "?n").find("?e")),
    );
    expect(pastRows).toEqual([]);

    const hist = db.history();
    const histRows = await run(
      hist.q((q) => q.where("?e", User.name, "Ada").find("?e")),
    );
    expect(histRows.length).toBeGreaterThanOrEqual(1);
    expect(isEid(histRows[0][0])).toBe(true);

    const friendRows = await run(
      db.q((q) => q.where("?e", User.friends, "?f").find("?f")),
    );
    expect(isEid(friendRows[0][0])).toBe(true);
    expect(friendRows[0][0].id).toBeGreaterThan(0);

    const viaEffect = await run(
      db.transact((tx) =>
        Effect.gen(function* () {
          const e = yield* tx.entity([User.name, "Ada"]);
          yield* e.add(User.age, 37);
        }),
      ),
    );
    expect(viaEffect.t).toBeGreaterThan(ack.t);

    const after = await run(adaRow![0].pull({ age: User.age }));
    expect(after!.age).toBe(37);

    const caught = await run(
      db.transactUntyped([[":db/add", 1, ":user/nope", "x"]]).pipe(
        Effect.catchTags({
          TxRejected: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          TransactorDead: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          BadRequest: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          NotFound: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          Unauthorized: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          QueryBudgetExceeded: (e) =>
            Effect.succeed({ error: e._tag, message: e.message }),
          Internal: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          NetworkError: (e) => Effect.succeed({ error: e._tag, message: e.message }),
        }),
      ),
    );
    expect("error" in caught ? caught.error : undefined).toBe("TxRejected");

    const opened = await run(
      system.create("nope!", Movies).pipe(
        Effect.catchTags({
          BadRequest: (e) => Effect.succeed({ error: e._tag, message: e.message }),
          SchemaEnsureError: (e) =>
            Effect.succeed({ error: e._tag, message: e.message }),
        }),
      ),
    );
    expect(opened).toEqual(
      expect.objectContaining({ error: "BadRequest" }),
    );

    const health = await run(system.health());
    expect(health.ok).toBe(true);
    expect((await run(db.info())).db).toBe("movies");
  });

  test("minT fences pull: a stale basis misses the write, the fence sees it", async () => {
    const { fetch, conns } = inProcessPeer();
    const system = makeSystem({ url: "https://peer.local", fetch });
    const db = await run(system.create("movies", Movies));
    const ack = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );

    // rebuild the client on a peer whose reads are pinned behind that write
    const stale = fencedPeer(ack.t - 1);
    stale.conns.set("movies", conns.get("movies")!);
    const fenced = await run(
      makeSystem({ url: "https://peer.local", fetch: stale.fetch }).connect(
        "movies",
        Movies,
      ),
    );
    const rows = await run(
      fenced.q((q) =>
        q.where("?e", User.name, "?n").options({ minT: ack.t }).find("?e"),
      ),
    );
    const ada = rows[0][0];

    expect(await run(ada.pull({ name: User.name }))).toBeNull();
    expect(await run(ada.pull({ name: User.name }, { minT: ack.t }))).toEqual({
      name: "Ada",
    });
  });

  test("connect re-ensures (ident upsert) and can read what create wrote", async () => {
    const { fetch } = inProcessPeer();
    const system = makeSystem({ url: "https://peer.local", fetch });
    const a = await run(system.create("movies", Movies));
    await run(
      a.transact(function* (tx) {
        const e = yield* tx.entity();
        yield* e.add(User.name, "Ada");
      }),
    );
    const b = await run(system.connect("movies", Movies));
    const rows = await run(
      b.q((q) => q.where("?e", User.name, "?n").find("?n")),
    );
    expect(rows).toEqual([["Ada"]]);
  });
});

describe("pull required vs optional (in-process)", () => {
  test("required missing → null; optional missing → undefined; nested many filters; required nested missing → parent null", async () => {
    const { fetch } = inProcessPeer();
    const system = makeSystem({ url: "https://peer.local", fetch });
    const db = await run(system.create("movies", Movies));

    await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");

        const alonzo = yield* tx.entity();
        yield* alonzo.add(User.name, "Alonzo");
        yield* ada.add(User.friends, alonzo.id as never);

        const ghost = yield* tx.entity();
        yield* ghost.add(User.age, 1);
        yield* ada.add(User.friends, ghost.id as never);
      }),
    );

    const rows = await run(
      db.q((q) => q.where("?e", User.name, "Ada").find("?e")),
    );
    const ada = rows[0][0];
    expect(isEid(ada)).toBe(true);

    const requiredAge = await run(ada.pull({ name: User.name, age: User.age }));
    expect(requiredAge).toBeNull();

    const optionalAge = await run(
      ada.pull({ name: User.name, age: User.age.optional }),
    );
    expect(optionalAge).toEqual({ name: "Ada", age: undefined });

    const friends = await run(
      ada.pull({
        name: User.name,
        friends: User.friends.with({ name: User.name }),
      }),
    );
    expect(friends).not.toBeNull();
    expect(friends!.friends.map((f) => f.name)).toEqual(["Alonzo"]);

    const requiredBest = await run(
      ada.pull({
        name: User.name,
        bestFriend: User.bestFriend.with({ name: User.name }),
      }),
    );
    expect(requiredBest).toBeNull();

    const optionalBest = await run(
      ada.pull({
        name: User.name,
        bestFriend: User.bestFriend.optional.with({ name: User.name }),
      }),
    );
    expect(optionalBest).toEqual({ name: "Ada", bestFriend: undefined });
  });
});

describe("effect honesty", () => {
  test("Eid.of without pullFn fails MissingPeer", async () => {
    const e = await runFail(Eid.of(Movies, 1001).pull({ name: User.name }));
    expect(e._tag).toBe("MissingPeer");
    expect(e).toBeInstanceOf(MissingPeer);
  });

  test("unsafeDatabase without a peer fails MissingPeer", async () => {
    const db = unsafeDatabase(Movies);
    const e = await runFail(
      db.q((q) => q.where("?e", User.name, "?n").find("?n")),
    );
    expect(e._tag).toBe("MissingPeer");
  });

  test("generator transact propagates yielded failures and does not submit", async () => {
    class Extra extends Data.TaggedError("Extra")<{
      readonly message: string;
    }> {}
    const { fetch } = inProcessPeer();
    const system = makeSystem({ url: "https://peer.local", fetch });
    const db = await run(system.create("movies", Movies));
    const e = await runFail(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        return yield* Effect.fail(new Extra({ message: "nope" }));
      }),
    );
    expect(e._tag).toBe("Extra");
    const rows = await run(
      db.q((q) => q.where("?e", User.name, "?n").find("?n")),
    );
    expect(rows).toEqual([]);
  });

  test("transactWire rejects unknown idents before the peer", async () => {
    const { calls, fetch } = recorder(() => ({
      body: { t: 1, txEid: 1, tempids: {}, datoms: 0 },
    }));
    const system = makeSystem({ url: "https://peer.example.com", fetch });
    const db = await run(system.create("movies", Movies));
    calls.length = 0;
    const e = await runFail(
      db.transactWire([{ ":user/nope": "x" }] as never),
    );
    expect(e._tag).toBe("BadRequest");
    expect(calls).toHaveLength(0);
  });
});
