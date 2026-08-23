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
import * as Data from "effect/Data";
import {
  InternalError,
  Operation,
  Operations,
  OperationRejected,
  PrefixHalt,
  Query,
  TxRejected,
  Unauthorized,
  txBuilder,
} from "../src/db/internal.ts";
import { asPromiseOp, buildOp, runBody } from "../src/db/op-handle.ts";
import { client, fakePeer, httpsClient, settle, type Call } from "./peer.ts";
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
    e.set(User.name, input.name);
    await op.effect("audit", () => "logged");
    const extra = op.entity();
    extra.set(User.name, "AFTER");
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
    op.set(op.self, User.name, input.name);
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
    expect(await db.query(names)).toEqual([{ name: "Ada" }]);

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
            operation: "user/create",
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
    expect(await db.query(names)).toEqual([]);

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
        yield* e.set(User.name, "Ada");
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
    expect(await db.query(names)).toEqual([{ name: "Ada Lovelace" }]);

    await c.dispose();
  });
});

const stubOp = (effects: "halt" | "run") =>
  buildOp({
    schema: Movies,
    db: "movies",
    principal: { eid: null, class: "admin", claims: {} },
    effects,
    q: () => Effect.succeed([]),
    pull: () => Effect.succeed(null),
  });

describe("PrefixHalt is out-of-band", () => {
  test("a swallowed PrefixHalt still stops the optimistic prefix", async () => {
    const built = stubOp("halt");
    const swallow = {
      body: async (op: {
        entity: () => {
          set: (attr: unknown, value: unknown) => void;
        };
        effect: (name: string, run: () => unknown) => Promise<unknown>;
      }) => {
        const e = op.entity();
        e.set(User.name, "Ada");
        try {
          await op.effect("charge", () => "nope");
        } catch {
          const extra = op.entity();
          extra.set(User.name, "AFTER");
        }
        return { ok: true };
      },
    };
    const result = await Effect.runPromise(runBody(swallow, built.op, {}));
    expect(result.halted).toBe(true);
    expect(result.output).toBeUndefined();
    expect(built.ops()).toEqual([[":db/add", "tmp-1", ":user/name", "Ada"]]);
  });

  test("PrefixHalt is exported so a caller can rethrow", () => {
    const err = new PrefixHalt();
    expect(err).toBeInstanceOf(PrefixHalt);
    expect(err._tag).toBe("ramose/PrefixHalt");
  });
});

describe("op.effect thunk rejections", () => {
  class PaymentDeclined extends Data.TaggedError("PaymentDeclined")<{
    readonly message: string;
  }> {}

  test("a tagged / _tag cause passes through; unknown wraps InternalError", async () => {
    const built = stubOp("run");
    const op = asPromiseOp(built.op);

    try {
      await op.effect("charge", async () => {
        throw new PaymentDeclined({ message: "card" });
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentDeclined);
      expect((error as PaymentDeclined)._tag).toBe("PaymentDeclined");
    }

    try {
      await op.effect("deny", async () => {
        throw new Unauthorized({ message: "no" });
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Unauthorized);
    }

    try {
      await op.effect("boom", async () => {
        throw new Error("plain");
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(InternalError);
      expect((error as InternalError).message).toBe("plain");
    }
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

describe("db.run / db.query promise rejection identity", () => {
  test("await db.run rejects with OperationRejected itself, not a FiberFailure", async () => {
    const peer = fakePeer({
      http: (call) => {
        if (call.url.endsWith("/op")) {
          return {
            status: 409,
            body: {
              error: "denied",
              tag: "OperationRejected",
              message: "denied",
              operation: "user/create",
              reason: "policy",
            },
          };
        }
        return { body: { t: 1 } };
      },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);
    try {
      await db.run(createUser, { name: "Ada" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationRejected);
      expect((error as OperationRejected)._tag).toBe("OperationRejected");
      expect((error as OperationRejected).operation).toBe("user/create");
      expect((error as OperationRejected).name).toBe("OperationRejected");
      expect((error as OperationRejected).name).not.toBe("FiberFailure");
    }
    close();
  });

  test("await db.run rejects with TxRejected itself, not a FiberFailure", async () => {
    const peer = fakePeer({
      http: (call) => {
        if (call.url.endsWith("/op")) {
          return {
            status: 409,
            body: {
              error: "unique conflict",
              tag: "TxRejected",
              message: "unique conflict",
              code: "tx/unique-conflict",
              attr: ":user/name",
            },
          };
        }
        return { body: { t: 1 } };
      },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);
    try {
      await db.run(createUser, { name: "Ada" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TxRejected);
      expect((error as TxRejected)._tag).toBe("TxRejected");
      expect((error as TxRejected).code).toBe("tx/unique-conflict");
      expect((error as TxRejected).attr).toBe(":user/name");
      expect((error as Error).name).not.toBe("FiberFailure");
      expect((error as { constructor?: { name?: string } }).constructor?.name).not.toBe(
        "FiberFailure",
      );
    }
    close();
  });
});

describe("optional add", () => {
  test("add(undefined | null) is encoded as a nil datom — the transactor rejects it", () => {
    const tx = txBuilder(Movies);
    const e = Effect.runSync(tx.entity());
    Effect.runSync(e.set(User.name, "Ada"));
    Effect.runSync(e.set(User.age, undefined as never));
    Effect.runSync(e.set(User.age, null as never));
    expect(tx.spec.ops).toEqual([
      [":db/add", "tmp-1", ":user/name", "Ada"],
      [":db/add", "tmp-1", ":user/age", undefined],
      [":db/add", "tmp-1", ":user/age", null],
    ]);
  });
});
