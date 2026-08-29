import { describe, expect, test } from "bun:test";
import { ValueTag } from "../../../src/internal/core/datom.ts";
import { DB_DOC, type AttributeSpec } from "../../../src/internal/core/schema.ts";
import {
  replicaAttributeDatoms,
  replicaAttributes,
  replicaBootstrapDatoms,
  sameReplicaAttributes,
} from "../../../src/internal/replication/replica-schema.ts";

const documented: readonly AttributeSpec[] = [
  { ident: ":item/tags", valueType: ":db.type/string", cardinality: "many", doc: "tags" },
  { ident: ":item/name", valueType: ":db.type/string", index: true, doc: "the name" },
];

describe("documentation-free replica schema", () => {
  test("normalization defaults every field and drops documentation", () => {
    expect(replicaAttributes(documented)).toEqual([
      {
        ident: ":item/name",
        valueType: ValueTag.Str,
        cardinality: "one",
        index: true,
        isComponent: false,
        optional: false,
      },
      {
        ident: ":item/tags",
        valueType: ValueTag.Str,
        cardinality: "many",
        index: false,
        isComponent: false,
        optional: false,
      },
    ]);
    for (const spec of replicaAttributes(documented)) {
      expect(Object.keys(spec)).not.toContain("doc");
      expect(Object.isFrozen(spec)).toBe(true);
    }
  });

  test("comparison is documentation-insensitive but not schema-insensitive", () => {
    const rewritten = documented.map((spec) => ({ ...spec, doc: "entirely rewritten" }));
    const undocumented = documented.map(({ doc: _, ...spec }) => spec);
    expect(sameReplicaAttributes(
      replicaAttributes(documented),
      replicaAttributes(rewritten),
    )).toBe(true);
    expect(sameReplicaAttributes(
      replicaAttributes(documented),
      replicaAttributes(undocumented),
    )).toBe(true);
    // Ordering is canonical, so input order cannot change the comparison.
    expect(sameReplicaAttributes(
      replicaAttributes(documented),
      replicaAttributes([...documented].reverse()),
    )).toBe(true);
    for (const change of [
      { ...documented[0]!, cardinality: "one" as const },
      { ...documented[0]!, index: true },
      { ...documented[0]!, unique: "identity" as const },
      { ...documented[0]!, optional: true },
      { ...documented[0]!, isComponent: true },
      { ...documented[0]!, valueType: ":db.type/long" as const },
    ]) {
      expect(sameReplicaAttributes(
        replicaAttributes(documented),
        replicaAttributes([change, documented[1]!]),
      )).toBe(false);
    }
    expect(sameReplicaAttributes(
      replicaAttributes(documented),
      replicaAttributes([documented[1]!]),
    )).toBe(false);
  });

  test("an ordinary application field named doc stays data", () => {
    const [spec] = replicaAttributes([
      { ident: ":article/doc", valueType: ":db.type/string", doc: "annotation" },
    ]);
    expect(spec?.ident).toBe(":article/doc");
    expect(spec).not.toHaveProperty("doc");
  });

  test("materialized datoms never carry :db/doc", () => {
    const bootstrap = replicaBootstrapDatoms();
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(bootstrap.some((datom) => datom.a === DB_DOC)).toBe(false);
    const [spec] = replicaAttributes(documented);
    const datoms = replicaAttributeDatoms(1000, spec!, 2);
    expect(datoms.some((datom) => datom.a === DB_DOC)).toBe(false);
    expect(datoms.map((datom) => datom.v)).toContain(":item/name");
  });

  test("invalid, duplicate, and contradictory metadata is rejected", () => {
    expect(() => replicaAttributes([{ ident: "item/name", valueType: ":db.type/string" }]))
      .toThrow(/invalid replica attribute/);
    expect(() => replicaAttributes([documented[0]!, documented[0]!]))
      .toThrow(/duplicate replica attribute/);
    expect(() => replicaAttributes([
      { ident: ":item/name", valueType: ":db.type/unknown" as AttributeSpec["valueType"] },
    ])).toThrow(/unknown value type/);
    expect(() => replicaAttributes([
      { ident: ":item/name", valueType: ":db.type/string", cardinality: "some" as "one" },
    ])).toThrow(/unknown cardinality/);
    expect(() => replicaAttributes([
      { ident: ":item/name", valueType: ":db.type/string", unique: "sometimes" as "value" },
    ])).toThrow(/unknown uniqueness/);
    // Documentation on a built-in attribute is accepted; a real disagreement is not.
    expect(replicaAttributes([
      { ident: ":ramose/type", valueType: ":db.type/string", index: true, doc: "rewritten" },
    ])).toHaveLength(1);
    expect(() => replicaAttributes([
      { ident: ":db/ident", valueType: ":db.type/long", unique: "identity" },
    ])).toThrow(/disagrees with built-in/);
  });
});
