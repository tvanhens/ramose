/**
 * Canonical and catalog-relative authorization identities.
 *
 * Binding (#358) turns relative names into catalog-scoped identities.
 * Runtime decisions are never keyed by a wire name alone (CAT-1).
 *
 * Rule / policy hashes are identity *types* here. Collision-resistant
 * assignment is #357 — these constructors do not hash.
 */

declare const CatalogIdBrand: unique symbol;
declare const DatabaseIdBrand: unique symbol;
declare const CatalogVersionBrand: unique symbol;
declare const SchemaFingerprintBrand: unique symbol;
declare const PolicyHashBrand: unique symbol;
declare const RuleIdBrand: unique symbol;

/** Installed catalog identity. Distinct from a local entity/trait name. */
export type CatalogId = string & { readonly [CatalogIdBrand]: typeof CatalogIdBrand };
export const CatalogId = (value: string): CatalogId => value as CatalogId;

/** Database the installed catalog is bound to. */
export type DatabaseId = string & { readonly [DatabaseIdBrand]: typeof DatabaseIdBrand };
export const DatabaseId = (value: string): DatabaseId => value as DatabaseId;

/** Catalog generation the IR was validated against (CAT-5). */
export type CatalogVersion = string & {
  readonly [CatalogVersionBrand]: typeof CatalogVersionBrand;
};
export const CatalogVersion = (value: string): CatalogVersion => value as CatalogVersion;

/** Fingerprint of the authoritative schema/catalog the IR was bound to. */
export type SchemaFingerprint = string & {
  readonly [SchemaFingerprintBrand]: typeof SchemaFingerprintBrand;
};
export const SchemaFingerprint = (value: string): SchemaFingerprint =>
  value as SchemaFingerprint;

/** Policy document identity. Later a collision-resistant digest (#357). */
export type PolicyHash = string & { readonly [PolicyHashBrand]: typeof PolicyHashBrand };
export const PolicyHash = (value: string): PolicyHash => value as PolicyHash;

/**
 * Rule identity. Later a collision-resistant canonical digest (#357).
 * One identity mapping to two different canonical bodies is an error;
 * silent interning overwrite is forbidden.
 */
export type RuleId = string & { readonly [RuleIdBrand]: typeof RuleIdBrand };
export const RuleId = (value: string): RuleId => value as RuleId;

/** Entity or trait that owns a field or operation. Ownerless ops are unsupported. */
export type OwnerKind = "entity" | "trait";

export type OwnerRef = {
  readonly kind: OwnerKind;
  readonly name: string;
};

/**
 * Target presence is independent of ownership.
 * `none` comes from `self: false`, not from a missing owner.
 */
export type OperationTarget = "required" | "none";

export type RelativeEntityId = {
  readonly _tag: "RelativeEntityId";
  readonly name: string;
};

export type RelativeTraitId = {
  readonly _tag: "RelativeTraitId";
  readonly name: string;
};

export type RelativeFieldId = {
  readonly _tag: "RelativeFieldId";
  readonly owner: OwnerRef;
  readonly localName: string;
};

/**
 * Catalog-relative operation identity. `owner` and `target` are both
 * required and independent — an owned targetless op is valid.
 */
export type RelativeOperationId = {
  readonly _tag: "RelativeOperationId";
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
};

export type EntityId = {
  readonly _tag: "EntityId";
  readonly catalog: CatalogId;
  readonly name: string;
};

export type TraitId = {
  readonly _tag: "TraitId";
  readonly catalog: CatalogId;
  readonly name: string;
};

export type FieldId = {
  readonly _tag: "FieldId";
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
};

/**
 * Canonical operation identity. Encodes catalog, owner, local name, and
 * target independently. Runtime must not key decisions by wire name alone.
 */
export type OperationId = {
  readonly _tag: "OperationId";
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
};

export type CanonicalIdentity = EntityId | TraitId | FieldId | OperationId;
export type RelativeIdentity =
  | RelativeEntityId
  | RelativeTraitId
  | RelativeFieldId
  | RelativeOperationId;

/** Identity flavor used to parameterize expressions, rules, and decisions. */
export interface IdentitySpace {
  readonly entity: RelativeEntityId | EntityId;
  readonly trait: RelativeTraitId | TraitId;
  readonly field: RelativeFieldId | FieldId;
  readonly operation: RelativeOperationId | OperationId;
}

export interface RelativeIdentities extends IdentitySpace {
  readonly entity: RelativeEntityId;
  readonly trait: RelativeTraitId;
  readonly field: RelativeFieldId;
  readonly operation: RelativeOperationId;
}

export interface CanonicalIdentities extends IdentitySpace {
  readonly entity: EntityId;
  readonly trait: TraitId;
  readonly field: FieldId;
  readonly operation: OperationId;
}

export const RelativeEntityId = (name: string): RelativeEntityId => ({
  _tag: "RelativeEntityId",
  name,
});

export const RelativeTraitId = (name: string): RelativeTraitId => ({
  _tag: "RelativeTraitId",
  name,
});

export const RelativeFieldId = (owner: OwnerRef, localName: string): RelativeFieldId => ({
  _tag: "RelativeFieldId",
  owner,
  localName,
});

export const RelativeOperationId = (
  owner: OwnerRef,
  localName: string,
  target: OperationTarget,
): RelativeOperationId => ({
  _tag: "RelativeOperationId",
  owner,
  localName,
  target,
});

export const EntityId = (catalog: CatalogId, name: string): EntityId => ({
  _tag: "EntityId",
  catalog,
  name,
});

export const TraitId = (catalog: CatalogId, name: string): TraitId => ({
  _tag: "TraitId",
  catalog,
  name,
});

export const FieldId = (
  catalog: CatalogId,
  owner: OwnerRef,
  localName: string,
): FieldId => ({
  _tag: "FieldId",
  catalog,
  owner,
  localName,
});

export const OperationId = (
  catalog: CatalogId,
  owner: OwnerRef,
  localName: string,
  target: OperationTarget,
): OperationId => ({
  _tag: "OperationId",
  catalog,
  owner,
  localName,
  target,
});
