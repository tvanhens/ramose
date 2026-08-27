/**
 * Canonical field identity and database-wide field-to-storage mapping.
 *
 * Lookup is keyed by catalog + owner kind + owner name + local name.
 * Physical idents encode those components injectively so names that
 * contain `.` or `/` cannot collide.
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

/** Percent-encode a path component, including `.` so dotted names stay injective. */
export const encodeIdentPart = (value: string): string =>
  encodeURIComponent(value).replace(/\./g, "%2e");

export const decodeIdentPart = (value: string): string => decodeURIComponent(value);

export const physicalComposerIdent = (id: {
  readonly catalog: CatalogId;
  readonly kind: string;
  readonly name: string;
}): string => `:${encodeIdentPart(id.catalog)}.${encodeIdentPart(id.kind)}.${encodeIdentPart(id.name)}`;

export const parsePhysicalComposerIdent = (
  ident: string,
): { readonly catalog: string; readonly kind: string; readonly name: string } | undefined => {
  if (!ident.startsWith(":")) return undefined;
  const parts = ident.slice(1).split(".");
  if (parts.length !== 3) return undefined;
  try {
    return {
      catalog: decodeIdentPart(parts[0]!),
      kind: decodeIdentPart(parts[1]!),
      name: decodeIdentPart(parts[2]!),
    };
  } catch {
    return undefined;
  }
};

/**
 * Database-wide physical schema ident for a canonical field identity.
 * Encoding is injective across catalog, owner kind, owner name, and local name.
 */
export const physicalStorageIdent = (id: {
  readonly catalog: CatalogId;
  readonly owner: { readonly kind: string; readonly name: string };
  readonly localName: string;
}): string =>
  `${physicalComposerIdent({ catalog: id.catalog, kind: id.owner.kind, name: id.owner.name })}/${encodeIdentPart(id.localName)}`;

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
