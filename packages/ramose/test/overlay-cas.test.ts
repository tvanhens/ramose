/**
 * Overlay remapping for `:db/cas` — queued tx tuples, invocation.entity,
 * and invocation.input rewrite acknowledged named tempids as pure data.
 * Engine re-run uses a real `Connection` (not a peer double).
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Connection } from "../src/internal/core/conn.ts";
import { Index } from "../src/internal/core/index.ts";
import { processTx, TxError } from "../src/internal/core/tx.ts";
import {
  Operation,
  tempid,
} from "../src/db/internal.ts";
import { buildOp, runBody } from "../src/db/op-handle.ts";
import {
  collectOpInputTempidPaths,
  pruneAckedNamedIds,
  remapQueuedLayers,
  rewritePendingInvocation,
  rewritePendingTx,
  submitDespiteLocalTxError,
  type OverlayInFlightRecord,
  type OverlayRemapLayer,
} from "../src/db/overlay.ts";
import { catalogWorld } from "./overlay-seed.ts";
import { Movies, User } from "./db/fixture.ts";

const moviesWorld = () => catalogWorld(Movies);

const layer = (
  partial: Partial<OverlayRemapLayer> & Pick<OverlayRemapLayer, "tx">,
): OverlayRemapLayer => ({
  tempids: {},
  generated: new Set(),
  usedTempids: new Set(),
  inputPaths: [],
  ...partial,
});

const inflight = (
  partial: Partial<OverlayInFlightRecord> & Pick<OverlayInFlightRecord, "tx">,
): OverlayInFlightRecord => ({
  names: new Set(),
  usedTempids: new Set(),
  inputPaths: [],
  ...partial,
});

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

/** Re-run an operation body the way `/op` does — real engine, no peer. */
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
    ...(body.entity !== undefined ? { self: body.entity } : {}),
    effects: "run",
    ...(body.tempids !== undefined ? { resolvedTempids: body.tempids } : {}),
    q: () => Effect.succeed([]),
    pull: () => Effect.succeed(null),
  });
  await Effect.runPromise(
    runBody(
      operation,
      built.op,
      body.input,
      body.tempids !== undefined ? { resolved: body.tempids } : {},
    ),
  );
  return server.transact([...built.ops()]);
};

const trackOpInput = async (
  operation: Parameters<typeof runBody>[0],
  input: unknown,
): Promise<{
  paths: (readonly (string | number)[])[];
  used: Set<string>;
}> => {
  const { input: tracked, paths } = collectOpInputTempidPaths(input);
  const used = new Set<string>();
  const built = buildOp({
    schema: Movies,
    db: "movies",
    principal: { eid: null, class: "admin", claims: {} },
    effects: "halt",
    q: () => Effect.succeed([]),
    pull: () => Effect.succeed(null),
  });
  await Effect.runPromise(
    runBody(operation, built.op, tracked, {
      onTempid: (name) => used.add(name),
    }),
  );
  return { paths, used };
};

const failProcessTx = async (
  conn: Connection,
  tx: readonly unknown[],
): Promise<TxError> => {
  try {
    await processTx(
      conn.db(),
      [...tx],
      conn.t + 1,
      conn.nextEntityId,
      Date.now(),
    );
    throw new Error("expected processTx to reject");
  } catch (err) {
    if (err instanceof TxError) return err;
    throw err;
  }
};

describe("overlay CAS remapping", () => {
  test("queued rewrite remaps a CAS tempid subject to the acknowledged eid", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
    ]);
    const eid = minted.tempids.new!;
    const ids = { new: eid };

    expect(
      rewritePendingTx(
        [[":db/cas", "new", ":user/age", null, 42]],
        ids,
        schema,
      ),
    ).toEqual([[":db/cas", eid, ":user/age", null, 42]]);

    const queued = layer({
      tx: [[":db/cas", "new", ":user/age", null, 42]],
      usedTempids: new Set(["new"]),
    });
    const ackedNamed: Record<string, number> = {};
    remapQueuedLayers([queued], [], ackedNamed, ids, {}, schema);
    expect(queued.tx).toEqual([[":db/cas", eid, ":user/age", null, 42]]);
    expect(ackedNamed.new).toBe(eid);
  });

  test("queued rewrite remaps a CAS ref replacement tempid to the eid", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
      { ":db/id": "bea", ":user/name": "Bea" },
    ]);
    const ada = minted.tempids.new!;
    const bea = minted.tempids.bea!;
    const ids = { new: ada };

    expect(
      rewritePendingTx(
        [[":db/cas", bea, ":user/bestFriend", null, "new"]],
        ids,
        schema,
      ),
    ).toEqual([[":db/cas", bea, ":user/bestFriend", null, ada]]);

    const queued = layer({
      tx: [[":db/cas", bea, ":user/bestFriend", null, "new"]],
      usedTempids: new Set(["new"]),
    });
    remapQueuedLayers([queued], [], {}, ids, {}, schema);
    expect(queued.tx).toEqual([[":db/cas", bea, ":user/bestFriend", null, ada]]);
  });

  test("queued rewrite remaps a CAS expected ref named tempid to the eid", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
      { ":db/id": "bea", ":user/name": "Bea" },
      { ":db/id": "cal", ":user/name": "Cal" },
    ]);
    const ada = minted.tempids.new!;
    const bea = minted.tempids.bea!;
    const cal = minted.tempids.cal!;

    expect(
      rewritePendingTx(
        [[":db/cas", bea, ":user/bestFriend", "new", cal]],
        { new: ada },
        schema,
      ),
    ).toEqual([[":db/cas", bea, ":user/bestFriend", ada, cal]]);

    const queued = layer({
      tx: [[":db/cas", bea, ":user/bestFriend", "new", cal]],
      usedTempids: new Set(["new"]),
    });
    remapQueuedLayers([queued], [], {}, { new: ada }, {}, schema);
    expect(queued.tx).toEqual([[":db/cas", bea, ":user/bestFriend", ada, cal]]);
  });

  test("non-ref CAS expected/replacement strings that equal a tempid name stay strings", async () => {
    // Scalar slots are also pinned in required-update.test.ts (Staffs title).
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    expect(
      rewritePendingTx(
        [[":db/cas", "new", ":user/name", "new", "new"]],
        { new: 2002 },
        schema,
      ),
    ).toEqual([[":db/cas", 2002, ":user/name", "new", "new"]]);
  });

  test("after the queue drains, pruneAckedNamedIds drops \"new\" so a later tempid is not rewritten", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
    ]);
    const eid = minted.tempids.new!;
    const queued = layer({
      tx: [[":db/cas", "new", ":user/age", null, 42]],
      tempids: { new: eid },
      usedTempids: new Set(["new"]),
    });
    const ackedNamed: Record<string, number> = {};
    remapQueuedLayers([queued], [], ackedNamed, { new: eid }, { new: eid }, schema);
    expect(ackedNamed.new).toBe(eid);

    pruneAckedNamedIds(ackedNamed, [], [], schema);
    expect(ackedNamed).toEqual({});
    expect(
      rewritePendingTx(
        [[":db/add", "new", ":user/name", "Bea"]],
        ackedNamed,
        schema,
      ),
    ).toEqual([[":db/add", "new", ":user/name", "Bea"]]);
  });

  test("in-flight no-layer record is remapped the same way as pending", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Cal" },
    ]);
    const eid = minted.tempids.new!;
    const rec = inflight({
      names: new Set(["new"]),
      usedTempids: new Set(["new"]),
      tx: [
        [":db/add", "new", ":user/name", "Bea"],
        [":db/cas", "new", ":user/age", null, 32],
      ],
    });
    const ackedNamed: Record<string, number> = {};
    remapQueuedLayers([], [rec], ackedNamed, { new: eid }, {}, schema);
    expect(rec.tx).toEqual([
      [":db/add", eid, ":user/name", "Bea"],
      [":db/cas", eid, ":user/age", null, 32],
    ]);
    expect(ackedNamed.new).toBe(eid);
  });

  test("resync / empty queue: prune leaves ackedNamed empty", async () => {
    const ackedNamed: Record<string, number> = { new: 1754 };
    pruneAckedNamedIds(ackedNamed, [], []);
    expect(ackedNamed).toEqual({});
  });

  test("generated tmp-1 is per-layer; explicit name \"new\" is shared even if the later layer allocated it", async () => {
    const conn = await moviesWorld();
    const schema = conn.db().schema;
    const generated = layer({
      tx: [[":db/cas", "tmp-1", ":user/age", null, 1]],
      tempids: { "tmp-1": 3001 },
      generated: new Set(["tmp-1"]),
    });
    const named = layer({
      tx: [[":db/cas", "new", ":user/age", null, 2]],
      tempids: { new: 4001 },
      usedTempids: new Set(["new"]),
    });
    const ackedNamed: Record<string, number> = {};
    remapQueuedLayers(
      [generated, named],
      [],
      ackedNamed,
      { "tmp-1": 2001, new: 1001 },
      { "tmp-1": 3001, new: 4001 },
      schema,
    );
    expect(generated.tx).toEqual([[":db/cas", "tmp-1", ":user/age", null, 1]]);
    expect(named.tx).toEqual([[":db/cas", 1001, ":user/age", null, 2]]);
    expect(ackedNamed["tmp-1"]).toBeUndefined();
    expect(ackedNamed.new).toBe(1001);
  });

  test("tempid(\"tmp-1\") throws", () => {
    expect(() => tempid("tmp-1")).toThrow(
      "ramose: tempid names matching tmp-<n> are reserved for the transaction builder",
    );
  });
});

describe("overlay CAS invocation remapping", () => {
  test("rewrites input.target used by op.cas(op.tempid) and leaves title \"new\"", async () => {
    const conn = await moviesWorld();
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
    ]);
    const eid = minted.tempids.new!;
    const input = { target: "new", title: "new" };
    const { paths, used } = await trackOpInput(casViaInput, input);
    expect(paths).toEqual([["target"]]);
    expect(used.has("new")).toBe(true);

    const rewritten = rewritePendingInvocation(
      { name: "user/cas-via-input", input, clientOpId: "op-1" },
      { new: eid },
      new Map(),
      used,
      paths,
    );
    expect(rewritten.input).toEqual({ target: eid, title: "new" });
    expect(rewritten.tempids).toEqual({ new: eid });

    const queued = layer({
      tx: [[":db/cas", "new", ":user/age", null, 42]],
      usedTempids: used,
      inputPaths: paths,
      invocation: { name: "user/cas-via-input", input, clientOpId: "op-1" },
    });
    remapQueuedLayers([queued], [], {}, { new: eid }, {}, conn.db().schema);
    expect(queued.invocation?.input).toEqual({ target: eid, title: "new" });
    expect(queued.invocation?.tempids).toEqual({ new: eid });
  });

  test("rewrites a nested input tempid used by op.cas(op.tempid)", async () => {
    const conn = await moviesWorld();
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Ada" },
    ]);
    const eid = minted.tempids.new!;
    const input = { nested: { target: "new" } };
    const { paths, used } = await trackOpInput(nestedCasViaInput, input);
    expect(paths).toEqual([["nested", "target"]]);

    const rewritten = rewritePendingInvocation(
      { name: "user/cas-via-nested-input", input, clientOpId: "op-2" },
      { new: eid },
      new Map(),
      used,
      paths,
    );
    expect(rewritten.input).toEqual({ nested: { target: eid } });

    const queued = layer({
      tx: [[":db/cas", "new", ":user/age", null, 7]],
      usedTempids: used,
      inputPaths: paths,
      invocation: { name: "user/cas-via-nested-input", input, clientOpId: "op-2" },
    });
    remapQueuedLayers([queued], [], {}, { new: eid }, {}, conn.db().schema);
    expect(queued.invocation?.input).toEqual({ nested: { target: eid } });
  });

  test("contextual invocation.entity named tempid remaps to eid on a no-layer inFlight", async () => {
    const conn = await moviesWorld();
    const minted = await conn.transact([
      { ":db/id": "new", ":user/name": "Cal" },
    ]);
    const eid = minted.tempids.new!;
    const rec = inflight({
      names: new Set(["new"]),
      usedTempids: new Set(["new"]),
      tx: [[":db/cas", 99, ":user/age", 31, 32]],
      invocation: {
        name: "user/stale-cas",
        entity: "new",
        input: { eid: 99 },
        clientOpId: "op-3",
      },
    });
    remapQueuedLayers([], [rec], {}, { new: eid }, {}, conn.db().schema);
    expect(rec.invocation?.entity).toBe(eid);
    expect(rec.invocation?.entity).not.toBe("new");
  });

  test("after prune, a later invocation entity \"new\" is not rewritten", async () => {
    const ackedNamed: Record<string, number> = { new: 1754 };
    const held = inflight({
      names: new Set(["new"]),
      usedTempids: new Set(["new"]),
      tx: [],
      invocation: {
        name: "user/stale-cas",
        entity: "new",
        input: {},
        clientOpId: "op-hold",
      },
    });
    pruneAckedNamedIds(ackedNamed, [], [held]);
    expect(ackedNamed.new).toBe(1754);

    pruneAckedNamedIds(ackedNamed, [], []);
    expect(ackedNamed).toEqual({});

    const later = rewritePendingInvocation(
      { name: "user/later", entity: "new", input: {}, clientOpId: "op-4" },
      ackedNamed,
      new Map(),
      new Set(["new"]),
    );
    expect(later.entity).toBe("new");
  });
});

describe("overlay CAS engine re-run", () => {
  test("remapped /op body CAS updates the minted entity, not a newly allocated one", async () => {
    const server = await moviesWorld();
    const minted = await server.transact([
      { ":db/id": "new", ":user/name": "Ada" },
    ]);
    const adaEid = minted.tempids.new!;
    const input = { target: "new", title: "new" };
    const { paths, used } = await trackOpInput(casViaInput, input);
    const remapped = rewritePendingInvocation(
      { name: "user/cas-via-input", input, clientOpId: "op-rerun" },
      { new: adaEid },
      new Map(),
      used,
      paths,
    );
    expect(remapped.input).toEqual({ target: adaEid, title: "new" });
    expect(remapped.tempids).toEqual({ new: adaEid });

    await rerunPostedOp(casViaInput, remapped, server);
    expect((await server.db().entity(adaEid))![":user/age"]).toBe(42);
    expect((await server.db().entity(adaEid))![":user/name"]).toBe("Ada");
    const nameAttr = server.db().attr(":user/name")!.id;
    const named = await server.db().datomsArray(Index.AVET, { a: nameAttr });
    expect(named.filter((d) => d.op).map((d) => d.e)).toEqual([adaEid]);
  });
});

describe("overlay CAS speculative submit policy", () => {
  test("stale replica CAS is tx/cas-conflict locally, still submitted, and commits on the fresher Connection", async () => {
    const replica = await moviesWorld();
    const seeded = await replica.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;
    const casTx = [[":db/cas", eid, ":user/age", 31, 32]];
    const err = await failProcessTx(replica, casTx);
    expect(err.code).toBe("tx/cas-conflict");
    expect(submitDespiteLocalTxError(err, casTx)).toBe(true);
    expect((await replica.db().entity(eid))![":user/age"]).toBe(30);

    const server = await moviesWorld();
    const fresh = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 31 },
    ]);
    expect(fresh.tempids.u).toBe(eid);
    await server.transact(casTx);
    expect((await server.db().entity(eid))![":user/age"]).toBe(32);
  });

  test("missing-entity CAS still submits; a fresher Connection that has the entity commits", async () => {
    const replica = await moviesWorld();
    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    const eid = seeded.tempids.u!;
    const casTx = [[":db/cas", eid, ":user/age", 30, 31]];
    const err = await failProcessTx(replica, casTx);
    expect(err.code).toBe("tx/missing-entity");
    expect(submitDespiteLocalTxError(err, casTx)).toBe(true);

    await server.transact(casTx);
    expect((await server.db().entity(eid))![":user/age"]).toBe(31);
  });

  test("lookup-ref CAS still submits; a Connection that resolves the lookup commits", async () => {
    const replica = await moviesWorld();
    const casTx = [[":db/cas", [":user/name", "Ada"], ":user/age", 30, 31]];
    const err = await failProcessTx(replica, casTx);
    expect(err.code).toBe("tx/lookup-ref");
    expect(submitDespiteLocalTxError(err, casTx)).toBe(true);

    const server = await moviesWorld();
    const seeded = await server.transact([
      { ":db/id": "u", ":user/name": "Ada", ":user/age": 30 },
    ]);
    await server.transact(casTx);
    expect((await server.db().entity(seeded.tempids.u!))![":user/age"]).toBe(31);
  });

  test("a non-CAS tx/missing-entity is not submitted", async () => {
    const replica = await moviesWorld();
    const tx = [[":db/add", 99_999, ":user/age", 1]];
    const err = await failProcessTx(replica, tx);
    expect(err.code).toBe("tx/missing-entity");
    expect(submitDespiteLocalTxError(err, tx)).toBe(false);
  });
});
