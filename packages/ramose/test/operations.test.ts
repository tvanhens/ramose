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
  InvalidRequest,
  Operation,
  Operations,
  OperationRejected,
  PrefixHalt,
  Query,
  TxRejected,
  Unauthorized,
  txBuilder,
  type Op,
} from "../src/db/internal.ts";
import { asPromiseOp, buildOp, runBody } from "../src/db/op-handle.ts";
import { asLookupRef, lowerEntityArg } from "../src/db/Operation.ts";
import { schemaTx } from "../src/db/ensure.ts";
import { client, fakePeer, httpsClient, settle, until, type Call } from "./peer.ts";
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
    await until(() => live.seen.length >= 1);
    expect(live.seen.at(-1)).toEqual([]);

    const pending = db.run(createUser, { name: "Ada" });
    await until(() =>
      (live.seen.at(-1) as readonly { name: string }[] | undefined)?.some(
        (r) => r.name === "Ada",
      ) === true,
    );
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
    await until(() => live.seen.length >= 1);

    const pending = runFail(db.run(createUser, { name: "Ada" }));
    await until(() =>
      (live.seen.at(-1) as readonly { name: string }[] | undefined)?.some(
        (r) => r.name === "Ada",
      ) === true,
    );
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    release();
    const err = await pending;
    expect(err).toBeInstanceOf(OperationRejected);
    expect((err as OperationRejected)._tag).toBe("OperationRejected");
    await until(() =>
      Array.isArray(live.seen.at(-1)) && (live.seen.at(-1) as unknown[]).length === 0,
    );
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
      body: async (op: Op) => {
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

const brokenRead = Operation(
  "user/broken-read",
  {
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  async (op) => {
    await op.query(Query.q(() => Query.entities(User)).after(null));
    return {};
  },
);

describe("db.run wire", () => {
  test("an unlowerable query in op.query is InvalidRequest, not InternalError", async () => {
    const server = await moviesWorld();
    const peer = fakePeer({
      http: (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        return { body: { t: server.t } };
      },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);
    const err = await runFail(db.run(brokenRead, {}));
    expect(err).toBeInstanceOf(InvalidRequest);
    expect((err as InvalidRequest).message).toMatch(/sorted query/);
    await c.dispose();
  });

  test("a contextual op without an entity is InvalidRequest", async () => {
    const peer = fakePeer();
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const err = await runFail(
      // @ts-expect-error contextual op requires an entity
      db.run(setName, undefined, { name: "x" }),
    );
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

describe("lookup-shaped entity args", () => {
  test("lowerEntityArg sends [attr, value] as an ident lookup", () => {
    expect(lowerEntityArg([":user/name", "Ada"])).toEqual([":user/name", "Ada"]);
    expect(lowerEntityArg([User.name, "Ada"])).toEqual([":user/name", "Ada"]);
    expect(asLookupRef([User.name, "Ada"])).toEqual([":user/name", "Ada"]);
    expect(lowerEntityArg({ id: 1001 })).toBe(1001);
    expect(lowerEntityArg("tmp-1")).toBe("tmp-1");
  });

  test("db.run looks up [attr, value] on the overlay and posts the lookup", async () => {
    const server = await moviesWorld();
    await server.transact([{ ":user/name": "Ada" }]);
    const opBodies: { entity?: unknown }[] = [];
    const peer = fakePeer({
      http: async (call) => {
        if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
        if (call.url.endsWith("/op")) {
          opBodies.push({ entity: call.body.entity });
          const eid =
            typeof call.body.entity === "number"
              ? call.body.entity
              : await server.db().entid(call.body.entity as [string, unknown]);
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

    const live = collect(db.effect.live(names));
    await until(() => live.seen.length >= 1);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);

    const pending = db.run(setName, [":user/name", "Ada"] as const, {
      name: "Ada Lovelace",
    });
    await until(
      () =>
        (live.seen.at(-1) as readonly { name: string }[] | undefined)?.some(
          (r) => r.name === "Ada Lovelace",
        ) === true,
    );
    const report = await pending;
    expect(report.output).toEqual({});
    expect(opBodies).toHaveLength(1);
    expect(opBodies[0]!.entity).toEqual([":user/name", "Ada"]);
    expect(await db.query(names)).toEqual([{ name: "Ada Lovelace" }]);

    await live.stop();
    await c.dispose();
  });
});

describe("ref tempid create-and-link", () => {
  test("op.self.set(ref, tempid) allocates the target like the transactor", async () => {
    const built = stubOp("run");
    const op = asPromiseOp(built.op);
    const ada = op.entity();
    ada.set(User.name, "Ada");
    ada.set(User.bestFriend, "bea");
    const bea = op.entity("bea");
    bea.set(User.name, "Bea");
    expect(built.ops()).toEqual([
      [":db/add", "tmp-1", ":user/name", "Ada"],
      [":db/add", "tmp-1", ":user/bestFriend", "bea"],
      [":db/add", "bea", ":user/name", "Bea"],
    ]);

    const conn = await Connection.create();
    await conn.transact(schemaTx(Movies) as unknown[]);
    const expansion = await conn.transact([...built.ops()]);
    const adaEid = expansion.tempids["tmp-1"];
    const beaEid = expansion.tempids.bea;
    expect(typeof adaEid).toBe("number");
    expect(typeof beaEid).toBe("number");
    const row = await conn.db().entity(adaEid!);
    expect(row?.[":user/bestFriend"]).toBe(beaEid);
    expect(row?.[":user/name"]).toBe("Ada");
  });

  test("a handle in a ref value slot is not unwrapped — use .eid", async () => {
    const built = buildOp({
      schema: Movies,
      db: "movies",
      principal: { eid: null, class: "admin", claims: {} },
      self: 1001,
      effects: "run",
      q: () => Effect.succeed([]),
      pull: () => Effect.succeed(null),
    });
    const op = asPromiseOp(built.op);
    const other = op.entity();
    other.set(User.bestFriend, op.self);
    expect((built.ops()[0] as unknown[])[3]).toEqual(
      expect.objectContaining({ _tag: "TxHandle" }),
    );

    const conn = await Connection.create();
    await conn.transact(schemaTx(Movies) as unknown[]);
    await expect(conn.transact([...built.ops()])).rejects.toThrow(
      /bad attribute key _tag/,
    );

    const viaEid = buildOp({
      schema: Movies,
      db: "movies",
      principal: { eid: null, class: "admin", claims: {} },
      self: 1001,
      effects: "run",
      q: () => Effect.succeed([]),
      pull: () => Effect.succeed(null),
    });
    const viaEidOp = asPromiseOp(viaEid.op);
    const linked = viaEidOp.entity();
    linked.set(User.name, "Bea");
    linked.set(User.bestFriend, viaEidOp.self.eid);
    expect((viaEid.ops()[1] as unknown[])[3]).toBe(1001);
    const expansion = await conn.transact([
      { ":db/id": 1001, ":user/name": "Ada" },
      ...viaEid.ops(),
    ]);
    const beaEid = expansion.tempids["tmp-1"];
    expect(typeof beaEid).toBe("number");
    const row = await conn.db().entity(beaEid!);
    expect(row?.[":user/bestFriend"]).toBe(1001);
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

describe("put / upsert", () => {
  const createByPut = Operation(
    "user/create-put",
    {
      schema: Movies,
      input: Schema.Struct({
        name: Schema.String,
        age: Schema.optional(Schema.Number),
      }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.put(User, { name: input.name, age: input.age });
      return {};
    },
  );

  const ensureUser = Operation(
    "user/ensure",
    {
      schema: Movies,
      input: Schema.Struct({ name: Schema.String, age: Schema.Number }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      const user = op.upsert(User.name, input.name);
      user.set(User.age, input.age);
      return {};
    },
  );

  test("op.put lowers to map form and omits undefined; set/remove stay the escape hatch", () => {
    const built = stubOp("run");
    const op = asPromiseOp(built.op);
    const bea = op.entity();
    bea.set(User.name, "Bea");
    op.put(User, {
      name: "Ada",
      age: undefined,
      friends: [bea],
    });
    op.put(User, 1001, { age: 36 });
    expect(built.ops()).toEqual([
      [":db/add", "tmp-1", ":user/name", "Bea"],
      {
        ":db/id": "tmp-2",
        ":user/name": "Ada",
        ":user/friends": ["tmp-1"],
      },
      { ":db/id": 1001, ":user/age": 36 },
    ]);
  });

  test("processTx: put creates; upsert unifies on unique identity", async () => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(Movies) as unknown[]);

    const create = txBuilder(Movies);
    Effect.runSync(create.put(User, { name: "Ada", age: 36 }));
    const first = await conn.transact([...create.spec.ops]);
    const ada = first.tempids["tmp-1"];
    expect(typeof ada).toBe("number");
    expect((await conn.db().entity(ada!))?.[":user/age"]).toBe(36);

    const again = txBuilder(Movies);
    const handle = Effect.runSync(again.upsert(User.name, "Ada"));
    Effect.runSync(handle.set(User.age, 37));
    const second = await conn.transact([...again.spec.ops]);
    expect(second.tempids["tmp-1"]).toBe(ada);
    expect((await conn.db().entity(ada!))?.[":user/age"]).toBe(37);

    await expect(
      conn.transact([[":db/add", [":user/name", "Missing"], ":user/age", 1]]),
    ).rejects.toThrow(/lookup ref/);
  });

  test("db.run(put) paints the overlay before POST /op", async () => {
    const server = await moviesWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
      if (!call.url.endsWith("/op")) return { body: { t: server.t } };
      await gate;
      const rep = await server.transact([{ ":user/name": call.body.input.name }]);
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
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);
    const live = collect(db.effect.live(names));
    await until(() => live.seen.length >= 1);

    const pending = db.run(createByPut, { name: "Ada" });
    await until(
      () =>
        (live.seen.at(-1) as readonly { name: string }[] | undefined)?.some(
          (r) => r.name === "Ada",
        ) === true,
    );
    release();
    await pending;
    expect(await db.query(names)).toEqual([{ name: "Ada" }]);
    await live.stop();
    await c.dispose();
  });

  test("db.run(upsert) unifies a second write onto the same row", async () => {
    const server = await moviesWorld();
    const http = async (call: Call) => {
      if (call.url.endsWith("/info")) return { body: infoBody(server.t) };
      if (!call.url.endsWith("/op")) return { body: { t: server.t } };
      const rep = await server.transact([
        { ":user/name": call.body.input.name, ":user/age": call.body.input.age },
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
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await db.run(ensureUser, { name: "Ada", age: 36 });
    await db.run(ensureUser, { name: "Ada", age: 37 });
    const rows = await db.query(
      Query.q(() =>
        pipe(
          Query.entities(User),
          Query.select({ name: User.name, age: User.age }),
        ),
      ),
    );
    expect(rows).toEqual([{ name: "Ada", age: 37 }]);
    await c.dispose();
  });
});
