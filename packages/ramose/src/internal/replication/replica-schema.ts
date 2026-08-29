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

import type { Datom, ValueTag as VT } from "../core/datom.ts";
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
