/** Lower a catalog to ident-datom maps. Ensure is a separate, idempotent schema tx. */

import type { AnyAttribute } from "./Attribute.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { inferDbValueType } from "./valueTypes.ts";

export interface SchemaAttrTx {
  readonly ":db/ident": string;
  readonly ":db/valueType": string;
  readonly ":db/cardinality": string;
  readonly ":db/unique"?: string;
  readonly ":db/index"?: true;
  readonly ":db/isComponent"?: true;
  readonly ":db/doc"?: string;
}

export const attributeTx = (
  ident: string,
  attribute: AnyAttribute,
): SchemaAttrTx => {
  const valueType = inferDbValueType(attribute.schema, attribute.valueType);
  const out: SchemaAttrTx = {
    ":db/ident": ident,
    ":db/valueType": valueType,
    ":db/cardinality": `:db.cardinality/${attribute.cardinality}`,
  };
  if (attribute.unique !== undefined) {
    (out as { ":db/unique": string })[":db/unique"] =
      `:db.unique/${attribute.unique}`;
  }
  if (attribute.index) {
    (out as { ":db/index": true })[":db/index"] = true;
  }
  if (attribute.isComponent) {
    (out as { ":db/isComponent": true })[":db/isComponent"] = true;
  }
  if (attribute.doc !== undefined) {
    (out as { ":db/doc": string })[":db/doc"] = attribute.doc;
  }
  return out;
};

/** One map form per attribute, in catalog / namespace / key order. */
export const schemaTx = (catalog: AnyCatalog): SchemaAttrTx[] => {
  const out: SchemaAttrTx[] = [];
  for (const ns of Object.values(catalog.namespaces)) {
    for (const [key, attribute] of Object.entries(ns.attributes)) {
      out.push(attributeTx(`:${ns.ns}/${key}`, attribute));
    }
  }
  return out;
};
