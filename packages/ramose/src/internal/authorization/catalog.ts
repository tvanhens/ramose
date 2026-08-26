/**
 * Authoritative catalog descriptors and operation input shapes.
 *
 * #358 binds a template against {@link CatalogDescriptor}. #341 supplies
 * the real catalog-local identities; tests may use an in-memory descriptor.
 */

import type {
  CatalogId,
  CatalogVersion,
  EntityId,
  FieldId,
  OperationId,
  RuleId,
  SchemaFingerprint,
  TraitId,
} from "./identities.ts";

/**
 * Storage value type a field or operation input key holds.
 * Mirrors the public catalog value-type names without importing `ramose/db`.
 */
export type AuthorizationValueType =
  | "string"
  | "long"
  | "double"
  | "boolean"
  | "ref"
  | "uuid"
  | "instant"
  | "bytes";

export type FieldCardinality = "one" | "many";
export type FieldUniqueness = "upsert" | "strict";

export type EntityDescriptor = {
  readonly id: EntityId;
  /** Direct composed traits. Transitive closure is {@link TraitComposition}. */
  readonly traits: readonly TraitId[];
};

export type TraitDescriptor = {
  readonly id: TraitId;
  readonly traits: readonly TraitId[];
};

export type FieldDescriptor = {
  readonly id: FieldId;
  readonly valueType: AuthorizationValueType;
  readonly cardinality: FieldCardinality;
  readonly unique?: FieldUniqueness;
  readonly optional: boolean;
  readonly owned: boolean;
};

export type OperationInputFieldDescriptor = {
  readonly key: string;
  readonly valueType: AuthorizationValueType;
  readonly cardinality: FieldCardinality;
  readonly optional: boolean;
};

/** Authoritative typed input for one owned operation. */
export type OperationInputDescriptor = {
  readonly fields: readonly OperationInputFieldDescriptor[];
};

export type OperationDescriptor = {
  readonly id: OperationId;
  readonly input: OperationInputDescriptor;
};

export type TraitComposition = {
  readonly composer: EntityId;
  readonly trait: TraitId;
  readonly transitive: readonly TraitId[];
};

/**
 * Authoritative catalog the binder validates against.
 * Cross-catalog and stale identities fail binding (CAT-3, CAT-5).
 */
export type CatalogDescriptor = {
  readonly id: CatalogId;
  readonly version: CatalogVersion;
  readonly fingerprint: SchemaFingerprint;
  readonly entities: readonly EntityDescriptor[];
  readonly traits: readonly TraitDescriptor[];
  readonly fields: readonly FieldDescriptor[];
  readonly operations: readonly OperationDescriptor[];
  readonly traitComposition: readonly TraitComposition[];
};

/**
 * Facts and index lookups a decision requires. Computed in #358; this is
 * the type shape installed IR will carry.
 */
export type RuleAccessLookup =
  | { readonly _tag: "field"; readonly field: FieldId }
  | { readonly _tag: "entity"; readonly entity: EntityId }
  | { readonly _tag: "exists"; readonly entity: EntityId; readonly fields: readonly FieldId[] }
  | { readonly _tag: "index"; readonly field: FieldId };

export type RuleAccessPlan = {
  readonly rule: RuleId;
  readonly lookups: readonly RuleAccessLookup[];
};

