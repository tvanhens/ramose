/**
 * Canonical and catalog-relative authorization identities.
 *
 * Binding (#358) turns relative names into catalog-scoped identities.
 * Runtime decisions are never keyed by a wire name alone (CAT-1).
 *
 * Rule / policy hashes are identity *types* here. #357 requires the
 * serialized digest representation; semantic recomputation is #358.
 *
 * Effect Schema is the source of truth. Types are `typeof Model.Type`.
 */

import * as Schema from "effect/Schema";

/** Installed catalog identity. Distinct from a local entity/trait name. */
export const CatalogId = Schema.String.pipe(Schema.brand("CatalogId"));
export type CatalogId = typeof CatalogId.Type;

/** Database the installed catalog is bound to. */
export const DatabaseId = Schema.String.pipe(Schema.brand("DatabaseId"));
export type DatabaseId = typeof DatabaseId.Type;

/** Catalog generation the IR was validated against (CAT-5). */
export const CatalogVersion = Schema.String.pipe(Schema.brand("CatalogVersion"));
export type CatalogVersion = typeof CatalogVersion.Type;

/** Fingerprint of the authoritative schema/catalog the IR was bound to. */
export const SchemaFingerprint = Schema.String.pipe(Schema.brand("SchemaFingerprint"));
export type SchemaFingerprint = typeof SchemaFingerprint.Type;

/**
 * SHA-256 digest as exactly 64 lowercase hexadecimal characters.
 * `RuleId` and `PolicyHash` are collision-resistant identities; this
 * schema requires the serialized digest representation. Semantic
 * recomputation and comparison of those digests is #358.
 */
export const DigestHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type DigestHex = typeof DigestHex.Type;

/** Policy document identity. Canonical serialized form is {@link DigestHex}. */
export const PolicyHash = DigestHex.pipe(Schema.brand("PolicyHash"));
export type PolicyHash = typeof PolicyHash.Type;

/**
 * Rule identity. Canonical serialized form is {@link DigestHex}.
 * One identity mapping to two different canonical bodies is an error;
 * silent interning overwrite is forbidden.
 */
export const RuleId = DigestHex.pipe(Schema.brand("RuleId"));
export type RuleId = typeof RuleId.Type;

/** Entity or trait that owns a field or operation. Ownerless ops are unsupported. */
export const OwnerKind = Schema.Literals(["entity", "trait"]);
export type OwnerKind = typeof OwnerKind.Type;

export const OwnerRef = Schema.Struct({
  kind: OwnerKind,
  name: Schema.String,
});
export type OwnerRef = typeof OwnerRef.Type;

/**
 * Target presence is independent of ownership.
 * `none` comes from `self: false`, not from a missing owner.
 */
export const OperationTarget = Schema.Literals(["required", "none"]);
export type OperationTarget = typeof OperationTarget.Type;

export const RelativeEntityId = Schema.TaggedStruct("RelativeEntityId", {
  name: Schema.String,
});
export type RelativeEntityId = typeof RelativeEntityId.Type;

export const RelativeTraitId = Schema.TaggedStruct("RelativeTraitId", {
  name: Schema.String,
});
export type RelativeTraitId = typeof RelativeTraitId.Type;

export const RelativeFieldId = Schema.TaggedStruct("RelativeFieldId", {
  owner: OwnerRef,
  localName: Schema.String,
});
export type RelativeFieldId = typeof RelativeFieldId.Type;

/**
 * Catalog-relative operation identity. `owner` and `target` are both
 * required and independent — an owned targetless op is valid.
 */
export const RelativeOperationId = Schema.TaggedStruct("RelativeOperationId", {
  owner: OwnerRef,
  localName: Schema.String,
  target: OperationTarget,
});
export type RelativeOperationId = typeof RelativeOperationId.Type;

export const EntityId = Schema.TaggedStruct("EntityId", {
  catalog: CatalogId,
  name: Schema.String,
});
export type EntityId = typeof EntityId.Type;

export const TraitId = Schema.TaggedStruct("TraitId", {
  catalog: CatalogId,
  name: Schema.String,
});
export type TraitId = typeof TraitId.Type;

export const FieldId = Schema.TaggedStruct("FieldId", {
  catalog: CatalogId,
  owner: OwnerRef,
  localName: Schema.String,
});
export type FieldId = typeof FieldId.Type;

/**
 * Canonical operation identity. Encodes catalog, owner, local name, and
 * target independently. Runtime must not key decisions by wire name alone.
 */
export const OperationId = Schema.TaggedStruct("OperationId", {
  catalog: CatalogId,
  owner: OwnerRef,
  localName: Schema.String,
  target: OperationTarget,
});
export type OperationId = typeof OperationId.Type;

export const CanonicalIdentity = Schema.Union([EntityId, TraitId, FieldId, OperationId]);
export type CanonicalIdentity = typeof CanonicalIdentity.Type;

export const RelativeIdentity = Schema.Union([
  RelativeEntityId,
  RelativeTraitId,
  RelativeFieldId,
  RelativeOperationId,
]);
export type RelativeIdentity = typeof RelativeIdentity.Type;

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

/** Identity-schema bag a factory can instantiate while preserving each schema. */
export type AnyIdentitySchemaSpace<
  Entity extends Schema.Top = Schema.Top,
  Trait extends Schema.Top = Schema.Top,
  Field extends Schema.Top = Schema.Top,
  Operation extends Schema.Top = Schema.Top,
> = {
  readonly entity: Entity;
  readonly trait: Trait;
  readonly field: Field;
  readonly operation: Operation;
};

/** Schema space a factory uses to build relative or canonical IR. */
export type IdentitySchemaSpace<
  Entity extends Schema.Top = typeof RelativeEntityId | typeof EntityId,
  Trait extends Schema.Top = typeof RelativeTraitId | typeof TraitId,
  Field extends Schema.Top = typeof RelativeFieldId | typeof FieldId,
  Operation extends Schema.Top = typeof RelativeOperationId | typeof OperationId,
> = {
  readonly entity: Entity;
  readonly trait: Trait;
  readonly field: Field;
  readonly operation: Operation;
};

export const RelativeIdentitySchemas = {
  entity: RelativeEntityId,
  trait: RelativeTraitId,
  field: RelativeFieldId,
  operation: RelativeOperationId,
} as const satisfies IdentitySchemaSpace;

export const CanonicalIdentitySchemas = {
  entity: EntityId,
  trait: TraitId,
  field: FieldId,
  operation: OperationId,
} as const satisfies IdentitySchemaSpace;
