/**
 * The optimistic projection authoring contract (#476 slice 1).
 *
 * Everything here is a pure transformation of an authored call into plain
 * changeset data: which values a declared field admits, which client refs a
 * projection may name, and what happens when an author gets it wrong. No
 * source is read anywhere — {@link runProjection} calls the function.
 */

import { describe, expect, test } from "bun:test";
import { Operation } from "../../src/db/Operation.ts";
import * as Schema from "effect/Schema";
import {
  DEFAULT_PROJECTION_REVISION,
  normalizeProjectionRevision,
  runProjection,
  type ProjectionChangeset,
  type ProjectionField,
  type ProjectionTx,
} from "../../src/db/Projection.ts";
import { clientRef, unsafeEntityId, type ClientRef } from "../../src/db/refs.ts";

const handle = (fill: string) => unsafeEntityId(fill.repeat(54).slice(0, 54) + "A");
const ISSUE = handle("A");
const OTHER = handle("B");

const Issue = { ns: "Issue" };
const title: ProjectionField = { ident: ":issue/title", valueType: "string" };
const rank: ProjectionField = { ident: ":issue/rank", valueType: "long" };
const score: ProjectionField = { ident: ":issue/score", valueType: "double" };
const done: ProjectionField = { ident: ":issue/done", valueType: "boolean" };
const owner: ProjectionField = { ident: ":issue/owner", valueType: "ref" };
const at: ProjectionField = { ident: ":issue/at", valueType: "instant" };
const key: ProjectionField = { ident: ":issue/key", valueType: "uuid" };
const blob: ProjectionField = { ident: ":issue/blob", valueType: "bytes" };
const untyped: ProjectionField = { ident: ":issue/untyped", valueType: undefined };

const changeset = (
  run: (tx: ProjectionTx) => void,
  allocations?: Readonly<Record<string, ClientRef>>,
): ProjectionChangeset => {
  const outcome = runProjection<null>(({ tx }) => run(tx), {
    input: null,
    ...(allocations === undefined ? {} : { allocations }),
  });
  if (outcome.type !== "changeset") {
    throw new Error(`expected a changeset, got ${outcome.reason}`);
  }
  return outcome.changeset;
};

const reason = (
  run: (tx: ProjectionTx) => void,
  allocations?: Readonly<Record<string, ClientRef>>,
): string => {
  const outcome = runProjection<null>(({ tx }) => run(tx), {
    input: null,
    ...(allocations === undefined ? {} : { allocations }),
  });
  return outcome.type === "failed" ? outcome.reason : "unexpectedly succeeded";
};

describe("native execution", () => {
  test("records operations in call order and chains", () => {
    const ops = changeset((tx) => {
      tx.set(ISSUE, title, "alpha").set(ISSUE, rank, 3).delete(OTHER);
    });
    expect(ops).toEqual([
      { op: "set", entity: ISSUE, field: ":issue/title", value: { type: "string", value: "alpha" } },
      { op: "set", entity: ISSUE, field: ":issue/rank", value: { type: "long", value: 3 } },
      { op: "delete", entity: OTHER },
    ]);
  });

  test("the changeset and its operations are frozen", () => {
    const ops = changeset((tx) => tx.delete(ISSUE));
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.isFrozen(ops[0])).toBe(true);
  });

  test("the input and the invocation target reach the projection", () => {
    const outcome = runProjection<{ readonly rank: number }>(
      ({ input, self, tx }) => {
        tx.set(self!, rank, input.rank);
      },
      { input: { rank: 7 }, self: ISSUE },
    );
    expect(outcome).toEqual({
      type: "changeset",
      changeset: [
        { op: "set", entity: ISSUE, field: ":issue/rank", value: { type: "long", value: 7 } },
      ],
    });
  });

  test("an untargeted invocation sees self as undefined", () => {
    let seen: unknown = "unset";
    runProjection<null>(({ self }) => {
      seen = self;
    }, { input: null });
    expect(seen).toBeUndefined();
  });

  test("a projection that throws produces no layer, not a partial one", () => {
    const outcome = runProjection<null>(({ tx }) => {
      tx.set(ISSUE, title, "alpha");
      throw new Error("author mistake");
    }, { input: null });
    expect(outcome).toEqual({ type: "failed", reason: "author mistake" });
  });

  test("an async projection is refused by the API, not by inspecting it", () => {
    const outcome = runProjection<null>(
      (() => Promise.resolve()) as never,
      { input: null },
    );
    expect(outcome.type).toBe("failed");
    expect(outcome.type === "failed" && outcome.reason).toContain("synchronous");
  });

  test("a rejecting async projection does not leak an unhandled rejection", () => {
    const outcome = runProjection<null>(
      (() => Promise.reject(new Error("async boom"))) as never,
      { input: null },
    );
    expect(outcome.type).toBe("failed");
  });

  test("the builder is inert once the projection has returned", () => {
    let escaped: ProjectionTx | undefined;
    const ops = changeset((tx) => {
      escaped = tx;
      tx.set(ISSUE, title, "alpha");
    });
    expect(() => escaped!.set(ISSUE, title, "later")).toThrow(
      /only usable while the projection runs/,
    );
    expect(ops).toHaveLength(1);
  });
});

describe("value lowering", () => {
  test("every declared value type lowers to the replica's own model", () => {
    const uuid = "0189d0e0-0000-7000-8000-000000000000";
    const ops = changeset((tx) => {
      tx.set(ISSUE, title, "alpha")
        .set(ISSUE, rank, 3)
        .set(ISSUE, score, 1.5)
        .set(ISSUE, done, true)
        .set(ISSUE, owner, OTHER)
        .set(ISSUE, at, new Date(1_700_000_000_000))
        .set(ISSUE, key, uuid)
        .set(ISSUE, blob, Uint8Array.of(1, 2, 3));
    });
    expect(ops.map((op) => (op.op === "set" ? op.value : null))).toEqual([
      { type: "string", value: "alpha" },
      { type: "long", value: 3 },
      { type: "double", value: 1.5 },
      { type: "boolean", value: true },
      { type: "ref", value: OTHER },
      { type: "instant", value: 1_700_000_000_000 },
      { type: "uuid", value: uuid },
      { type: "bytes", value: "AQID" },
    ]);
  });

  test("infinities carry the replica's sentinels and NaN is refused", () => {
    const ops = changeset((tx) => {
      tx.set(ISSUE, score, Number.POSITIVE_INFINITY)
        .set(ISSUE, score, Number.NEGATIVE_INFINITY);
    });
    expect(ops.map((op) => (op.op === "set" ? op.value : null))).toEqual([
      { type: "double", value: "positive-infinity" },
      { type: "double", value: "negative-infinity" },
    ]);
    expect(reason((tx) => tx.set(ISSUE, score, Number.NaN))).toContain("NaN");
  });

  test("a value of the wrong type is refused against the declared field", () => {
    expect(reason((tx) => tx.set(ISSUE, rank, 1.5))).toContain("safe integer");
    expect(reason((tx) => tx.set(ISSUE, title, 3))).toContain("expects a string");
    expect(reason((tx) => tx.set(ISSUE, done, "yes"))).toContain("expects a boolean");
    expect(reason((tx) => tx.set(ISSUE, blob, "AQID"))).toContain("Uint8Array");
  });

  test("a ref field only accepts a durable public handle", () => {
    expect(reason((tx) => tx.set(ISSUE, owner, "not-a-handle"))).toContain(
      "EntityId or a ClientRef",
    );
    const ref = clientRef();
    expect(changeset((tx) => tx.set(ISSUE, owner, ref))[0]).toEqual({
      op: "set",
      entity: ISSUE,
      field: ":issue/owner",
      value: { type: "ref", value: ref },
    });
  });

  test("a field with no declared value type is refused, never guessed", () => {
    expect(reason((tx) => tx.set(ISSUE, untyped, "alpha"))).toContain(
      "no declared value type",
    );
  });

  test("a bare ident is refused: it cannot say what a string means", () => {
    expect(reason((tx) => tx.set(ISSUE, ":issue/title" as never, "alpha")))
      .toContain("stamped field ref");
  });

  test("engine metadata is not a projectable field", () => {
    for (const ident of [":db/ident", ":db.type/string", ":ramose/type"]) {
      expect(
        reason((tx) => tx.set(ISSUE, { ident, valueType: "string" }, "x")),
      ).toContain("engine metadata");
      expect(
        reason((tx) => tx.remove(ISSUE, { ident, valueType: "string" })),
      ).toContain("engine metadata");
    }
  });

  test("a target must be a handle or a client ref", () => {
    expect(reason((tx) => tx.set(42 as never, title, "alpha"))).toContain(
      "EntityId or a ClientRef",
    );
  });
});

describe("remove", () => {
  test("removes one value or every value of the field", () => {
    expect(changeset((tx) => tx.remove(ISSUE, title, "alpha"))).toEqual([
      { op: "remove", entity: ISSUE, field: ":issue/title", value: { type: "string", value: "alpha" } },
    ]);
    expect(changeset((tx) => tx.remove(ISSUE, title))).toEqual([
      { op: "remove", entity: ISSUE, field: ":issue/title", value: null },
    ]);
  });
});

describe("allocation slots are the only way to mint a client ref", () => {
  const ref = clientRef();

  test("create returns the declared slot's ref and names the entity type", () => {
    let returned: ClientRef | undefined;
    const ops = changeset((tx) => {
      returned = tx.create("issue", Issue);
    }, { issue: ref });
    expect(returned).toBe(ref);
    expect(ops).toEqual([
      { op: "create", entity: ref, slot: "issue", type: "Issue" },
    ]);
  });

  test("an undeclared slot is refused", () => {
    expect(reason((tx) => tx.create("other", Issue), { issue: ref })).toContain(
      "not a declared allocation slot",
    );
    expect(reason((tx) => tx.create("issue", Issue))).toContain(
      "not a declared allocation slot",
    );
  });

  test("an inherited slot name is not a declaration", () => {
    const inherited = Object.create({ issue: ref }) as Record<string, ClientRef>;
    expect(reason((tx) => tx.create("issue", Issue), inherited)).toContain(
      "not a declared allocation slot",
    );
  });

  test("create needs an entity definition to be a member of anything", () => {
    expect(reason((tx) => tx.create("issue", undefined as never), { issue: ref }))
      .toContain("needs an entity definition");
  });
});

describe("projection revision", () => {
  test("defaults to 1 and refuses anything that is not a positive integer", () => {
    expect(normalizeProjectionRevision(undefined)).toBe(DEFAULT_PROJECTION_REVISION);
    expect(normalizeProjectionRevision(4)).toBe(4);
    for (const bad of [0, -1, 1.5, "2", null]) {
      expect(() => normalizeProjectionRevision(bad)).toThrow(/positive integer/);
    }
  });
});

describe("operation declaration", () => {
  const spec = {
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({}),
    run: () => ({}),
  } as const;

  test("an operation may declare one projection and its own revision", () => {
    const declared = Operation({
      ...spec,
      optimisticRevision: 3,
      optimistic: ({ tx }) => {
        tx.delete(ISSUE);
      },
    });
    expect(typeof declared.optimistic).toBe("function");
    expect(declared.optimisticRevision).toBe(3);
  });

  test("an operation without a projection still declares normally", () => {
    const declared = Operation(spec);
    expect(declared.optimistic).toBeUndefined();
    expect(declared.optimisticRevision).toBe(DEFAULT_PROJECTION_REVISION);
  });

  test("a non-function projection is refused at declaration", () => {
    expect(() => Operation({ ...spec, optimistic: "tx.set(...)" as never })).toThrow(
      /must be a function/,
    );
  });

  test("the projection revision does not touch anything OperationVersion covers", () => {
    // #487 hashes the catalog key, owner, local name, target, `revision`,
    // input/output contracts, composers, writes, and allocations. None of them
    // may move because a projection was edited, or every queued invocation
    // would lose its right to submit.
    const before = Operation({ ...spec, optimistic: () => {}, optimisticRevision: 1 });
    const after = Operation({ ...spec, optimistic: () => {}, optimisticRevision: 9 });
    expect(after.revision).toBe(before.revision);
    expect(after.self).toBe(before.self);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.writes).toEqual(before.writes);
    expect(after.input).toBe(before.input);
    expect(after.output).toBe(before.output);
  });
});
