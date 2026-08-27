/**
 * Canonical field identity and database-wide field-to-storage mapping.
 *
 * Lookup is keyed by catalog + owner kind + owner name + local name.
 * The reconstructed storage ident includes those same components so two
 * catalogs — or an entity and a trait — never share a physical attribute
 * because they reuse an owner/local field name.
 *
 * @internal
 */

import type { CatalogDescriptor, FieldDescriptor } from "../catalog.ts";
import type { CatalogId } from "../identities.ts";

export type TraversalCompositions = {
  readonly entityTraits: ReadonlyMap<string, ReadonlySet<string>>;
  readonly traitTraits: ReadonlyMap<string, ReadonlySet<string>>;
};

export const fieldDescriptorKey = (id: {
  readonly catalog: CatalogId;
  readonly owner: { readonly kind: string; readonly name: string };
  readonly localName: string;
}): string => `${id.catalog}\0${id.owner.kind}\0${id.owner.name}\0${id.localName}`;

/**
 * Database-wide physical schema ident for a canonical field identity.
 * Catalog and owner kind are part of the ident so cross-catalog and
 * entity/trait reuse of an owner/local name stay distinct.
 */
export const physicalStorageIdent = (id: {
  readonly catalog: CatalogId;
  readonly owner: { readonly kind: string; readonly name: string };
  readonly localName: string;
}): string => `:${id.catalog}.${id.owner.kind}.${id.owner.name}/${id.localName}`;

export const fieldStorageIndex = (
  fields: readonly FieldDescriptor[],
): ReadonlyMap<string, string> => {
  const owners = new Map<string, string[]>();
  for (const field of fields) {
    const key = fieldDescriptorKey(field.id);
    const ident = physicalStorageIdent(field.id);
    const existing = owners.get(ident) ?? [];
    existing.push(key);
    owners.set(ident, existing);
  }
  const out = new Map<string, string>();
  for (const field of fields) {
    const key = fieldDescriptorKey(field.id);
    const ident = physicalStorageIdent(field.id);
    if ((owners.get(ident)?.length ?? 0) === 1) out.set(key, ident);
  }
  return out;
};

export const traversalCompositionsOf = (catalog: CatalogDescriptor): TraversalCompositions => {
  const traitEdges = new Map<string, Set<string>>();
  for (const trait of catalog.traits) {
    traitEdges.set(trait.id.name, new Set(trait.traits.map((nested) => nested.name)));
  }
  const traitTraits = new Map<string, Set<string>>();
  const visitTrait = (name: string, seen: Set<string>): void => {
    const children = traitEdges.get(name);
    if (children === undefined) return;
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      visitTrait(child, seen);
    }
  };
  for (const name of traitEdges.keys()) {
    const seen = new Set<string>();
    visitTrait(name, seen);
    traitTraits.set(name, seen);
  }
  const entityTraits = new Map<string, Set<string>>();
  for (const entity of catalog.entities) {
    const seen = new Set<string>();
    for (const trait of entity.traits) {
      seen.add(trait.name);
      for (const nested of traitTraits.get(trait.name) ?? []) seen.add(nested);
    }
    entityTraits.set(entity.id.name, seen);
  }
  for (const row of catalog.traitComposition) {
    const seen = entityTraits.get(row.composer.name) ?? new Set<string>();
    seen.add(row.trait.name);
    for (const trait of row.transitive) seen.add(trait.name);
    entityTraits.set(row.composer.name, seen);
  }
  return { entityTraits, traitTraits };
};
