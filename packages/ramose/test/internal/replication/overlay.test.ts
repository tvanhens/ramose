/**
 * The deterministic speculative overlay (#476 slice 1).
 *
 * The committed value here is built exactly the way a restored replica is —
 * canonical replica attributes, the replica's own schema datoms, facts through
 * `replicaFactDatom`, roots over the engine's own node store — so the overlay
 * is exercised against a real `Db`, and the real query engine and pull answer
 * every question about it. Durability and the observation fence are slice 2.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  runProjection,
  type ProjectionChangeset,
  type ProjectionField,
  type ProjectionTx,
} from "../../../src/db/Projection.ts";
import {
  clientRef,
  invocationId,
  unsafeEntityId,
  type ClientRef,
  type MutationRef,
  type EntityId,
  type InvocationId,
} from "../../../src/db/refs.ts";
import { buildRoots } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag, type Datom } from "../../../src/internal/core/datom.ts";
import { Db } from "../../../src/internal/core/db.ts";
import { Novelty } from "../../../src/internal/core/novelty.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import {
  FIRST_USER_EID,
  Schema,
  type AttributeSpec,
} from "../../../src/internal/core/schema.ts";
import { MemStore } from "../../../src/internal/core/store.ts";
import type { OverlayLayer, OverlayLayers } from "../../../src/internal/replication/overlay-layers.ts";
import {
  projectOverlay,
  type OverlayResolver,
  type OverlayView,
} from "../../../src/internal/replication/overlay.ts";
import {
  REPLICA_USER_T,
  replicaAttributes,
  replicaBootstrapDatoms,
  replicaSchema,
} from "../../../src/internal/replication/replica-schema.ts";

const ATTRS: AttributeSpec[] = [
  { ident: ":issue/title", valueType: ":db.type/string", cardinality: "one", index: true, optional: true },
  { ident: ":issue/rank", valueType: ":db.type/long", cardinality: "one", index: true, optional: true },
  { ident: ":issue/key", valueType: ":db.type/uuid", cardinality: "one", optional: true },
  { ident: ":issue/owner", valueType: ":db.type/ref", cardinality: "one", optional: true },
  { ident: ":issue/tags", valueType: ":db.type/string", cardinality: "many" },
  { ident: ":user/name", valueType: ":db.type/string", cardinality: "one", optional: true },
];

const Issue = { ns: "Issue" };
const title: ProjectionField = { ident: ":issue/title", valueType: "string" };
const rank: ProjectionField = { ident: ":issue/rank", valueType: "long" };
const key: ProjectionField = { ident: ":issue/key", valueType: "uuid" };
const owner: ProjectionField = { ident: ":issue/owner", valueType: "ref" };
const tags: ProjectionField = { ident: ":issue/tags", valueType: "string" };
const missing: ProjectionField = { ident: ":issue/nope", valueType: "string" };
const mistyped: ProjectionField = { ident: ":issue/rank", valueType: "string" };

const handle = (fill: string): EntityId =>
  unsafeEntityId(fill.repeat(54).slice(0, 54) + "A");
const ALPHA = handle("A");
const BETA = handle("B");
const USER = handle("C");
/** Authoritative, but not in this replica yet. */
const UNSEEN = handle("D");
/** A handle this client has simply never been given. */
const STRANGER = handle("E");

let committed: Db;
let alpha: number;
let beta: number;
let user: number;
let held: ReadonlyMap<string, number>;

beforeAll(async () => {
  const store = new MemStore();
  const specs = replicaAttributes(ATTRS);
  const bootstrap = Schema.bootstrap();
  const attributeIds = new Map<string, number>();
  let next = FIRST_USER_EID;
  for (const spec of specs) {
    if (bootstrap.attr(spec.ident) === undefined) attributeIds.set(spec.ident, next++);
  }
  const built = replicaSchema(specs, attributeIds)!;
  alpha = next++;
  beta = next++;
  user = next++;
  const a = (ident: string): number => built.schema.requireAttr(ident).id;
  const fact = (
    e: number,
    ident: string,
    vt: ValueTag,
    v: Datom["v"],
  ): Datom => ({ e, a: a(ident), vt, v, t: REPLICA_USER_T, op: true });
  const facts: Datom[] = [
    fact(alpha, ":ramose/type", ValueTag.Str, "Issue"),
    fact(alpha, ":issue/title", ValueTag.Str, "alpha"),
    fact(alpha, ":issue/rank", ValueTag.Long, 1),
    fact(alpha, ":issue/tags", ValueTag.Str, "red"),
    fact(alpha, ":issue/owner", ValueTag.Ref, user),
    fact(beta, ":ramose/type", ValueTag.Str, "Issue"),
    fact(beta, ":issue/title", ValueTag.Str, "beta"),
    fact(beta, ":issue/rank", ValueTag.Long, 2),
    fact(user, ":ramose/type", ValueTag.Str, "User"),
    fact(user, ":user/name", ValueTag.Str, "ada"),
  ];
  const roots = await buildRoots(
    store,
    built.schema,
    replicaBootstrapDatoms().concat(built.datoms, facts),
  );
  committed = new Db({
    store,
    roots,
    novelty: new Novelty(),
    basisT: roots.t,
    schema: built.schema,
    nextEid: next,
  });
  held = new Map([[ALPHA, alpha], [BETA, beta], [USER, user]]);
});

const resolver = (
  mappings: Readonly<Record<string, EntityId>> = {},
): OverlayResolver => ({
  entity: (id) => held.get(id),
  mapping: (ref) => mappings[ref],
});

const authored = (
  run: (tx: ProjectionTx) => void,
  allocations?: Readonly<Record<string, ClientRef>>,
): ProjectionChangeset => {
  const outcome = runProjection<null>(({ tx }) => run(tx), {
    input: null,
    ...(allocations === undefined ? {} : { allocations }),
  });
  if (outcome.type !== "changeset") throw new Error(outcome.reason);
  return outcome.changeset;
};

let sequence = 0;
const layer = (
  changeset: ProjectionChangeset,
  overrides: Partial<OverlayLayer> = {},
): OverlayLayer => ({
  invocation: invocationId(),
  sequence: ++sequence,
  state: "queued",
  activation: null,
  // Every ref the changeset names, unless a case is explicitly narrowing the
  // declared set: slice 2's durable row carries exactly this list.
  declared: declaredIn(changeset),
  changeset,
  ...overrides,
});

/** The refs a changeset names, as the durable layer would have recorded them. */
const declaredIn = (
  changeset: ProjectionChangeset,
): readonly MutationRef[] => {
  const refs = new Set<MutationRef>();
  for (const op of changeset) {
    refs.add(op.entity);
    if ((op.op === "set" || op.op === "remove") && op.value?.type === "ref") {
      refs.add(op.value.value);
    }
  }
  return [...refs];
};

const overlay = (
  layers: OverlayLayers,
  mappings?: Readonly<Record<string, EntityId>>,
): Promise<OverlayView> => projectOverlay(committed, layers, resolver(mappings));

const view = async (
  layers: OverlayLayers,
  mappings?: Readonly<Record<string, EntityId>>,
): Promise<Db> => (await overlay(layers, mappings)).db;

const dump = async (db: Db): Promise<readonly string[]> =>
  (await db.datomsArray(Index.EAVT, {})).map((d) =>
    `${d.e}|${d.a}|${d.vt}|${String(d.v)}|${d.t}|${d.op}`
  );

const titles = async (db: Db): Promise<readonly string[]> =>
  (await query(
    db,
    `[:find [?t ...] :where [?e :ramose/type "Issue"] [?e :issue/title ?t] :order ?t]`,
  )) as string[];

describe("the committed value is untouched", () => {
  test("no layers is the committed value itself", async () => {
    const result = await overlay([]);
    expect(result.db).toBe(committed);
    expect(result.refusals).toEqual([]);
    expect(result.speculative.size).toBe(0);
  });

  test("an overlay never mutates the value it was built from", async () => {
    const before = await dump(committed);
    await view([layer(authored((tx) => tx.set(ALPHA, title, "changed")))]);
    expect(await dump(committed)).toEqual(before);
    expect(await titles(committed)).toEqual(["alpha", "beta"]);
  });
});

describe("query membership", () => {
  test("a create becomes a member of its declared type immediately", async () => {
    const ref = clientRef();
    const db = await view([
      layer(authored((tx) => {
        tx.create("issue", Issue);
        tx.set(ref, title, "gamma");
      }, { issue: ref })),
    ]);
    expect(await titles(db)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a create with no fields is not yet anything a query can find", async () => {
    const ref = clientRef();
    const db = await view([
      layer(authored((tx) => {
        tx.create("issue", Issue);
      }, { issue: ref })),
    ]);
    expect(await titles(db)).toEqual(["alpha", "beta"]);
  });

  test("a delete leaves membership and every inbound reference", async () => {
    const db = await view([layer(authored((tx) => tx.delete(USER)))]);
    expect(await query(db, `[:find [?n ...] :where [?e :user/name ?n]]`)).toEqual([]);
    expect(
      await query(db, `[:find [?e ...] :where [?e :issue/owner ?u]]`),
    ).toEqual([]);
    // The issue itself survives; only the dangling reference is gone.
    expect(await titles(db)).toEqual(["alpha", "beta"]);
  });
});

describe("values", () => {
  test("a cardinality-one set replaces", async () => {
    const db = await view([layer(authored((tx) => tx.set(ALPHA, title, "omega")))]);
    expect(await titles(db)).toEqual(["beta", "omega"]);
    expect(await db.datomsArray(Index.EAVT, { e: alpha, a: committed.requireAttr(":issue/title").id }))
      .toHaveLength(1);
  });

  test("a cardinality-many set adds and remove takes one value back", async () => {
    const added = await view([layer(authored((tx) => tx.set(ALPHA, tags, "blue")))]);
    expect(
      ((await query(added, `[:find [?t ...] :where [?e :issue/tags ?t] :order ?t]`)) as string[]),
    ).toEqual(["blue", "red"]);
    const removed = await view([
      layer(authored((tx) => tx.set(ALPHA, tags, "blue").remove(ALPHA, tags, "red"))),
    ]);
    expect(
      await query(removed, `[:find [?t ...] :where [?e :issue/tags ?t]]`),
    ).toEqual(["blue"]);
  });

  test("remove with no value clears every value of the field", async () => {
    const db = await view([layer(authored((tx) => tx.remove(ALPHA, tags)))]);
    expect(await query(db, `[:find [?t ...] :where [?e :issue/tags ?t]]`)).toEqual([]);
  });

  test("sorting reflects the overlay", async () => {
    const ordered = `[:find [?t ...] :where [?e :issue/title ?t] [?e :issue/rank ?r] :order [?r :asc]]`;
    expect(await query(committed, ordered)).toEqual(["alpha", "beta"]);
    const db = await view([layer(authored((tx) => tx.set(ALPHA, rank, 9)))]);
    expect(await query(db, ordered)).toEqual(["beta", "alpha"]);
  });

  test("reference joins reflect the overlay", async () => {
    const joined = `[:find [?n ...] :where [?i :issue/title "beta"] [?i :issue/owner ?u] [?u :user/name ?n]]`;
    expect(await query(committed, joined)).toEqual([]);
    const db = await view([layer(authored((tx) => tx.set(BETA, owner, USER)))]);
    expect(await query(db, joined)).toEqual(["ada"]);
  });

  test("graph-local pulls reflect the overlay, forward and reverse", async () => {
    const db = await view([layer(authored((tx) => tx.set(BETA, owner, USER)))]);
    expect(await pull(db, beta, `[:issue/title {:issue/owner [:user/name]}]`)).toEqual({
      ":issue/title": "beta",
      ":issue/owner": { ":user/name": "ada" },
    });
    const reverse = await pull(db, user, `[{:issue/_owner [:issue/title]}]`) as {
      readonly ":issue/_owner": readonly { readonly ":issue/title": string }[];
    };
    expect(reverse[":issue/_owner"].map((row) => row[":issue/title"]).sort())
      .toEqual(["alpha", "beta"]);
  });
});

describe("layer order", () => {
  test("a second write inside one layer replaces the first", async () => {
    // The fold is per operation: two sets of one cardinality-one field in the
    // same projection must leave one value, exactly as two layers would.
    const db = await view([
      layer(authored((tx) => tx.set(ALPHA, title, "first").set(ALPHA, title, "second"))),
    ]);
    expect(await titles(db)).toEqual(["beta", "second"]);
    expect(
      await db.datomsArray(Index.EAVT, {
        e: alpha,
        a: committed.requireAttr(":issue/title").id,
      }),
    ).toHaveLength(1);
  });

  test("a remove inside one layer sees what an earlier set added", async () => {
    const db = await view([
      layer(authored((tx) => tx.set(ALPHA, tags, "blue").remove(ALPHA, tags, "blue"))),
    ]);
    expect(
      await query(db, `[:find [?t ...] :where [?e :issue/tags ?t]]`),
    ).toEqual(["red"]);
  });

  test("a create and its fields land in one layer", async () => {
    const ref = clientRef();
    const db = await view([
      layer(authored((tx) => {
        tx.create("issue", Issue);
        tx.set(ref, title, "one").set(ref, title, "two");
      }, { issue: ref })),
    ]);
    expect(await titles(db)).toEqual(["alpha", "beta", "two"]);
  });

  test("a later layer sees and overwrites an earlier one", async () => {
    const db = await view([
      layer(authored((tx) => tx.set(ALPHA, title, "first"))),
      layer(authored((tx) => tx.set(ALPHA, title, "second"))),
    ]);
    expect(await titles(db)).toEqual(["beta", "second"]);
  });

  test("a later layer can delete what an earlier one created", async () => {
    const ref = clientRef();
    const created = authored((tx) => {
      tx.create("issue", Issue);
      tx.set(ref, title, "gamma");
    }, { issue: ref });
    const db = await view([
      layer(created),
      layer(authored((tx) => tx.delete(ref))),
    ]);
    expect(await titles(db)).toEqual(["alpha", "beta"]);
  });

  test("the view is exactly the ordered fold, in the order given", async () => {
    const first = layer(authored((tx) => tx.set(ALPHA, rank, 10)));
    const second = layer(authored((tx) => tx.set(ALPHA, rank, 20)));
    const forward = await view([first, second]);
    const backward = await view([second, first]);
    expect(await query(forward, `[:find [?r ...] :where [?e :issue/title "alpha"] [?e :issue/rank ?r]]`))
      .toEqual([20]);
    expect(await query(backward, `[:find [?r ...] :where [?e :issue/title "alpha"] [?e :issue/rank ?r]]`))
      .toEqual([10]);
  });
});

describe("determinism", () => {
  test("the same replica and layers produce identical datoms", async () => {
    const ref = clientRef();
    const layers = [
      layer(authored((tx) => {
        tx.create("issue", Issue);
        tx.set(ref, title, "gamma").set(ref, owner, USER);
      }, { issue: ref })),
      layer(authored((tx) => tx.set(ALPHA, rank, 42).remove(ALPHA, tags))),
      layer(authored((tx) => tx.delete(BETA))),
    ];
    const left = await overlay(layers);
    const right = await overlay(layers);
    expect(await dump(left.db)).toEqual(await dump(right.db));
    expect([...left.speculative]).toEqual([...right.speculative]);
    expect(left.refusals).toEqual(right.refusals);
  });

  test("speculative ids come from the committed frontier, by first appearance", async () => {
    const first = clientRef();
    const second = clientRef();
    const result = await overlay([
      layer(authored((tx) => {
        tx.create("a", Issue);
        tx.create("b", Issue);
        tx.set(second, owner, first);
      }, { a: first, b: second })),
    ]);
    expect([...result.speculative]).toEqual([
      [first, committed.nextEid],
      [second, committed.nextEid + 1],
    ]);
  });
});

describe("the overlay's own frontier", () => {
  test("covers every speculative id, including a refused operation's", async () => {
    const ref = clientRef();
    const kept = clientRef();
    const result = await overlay([
      layer(authored((tx) => {
        tx.set(kept, title, "gamma").set(ref, mistyped, "x");
      })),
    ]);
    expect(result.refusals).toHaveLength(1);
    expect([...result.speculative.values()]).toEqual([
      committed.nextEid,
      committed.nextEid + 1,
    ]);
    expect(result.db.nextEid).toBe(committed.nextEid + 2);
  });
});

describe("client-ref aliasing", () => {
  test("a mapped ref and the handle it maps to are one entity", async () => {
    const ref = clientRef();
    const mappings = { [ref]: UNSEEN };
    const result = await overlay([
      layer(authored((tx) => {
        tx.create("issue", Issue);
        tx.set(ref, title, "gamma");
      }, { issue: ref })),
      layer(authored((tx) => tx.set(UNSEEN, rank, 7))),
    ], mappings);
    expect(await titles(result.db)).toEqual(["alpha", "beta", "gamma"]);
    const rows = await query(
      result.db,
      `[:find ?t ?r :where [?e :issue/title ?t] [?e :issue/rank ?r] :order [?r :asc]]`,
    );
    expect(rows).toEqual([[ "alpha", 1 ], [ "beta", 2 ], [ "gamma", 7 ]]);
    // One speculative entity, keyed by the authoritative handle — not two.
    expect([...result.speculative]).toEqual([[UNSEEN, committed.nextEid]]);
  });

  test("a mapping the replica already holds resolves to the committed row", async () => {
    const ref = clientRef();
    const result = await overlay([
      layer(authored((tx) => tx.set(ref, title, "renamed"))),
    ], { [ref]: ALPHA });
    expect(result.speculative.size).toBe(0);
    expect(await titles(result.db)).toEqual(["beta", "renamed"]);
  });

  test("an unmapped ref is speculative under its own name", async () => {
    const ref = clientRef();
    const result = await overlay([
      layer(authored((tx) => tx.set(ref, title, "gamma"))),
    ]);
    expect([...result.speculative]).toEqual([[ref, committed.nextEid]]);
  });
});

describe("rejection removes exactly one layer", () => {
  test("the rebuilt view equals a fresh build from the survivors", async () => {
    const first = layer(authored((tx) => tx.set(ALPHA, title, "one")));
    const rejected = layer(authored((tx) => tx.set(BETA, title, "two")));
    const third = layer(authored((tx) => tx.set(ALPHA, rank, 30)));
    expect(await titles(await view([first, rejected, third]))).toEqual(["one", "two"]);
    // Removing the middle layer replays the third at its new position; the
    // result is indistinguishable from never having queued the rejected one.
    const rebuilt = await view([first, third]);
    const fresh = await view([layer(first.changeset), layer(third.changeset)]);
    expect(await dump(rebuilt)).toEqual(await dump(fresh));
    expect(await titles(rebuilt)).toEqual(["beta", "one"]);
  });

  test("unrelated later layers survive a removal untouched", async () => {
    const withAll = await view([
      layer(authored((tx) => tx.set(ALPHA, title, "one"))),
      layer(authored((tx) => tx.set(BETA, title, "two"))),
      layer(authored((tx) => tx.set(BETA, rank, 30))),
    ]);
    expect(await titles(withAll)).toEqual(["one", "two"]);
    const without = await view([
      layer(authored((tx) => tx.set(ALPHA, title, "one"))),
      layer(authored((tx) => tx.set(BETA, rank, 30))),
    ]);
    expect(await titles(without)).toEqual(["beta", "one"]);
    expect(
      await query(without, `[:find [?r ...] :where [?e :issue/title "beta"] [?e :issue/rank ?r]]`),
    ).toEqual([30]);
  });
});

describe("refusals are recorded, never thrown", () => {
  const refusals = async (
    changeset: ProjectionChangeset,
  ): Promise<readonly string[]> => {
    const one = layer(changeset);
    const result = await projectOverlay(committed, [one], resolver());
    return result.refusals.map((refusal) => `${refusal.index}:${refusal.reason}`);
  };

  test("an unknown field, a mistyped value, and a bad uuid", async () => {
    expect(
      await refusals(authored((tx) => tx.set(ALPHA, missing, "x"))),
    ).toEqual(["0:unknown-field"]);
    expect(
      await refusals(authored((tx) => tx.set(ALPHA, mistyped, "x"))),
    ).toEqual(["0:value-type"]);
    expect(
      await refusals(authored((tx) => tx.set(ALPHA, key, "not-a-uuid"))),
    ).toEqual(["0:value-type"]);
  });

  test("a handle this client was never given is refused, not invented", async () => {
    expect(
      await refusals(authored((tx) => tx.set(STRANGER, title, "x"))),
    ).toEqual(["0:unknown-entity"]);
    expect(
      await refusals(authored((tx) => tx.set(ALPHA, owner, STRANGER))),
    ).toEqual(["0:unknown-entity"]);
    expect(
      await refusals(authored((tx) => tx.delete(STRANGER))),
    ).toEqual(["0:unknown-entity"]);
  });

  test("a refused operation does not stop the rest of its layer", async () => {
    const one = layer(authored((tx) => {
      tx.set(ALPHA, missing, "x").set(ALPHA, title, "kept");
    }));
    const result = await projectOverlay(committed, [one], resolver());
    expect(result.refusals).toEqual([
      { invocation: one.invocation, index: 0, reason: "unknown-field" },
    ]);
    expect(await titles(result.db)).toEqual(["beta", "kept"]);
  });

  test("a refusal names the invocation it came from", async () => {
    const first = layer(authored((tx) => tx.set(ALPHA, title, "ok")));
    const second = layer(authored((tx) => tx.set(STRANGER, title, "no")));
    const result = await projectOverlay(committed, [first, second], resolver());
    expect(result.refusals.map((r) => r.invocation)).toEqual([second.invocation]);
  });
});

describe("commit does not change the view", () => {
  test("stamping a layer committed-unobserved leaves every datom in place", async () => {
    const changeset = authored((tx) => tx.set(ALPHA, title, "pending"));
    const invocation: InvocationId = invocationId();
    const queued = layer(changeset, { invocation });
    const committedUnobserved = layer(changeset, {
      invocation,
      sequence: queued.sequence,
      state: "committed-unobserved",
      activation: 4,
    });
    expect(await dump(await view([queued]))).toEqual(
      await dump(await view([committedUnobserved])),
    );
  });
});

describe("slice-1 gate carry-forwards (#476 slice 2)", () => {
  const refusalsOf = async (
    ordered: OverlayLayers,
    mappings?: Readonly<Record<string, EntityId>>,
  ): Promise<readonly string[]> =>
    (await overlay(ordered, mappings)).refusals.map((refusal) =>
      `${refusal.index}:${refusal.reason}`
    );

  /**
   * N2. A committed value that applied a change since it was last flushed
   * carries datoms in novelty that no tree root holds. Installing a fresh
   * `Novelty` would drop them, and the overlay would answer from a *stale*
   * committed basis while claiming the current one.
   */
  test("seeds from the committed value's own novelty", async () => {
    const novelty = new Novelty();
    const attribute = committed.schema.attr(":issue/title")!.id;
    const at = committed.basisT + 1;
    novelty.add(
      [
        { e: alpha, a: attribute, vt: ValueTag.Str, v: "alpha", t: at, op: false },
        { e: alpha, a: attribute, vt: ValueTag.Str, v: "alpha-changed", t: at, op: true },
      ],
      (a) => committed.schema.isAvet(a),
      (a) => committed.schema.isVaet(a),
    );
    const live = new Db({
      store: committed.store,
      roots: committed.roots,
      novelty,
      basisT: at,
      schema: committed.schema,
      nextEid: committed.nextEid,
    });
    const overlaid = await projectOverlay(
      live,
      [layer(authored((tx) => tx.set(BETA, title, "beta-optimistic")))],
      resolver(),
    );
    expect(await titles(overlaid.db)).toEqual(["alpha-changed", "beta-optimistic"]);
  });

  test("refuses a temporal committed value rather than silently hiding every layer", async () => {
    for (const temporal of [committed.asOf(committed.basisT), committed.history()]) {
      await expect(projectOverlay(temporal, [], resolver())).rejects.toThrow(
        /applies only to a live committed value/,
      );
    }
  });

  /**
   * N3. `replication.md` says a projection may create *or use* a `ClientRef`
   * only through a declared slot; slice 1 enforced that on `create` alone. The
   * durable layer now carries the refs the invocation was given, so the rule is
   * closed on every verb — while the input-supplied case stays open, which is
   * why `set` could not simply be narrowed to allocations.
   */
  test("refuses a client ref the durable layer does not account for", async () => {
    const stray = clientRef();
    expect(
      await refusalsOf([
        layer(authored((tx) => tx.set(stray, title, "x")), { declared: [] }),
      ]),
    ).toEqual(["0:undeclared-ref"]);
    expect(
      await refusalsOf([
        layer(authored((tx) => tx.set(ALPHA, owner, stray)), { declared: [ALPHA] }),
      ]),
    ).toEqual(["0:undeclared-ref"]);
    expect(
      await refusalsOf([
        layer(authored((tx) => tx.delete(stray)), { declared: [] }),
      ]),
    ).toEqual(["0:undeclared-ref"]);
  });

  test("admits a ref the input supplied, a slot minted, or a mapping resolves", async () => {
    const supplied = clientRef();
    expect(
      await refusalsOf([
        layer(authored((tx) => tx.set(supplied, title, "x")), { declared: [supplied] }),
      ]),
    ).toEqual([]);
    const slot = clientRef();
    expect(
      await refusalsOf([
        layer(authored((tx) => tx.create("draft", Issue), { draft: slot }), {
          declared: [slot],
        }),
      ]),
    ).toEqual([]);
    // Committed-mapped needs no declaration: the authoritative receipt that
    // produced the mapping is itself the account of that ref.
    const mapped = clientRef();
    expect(
      await refusalsOf(
        [layer(authored((tx) => tx.set(mapped, title, "x")), { declared: [] })],
        { [mapped]: ALPHA },
      ),
    ).toEqual([]);
  });

  /**
   * N4. Naming a mapped handle *before* the client ref that aliases it was an
   * `unknown-entity` refusal, while naming it after resolved. Both orders
   * express the same intent, so every alias is bound in one pass first.
   */
  test("resolves a mapped handle whichever order the layers name it in", async () => {
    const ref = clientRef();
    const byHandleFirst: OverlayLayers = [
      layer(authored((tx) => tx.set(UNSEEN, title, "by-handle")), { declared: [] }),
      layer(authored((tx) => tx.set(ref, rank, 9)), { declared: [ref] }),
    ];
    const byRefFirst: OverlayLayers = [
      layer(authored((tx) => tx.set(ref, rank, 9)), { declared: [ref] }),
      layer(authored((tx) => tx.set(UNSEEN, title, "by-handle")), { declared: [] }),
    ];
    expect(await refusalsOf(byHandleFirst, { [ref]: UNSEEN })).toEqual([]);
    expect(await refusalsOf(byRefFirst, { [ref]: UNSEEN })).toEqual([]);
    // One entity, never two, in either order.
    expect((await overlay(byHandleFirst, { [ref]: UNSEEN })).speculative.size).toBe(1);
    expect((await overlay(byRefFirst, { [ref]: UNSEEN })).speculative.size).toBe(1);
  });

  /**
   * N5. `delete` retracts every datom the entity holds, `:ramose/type`
   * included; a later `set` in the same layer then asserts an attribute datom
   * on an entity that no longer claims a type. That is exactly what
   * retract-then-assert means, and the intent is pinned here rather than left
   * to be rediscovered.
   */
  test("delete then set in one layer resurrects the attribute, not the type", async () => {
    const db = await view([layer(authored((tx) => {
      tx.delete(ALPHA).set(ALPHA, title, "resurrected");
    }))]);
    const rows = await db.datomsArray(Index.EAVT, { e: alpha });
    expect(rows.map((datom) => committed.schema.ident(datom.a))).toEqual([
      ":issue/title",
    ]);
    expect(rows[0]?.v).toBe("resurrected");
  });
});
