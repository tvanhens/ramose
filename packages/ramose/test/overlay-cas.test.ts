/**
 * Overlay remapping for `:db/cas` — queued tx tuples, invocation.entity,
 * and invocation.input must all rewrite acknowledged named tempids before
 * post / `/op`.
 */

import { describe, expect, test } from "bun:test";
import { Connection } from "../src/internal/core/conn.ts";
import { Index, toWireDatom, type WireDatom } from "../src/internal/core/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import {
  Operation,
  Query,
  TxRejected,
  seedWrite,
  tempid,
} from "../src/db/internal.ts";
import { buildOp, runBody } from "../src/db/op-handle.ts";
import { client, scriptedPeer, settle } from "./peer.ts";
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
const ages = Query.q(() =>
  pipe(Query.entities(User), Query.select({ name: User.name, age: User.age })),
);

const collect = <A, E>(stream: Stream.Stream<A, E>) => {
  const seen: A[] = [];
  let error: unknown;
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (a) => Effect.sync(() => seen.push(a))).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          error = Cause.squash(cause);
        }),
      ),
    ),
  );
  return {
    seen,
    get error() {
      return error;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const snapshotOf = async (conn: Connection): Promise<{ t: number; datoms: WireDatom[] }> => {
  const datoms: WireDatom[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return { t: conn.t, datoms };
};

const moviesWorld = async () => {
  const conn = await Connection.create();
  await conn.transact([
    { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
    { ":db/ident": ":user/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/ident": ":user/friends", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
    { ":db/ident": ":user/bestFriend", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/ident": ":movie/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
    { ":db/ident": ":movie/year", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/ident": ":movie/released", ":db/valueType": ":db.type/instant", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/ident": ":meta/source", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  ]);
  return conn;
};

const seedClient = async (
  peer: { socket: { push: (f: unknown) => void } },
  db: { query: (q: typeof names) => Effect.Effect<unknown, unknown> | Promise<unknown> },
  conn: Connection,
) => {
  await db.query(names);
  const snap = await snapshotOf(conn);
  peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
  await settle();
  return snap;
};

const infoBody = (t: number) => ({
  db: "movies",
  t,
  principal: { eid: null, class: "admin" },
});

/** Re-run an operation body from the posted `/op` invocation — real peer path. */
const rerunPostedOp = async (
  operation: Parameters<typeof runBody>[0],
  body: {
    readonly input: unknown;
    readonly entity?: unknown;
    readonly tempids?: Readonly<Record<string, number>>;
  },
  server: Connection,
) => {
  const built = buildOp({
    schema: Movies,
    db: "movies",
    principal: { eid: null, class: "admin", claims: {} },
    self: body.entity,
    effects: "run",
    resolvedTempids: body.tempids,
    q: () => Effect.succeed([]),
    pull: () => Effect.succeed(null),
  });
  await Effect.runPromise(
    runBody(operation, built.op, body.input, { resolved: body.tempids }),
  );
  return server.transact([...built.ops()]);
};

describe("overlay CAS remapping", () => {
  test("queued rewrite remaps a CAS tempid subject to the server eid", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        if (posts.length === 0) await gate;
        posts.push(call.body.tx as unknown[]);
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.cas(User.age, null, 42);
      }),
    );
    await settle();
    release();
    await first;
    await second;
    expect(posts).toHaveLength(2);
    const casOps = (posts[1] ?? []).filter(
      (op): op is unknown[] => Array.isArray(op) && op[0] === ":db/cas",
    );
    expect(casOps).toHaveLength(1);
    expect(typeof casOps[0]![1]).toBe("number");
    const eid = casOps[0]![1] as number;
    const row = await server.db().entity(eid);
    expect(row![":user/name"]).toBe("Ada");
    expect(row![":user/age"]).toBe(42);
    const nameAttr = server.db().attr(":user/name")!.id;
    const named = await server.db().datomsArray(Index.AVET, { a: nameAttr });
    expect(named.filter((d) => d.op).map((d) => d.e)).toEqual([eid]);
    await c.dispose();
  });

  test("queued rewrite remaps a CAS ref replacement tempid to the server eid", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        if (posts.length === 0) await gate;
        posts.push(call.body.tx as unknown[]);
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity(tx.tempid("new"));
        yield* ada.set(User.name, "Ada");
        const e = yield* tx.entity();
        yield* e.set(User.name, "Bea");
        yield* e.cas(User.bestFriend, null, tx.tempid("new"));
      }),
    );
    await settle();
    release();
    await first;
    await second;
    expect(posts).toHaveLength(2);
    const casOps = (posts[1] ?? []).filter(
      (op): op is unknown[] =>
        Array.isArray(op) && op[0] === ":db/cas" && op[2] === ":user/bestFriend",
    );
    expect(casOps).toHaveLength(1);
    expect(casOps[0]![3]).toBeNull();
    expect(typeof casOps[0]![4]).toBe("number");
    const friend = casOps[0]![4] as number;
    expect((await server.db().entity(friend))![":user/name"]).toBe("Ada");
    const bea = await server.db().entid([":user/name", "Bea"]);
    expect((await server.db().entity(bea!))![":user/bestFriend"]).toBe(friend);
    await c.dispose();
  });

  test("ackedNamed does not rewrite a later unrelated tempid(\"new\") after the queue drains", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        if (posts.length === 0) await gate;
        posts.push(call.body.tx as unknown[]);
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.cas(User.age, null, 42);
      }),
    );
    await settle();
    release();
    await first;
    await second;
    expect(posts).toHaveLength(2);
    const adaEid = (await server.db().entid([":user/name", "Ada"]))!;
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(42);

    await server.transact([[":db/add", adaEid, ":user/age", 31]]);

    const third = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Bea");
        yield* tx.cas(adaEid, User.age, 31, 32);
      }),
    );
    expect(third.t).toBeGreaterThan(0);
    expect(posts).toHaveLength(3);
    const thirdTx = posts[2] ?? [];
    const beaAdds = thirdTx.filter(
      (op): op is unknown[] =>
        Array.isArray(op) && op[0] === ":db/add" && op[2] === ":user/name" && op[3] === "Bea",
    );
    expect(beaAdds).toHaveLength(1);
    expect(beaAdds[0]![1]).toBe("new");

    expect((await server.db().entity(adaEid))![":user/name"]).toBe("Ada");
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(32);
    const beaEid = await server.db().entid([":user/name", "Bea"]);
    expect(beaEid).toBeDefined();
    expect(beaEid).not.toBe(adaEid);

    await c.dispose();
  });

  test("in-flight no-layer post still rewrites a named tempid after the earlier ack", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const adaEid = seeded.tempids.u!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        if (posts.length === 0) await gate;
        posts.push(call.body.tx as unknown[]);
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await server.transact([[":db/add", adaEid, ":user/age", 31]]);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Cal");
      }),
    );
    await settle();
    const second = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Bea");
        yield* tx.cas(adaEid, User.age, 31, 32);
      }),
    );
    await settle();
    release();
    await first;
    await second;
    expect(posts).toHaveLength(2);
    const secondTx = posts[1] ?? [];
    const beaAdds = secondTx.filter(
      (op): op is unknown[] =>
        Array.isArray(op) && op[0] === ":db/add" && op[2] === ":user/name" && op[3] === "Bea",
    );
    expect(beaAdds).toHaveLength(1);
    expect(typeof beaAdds[0]![1]).toBe("number");
    expect(beaAdds[0]![1]).not.toBe(adaEid);
    expect(beaAdds[0]![1]).not.toBe("new");

    expect((await server.db().entity(adaEid))![":user/name"]).toBe("Ada");
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(32);
    const beaEid = await server.db().entid([":user/name", "Bea"]);
    expect(beaEid).toBeDefined();
    expect(beaEid).not.toBe(adaEid);
    expect(await server.db().entid([":user/name", "Cal"])).toBeUndefined();

    await c.dispose();
  });

  test("resync after a named-tempid ack does not keep the mapping if nothing is queued", async () => {
    const server = await moviesWorld();
    const posts: unknown[][] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posts.push(call.body.tx as unknown[]);
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
        yield* e.set(User.age, 30);
      }),
    );
    const adaEid = (await server.db().entid([":user/name", "Ada"]))!;
    const snap = await snapshotOf(server);
    peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();

    await server.transact([[":db/add", adaEid, ":user/age", 31]]);

    await Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Bea");
        yield* tx.cas(adaEid, User.age, 31, 32);
      }),
    );
    expect((await server.db().entity(adaEid))![":user/name"]).toBe("Ada");
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(32);
    const beaEid = await server.db().entid([":user/name", "Bea"]);
    expect(beaEid).toBeDefined();
    expect(beaEid).not.toBe(adaEid);

    await c.dispose();
  });

  test("stale replica CAS still POSTs and succeeds without optimistic paint", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let posted = 0;
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posted += 1;
        await gate;
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await server.transact([[":db/add", eid, ":user/age", 31]]);

    const live = collect(db.effect.live(ages));
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada", age: 30 }]);

    const write = Effect.runPromise(
      seedWrite(db, function* (tx) {
        yield* tx.cas(eid, User.age, 31, 32);
      }),
    );
    await settle();
    expect(posted).toBe(1);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada", age: 30 }]);

    release();
    await write;
    await settle();
    expect((await server.db().entity(eid))![":user/age"]).toBe(32);
    const snap = await snapshotOf(server);
    peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();
    expect(await run(db.query(ages))).toEqual([{ name: "Ada", age: 32 }]);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada", age: 32 }]);

    await live.stop();
    await c.dispose();
  });

  test("CAS-only on a server-only numeric eid still POSTs", async () => {
    const server = await moviesWorld();
    let posted = 0;
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posted += 1;
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;

    const report = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        yield* tx.cas(eid, User.age, 30, 31);
      }),
    );
    expect(posted).toBe(1);
    expect(report.t).toBeGreaterThan(0);
    expect((await server.db().entity(eid))![":user/age"]).toBe(31);

    await c.dispose();
  });

  test("CAS-only on a server-only lookup subject still POSTs", async () => {
    const server = await moviesWorld();
    let posted = 0;
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posted += 1;
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;

    const report = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        yield* tx.cas([":user/name", "Ada"], User.age, 30, 31);
      }),
    );
    expect(posted).toBe(1);
    expect(report.t).toBeGreaterThan(0);
    expect((await server.db().entity(eid))![":user/age"]).toBe(31);

    await c.dispose();
  });

  test("CAS ref replacement of a server-only eid still POSTs", async () => {
    const server = await moviesWorld();
    const ada = await server.transact([{ ":db/id": "a", ":user/name": "Ada" }]);
    const adaEid = ada.tempids.a!;
    let posted = 0;
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posted += 1;
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const bea = await server.transact([{ ":db/id": "b", ":user/name": "Bea" }]);
    const beaEid = bea.tempids.b!;

    const report = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        yield* tx.cas(adaEid, User.bestFriend, null, beaEid);
      }),
    );
    expect(posted).toBe(1);
    expect(report.t).toBeGreaterThan(0);
    expect((await server.db().entity(adaEid))![":user/bestFriend"]).toBe(beaEid);

    await c.dispose();
  });

  test("genuine CAS conflict still POSTs and fails without leftover overlay", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;
    let posted = 0;
    const peer = scriptedPeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posted += 1;
        try {
          const rep = await server.transact(call.body.tx);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientTxId: call.body.clientTxId,
            },
          };
        } catch (err) {
          const code = err instanceof Error && "code" in err ? String((err as { code: string }).code) : "tx/rejected";
          return {
            status: 409,
            body: { error: (err as Error).message, tag: "TxRejected", code },
          };
        }
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(ages));
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada", age: 30 }]);

    const err = await runFail(
      seedWrite(db, function* (tx) {
        yield* tx.cas(eid, User.age, 99, 32);
      }),
    );
    await settle();
    expect(posted).toBe(1);
    expect(err).toBeInstanceOf(TxRejected);
    expect((err as TxRejected).code).toBe("tx/cas-conflict");
    expect((await server.db().entity(eid))![":user/age"]).toBe(30);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada", age: 30 }]);
    expect(await run(db.query(ages))).toEqual([{ name: "Ada", age: 30 }]);

    await live.stop();
    await c.dispose();
  });
});

describe("overlay CAS /op remapping", () => {
  const casViaInput = Operation(
    "user/cas-via-input",
    {
      input: Schema.Struct({
        target: Schema.Union([Schema.String, Schema.Finite]),
        title: Schema.optional(Schema.String),
      }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.cas(op.tempid(input.target as string), User.age, null, 42);
      return {};
    },
  );

  const nestedCasViaInput = Operation(
    "user/cas-via-nested-input",
    {
      input: Schema.Struct({
        nested: Schema.Struct({
          target: Schema.Union([Schema.String, Schema.Finite]),
        }),
      }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.cas(op.tempid(input.nested.target as string), User.age, null, 7);
      return {};
    },
  );

  test("queued /op remaps a named tempid inside invocation.input used by op.cas(op.tempid)", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opBodies: Record<string, unknown>[] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (call.url.endsWith("/transact")) {
          await gate;
          const rep = await server.transact(call.body.tx);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientTxId: call.body.clientTxId,
            },
          };
        }
        if (call.url.endsWith("/op")) {
          opBodies.push(call.body);
          const rep = await rerunPostedOp(casViaInput, call.body, server);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientOpId: call.body.clientOpId,
              output: {},
            },
          };
        }
        return { body: { t: server.t } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = db.run(casViaInput, { target: "new", title: "new" });
    await settle();
    expect(opBodies).toHaveLength(0);

    release();
    await first;
    await second;
    expect(opBodies).toHaveLength(1);
    const posted = opBodies[0]!;
    const input = posted.input as { target: unknown; title?: unknown };
    expect(typeof input.target).toBe("number");
    expect(input.target).not.toBe("new");
    expect(input.title).toBe("new");
    const postedTempids = posted.tempids as Record<string, number> | undefined;
    expect(postedTempids?.new).toBe(input.target);

    const adaEid = await server.db().entid([":user/name", "Ada"]);
    expect(adaEid).toBe(input.target);
    expect((await server.db().entity(adaEid!))![":user/age"]).toBe(42);
    const nameAttr = server.db().attr(":user/name")!.id;
    const named = await server.db().datomsArray(Index.AVET, { a: nameAttr });
    expect(named.filter((d) => d.op).map((d) => d.e)).toEqual([adaEid]);

    await c.dispose();
  });

  test("queued /op remaps a nested input tempid used by op.cas(op.tempid)", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opBodies: Record<string, unknown>[] = [];
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (call.url.endsWith("/transact")) {
          await gate;
          const rep = await server.transact(call.body.tx);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientTxId: call.body.clientTxId,
            },
          };
        }
        if (call.url.endsWith("/op")) {
          opBodies.push(call.body);
          const rep = await rerunPostedOp(nestedCasViaInput, call.body, server);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientOpId: call.body.clientOpId,
              output: {},
            },
          };
        }
        return { body: { t: server.t } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = db.run(nestedCasViaInput, { nested: { target: "new" } });
    await settle();
    release();
    await first;
    await second;
    const input = opBodies[0]!.input as { nested: { target: unknown } };
    expect(typeof input.nested.target).toBe("number");
    const adaEid = await server.db().entid([":user/name", "Ada"]);
    expect(input.nested.target).toBe(adaEid);
    expect((await server.db().entity(adaEid!))![":user/age"]).toBe(7);

    await c.dispose();
  });

  test("no-layer run rewrites a queued contextual entity after the tempid ack", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const adaEid = seeded.tempids.u!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opBodies: { entity?: unknown; name?: unknown }[] = [];
    const staleCas = Operation(
      "user/stale-cas",
      {
        on: User,
        input: Schema.Struct({ eid: Schema.Finite }),
        output: Schema.Struct({}),
      },
      (op, input) => {
        op.cas(input.eid, User.age, 31, 32);
        return {};
      },
    );
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (call.url.endsWith("/transact")) {
          await gate;
          const rep = await server.transact(call.body.tx);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientTxId: call.body.clientTxId,
            },
          };
        }
        if (call.url.endsWith("/op")) {
          opBodies.push({ entity: call.body.entity, name: call.body.name });
          const rep = await server.transact([
            [":db/cas", call.body.input.eid, ":user/age", 31, 32],
          ]);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientOpId: call.body.clientOpId,
              output: {},
            },
          };
        }
        return { body: { t: server.t } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);
    await server.transact([[":db/add", adaEid, ":user/age", 31]]);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Cal");
      }),
    );
    await settle();
    const second = db.run(staleCas, tempid("new"), { eid: adaEid });
    await settle();
    expect(opBodies).toHaveLength(0);

    release();
    await first;
    await second;
    const calEid = await server.db().entid([":user/name", "Cal"]);
    expect(opBodies).toHaveLength(1);
    expect(opBodies[0]!.name).toBe("user/stale-cas");
    expect(typeof opBodies[0]!.entity).toBe("number");
    expect(opBodies[0]!.entity).toBe(calEid);
    expect(opBodies[0]!.entity).not.toBe("new");
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(32);

    await c.dispose();
  });

  test("no-layer run does not rewrite a later unrelated tempid(\"new\") after the queue drains", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const adaEid = seeded.tempids.u!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const staleCas = Operation(
      "user/stale-cas-expire",
      {
        on: User,
        input: Schema.Struct({ eid: Schema.Finite }),
        output: Schema.Struct({}),
      },
      (op, input) => {
        op.cas(input.eid, User.age, 31, 32);
        return {};
      },
    );
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (call.url.endsWith("/transact")) {
          if (posts.length === 0) await gate;
          posts.push(call.body.tx as unknown[]);
          const rep = await server.transact(call.body.tx);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientTxId: call.body.clientTxId,
            },
          };
        }
        if (call.url.endsWith("/op")) {
          const rep = await server.transact([
            [":db/cas", call.body.input.eid, ":user/age", 31, 32],
          ]);
          return {
            body: {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: rep.txData.map(toWireDatom),
              clientOpId: call.body.clientOpId,
              output: {},
            },
          };
        }
        return { body: { t: server.t } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);
    await server.transact([[":db/add", adaEid, ":user/age", 31]]);

    const first = Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Cal");
      }),
    );
    await settle();
    const second = db.run(staleCas, tempid("new"), { eid: adaEid });
    await settle();
    release();
    await first;
    await second;
    const calEid = (await server.db().entid([":user/name", "Cal"]))!;

    await server.transact([[":db/add", adaEid, ":user/age", 33]]);
    const third = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Dot");
        yield* tx.cas(adaEid, User.age, 33, 34);
      }),
    );
    expect(third.t).toBeGreaterThan(0);
    expect(posts).toHaveLength(2);
    const thirdTx = posts[1] ?? [];
    const dotAdds = thirdTx.filter(
      (op): op is unknown[] =>
        Array.isArray(op) && op[0] === ":db/add" && op[2] === ":user/name" && op[3] === "Dot",
    );
    expect(dotAdds).toHaveLength(1);
    expect(dotAdds[0]![1]).toBe("new");
    expect(dotAdds[0]![1]).not.toBe(calEid);
    const dotEid = await server.db().entid([":user/name", "Dot"]);
    expect(dotEid).toBeDefined();
    expect(dotEid).not.toBe(calEid);

    await c.dispose();
  });

  test("stale replica CAS then op.query / op.pull still reaches /op", async () => {
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;
    let postedOp = 0;
    const staleCasThenRead = Operation(
      "user/stale-cas-then-read",
      {
        input: Schema.Struct({ eid: Schema.Finite }),
        output: Schema.Struct({}),
      },
      async (op, input) => {
        op.cas(input.eid, User.age, 31, 32);
        await op.query(ages);
        await op.pull(input.eid, { name: User.name, age: User.age });
        return {};
      },
    );
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (!call.url.endsWith("/op")) return { body: { t: server.t } };
        postedOp += 1;
        const rep = await server.transact([
          [":db/cas", call.body.input.eid, ":user/age", 31, 32],
        ]);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientOpId: call.body.clientOpId,
            output: {},
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await server.transact([[":db/add", eid, ":user/age", 31]]);

    const report = await db.run(staleCasThenRead, { eid });
    expect(postedOp).toBe(1);
    expect(peer.calls.some((call) => call.url.endsWith("/op"))).toBe(true);
    expect(report.output).toEqual({});
    expect((await server.db().entity(eid))![":user/age"]).toBe(32);

    await c.dispose();
  });

  test("op.cas on a server-only eid then op.query still reaches /op", async () => {
    const server = await moviesWorld();
    let postedOp = 0;
    const serverOnlyCasThenRead = Operation(
      "user/server-only-cas-then-read",
      {
        input: Schema.Struct({ eid: Schema.Finite }),
        output: Schema.Struct({}),
      },
      async (op, input) => {
        op.cas(input.eid, User.age, 30, 31);
        await op.query(ages);
        return {};
      },
    );
    const peer = scriptedPeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (!call.url.endsWith("/op")) return { body: { t: server.t } };
        postedOp += 1;
        const rep = await server.transact([
          [":db/cas", call.body.input.eid, ":user/age", 30, 31],
        ]);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientOpId: call.body.clientOpId,
            output: {},
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;

    const report = await db.run(serverOnlyCasThenRead, { eid });
    expect(postedOp).toBe(1);
    expect(peer.calls.some((call) => call.url.endsWith("/op"))).toBe(true);
    expect(report.output).toEqual({});
    expect((await server.db().entity(eid))![":user/age"]).toBe(31);

    await c.dispose();
  });
});
