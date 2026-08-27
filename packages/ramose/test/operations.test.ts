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
  Entity,
  Field,
  Operation,
  Schema as DbSchema,
  Operations,
  OperationsCoverageError,
  OperationRejected,
  PrefixHalt,
  Query,
  TxRejected,
  Unauthorized,
  checkOperationsCoverage,
  defineOperations,
  txBuilder,
  tempid,
  type Op,
  txOps,
  seedWrite,
} from "../src/db/internal.ts";
import { BodyFailed, asPromiseOp, buildOp, runBody } from "../src/db/op-handle.ts";
import { isDatabaseError } from "../src/db/Errors.ts";
import { asLookupRef, lowerEntityArg, materializeOutput } from "../src/db/Operation.ts";
import { schemaTx } from "../src/db/ensure.ts";
import { client, scriptedPeer, httpsClient, settle, until, type Call } from "./peer.ts";
import { Movie, Movies, User } from "./db/fixture.ts";

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
const ages = Query.q(() =>
  pipe(Query.entities(User), Query.select({ name: User.name, age: User.age })),
);

describe("materializeOutput", () => {
  test("resolves a returned handle through the writer's tempids", () => {
    const handle = { _tag: "TxHandle", eid: "tmp-1" };
    expect(materializeOutput({ id: handle }, { "tmp-1": 42 })).toEqual({
      id: 42,
    });
  });
});

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
      ":db/optional": true,
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

  test("defineOperations binds the catalog and lists ids and cards", () => {
    const documented = Operation(
      "user/set-name",
      {
        on: User,
        input: Schema.Struct({ name: Schema.String }),
        output: Schema.Struct({}),
        doc: "Rename a user",
      },
      (op, input) => {
        op.set(op.self, User.name, input.name);
        return {};
      },
    );
    const ops = defineOperations(Movies, { createUser, documented });
    expect(ops.schema).toBe(Movies);
    expect(ops.names()).toEqual(["user/create", "user/set-name"]);
    expect(ops.cards()).toEqual([
      { name: "user/create" },
      { name: "user/set-name", doc: "Rename a user", on: "user" },
    ]);
    expect(ops.get("user/set-name")?.doc).toBe("Rename a user");
  });

  test("Operation.patch is a one-line contextual update", () => {
    const setTitle = Operation.patch("movie/set-title", Movie, ["title"], {
      doc: "Set a movie title",
    });
    expect(setTitle.name).toBe("movie/set-title");
    expect(setTitle.on).toBe(Movie);
    expect(setTitle.doc).toBe("Set a movie title");
  });

  test("coverage check fails when an id is missing", () => {
    const client = defineOperations(Movies, { createUser, setName });
    const peer = defineOperations(Movies, { createUser });
    expect(() => checkOperationsCoverage(client, peer)).toThrow(
      OperationsCoverageError,
    );
    try {
      checkOperationsCoverage(client, peer);
      throw new Error("expected coverage failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationsCoverageError);
      expect((error as OperationsCoverageError).missing).toEqual(["user/set-name"]);
      expect((error as OperationsCoverageError).message).toMatch(
        /missing operations: user\/set-name/,
      );
    }
  });

  test("coverage check accepts extra peer ops and matching ids", () => {
    const client = defineOperations(Movies, { createUser });
    const peer = defineOperations(Movies, { createUser, setName });
    expect(() => checkOperationsCoverage(client, peer)).not.toThrow();
    expect(() =>
      checkOperationsCoverage(["user/create"], ["user/create", "user/set-name"]),
    ).not.toThrow();
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

    const peer = scriptedPeer({ http });
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
    const peer = scriptedPeer({
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
      seedWrite(db, function* (tx) {
        const e = yield* tx.entity(tx.tempid("new"));
        yield* e.set(User.name, "Ada");
      }),
    );
    await settle();
    const second = db.run(setName, tempid("new"), { name: "Ada Lovelace" });
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

describe("BodyFailed carries the body's throw", () => {
  const throwing = (thrown: unknown) => ({
    body: async (_op: Op) => {
      throw thrown;
    },
  });
  const failureOf = (thrown: unknown): Promise<unknown> =>
    Effect.runPromise(runBody(throwing(thrown), stubOp("run").op, {})).then(
      () => null,
      (e: unknown) => e,
    );

  // Callers unwrap with `err instanceof BodyFailed`, so the
  // class identity has to survive the rejection, not just the shape.
  test("runPromise rejects with the BodyFailed instance", async () => {
    const thrown = new OperationRejected({ message: "no", operation: "x" });
    const err = await failureOf(thrown);
    expect(err).toBeInstanceOf(BodyFailed);
    expect((err as BodyFailed).cause).toBe(thrown);
  });

  // `overlay.ts` classifies `cause`; a thrown DbError has to stay one rather
  // than being re-classified as an opaque tx failure.
  test("a thrown DbError is still a DbError under .cause", async () => {
    const err = await failureOf(new TxRejected({ message: "bad", code: "dangling" }));
    const cause = (err as BodyFailed).cause;
    expect(isDatabaseError(cause)).toBe(true);
    expect((cause as TxRejected)._tag).toBe("TxRejected");
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
    const peer = scriptedPeer({
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
    const peer = scriptedPeer();
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
    const peer = scriptedPeer({
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
    const peer = scriptedPeer({
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
    expect(lowerEntityArg(1001)).toBe(1001);
    expect(lowerEntityArg({ _tag: "TxHandle", eid: { id: 1001 } })).toBe(1001);
    expect(lowerEntityArg({ eid: 7, class: "admin" })).toBe(7);
    expect(lowerEntityArg({ eid: null, class: "admin" })).toBeUndefined();
  });

  test("db.run looks up [attr, value] on the overlay and posts the lookup", async () => {
    const server = await moviesWorld();
    await server.transact([{ ":user/name": "Ada" }]);
    const opBodies: { entity?: unknown }[] = [];
    const peer = scriptedPeer({
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
    ada.set(User.bestFriend, op.tempid("bea"));
    const bea = op.entity(op.tempid("bea"));
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

  test("a handle in a ref value slot lowers to its eid", async () => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(Movies) as unknown[]);
    const seeded = await conn.transact([{ ":db/id": "ada", ":user/name": "Ada" }]);
    const adaEid = seeded.tempids.ada!;

    const built = buildOp({
      schema: Movies,
      db: "movies",
      principal: { eid: null, class: "admin", claims: {} },
      self: adaEid,
      effects: "run",
      q: () => Effect.succeed([]),
      pull: () => Effect.succeed(null),
    });
    const op = asPromiseOp(built.op);
    const other = op.entity();
    other.set(User.name, "Bea");
    other.set(User.bestFriend, op.self);
    expect((built.ops()[1] as unknown[])[3]).toBe(adaEid);

    const expansion = await conn.transact([...built.ops()]);
    const beaEid = expansion.tempids["tmp-1"];
    expect(typeof beaEid).toBe("number");
    const row = await conn.db().entity(beaEid!);
    expect(row?.[":user/bestFriend"]).toBe(adaEid);
  });
});

describe("optional add", () => {
  test("add(undefined | null) is encoded as a nil datom — the transactor rejects it", () => {
    const tx = txBuilder(Movies);
    const e = Effect.runSync(tx.entity());
    Effect.runSync(e.set(User.name, "Ada"));
    Effect.runSync(e.set(User.age, undefined as never));
    Effect.runSync(e.set(User.age, null as never));
    expect(txOps(tx)).toEqual([
      [":db/add", "tmp-1", ":user/name", "Ada"],
      [":db/add", "tmp-1", ":user/age", undefined],
      [":db/add", "tmp-1", ":user/age", null],
    ]);
  });
});

describe("put", () => {
  const createByPut = Operation(
    "user/create-put",
    {
      schema: Movies,
      input: Schema.Struct({
        name: Schema.String,
        age: Schema.optional(Schema.Finite),
      }),
      output: Schema.Struct({}),
    },
    (op, input) => {
      op.put(User, { name: input.name, age: input.age });
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

  test("processTx: put with a unique field unifies on identity", async () => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(Movies) as unknown[]);

    const create = txBuilder(Movies);
    Effect.runSync(create.put(User, { name: "Ada", age: 36 }));
    const first = await conn.transact([...txOps(create)]);
    const ada = first.tempids["tmp-1"];
    expect(typeof ada).toBe("number");
    expect((await conn.db().entity(ada!))?.[":user/age"]).toBe(36);

    const again = txBuilder(Movies);
    Effect.runSync(again.put(User, { name: "Ada", age: 37 }));
    const second = await conn.transact([...txOps(again)]);
    expect(second.tempids["tmp-1"]).toBe(ada);
    expect((await conn.db().entity(ada!))?.[":user/age"]).toBe(37);

    await expect(
      conn.transact([[":db/add", [":user/name", "Missing"], ":user/age", 1]]),
    ).rejects.toThrow(/lookup ref/);
  });

  test("processTx: card-many string pair that looks like a lookup writes two values", async () => {
    const Doc = Entity("doc", {
      tags: Field.many(Schema.String),
    });
    const Docs = DbSchema({ doc: Doc });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Docs) as unknown[]);

    const tx = txBuilder(Docs);
    Effect.runSync(tx.put(Doc, { tags: [":alpha", "beta"] }));
    const rep = await conn.transact([...txOps(tx)]);
    const eid = rep.tempids["tmp-1"];
    expect(typeof eid).toBe("number");
    const row = await conn.db().entity(eid!);
    const tags = row?.[":doc/tags"];
    expect(Array.isArray(tags) ? [...tags].sort() : tags).toEqual([":alpha", "beta"]);
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
    const peer = scriptedPeer({ http });
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

  test("db.run(put) with a unique field unifies a second write onto the same row", async () => {
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
    const peer = scriptedPeer({ http });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    await seedClient(peer, db, server);

    await db.run(createByPut, { name: "Ada", age: 36 });
    await db.run(createByPut, { name: "Ada", age: 37 });
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
