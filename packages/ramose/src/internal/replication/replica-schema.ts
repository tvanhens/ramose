/**
 * The canonical persisted/materialized replica schema.
 *
 * Annotation documentation is not part of a replica. It describes a catalog for
 * humans, never the authorized value, so it is removed by construction here:
 * `ReplicaAttributeSpec` has no `doc`, `:db/doc` is never materialized into the
 * local indexes or roots, and every stored/restored comparison is therefore
 * documentation-insensitive without a special case. Documentation stays in the
 * installed client catalog. An ordinary application field named `doc` is data
 * and is unaffected — Ramose documentation lives in a symbol slot.
 */

import { type Datom, type DatomValue, ValueTag, type ValueTag as VT } from "../core/datom.ts";
import { base64ToBytes } from "../core/log.ts";
import {
  DB_DOC,
  type AttributeSpec,
  type Cardinality,
  Schema,
  type Uniqueness,
  VALUE_TYPE_IDENTS,
  VALUE_TYPE_NAMES,
  attributeDatoms,
  bootstrapDatoms,
} from "../core/schema.ts";
import type { LogicalDatom, LogicalValue } from "./protocol.ts";

/**
 * The transaction every materialized replica fact and local schema datom
 * carries. A replica holds current authorized values only — there is no local
 * transaction history — so one transaction above the bootstrap is enough, and
 * it keeps the basis a restore can check exactly.
 */
export const REPLICA_USER_T = 2;

/** One attribute exactly as a replica persists and materializes it. */
export type ReplicaAttributeSpec = {
  readonly ident: string;
  readonly valueType: VT;
  readonly cardinality: Cardinality;
  readonly index: boolean;
  readonly isComponent: boolean;
  readonly optional: boolean;
  readonly unique?: Uniqueness;
};

const withoutDocumentation = (datoms: readonly Datom[]): Datom[] =>
  datoms.filter((datom) => datom.a !== DB_DOC);

/** Bootstrap facts for a local replica index, with built-in docs removed. */
export const replicaBootstrapDatoms = (): Datom[] =>
  withoutDocumentation(bootstrapDatoms());

/** Attribute facts for a local replica index, with docs removed. */
export const replicaAttributeDatoms = (
  e: number,
  spec: ReplicaAttributeSpec,
  t: number,
): Datom[] => withoutDocumentation(attributeDatoms(e, spec, t));

/**
 * Project installed catalog attributes onto the canonical replica schema:
 * sorted, deduplicated, fully defaulted, documentation-free, and validated
 * against the built-in attributes it may not contradict.
 */
export const replicaAttributes = (
  attributes: readonly AttributeSpec[],
): readonly ReplicaAttributeSpec[] => {
  const seen = new Set<string>();
  const bootstrap = Schema.bootstrap();
  return Object.freeze([...attributes]
    .sort((left, right) => left.ident < right.ident ? -1 : left.ident > right.ident ? 1 : 0)
    .map((spec): ReplicaAttributeSpec => {
      if (!spec.ident.startsWith(":")) throw new Error(`invalid replica attribute ${spec.ident}`);
      if (seen.has(spec.ident)) throw new Error(`duplicate replica attribute ${spec.ident}`);
      seen.add(spec.ident);
      const valueType = typeof spec.valueType === "number"
        ? spec.valueType
        : VALUE_TYPE_IDENTS[spec.valueType];
      if (valueType === undefined || VALUE_TYPE_NAMES[valueType] === undefined) {
        throw new Error(`unknown value type for ${spec.ident}`);
      }
      if (spec.cardinality !== undefined && spec.cardinality !== "one" && spec.cardinality !== "many") {
        throw new Error(`unknown cardinality for ${spec.ident}`);
      }
      if (spec.unique !== undefined && spec.unique !== "identity" && spec.unique !== "value") {
        throw new Error(`unknown uniqueness for ${spec.ident}`);
      }
      const normalized: ReplicaAttributeSpec = {
        ident: spec.ident,
        valueType,
        cardinality: spec.cardinality ?? "one",
        index: spec.index ?? false,
        isComponent: spec.isComponent ?? false,
        optional: spec.optional ?? false,
        ...(spec.unique === undefined ? {} : { unique: spec.unique }),
      };
      const builtIn = bootstrap.attr(spec.ident);
      if (
        builtIn !== undefined &&
        (builtIn.valueType !== valueType ||
          builtIn.cardinality !== normalized.cardinality ||
          builtIn.index !== normalized.index ||
          builtIn.isComponent !== normalized.isComponent ||
          !!builtIn.optional !== normalized.optional ||
          builtIn.unique !== normalized.unique)
      ) {
        throw new Error(`replica metadata disagrees with built-in ${spec.ident}`);
      }
      return Object.freeze(normalized);
    }));
};

const canonicalAttribute = (spec: ReplicaAttributeSpec): string => JSON.stringify([
  spec.ident,
  spec.valueType,
  spec.cardinality,
  spec.index,
  spec.isComponent,
  spec.optional,
  spec.unique ?? null,
]);

/**
 * Compare two canonical replica schemas. Both sides are already
 * documentation-free, so a documentation-only catalog edit compares equal.
 */
export const sameReplicaAttributes = (
  left: readonly ReplicaAttributeSpec[],
  right: readonly ReplicaAttributeSpec[],
): boolean =>
  left.length === right.length &&
  left.every((spec, index) => {
    const other = right[index];
    return other !== undefined && canonicalAttribute(spec) === canonicalAttribute(other);
  });

/**
 * Project one stored logical fact onto the physical datom a replica indexes.
 *
 * Materialization and integrity validation must agree exactly: the validator's
 * job is to prove that the stored journal, the stored local id maps, and the
 * stored physical indexes all describe one value, and it can only do that by
 * deriving the physical datoms the same way the installer did. Sharing this
 * projection is what makes the two unable to drift apart.
 *
 * `undefined` means the fact cannot be materialized at all: the installer
 * treats that as a broken frame, the validator as a corrupt manifest.
 */
export const replicaValueTag = (value: LogicalValue): VT => {
  switch (value.type) {
    case "long": return ValueTag.Long;
    case "double": return ValueTag.Double;
    case "string": return ValueTag.Str;
    case "boolean": return ValueTag.Bool;
    case "ref": return ValueTag.Ref;
    case "uuid": return ValueTag.Uuid;
    case "instant": return ValueTag.Inst;
    case "bytes": return ValueTag.Bytes;
  }
};

export const replicaDatomValue = (
  value: LogicalValue,
  entities: ReadonlyMap<string, number>,
): DatomValue | undefined => {
  switch (value.type) {
    case "double":
      return value.value === "positive-infinity"
        ? Number.POSITIVE_INFINITY
        : value.value === "negative-infinity"
          ? Number.NEGATIVE_INFINITY
          : value.value;
    case "ref":
      return entities.get(value.value);
    case "bytes":
      return base64ToBytes(value.value);
    default:
      return value.value;
  }
};

/** Why one logical fact cannot become a physical datom. */
export type ReplicaFactRefusal = "unknown-entity" | "unknown-field" | "value-type";

export const replicaFactDatom = (
  logical: LogicalDatom,
  schema: Schema,
  entities: ReadonlyMap<string, number>,
): Datom | ReplicaFactRefusal => {
  const e = entities.get(logical.entity);
  if (e === undefined) return "unknown-entity";
  const attribute = schema.attr(logical.field);
  if (attribute === undefined) return "unknown-field";
  const vt = replicaValueTag(logical.value);
  if (attribute.valueType !== vt) return "value-type";
  const v = replicaDatomValue(logical.value, entities);
  if (v === undefined) return "unknown-entity";
  return { e, a: attribute.id, vt, v, t: REPLICA_USER_T, op: true };
};

/**
 * The local schema datoms one stored replica materializes, or `undefined` when
 * a non-built-in attribute has no partition-local id to materialize it at.
 */
export const replicaSchemaDatoms = (
  attributes: readonly ReplicaAttributeSpec[],
  attributeIds: ReadonlyMap<string, number>,
): Datom[] | undefined => {
  const bootstrap = Schema.bootstrap();
  const datoms: Datom[] = [];
  for (const spec of attributes) {
    const builtIn = bootstrap.attr(spec.ident);
    if (builtIn !== undefined) continue;
    const id = attributeIds.get(spec.ident);
    if (id === undefined) return undefined;
    datoms.push(...replicaAttributeDatoms(id, spec, REPLICA_USER_T));
  }
  return datoms;
};

/** The schema a stored replica restores, over its own local attribute ids. */
export const replicaSchema = (
  attributes: readonly ReplicaAttributeSpec[],
  attributeIds: ReadonlyMap<string, number>,
): { readonly schema: Schema; readonly datoms: readonly Datom[] } | undefined => {
  const datoms = replicaSchemaDatoms(attributes, attributeIds);
  if (datoms === undefined) return undefined;
  return { schema: Schema.bootstrap().clone().apply(datoms), datoms };
};
