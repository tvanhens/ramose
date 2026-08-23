/**
 * Server-side operations (issue #160): optimistic prefix, revoke, remap of
 * queued contextual `entity`, and the HTTPS `/op` wire from `db.run`.
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
  Operations,
  OperationRejected,
  Query,
  txBuilder,
} from "../src/db/internal.ts";
import { client, fakePeer, settle, type Call } from "./peer.ts";
import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;
const runFail = async <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<unknown> => {
  if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value));
  try {
    await value;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
};

const names = Query.q(() =>
  pipe(Query.entities(User), Query.select({ name: User.name })),
);

const createUser = Operation(
  "user/create",
  {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  async (op, input) => {
    const e = op.entity();
    e.add(User.name, input.name);
    await op.effect("audit", () => "logged");
    const extra = op.entity();
    extra.add(User.name, "AFTER");
    return {};
  },
);

const setName = Operation(
  "user/set-name",
  {
    on: User,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.add(op.self, User.name, input.name);
    return {};
  },
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

const snapshotOf = async (
  conn: Connection,
): Promise<{ t: number; datoms: WireDatom[] }> => {
  const datoms: WireDatom[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return { t: conn.t, datoms };
};

const moviesWorld = async () => {
  const conn = await Connection.create();
  await conn.transact([
    {
      ":db/ident": ":user/name",
      ":db/valueType": ":db.type/string",
      ":db/cardinality": ":db.cardinality/one",
      ":db/unique": ":db.unique/identity",
    },
    {
      ":db/ident": ":user/age",
      ":db/valueType": ":db.type/long",
      ":db/cardinality": ":db.cardinality/one",
    },
    {
      ":db/ident": ":movie/title",
      ":db/valueType": ":db.type/string",
      ":db/cardinality": ":db.cardinality/one",
      ":db/index": true,
    },
  ]);
  return conn;
};

const seedClient = async (
  peer: { socket: { push: (f: unknown) => void } },
  db: { q: (q: typeof names) => Effect.Effect<unknown, unknown> | Promise<unknown> },
  conn: Connection,
) => {
  await db.q(names);
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

describe("Operations registry", () => {
  test("resolves by declared name, not the registry key", () => {
    const ops = Operations({ createUser, setName });
    expect(ops.get("user/create")).toBe(createUser);
    expect(ops.get("user/set-name")).toBe(setName);
    expect(ops.get("createUser")).toBeUndefined();
  });
});

describe("optimistic prefix", () => {
  test("live sees prefix writes before POST /op; steps after op.effect are not guessed", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ack:
      | {
          t: number;
          txEid: number;
          tempids: Record<string, number>;
          datoms: WireDatom[];
        }
      | undefined;

    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
      if (!call.url.endsWith("/op")) return { body: { t: server.t } };
      await gate;
      const rep = await server.transact([
        { ":user/name": call.body.input.name },
      ]);
      ack = {
        t: rep.t,
        txEid: rep.txEid,
        tempids: rep.tempids,
        datoms: rep.txData.map(toWireDatom),
      };
      return { body: { ...ack, clientOpId: call.body.clientOpId, output: {} } };
    };

    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(names));
    await settle();
    expect(live.seen.at(-1)).toEqual([]);

    const pending = db.run(createUser, { name: "Ada" });
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(live.seen.at(-1)).not.toEqual(
      expect.arrayContaining([{ name: "AFTER" }]),
    );
    expect(peer.calls.some((call) => call.url.endsWith("/op"))).toBe(true);
    expect(peer.calls.some((call) => call.url.endsWith("/transact"))).toBe(
      false,
    );

    release();
    const report = await pending;
    expect(report.output).toEqual({});
    expect(ack?.t).toBe(report.t);
    expect(await db.q(names)).toEqual([{ name: "Ada" }]);

    await live.stop();
    await c.dispose();
  });

  test("a 409 OperationRejected drops the pending layer", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const peer = fakePeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (!call.url.endsWith("/op")) return { body: { t: server.t } };
        await gate;
        return {
          status: 409,
          body: {
            error: "OperationRejected",
            tag: "OperationRejected",
            message: "denied",
            name: "user/create",
            reason: "policy",
          },
        };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    const live = collect(db.effect.live(names));
    await settle();

    const pending = runFail(db.run(createUser, { name: "Ada" }));
    await settle();
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    release();
    const err = await pending;
    expect(err).toBeInstanceOf(OperationRejected);
    expect((err as OperationRejected)._tag).toBe("OperationRejected");
    await settle();
    expect(live.seen.at(-1)).toEqual([]);
    expect(await db.q(names)).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("remapQueued rewrites a queued contextual entity after the tempid ack", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opBodies: { entity?: unknown; name?: unknown }[] = [];
    const peer = fakePeer({
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
          const eid = call.body.entity as number;
          const rep = await server.transact([
            [":db/add", eid, ":user/name", call.body.input.name],
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

    const first = Effect.runPromise(
      db.effect.transact(function* (tx) {
        const e = yield* tx.entity("new");
        yield* e.add(User.name, "Ada");
      }),
    );
    await settle();
    const second = db.run(setName, "new", { name: "Ada Lovelace" });
    await settle();
    expect(opBodies).toHaveLength(0);

    release();
    const created = await first;
    const renamed = await second;
    expect(opBodies).toHaveLength(1);
    expect(opBodies[0]!.name).toBe("user/set-name");
    expect(typeof opBodies[0]!.entity).toBe("number");
    expect(opBodies[0]!.entity).not.toBe("new");
    expect(created.t).toBeLessThanOrEqual(renamed.t);
    expect(await db.q(names)).toEqual([{ name: "Ada Lovelace" }]);

    await c.dispose();
  });
});

describe("db.run wire", () => {
  test("a contextual op without an entity is InvalidRequest", async () => {
    const peer = fakePeer();
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const err = await runFail(db.run(setName, undefined, { name: "x" }));
    expect((err as { _tag: string })._tag).toBe("InvalidRequest");
    await c.dispose();
  });
});

describe("optional add", () => {
  test("add(undefined | null) is a no-op — it is not encoded as a nil datom", () => {
    const tx = txBuilder(Movies);
    const e = Effect.runSync(tx.entity());
    Effect.runSync(e.add(User.name, "Ada"));
    Effect.runSync(e.add(User.age, undefined as never));
    Effect.runSync(e.add(User.age, null as never));
    expect(tx.spec.ops).toEqual([[":db/add", "tmp-1", ":user/name", "Ada"]]);
  });
});
