/** Authoritative in-memory catalog descriptor used for binding and tests. */

import type {
  CatalogId,
  CatalogVersion,
  OwnerKind,
  RelativeFieldRef,
  RelativeOperationRef,
  RelativeOwnerRef,
} from "./identity.ts";

export interface CatalogFieldDescriptor {
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
  readonly ident: string;
  readonly cardinality: "one" | "many";
  readonly valueType: string;
  readonly optional: boolean;
  readonly unique?: "upsert" | "strict";
  readonly refTarget?: string;
}

export interface CatalogEntityDescriptor {
  readonly name: string;
  readonly fields: readonly CatalogFieldDescriptor[];
  readonly traits: readonly string[];
}

export interface CatalogTraitDescriptor {
  readonly name: string;
  readonly fields: readonly CatalogFieldDescriptor[];
  readonly traits: readonly string[];
  readonly reachable: boolean;
}

export interface CatalogOperationDescriptor {
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
  readonly target: "required" | "none";
  readonly inputKeys: readonly string[];
}

/**
 * Authoritative catalog view for binding. #341 later supplies real
 * catalog-local identities; tests may construct this in memory.
 */
export interface CatalogDescriptor {
  readonly catalogId: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly fingerprint: string;
  readonly entities: readonly CatalogEntityDescriptor[];
  readonly traits: readonly CatalogTraitDescriptor[];
  readonly operations: readonly CatalogOperationDescriptor[];
}

export const fieldOf = (
  catalog: CatalogDescriptor,
  ref: RelativeFieldRef,
): CatalogFieldDescriptor | undefined => {
  const owner = ownerOf(catalog, ref.owner);
  if (owner === undefined) return undefined;
  return owner.fields.find((field) => field.localName === ref.localName);
};

export const ownerOf = (
  catalog: CatalogDescriptor,
  owner: RelativeOwnerRef,
): CatalogEntityDescriptor | CatalogTraitDescriptor | undefined => {
  if (owner.kind === "entity") {
    return catalog.entities.find((entity) => entity.name === owner.name);
  }
  return catalog.traits.find((trait) => trait.name === owner.name);
};

export const entityOf = (
  catalog: CatalogDescriptor,
  name: string,
): CatalogEntityDescriptor | undefined =>
  catalog.entities.find((entity) => entity.name === name);

export const traitOf = (
  catalog: CatalogDescriptor,
  name: string,
): CatalogTraitDescriptor | undefined =>
  catalog.traits.find((trait) => trait.name === name);

export const operationOf = (
  catalog: CatalogDescriptor,
  ref: RelativeOperationRef,
): CatalogOperationDescriptor | undefined =>
  catalog.operations.find(
    (op) =>
      op.owner.kind === ref.owner.kind &&
      op.owner.name === ref.owner.name &&
      op.localName === ref.localName &&
      op.target === ref.target,
  );

export const entityComposesTrait = (
  catalog: CatalogDescriptor,
  entityName: string,
  traitName: string,
): boolean => {
  const entity = entityOf(catalog, entityName);
  return entity !== undefined && entity.traits.includes(traitName);
};

export const traitIsReachable = (
  catalog: CatalogDescriptor,
  traitName: string,
): boolean => {
  const trait = traitOf(catalog, traitName);
  return trait !== undefined && trait.reachable;
};

export const ownerKindName = (
  kind: OwnerKind,
  name: string,
): `${OwnerKind}:${string}` => `${kind}:${name}`;
