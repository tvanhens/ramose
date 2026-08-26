/** Canonical and catalog-relative authorization identities. */

export type OwnerKind = "entity" | "trait";
export type OperationTarget = "required" | "none";

export type CatalogId = string;
export type CatalogVersion = string;
export type RuleId = string;

export interface RelativeOwnerRef {
  readonly kind: OwnerKind;
  readonly name: string;
}

export interface RelativeEntityRef {
  readonly name: string;
}

export interface RelativeTraitRef {
  readonly name: string;
}

export interface RelativeFieldRef {
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
}

/**
 * Operation identity. Ownerless operations are unsupported. `localName` is
 * the owner map key, never a legacy wire name. `target: "none"` comes from
 * `self: false`, not from absence of an owner.
 */
export interface RelativeOperationRef {
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
}

export interface CanonicalEntityRef {
  readonly catalog: CatalogId;
  readonly name: string;
}

export interface CanonicalTraitRef {
  readonly catalog: CatalogId;
  readonly name: string;
}

export interface CanonicalFieldRef {
  readonly catalog: CatalogId;
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
}

export interface CanonicalOperationRef {
  readonly catalog: CatalogId;
  readonly owner: RelativeOwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
}

export const ownerKey = (owner: RelativeOwnerRef): string =>
  `${owner.kind}:${owner.name}`;

export const relativeFieldKey = (field: RelativeFieldRef): string =>
  `${ownerKey(field.owner)}/${field.localName}`;

export const relativeOperationKey = (op: RelativeOperationRef): string =>
  `${ownerKey(op.owner)}/${op.localName}:${op.target}`;

export const canonicalFieldKey = (field: CanonicalFieldRef): string =>
  `${field.catalog}:${relativeFieldKey(field)}`;

export const canonicalOperationKey = (op: CanonicalOperationRef): string =>
  `${op.catalog}:${relativeOperationKey(op)}`;

export const canonicalEntityKey = (entity: CanonicalEntityRef): string =>
  `${entity.catalog}:entity:${entity.name}`;

export const canonicalTraitKey = (trait: CanonicalTraitRef): string =>
  `${trait.catalog}:trait:${trait.name}`;

export const sameOwner = (a: RelativeOwnerRef, b: RelativeOwnerRef): boolean =>
  a.kind === b.kind && a.name === b.name;

export const sameRelativeField = (
  a: RelativeFieldRef,
  b: RelativeFieldRef,
): boolean => sameOwner(a.owner, b.owner) && a.localName === b.localName;

export const sameRelativeOperation = (
  a: RelativeOperationRef,
  b: RelativeOperationRef,
): boolean =>
  sameOwner(a.owner, b.owner) &&
  a.localName === b.localName &&
  a.target === b.target;
