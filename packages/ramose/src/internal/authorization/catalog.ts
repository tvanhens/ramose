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

/**
 * Where a ref field (or ref-shaped operation input) points.
 * Required so a later hop such as `Issue.owner.organization` can check
 * that `organization` belongs to the referenced type — `valueType: "ref"`
 * alone is not enough. `self` is `Ref.self`; `untargeted` is `Field(Ref)`.
 */
export type FieldRefTarget =
  | { readonly _tag: "entity"; readonly entity: EntityId }
  | { readonly _tag: "trait"; readonly trait: TraitId }
  | { readonly _tag: "self" }
  | { readonly _tag: "untargeted" };

type FieldDescriptorBase = {
  readonly id: FieldId;
  readonly cardinality: FieldCardinality;
  readonly unique?: FieldUniqueness;
  /** AVET membership. Distinct from uniqueness — `Field(..., { index: true })`. */
  readonly index: boolean;
  readonly optional: boolean;
  readonly owned: boolean;
};

export type ScalarFieldDescriptor = FieldDescriptorBase & {
  readonly valueType: Exclude<AuthorizationValueType, "ref">;
};

export type RefFieldDescriptor = FieldDescriptorBase & {
  readonly valueType: "ref";
  readonly refTarget: FieldRefTarget;
};

export type FieldDescriptor = ScalarFieldDescriptor | RefFieldDescriptor;

/**
 * Recursive authoritative shape of one operation input key.
 * Nested arrays/structs stay intact; `opaque` is valid input that policy
 * expressions cannot traverse by key.
 */
export type OperationInputShape =
  | {
      readonly _tag: "scalar";
      readonly valueType: Exclude<AuthorizationValueType, "ref">;
    }
  | { readonly _tag: "ref"; readonly refTarget: FieldRefTarget }
  | {
      readonly _tag: "struct";
      readonly fields: readonly OperationInputFieldDescriptor[];
    }
  | { readonly _tag: "array"; readonly items: OperationInputShape }
  | { readonly _tag: "opaque" };

export type OperationInputFieldDescriptor = {
  readonly key: string;
  readonly optional: boolean;
  readonly shape: OperationInputShape;
};

/**
 * Authoritative typed input for one owned operation.
 * The codec itself may be a struct, array, scalar, ref, or opaque value —
 * not only a top-level field map.
 */
export type OperationInputDescriptor = OperationInputShape;

export type OperationDescriptor = {
  readonly id: OperationId;
  readonly input: OperationInputShape;
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

