import * as Schema from "effect/Schema";

export const CatalogId = Schema.String.pipe(Schema.brand("CatalogId"));
export type CatalogId = typeof CatalogId.Type;

export const DatabaseId = Schema.String.pipe(Schema.brand("DatabaseId"));
export type DatabaseId = typeof DatabaseId.Type;

export const CatalogVersion = Schema.String.pipe(Schema.brand("CatalogVersion"));
export type CatalogVersion = typeof CatalogVersion.Type;

export const SchemaFingerprint = Schema.String.pipe(Schema.brand("SchemaFingerprint"));
export type SchemaFingerprint = typeof SchemaFingerprint.Type;

export const ReadCompatibilityHash = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("ReadCompatibilityHash"));
export type ReadCompatibilityHash = typeof ReadCompatibilityHash.Type;

export const DigestHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type DigestHex = typeof DigestHex.Type;

export const PolicyHash = DigestHex.pipe(Schema.brand("PolicyHash"));
export type PolicyHash = typeof PolicyHash.Type;

export const CatalogUnitHash = DigestHex.pipe(Schema.brand("CatalogUnitHash"));
export type CatalogUnitHash = typeof CatalogUnitHash.Type;

export const OperationVersion = DigestHex.pipe(Schema.brand("OperationVersion"));
export type OperationVersion = typeof OperationVersion.Type;

export const RuleId = DigestHex.pipe(Schema.brand("RuleId"));
export type RuleId = typeof RuleId.Type;

export const OwnerKind = Schema.Literals(["entity", "trait"]);
export type OwnerKind = typeof OwnerKind.Type;

export const OwnerRef = Schema.Struct({
  kind: OwnerKind,
  name: Schema.String,
});
export type OwnerRef = typeof OwnerRef.Type;

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
