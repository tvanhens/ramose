/**
 * #111 PR 2 — session overlay: optimistic transact, local q/live, filtered
 * `tx` / `resync` apply. HTTPS-only clients are not covered here.
 */

import { describe, expect, test } from "bun:test";
import { Connection } from "../src/internal/core/conn.ts";
import {
  Index,
  ValueTag,
  toWireDatom,
  type WireDatom,
} from "../src/internal/core/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import { schemaTx } from "../src/db/ensure.ts";
import { Entity, Field, Query, Schema as DbSchema, seedWrite } from "../src/db/internal.ts";
import { openOverlay, type Overlay } from "../src/db/overlay.ts";
import type { Session } from "../src/db/session.ts";
import { client, fakePeer, settle, until, type Call } from "./peer.ts";

import { Meta, Movie, Movies, User } from "./db/fixture.ts";

const Doc = Entity("doc", {
  slug: Field.unique(Schema.String, "strict"),
});
const Secret = Entity("secret", {
  note: Field(Schema.String),
});
const Note = Entity("note", {
  title: Field(Schema.String),
  audit: Field(Schema.String),
});
const WithSlug = DbSchema({ user: User, movie: Movie, meta: Meta, doc: Doc });
const WithSecret = DbSchema({ user: User, movie: Movie, meta: Meta, secret: Secret });
const WithNotes = DbSchema({ user: User, movie: Movie, meta: Meta, note: Note });
const secretNotes = Query.q(() => pipe(Query.entities(Secret), Query.select({ note: Secret.note })));
const noteTitles = Query.q(() => pipe(Query.entities(Note), Query.select({ title: Note.title })));
const noteAudits = Query.q(() => pipe(Query.entities(Note), Query.select({ audit: Note.audit })));

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
  peer: { socket: { push: (f: unknown) => void }; sockets: { push: (f: unknown) => void }[] },
  db: { query: (q: typeof names) => Effect.Effect<unknown, unknown> | Promise<unknown> },
  conn: Connection,
) => {
  await db.query(names);
  const snap = await snapshotOf(conn);
  peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
  await settle();
  return snap;
};

describe("optimistic transact", () => {
  test("a local add is visible to this live before POST returns, and invisible to a second client until a tx frame", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ack: { t: number; txEid: number; tempids: Record<string, number>; datoms: WireDatom[] } | undefined;

    const http = async (call: Call) => {
      if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
      await gate;
      const rep = await server.transact(call.body.tx);
      ack = {
        t: rep.t,
        txEid: rep.txEid,
        tempids: rep.tempids,
        datoms: rep.txData.map(toWireDatom),
      };
      return { body: { ...ack, clientTxId: call.body.clientTxId } };
    };

    const adaPeer = fakePeer({ http });
    const beaPeer = fakePeer({ http: () => ({ body: { t: server.t } }) });
    const adaC = client(adaPeer);
    const beaC = client(beaPeer);
    const ada = adaC.ramose.db("movies", Movies);
    const bea = beaC.ramose.db("movies", Movies);

    await seedClient(adaPeer, ada, server);
    await seedClient(beaPeer, bea, server);

    const adaLive = collect(ada.effect.live(names));
    const beaLive = collect(bea.effect.live(names));
    await until(() => adaLive.seen.length > 0 && beaLive.seen.length > 0);
    expect(adaLive.seen.at(-1)).toEqual([]);
    expect(beaLive.seen.at(-1)).toEqual([]);

    const writes = adaPeer.calls.filter((c) => c.url.endsWith("/transact")).length;
    const pending = Effect.runPromise(
      seedWrite(ada, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();

    expect(adaLive.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(beaLive.seen.at(-1)).toEqual([]);
    expect(adaPeer.calls.filter((c) => c.url.endsWith("/transact")).length).toBe(writes + 1);

    release();
    const report = await pending;
    await settle();
    expect(report.t).toBeGreaterThan(0);
    expect(beaLive.seen.at(-1)).toEqual([]);

    beaPeer.socket.push({ op: "tx", t: ack!.t, datoms: ack!.datoms });
    await settle();
    expect(beaLive.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(beaPeer.frameOps("q")).toHaveLength(0);

    await adaLive.stop();
    await beaLive.stop();
    await adaC.dispose();
    await beaC.dispose();
  });

  test("ack remaps the tempid onto the server eid", async () => {
    const server = await moviesWorld();
    const adaPeer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
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
    const c = client(adaPeer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(adaPeer, db, server);

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("ada"));
        yield* e.set(User.name, "Ada");
      }),
    );
    expect(report.t).toBe(server.t);
    const rows = await run(
      db.query(Query.q(() => pipe(Query.entities(User), Query.select({ id: User.id, name: User.name })))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada");
    const fact = await server.db().first(Index.AVET, {
      a: server.db().schema.requireAttr(":user/name").id,
    });
    expect(rows[0]!.id as number).toBe(fact!.e);
    await c.dispose();
  });

  test("409 drops the pending row and fails TxRejected", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        await gate;
        return {
          status: 409,
          body: { error: "unique conflict", tag: "TxRejected", code: "tx/unique-conflict" },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(names));
    await settle();

    const failed = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    release();
    const e = await failed;
    await settle();
    expect(e._tag).toBe("TxRejected");
    expect((e as { code?: string }).code).toBe("tx/unique-conflict");
    expect(live.seen.at(-1)).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("a 409 drops only that pending layer; live reverts without remount", async () => {
    const server = await moviesWorld();
    await server.transact([{ ":user/name": "Ada" }]);
    let releaseFail!: () => void;
    let releaseKeep!: () => void;
    const failGate = new Promise<void>((r) => {
      releaseFail = r;
    });
    const keepGate = new Promise<void>((r) => {
      releaseKeep = r;
    });
    let posts = 0;
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posts += 1;
        if (posts === 1) {
          await failGate;
          return {
            status: 409,
            body: { error: "denied", tag: "TxRejected", code: "tx/unique-conflict" },
          };
        }
        await keepGate;
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

    const live = collect(db.effect.live(names));
    await settle();
    const namesOf = (rows: readonly { name: string }[] | undefined) =>
      (rows ?? []).map((r) => r.name).sort();
    expect(namesOf(live.seen.at(-1))).toEqual(["Ada"]);

    const denied = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Bob");
      }),
    );
    await settle();
    expect(namesOf(live.seen.at(-1))).toEqual(["Ada", "Bob"]);

    const kept = run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Cy");
      }),
    );
    await settle();
    expect(namesOf(live.seen.at(-1))).toEqual(["Ada", "Bob", "Cy"]);

    releaseFail();
    const err = await denied;
    await settle();
    expect(err._tag).toBe("TxRejected");
    expect(namesOf(live.seen.at(-1))).toEqual(["Ada", "Cy"]);
    expect(live.error).toBeUndefined();

    releaseKeep();
    await kept;
    await settle();
    expect(namesOf(live.seen.at(-1))).toEqual(["Ada", "Cy"]);

    await live.stop();
    await c.dispose();
  });

  test("local unique conflict does not POST", async () => {
    const server = await moviesWorld();
    await server.transact([
      { ":db/ident": ":doc/slug", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/value", ":db/optional": true },
    ]);
    await server.transact([{ ":doc/slug": "ada" }]);
    const posts: Call[] = [];
    const peer = fakePeer({
      http: (call) => {
        if (call.url.endsWith("/transact")) posts.push(call);
        return { body: { t: server.t, txEid: 1, tempids: {}, datoms: [] } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithSlug);
    await seedClient(peer, db, server);

    const e = await runFail(
      seedWrite(db, function* (tx) {
        const row = yield* tx.entity();
        yield* row.set(Doc.slug, "ada");
      }),
    );
    expect(e._tag).toBe("TxRejected");
    expect((e as { code?: string }).code).toBe("tx/unique-conflict");
    expect(posts).toEqual([]);
    await c.dispose();
  });

  test("empty ack.datoms drop the pending layer and do not commit it to confirmed", async () => {
    const server = await moviesWorld();
    const peer = fakePeer({
      http: (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        return {
          body: {
            t: server.t + 1,
            txEid: 0,
            tempids: {},
            datoms: [],
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithSecret);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(secretNotes));
    await settle();
    expect(live.seen.at(-1)).toEqual([]);

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Secret.note, "classified");
      }),
    );
    await settle();
    expect(report.datomCount).toBe(0);
    expect(report.t).toBe(server.t + 1);
    expect(live.seen.at(-1)).toEqual([]);
    expect(await db.query(secretNotes)).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("count-only ack.datoms is datomCount, not confirmed facts", async () => {
    const server = await moviesWorld();
    const peer = fakePeer({
      http: (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        return {
          body: {
            t: server.t + 1,
            txEid: 0,
            tempids: {},
            datoms: 4,
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithSecret);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(secretNotes));
    await settle();

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Secret.note, "classified");
      }),
    );
    await settle();
    expect(report.datomCount).toBe(4);
    expect(live.seen.at(-1)).toEqual([]);
    expect(await db.query(secretNotes)).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("queued rewrite remaps a tempid entity, not a title that equals the tempid", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: unknown[][] = [];
    const peer = fakePeer({
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
        const e = yield* tx.entity();
        yield* e.set(Movie.title, "new");
      }),
    );
    await settle();
    release();
    await first;
    await second;
    expect(posts).toHaveLength(2);
    const secondTx = posts[1] ?? [];
    const titleAdds = secondTx.filter(
      (op): op is unknown[] =>
        Array.isArray(op) && op[0] === ":db/add" && op[2] === ":movie/title",
    );
    expect(titleAdds).toHaveLength(1);
    expect(titleAdds[0]![3]).toBe("new");
    await c.dispose();
  });
});

describe("confirmed follower", () => {
  test("inbound tx with clientTxId drops only that pending layer", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        await gate;
        return {
          status: 409,
          body: { error: "stopped", tag: "TxRejected", code: "tx/unique-conflict" },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(names));
    await settle();

    const first = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Bea");
      }),
    );
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bea" }]);

    const ids = peer.calls
      .filter((call) => call.url.endsWith("/transact"))
      .map((call) => call.body.clientTxId as string);
    peer.push({ op: "tx", t: server.t + 1, clientTxId: ids[0], datoms: [] });
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Bea" }]);

    release();
    await first;
    await second;
    await live.stop();
    await c.dispose();
  });

  test("same-t ack then { op: tx } is a no-op on confirmed", async () => {
    const server = await moviesWorld();
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
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

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Ada");
      }),
    );
    const allUsers = Query.q(() => Query.entities(User));
    const before = await db.query(allUsers);
    const ackCall = peer.calls.filter((call) => call.url.endsWith("/transact")).at(-1)!;
    void ackCall;

    const datoms = (await snapshotOf(server)).datoms.filter((d) => d[4] === report.t);
    peer.push({ op: "tx", t: report.t, datoms });
    await settle();
    expect(await db.query(allUsers)).toEqual(before);
    await c.dispose();
  });

  test("sync reply t does not skip a later-queued earlier tx frame", async () => {
    const schemaConn = await Connection.create();
    await schemaConn.transact(schemaTx(Movies) as unknown[]);
    const nameA = schemaConn.db().schema.requireAttr(":user/name").id;
    const fact = toWireDatom({
      e: 2001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Ada",
      t: 6,
      op: true,
    });

    let pusher: (frame: Record<string, unknown>) => void | Promise<void> = () => {};
    let basis = 0;
    let epoch = 0;
    const session: Session = {
      get t() {
        return basis;
      },
      generation: 1,
      principal: undefined,
      connects: 1,
      closed: false,
      status: "live",
      get epoch() {
        return epoch;
      },
      request: async (frame) => {
        if (frame.op === "sync") {
          void pusher({ op: "tx", t: 6, datoms: [fact] });
          return { status: 200, body: { t: 8, from: frame.from ?? 0 } };
        }
        return { status: 200, body: {} };
      },
      bump: (n) => {
        if (n > basis) basis = n;
      },
      nudge: () => {
        epoch += 1;
      },
      onWake: () => () => {},
      onPush: (cb) => {
        pusher = cb;
        return () => {};
      },
      close: () => {},
    };

    const overlay = openOverlay({
      session,
      post: () => Effect.succeed({}),
      schema: Movies,
    });
    await run(overlay.ready());
    expect(overlay.confirmedT).toBe(8);
    const body = (await run(
      overlay.read("q", {
        query: {
          find: ["?n"],
          where: [["?e", ":user/name", "?n"]],
        },
      }),
    )) as { result: unknown };
    expect(body.result).toEqual([["Ada"]]);
  });

  test("{ op: sync } / resync rebuilds confirmed from the snapshot", async () => {
    const server = await moviesWorld();
    await server.transact([{ ":user/name": "Ada" }]);
    const peer = fakePeer();
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);
    expect(await db.query(names)).toEqual([{ name: "Ada" }]);

    const other = await moviesWorld();
    await other.transact([{ ":user/name": "Bea" }]);
    const snap = await snapshotOf(other);
    peer.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();
    expect(await db.query(names)).toEqual([{ name: "Bea" }]);
    await c.dispose();
  });
});

describe("two-writer races", () => {
  test("queued inbound t=N is not skipped when HTTP ack for t=N+1 arrives first", async () => {
    const schemaConn = await Connection.create();
    await schemaConn.transact(schemaTx(Movies) as unknown[]);
    const nameA = schemaConn.db().schema.requireAttr(":user/name").id;
    const phone = toWireDatom({
      e: 2001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Phone",
      t: 40,
      op: true,
    });
    const browser = toWireDatom({
      e: 2002,
      a: nameA,
      vt: ValueTag.Str,
      v: "Browser",
      t: 41,
      op: true,
    });

    let overlay!: Overlay;
    let basis = 0;
    let epoch = 0;
    const session: Session = {
      get t() {
        return basis;
      },
      generation: 1,
      principal: undefined,
      connects: 1,
      closed: false,
      status: "live",
      get epoch() {
        return epoch;
      },
      request: async (frame) => {
        if (frame.op === "sync") return { status: 200, body: { t: 39, from: frame.from ?? 0 } };
        return { status: 200, body: {} };
      },
      bump: (n) => {
        if (n > basis) basis = n;
      },
      nudge: () => {
        epoch += 1;
      },
      onWake: () => () => {},
      onPush: () => () => {},
      close: () => {},
    };

    const namesOf = async () => {
      const body = (await run(
        overlay.read("q", {
          query: {
            find: ["?n"],
            where: [["?e", ":user/name", "?n"]],
          },
        }),
      )) as { result: [string][] };
      return body.result.map((row) => row[0]).sort();
    };

    overlay = openOverlay({
      session,
      post: () => {
        // other device’s t=40 is already queued when this later writer’s ack runs
        void overlay.handlePush({ op: "tx", t: 40, datoms: [phone] });
        return Effect.succeed({
          t: 41,
          txEid: 1,
          tempids: {},
          datoms: [browser],
          clientTxId: "c-browser",
        });
      },
      schema: Movies,
    });
    await run(overlay.ready());
    expect(overlay.confirmedT).toBe(39);

    await run(overlay.transact([{ ":user/name": "Browser" }]));
    // Ack painted the writer’s facts but must not jump the prefix. Own echo
    // and inbound tx paint; they do not claim the follow cursor.
    expect(overlay.confirmedT).toBe(39);
    expect(await namesOf()).toEqual(["Browser", "Phone"]);

    await overlay.handlePush({ op: "tx", t: 41, datoms: [browser], clientTxId: "c-browser" });
    expect(overlay.confirmedT).toBe(39);
    expect(await namesOf()).toEqual(["Browser", "Phone"]);
  });

  test("a late lower-t { op: tx } still applies after a higher-t echo", async () => {
    const schemaConn = await Connection.create();
    await schemaConn.transact(schemaTx(Movies) as unknown[]);
    const nameA = schemaConn.db().schema.requireAttr(":user/name").id;
    const phone = toWireDatom({
      e: 2001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Phone",
      t: 40,
      op: true,
    });
    const browser = toWireDatom({
      e: 2002,
      a: nameA,
      vt: ValueTag.Str,
      v: "Browser",
      t: 41,
      op: true,
    });

    let overlay!: Overlay;
    let basis = 0;
    let epoch = 0;
    const session: Session = {
      get t() {
        return basis;
      },
      generation: 1,
      principal: undefined,
      connects: 1,
      closed: false,
      status: "live",
      get epoch() {
        return epoch;
      },
      request: async (frame) => {
        if (frame.op === "sync") return { status: 200, body: { t: 39, from: frame.from ?? 0 } };
        return { status: 200, body: {} };
      },
      bump: (n) => {
        if (n > basis) basis = n;
      },
      nudge: () => {
        epoch += 1;
      },
      onWake: () => () => {},
      onPush: () => () => {},
      close: () => {},
    };

    overlay = openOverlay({
      session,
      post: () => Effect.succeed({}),
      schema: Movies,
    });
    await run(overlay.ready());
    await overlay.handlePush({ op: "tx", t: 41, datoms: [browser] });
    expect(overlay.confirmedT).toBe(39);
    await overlay.handlePush({ op: "tx", t: 40, datoms: [phone] });
    const body = (await run(
      overlay.read("q", {
        query: {
          find: ["?n"],
          where: [["?e", ":user/name", "?n"]],
        },
      }),
    )) as { result: [string][] };
    expect(body.result.map((row) => row[0]).sort()).toEqual(["Browser", "Phone"]);
  });

  test("own echo does not claim the prefix: sync({ from }) still includes the other device's t", async () => {
    const schemaConn = await Connection.create();
    await schemaConn.transact(schemaTx(Movies) as unknown[]);
    const nameA = schemaConn.db().schema.requireAttr(":user/name").id;
    const phone = toWireDatom({
      e: 2001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Phone",
      t: 40,
      op: true,
    });
    const browser = toWireDatom({
      e: 2002,
      a: nameA,
      vt: ValueTag.Str,
      v: "Browser",
      t: 41,
      op: true,
    });

    let overlay!: Overlay;
    let basis = 0;
    let epoch = 0;
    const session: Session = {
      get t() {
        return basis;
      },
      generation: 1,
      principal: undefined,
      connects: 1,
      closed: false,
      status: "live",
      get epoch() {
        return epoch;
      },
      request: async (frame) => {
        if (frame.op === "sync") return { status: 200, body: { t: 39, from: frame.from ?? 0 } };
        return { status: 200, body: {} };
      },
      bump: (n) => {
        if (n > basis) basis = n;
      },
      nudge: () => {
        epoch += 1;
      },
      onWake: () => () => {},
      onPush: () => () => {},
      close: () => {},
    };

    overlay = openOverlay({
      session,
      post: () =>
        Effect.succeed({
          t: 41,
          txEid: 1,
          tempids: {},
          datoms: [browser],
          clientTxId: "c-browser",
        }),
      schema: Movies,
    });
    await run(overlay.ready());
    expect(overlay.confirmedT).toBe(39);

    await run(overlay.transact([{ ":user/name": "Browser" }]));
    await overlay.handlePush({ op: "tx", t: 40, datoms: [phone] });
    await overlay.handlePush({ op: "tx", t: 41, datoms: [browser], clientTxId: "c-browser" });
    const body = (await run(
      overlay.read("q", {
        query: {
          find: ["?n"],
          where: [["?e", ":user/name", "?n"]],
        },
      }),
    )) as { result: [string][] };
    expect(body.result.map((row) => row[0]).sort()).toEqual(["Browser", "Phone"]);
    // follow cursor still at the last walked prefix — sync({ from: 41 }) would skip Phone
    expect(overlay.confirmedT).toBe(39);
  });

  test("writer { op: tx } with clientTxId drops pending even when the sieved set is a subset", async () => {
    const server = await moviesWorld();
    await server.transact([
      { ":db/ident": ":note/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":note/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        await gate;
        return {
          status: 409,
          body: { error: "stopped", tag: "TxRejected", code: "tx/unique-conflict" },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithNotes);
    await seedClient(peer, db, server);

    const titles = collect(db.effect.live(noteTitles));
    const audits = collect(db.effect.live(noteAudits));
    await settle();

    const pending = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "Q3");
        yield* e.set(Note.audit, "classified");
      }),
    );
    await settle();
    expect(titles.seen.at(-1)).toEqual([{ title: "Q3" }]);
    expect(audits.seen.at(-1)).toEqual([{ audit: "classified" }]);

    const id = peer.calls.filter((call) => call.url.endsWith("/transact")).at(-1)!.body.clientTxId as string;
    const titleA = server.db().schema.requireAttr(":note/title").id;
    const sieved = [
      toWireDatom({
        e: 3001,
        a: titleA,
        vt: ValueTag.Str,
        v: "Q3",
        t: server.t + 1,
        op: true,
      }),
    ];
    peer.push({ op: "tx", t: server.t + 1, clientTxId: id, datoms: sieved });
    await settle();
    expect(titles.seen.at(-1)).toEqual([{ title: "Q3" }]);
    expect(audits.seen.at(-1)).toEqual([]);
    expect(await db.query(noteAudits)).toEqual([]);

    release();
    await pending;
    await titles.stop();
    await audits.stop();
    await c.dispose();
  });

  test("another session's { op: tx } with overlapping a/v/op does not drop this pending layer", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const peer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        await gate;
        return {
          status: 409,
          body: { error: "stopped", tag: "TxRejected", code: "tx/unique-conflict" },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(names));
    await settle();

    const pending = runFail(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    const nameA = server.db().schema.requireAttr(":user/name").id;
    peer.push({
      op: "tx",
      t: server.t + 1,
      datoms: [
        toWireDatom({
          e: 4001,
          a: nameA,
          vt: ValueTag.Str,
          v: "Ada",
          t: server.t + 1,
          op: true,
        }),
      ],
    });
    await settle();
    // pending layer still painted; inbound confirmed is a second Ada
    expect(live.seen.at(-1)).toHaveLength(2);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Ada" }]);

    release();
    await pending;
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    await live.stop();
    await c.dispose();
  });

  test("empty ack does not apply local expansion; later inbound at that t still applies", async () => {
    const server = await moviesWorld();
    await server.transact([
      { ":db/ident": ":secret/note", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const peer = fakePeer({
      http: (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        return {
          body: {
            t: server.t + 1,
            txEid: 0,
            tempids: {},
            datoms: [],
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithSecret);
    await seedClient(peer, db, server);

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Secret.note, "classified");
      }),
    );
    await settle();
    expect(await db.query(secretNotes)).toEqual([]);

    const noteA = server.db().schema.requireAttr(":secret/note").id;
    peer.push({
      op: "tx",
      t: report.t,
      datoms: [
        toWireDatom({
          e: 5001,
          a: noteA,
          vt: ValueTag.Str,
          v: "from-log",
          t: report.t,
          op: true,
        }),
      ],
    });
    await settle();
    expect(await db.query(secretNotes)).toEqual([{ note: "from-log" }]);
    await c.dispose();
  });

  test("count-only ack does not apply local expansion; later inbound at that t still applies", async () => {
    const server = await moviesWorld();
    await server.transact([
      { ":db/ident": ":secret/note", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const peer = fakePeer({
      http: (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        return {
          body: {
            t: server.t + 1,
            txEid: 0,
            tempids: {},
            datoms: 4,
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", WithSecret);
    await seedClient(peer, db, server);

    const report = await run(
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Secret.note, "classified");
      }),
    );
    await settle();
    expect(report.datomCount).toBe(4);
    expect(await db.query(secretNotes)).toEqual([]);

    const noteA = server.db().schema.requireAttr(":secret/note").id;
    peer.push({
      op: "tx",
      t: report.t,
      datoms: [
        toWireDatom({
          e: 5002,
          a: noteA,
          vt: ValueTag.Str,
          v: "from-log",
          t: report.t,
          op: true,
        }),
      ],
    });
    await settle();
    expect(await db.query(secretNotes)).toEqual([{ note: "from-log" }]);
    await c.dispose();
  });
});

describe("filtered tx frames (#112 sieve)", () => {
  test("Ada's POST is {tx, clientTxId}; Cal sees skip; filtered ack omits hidden", async () => {
    const server = await moviesWorld();
    await server.transact([
      { ":db/ident": ":note/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":note/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const posts: Call[] = [];
    const adaPeer = fakePeer({
      http: async (call) => {
        if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
        posts.push(call);
        await gate;
        const rep = await server.transact(call.body.tx);
        const auditId = server.db().schema.requireAttr(":note/audit").id;
        const visible = rep.txData.filter((d) => d.a !== auditId).map(toWireDatom);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: visible,
            clientTxId: call.body.clientTxId,
          },
        };
      },
    });
    const calPeer = fakePeer({
      http: () => ({ body: { t: server.t } }),
    });
    const adaC = client(adaPeer);
    const calC = client(calPeer);
    const ada = adaC.ramose.db("acme", WithNotes);
    const cal = calC.ramose.db("acme", WithNotes);
    await seedClient(adaPeer, ada, server);
    await seedClient(calPeer, cal, server);

    const adaTitles = collect(ada.effect.live(noteTitles));
    const adaAudits = collect(ada.effect.live(noteAudits));
    const calTitles = collect(cal.effect.live(noteTitles));
    await settle();

    const pending = Effect.runPromise(
      seedWrite(ada, function* (tx) {
        const e = yield* tx.entity();
        yield* e.set(Note.title, "Q3");
        yield* e.set(Note.audit, "classified");
      }),
    );
    await settle();

    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]!.body).sort()).toEqual(["clientTxId", "tx"]);
    expect(posts[0]!.body.datoms).toBeUndefined();
    expect(adaTitles.seen.at(-1)).toEqual([{ title: "Q3" }]);
    expect(adaAudits.seen.at(-1)).toEqual([{ audit: "classified" }]);
    expect(calTitles.seen.at(-1)).toEqual([]);

    release();
    await pending;
    await settle();
    expect(adaTitles.seen.at(-1)).toEqual([{ title: "Q3" }]);
    expect(adaAudits.seen.at(-1)).toEqual([]);
    expect(await run(ada.query(noteAudits))).toEqual([]);
    expect(calTitles.seen.at(-1)).toEqual([]);
    expect(await run(cal.query(noteTitles))).toEqual([]);

    await adaTitles.stop();
    await adaAudits.stop();
    await calTitles.stop();
    await adaC.dispose();
    await calC.dispose();
  });
});

describe("apply is the notify", () => {
  test("a { op: tx } paints and notifies before handlePush returns", async () => {
    const schemaConn = await Connection.create();
    await schemaConn.transact(schemaTx(Movies) as unknown[]);
    const nameA = schemaConn.db().schema.requireAttr(":user/name").id;
    const ada = toWireDatom({
      e: 2001,
      a: nameA,
      vt: ValueTag.Str,
      v: "Ada",
      t: 40,
      op: true,
    });

    let basis = 0;
    let sessionEpoch = 0;
    const session: Session = {
      get t() {
        return basis;
      },
      generation: 1,
      principal: undefined,
      connects: 1,
      closed: false,
      status: "live",
      get epoch() {
        return sessionEpoch;
      },
      request: async (frame) => {
        if (frame.op === "sync") return { status: 200, body: { t: 39, from: frame.from ?? 0 } };
        return { status: 200, body: {} };
      },
      bump: (n) => {
        if (n > basis) basis = n;
      },
      nudge: () => {
        sessionEpoch += 1;
      },
      onWake: () => () => {},
      onPush: () => () => {},
      close: () => {},
    };

    const overlay = openOverlay({
      session,
      post: () => Effect.succeed({}),
      schema: Movies,
    });
    await run(overlay.ready());

    let notified = 0;
    overlay.onChange(() => {
      notified += 1;
    });
    const before = overlay.epoch;
    const pending = overlay.handlePush({ op: "tx", t: 40, datoms: [ada] });
    expect(notified).toBe(1);
    expect(overlay.epoch).toBe(before + 1);
    const body = (await run(
      overlay.read("q", {
        query: {
          find: ["?n"],
          where: [["?e", ":user/name", "?n"]],
        },
      }),
    )) as { result: [string][]; epoch: number };
    expect(body.result).toEqual([["Ada"]]);
    expect(body.epoch).toBe(overlay.epoch);
    await pending;
  });
});

describe("HTTPS-only is unchanged", () => {
  test("reads still POST /query and there is no overlay sync", async () => {
    const { httpsClient } = await import("./peer.ts");
    const peer = fakePeer({
      http: (call: Call) =>
        call.url.endsWith("/query")
          ? { body: { t: 2, root: 2, result: [[{ name: "Ada" }]] } }
          : { body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);
    expect(await db.query(names)).toEqual([{ name: "Ada" }]);
    expect(peer.sockets).toEqual([]);
    expect(peer.calls.map((c) => c.url)).toEqual([
      "https://peer.example.com/db/movies/query",
    ]);
    close();
  });
});
