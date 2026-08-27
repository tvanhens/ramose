/** Lower a schema to ident-datom maps. Ensure is a separate, idempotent schema tx. */

import {
  composerIdent,
  fieldIdentOf,
  reachableTraits,
} from "./compose.ts";
import { isOptionalField, type AnyField } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import { inferDbValueType, toWireValueType } from "./valueTypes.ts";

export const RAMOSE_KIND_ENTITY = ":ramose.kind/entity";
export const RAMOSE_KIND_TRAIT = ":ramose.kind/trait";

export interface SchemaAttrTx {
  readonly ":db/ident": string;
  readonly ":db/valueType": string;
  readonly ":db/cardinality": string;
  readonly ":db/unique"?: string;
  readonly ":db/index"?: true;
  readonly ":db/isComponent"?: true;
  readonly ":db/optional"?: true;
  readonly ":db/doc"?: string;
}

/** Type / trait ident plus composition edges. Not an attribute. */
export interface SchemaCompositionTx {
  readonly ":db/ident": string;
  readonly ":ramose/kind"?: string;
  readonly ":ramose/composes"?: string;
}

export type SchemaTxOp = SchemaAttrTx | SchemaCompositionTx;

export const isAttributeTx = (tx: SchemaTxOp): tx is SchemaAttrTx =>
  ":db/valueType" in tx && typeof tx[":db/valueType"] === "string";

const uniqueWire = {
  upsert: "identity",
  strict: "value",
} as const;

export const attributeTx = (
  ident: string,
  field: AnyField,
): SchemaAttrTx => {
  const valueType = inferDbValueType(field.schema, field.valueType);
  const out: SchemaAttrTx = {
    ":db/ident": ident,
    ":db/valueType": toWireValueType(valueType),
    ":db/cardinality": `:db.cardinality/${field.cardinality}`,
  };
  if (field.unique !== undefined) {
    (out as { ":db/unique": string })[":db/unique"] =
      `:db.unique/${uniqueWire[field.unique]}`;
  }
  if (field.index) {
    (out as { ":db/index": true })[":db/index"] = true;
  }
  if (field.owned) {
    (out as { ":db/isComponent": true })[":db/isComponent"] = true;
  }
  if (isOptionalField(field) && field.cardinality !== "many") {
    (out as { ":db/optional": true })[":db/optional"] = true;
  }
  if (field.doc !== undefined) {
    (out as { ":db/doc": string })[":db/doc"] = field.doc;
  }
  return out;
};

const attributeMaps = (schema: AnySchema): SchemaAttrTx[] => {
  const out: SchemaAttrTx[] = [];
  const seen = new Set<string>();
  for (const entity of Object.values(schema.entities)) {
    for (const [key, field] of Object.entries(entity.fields)) {
      const ident = fieldIdentOf(field, `:${entity.ns}/${key}`);
      if (seen.has(ident)) continue;
      seen.add(ident);
      out.push(attributeTx(ident, field));
    }
  }
  return out;
};

const compositionMaps = (schema: AnySchema): SchemaCompositionTx[] => {
  const traits = reachableTraits(
    Object.values(schema.entities) as import("./compose.ts").ComposerLike[],
  );
  const out: SchemaCompositionTx[] = [];
  const traitNss = [...traits.keys()].sort();
  for (const ns of traitNss) {
    const trait = traits.get(ns)!;
    out.push({
      ":db/ident": composerIdent(ns),
      ":ramose/kind": RAMOSE_KIND_TRAIT,
    });
    const composed = [...((trait as { traits?: readonly { ns: string }[] }).traits ?? [])]
      .map((t) => composerIdent(t.ns))
      .sort();
    for (const ident of composed) {
      out.push({
        ":db/ident": composerIdent(ns),
        ":ramose/composes": ident,
      });
    }
  }
  const entityNss = Object.keys(schema.entities).sort();
  for (const ns of entityNss) {
    const entity = schema.entities[ns]!;
    const composed = [...((entity as { traits?: readonly { ns: string }[] }).traits ?? [])]
      .map((t) => composerIdent(t.ns))
      .sort();
    out.push({
      ":db/ident": composerIdent(ns),
      ":ramose/kind": RAMOSE_KIND_ENTITY,
    });
    for (const ident of composed) {
      out.push({
        ":db/ident": composerIdent(ns),
        ":ramose/composes": ident,
      });
    }
  }
  return out;
};

/**
 * One map form per field, in schema / entity / key order, then
 * catalog identity and composition metadata for every entity and trait.
 */
export const schemaTx = (schema: AnySchema): SchemaTxOp[] => [
  ...attributeMaps(schema),
  ...compositionMaps(schema),
];
