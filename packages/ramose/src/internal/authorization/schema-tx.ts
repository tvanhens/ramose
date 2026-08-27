/**
 * Lower a {@link CatalogDescriptor} onto the same ident-datom maps
 * `schemaTx` emits. Schema attr + composition datoms are the runtime
 * projection; they are not a second catalog source.
 */

import type { CatalogDescriptor, FieldDescriptor } from "./catalog.ts";
import { RAMOSE_KIND_ENTITY, RAMOSE_KIND_TRAIT } from "../core/schema.ts";
import type { CatalogPublication } from "../core/tx.ts";

export interface SchemaAttrTx {
  readonly ":db/ident": string;
  readonly ":db/valueType": string;
  readonly ":db/cardinality": string;
  readonly ":db/unique"?: string;
  readonly ":db/index"?: true;
  readonly ":db/isComponent"?: true;
  readonly ":db/optional"?: true;
}

export interface SchemaCompositionTx {
  readonly ":db/ident": string;
  readonly ":ramose/kind"?: string;
  readonly ":ramose/composes"?: string;
}

export type SchemaTxOp = SchemaAttrTx | SchemaCompositionTx;

const uniqueWire = {
  upsert: "identity",
  strict: "value",
} as const;

const toWireValueType = (vt: FieldDescriptor["valueType"]): `:db.type/${string}` =>
  `:db.type/${vt}`;

/** Public schema ident: `:todo/title` from owner name + local name. */
export const fieldIdentFromDescriptor = (field: FieldDescriptor): string =>
  `:${field.id.owner.name}/${field.id.localName}`;

export const composerIdentFromName = (name: string): string => `:${name}`;

const attributeTxFromField = (field: FieldDescriptor): SchemaAttrTx => {
  const out: SchemaAttrTx = {
    ":db/ident": fieldIdentFromDescriptor(field),
    ":db/valueType": toWireValueType(field.valueType),
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
  if (field.optional && field.cardinality !== "many") {
    (out as { ":db/optional": true })[":db/optional"] = true;
  }
  return out;
};

const compositionMaps = (catalog: CatalogDescriptor): SchemaCompositionTx[] => {
  const out: SchemaCompositionTx[] = [];
  const traits = [...catalog.traits].sort((a, b) => (a.id.name < b.id.name ? -1 : a.id.name > b.id.name ? 1 : 0));
  for (const trait of traits) {
    const ident = composerIdentFromName(trait.id.name);
    out.push({ ":db/ident": ident, ":ramose/kind": RAMOSE_KIND_TRAIT });
    const composed = [...trait.traits].map((t) => composerIdentFromName(t.name)).sort();
    for (const inner of composed) {
      out.push({ ":db/ident": ident, ":ramose/composes": inner });
    }
  }
  const entities = [...catalog.entities].sort((a, b) =>
    a.id.name < b.id.name ? -1 : a.id.name > b.id.name ? 1 : 0,
  );
  for (const entity of entities) {
    const ident = composerIdentFromName(entity.id.name);
    out.push({ ":db/ident": ident, ":ramose/kind": RAMOSE_KIND_ENTITY });
    const composed = [...entity.traits].map((t) => composerIdentFromName(t.name)).sort();
    for (const inner of composed) {
      out.push({ ":db/ident": ident, ":ramose/composes": inner });
    }
  }
  return out;
};

/**
 * Field descriptors → attribute maps, then entity/trait kind + direct
 * `:ramose/composes` edges. Operations and identity tables are not persisted.
 */
export const schemaTxFromCatalog = (catalog: CatalogDescriptor): SchemaTxOp[] => {
  const seen = new Set<string>();
  const attrs: SchemaAttrTx[] = [];
  for (const field of catalog.fields) {
    const ident = fieldIdentFromDescriptor(field);
    if (seen.has(ident)) continue;
    seen.add(ident);
    attrs.push(attributeTxFromField(field));
  }
  return [...attrs, ...compositionMaps(catalog)];
};

/** Privilege payload {@link processTx} uses for occupied-closure checks. */
export const catalogPublicationOf = (catalog: CatalogDescriptor): CatalogPublication => {
  const traitClosures: Record<string, string[]> = {};
  for (const entity of catalog.entities) {
    traitClosures[composerIdentFromName(entity.id.name)] = [];
  }
  for (const row of catalog.traitComposition) {
    const ident = composerIdentFromName(row.composer.name);
    const set = new Set(traitClosures[ident] ?? []);
    for (const trait of row.transitive) set.add(composerIdentFromName(trait.name));
    traitClosures[ident] = [...set].sort();
  }
  const schemaTx = schemaTxFromCatalog(catalog);
  const projectedIdents = [...new Set(schemaTx.map((op) => op[":db/ident"]))];
  return {
    entityNames: catalog.entities.map((entity) => entity.id.name),
    traitClosures,
    schemaTx,
    projectedIdents,
  };
};
