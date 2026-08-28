/** Lower a schema to ident-datom maps. Ensure is a separate, idempotent schema tx. */

import { fieldIdentOf } from "./compose.ts";
import { isOptionalField, type AnyField } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import { inferDbValueType, toWireValueType } from "./valueTypes.ts";

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

export type SchemaTxOp = SchemaAttrTx;

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

/** One map form per field, in schema / entity / key order. */
export const schemaTx = (schema: AnySchema): SchemaTxOp[] => attributeMaps(schema);
