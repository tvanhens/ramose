/**
 * Authoritative catalog descriptors and operation input shapes.
 *
 * #384 binds a template against {@link CatalogDescriptor}. #341 supplies
 * the real catalog-local identities; tests may use an in-memory descriptor.
 *
 * Effect Schema is the source of truth. Types are `typeof Model.Type`.
 */

import * as Schema from "effect/Schema";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  DigestHex,
  EntityId,
  FieldId,
  OperationId,
  OperationVersion,
  RuleId,
  SchemaFingerprint,
  TraitId,
} from "./identities.ts";

/**
 * Storage value type a field or operation input key holds.
 * Mirrors the public catalog value-type names without importing `ramose/db`.
 */
export const AuthorizationValueType = Schema.Literals([
  "string",
  "long",
  "double",
  "boolean",
  "ref",
  "uuid",
  "instant",
  "bytes",
]);
export type AuthorizationValueType = typeof AuthorizationValueType.Type;

export const ScalarValueType = Schema.Literals([
  "string",
  "long",
  "double",
  "boolean",
  "uuid",
  "instant",
  "bytes",
]);
export type ScalarValueType = typeof ScalarValueType.Type;

export const FieldCardinality = Schema.Literals(["one", "many"]);
export type FieldCardinality = typeof FieldCardinality.Type;

export const FieldUniqueness = Schema.Literals(["upsert", "strict"]);
export type FieldUniqueness = typeof FieldUniqueness.Type;

export const EntityDescriptor = Schema.Struct({
  id: EntityId,
  /** Direct composed traits. Transitive closure is {@link TraitComposition}. */
  traits: Schema.Array(TraitId),
  /** Optional Markdown documentation for discovery. */
  doc: Schema.optionalKey(Schema.String),
});
export type EntityDescriptor = typeof EntityDescriptor.Type;

export const TraitDescriptor = Schema.Struct({
  id: TraitId,
  traits: Schema.Array(TraitId),
  /** Optional Markdown documentation for discovery. */
  doc: Schema.optionalKey(Schema.String),
});
export type TraitDescriptor = typeof TraitDescriptor.Type;

/**
 * Where a ref field (or ref-shaped operation input) points.
 * Required so a later hop such as `Issue.owner.organization` can check
 * that `organization` belongs to the referenced type — `valueType: "ref"`
 * alone is not enough. `self` is `Ref.self`; `untargeted` is `Field(Ref)`.
 */
export const FieldRefTarget = Schema.Union([
  Schema.TaggedStruct("entity", { entity: EntityId }),
  Schema.TaggedStruct("trait", { trait: TraitId }),
  Schema.TaggedStruct("self", {}),
  Schema.TaggedStruct("untargeted", {}),
]);
export type FieldRefTarget = typeof FieldRefTarget.Type;

const FieldDescriptorBase = {
  id: FieldId,
  cardinality: FieldCardinality,
  unique: Schema.optionalKey(FieldUniqueness),
  /** AVET membership. Distinct from uniqueness — `Field(..., { index: true })`. */
  index: Schema.Boolean,
  optional: Schema.Boolean,
  owned: Schema.Boolean,
  /** Optional Markdown documentation for discovery. */
  doc: Schema.optionalKey(Schema.String),
};

export const ScalarFieldDescriptor = Schema.Struct({
  ...FieldDescriptorBase,
  valueType: ScalarValueType,
});
export type ScalarFieldDescriptor = typeof ScalarFieldDescriptor.Type;

export const RefFieldDescriptor = Schema.Struct({
  ...FieldDescriptorBase,
  valueType: Schema.Literal("ref"),
  refTarget: FieldRefTarget,
});
export type RefFieldDescriptor = typeof RefFieldDescriptor.Type;

export const FieldDescriptor = Schema.Union([ScalarFieldDescriptor, RefFieldDescriptor]);
export type FieldDescriptor = typeof FieldDescriptor.Type;

export const OperationInputScalarShape = Schema.TaggedStruct("scalar", { valueType: ScalarValueType });
export type OperationInputScalarShape = typeof OperationInputScalarShape.Type;

export const OperationInputRefShape = Schema.TaggedStruct("ref", { refTarget: FieldRefTarget });
export type OperationInputRefShape = typeof OperationInputRefShape.Type;

export const OperationInputOpaqueShape = Schema.TaggedStruct("opaque", {});
export type OperationInputOpaqueShape = typeof OperationInputOpaqueShape.Type;

/**
 * Recursive authoritative shape of one operation input key.
 * Nested arrays/structs stay intact; `opaque` is valid input that policy
 * expressions cannot traverse by key.
 *
 * Recursive types exist only to break the inference cycle.
 * Encoded forms keep unbranded catalog strings so #357 can encode without
 * a second contract.
 */
export type OperationInputFieldDescriptor = {
  readonly key: string;
  readonly optional: boolean;
  readonly shape: OperationInputShape;
};

export type OperationInputShape =
  | OperationInputScalarShape
  | OperationInputRefShape
  | OperationInputOpaqueShape
  | { readonly _tag: "struct"; readonly fields: ReadonlyArray<OperationInputFieldDescriptor> }
  | { readonly _tag: "array"; readonly items: OperationInputShape };

export type OperationInputFieldDescriptorEncoded = {
  readonly key: string;
  readonly optional: boolean;
  readonly shape: OperationInputShapeEncoded;
};

export type OperationInputShapeEncoded =
  | typeof OperationInputScalarShape.Encoded
  | typeof OperationInputRefShape.Encoded
  | typeof OperationInputOpaqueShape.Encoded
  | { readonly _tag: "struct"; readonly fields: ReadonlyArray<OperationInputFieldDescriptorEncoded> }
  | { readonly _tag: "array"; readonly items: OperationInputShapeEncoded };

const uniqueInputKeys = Schema.makeFilter(
  (fields: ReadonlyArray<{ readonly key: string }>) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) return `duplicate operation input key '${field.key}'`;
      seen.add(field.key);
    }
    return undefined;
  },
);

const OperationInputKey = Schema.String.check(
  Schema.makeFilter((key) => (key.length === 0 ? "blank operation input key" : undefined)),
);

export const OperationInputFieldDescriptor: Schema.Codec<
  OperationInputFieldDescriptor,
  OperationInputFieldDescriptorEncoded
> = Schema.Struct({
  key: OperationInputKey,
  optional: Schema.Boolean,
  shape: Schema.suspend(() => OperationInputShape),
});

export const OperationInputShape: Schema.Codec<OperationInputShape, OperationInputShapeEncoded> =
  Schema.Union([
    OperationInputScalarShape,
    OperationInputRefShape,
    Schema.TaggedStruct("struct", {
      fields: Schema.Array(OperationInputFieldDescriptor).check(uniqueInputKeys),
    }),
    Schema.TaggedStruct("array", { items: Schema.suspend(() => OperationInputShape) }),
    OperationInputOpaqueShape,
  ]);

/**
 * Authoritative typed input for one owned operation.
 * The codec itself may be a struct, array, scalar, ref, or opaque value —
 * not only a top-level field map.
 */
export const OperationInputDescriptor = OperationInputShape;
export type OperationInputDescriptor = OperationInputShape;

/** Author-declared executable revision; ordinary positive integer. */
const OperationRevision = Schema.Int.check(
  Schema.makeFilter((value: number) =>
    value < 1 ? "operation revision must be a positive integer" : undefined
  ),
);

/**
 * One declared client-ref allocation slot, inert (#475).
 *
 * The slot name predicate is the *same* one `db/allocations.ts` applies when
 * the declaration is authored and when a durable queue row is decoded, spelled
 * here as its regular expression so the catalog descriptor cannot accept a
 * name the durable client would refuse — or the reverse, which would leave a
 * queued invocation permanently unmappable.
 */
export const AllocationSlotDescriptor = Schema.Struct({
  slot: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)),
  /** Property names and array indexes into the operation's declared output. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
});
export type AllocationSlotDescriptor = typeof AllocationSlotDescriptor.Type;

export const OperationDescriptor = Schema.Struct({
  id: OperationId,
  input: OperationInputShape,
  output: OperationInputShape,
  /**
   * Operation-scoped compatibility version (#487). Deployment-free: it never
   * moves with a redeploy or an unrelated catalog change. Compatibility
   * decisions use this; `unitHash`/`bodyHash` remain deployment fences.
   */
  version: OperationVersion,
  /** Author-declared executable revision folded into {@link version}. */
  revision: OperationRevision,
  /** Hashes of the exact Effect Schema definitions retained by deployed code. */
  inputSchemaHash: DigestHex,
  outputSchemaHash: DigestHex,
  /** Deployment digest identifying the deployed operation implementation. */
  bodyHash: DigestHex,
  /** Canonical composer entity types for a targeted trait operation; empty otherwise. */
  composers: Schema.Array(EntityId),
  /** Additional entity definitions retained as authoring/reachability metadata. */
  writes: Schema.Array(EntityId),
  /**
   * Named client-ref allocation slots, canonically ordered by slot name (#475).
   * Omitted entirely when the operation allocates nothing, so a descriptor for
   * an operation that declares no slots encodes exactly as it did before this
   * field existed. Already folded into {@link OperationVersion} by descriptor
   * generation 2; carried here so the authoritative edge can read a slot's
   * declared output path without re-deriving it.
   */
  allocations: Schema.optionalKey(Schema.Array(AllocationSlotDescriptor)),
  /** Optional operation documentation. */
  doc: Schema.optionalKey(Schema.String),
});
export type OperationDescriptor = typeof OperationDescriptor.Type;

export const TraitComposition = Schema.Struct({
  composer: EntityId,
  trait: TraitId,
  transitive: Schema.Array(TraitId),
});
export type TraitComposition = typeof TraitComposition.Type;

/**
 * Authoritative catalog the binder validates against.
 * Cross-catalog, cross-database, and stale identities fail binding (CAT-3, CAT-5).
 * `database` is the install the descriptor was resolved for — not derivable
 * from {@link CatalogId}.
 */
export const CatalogDescriptor = Schema.Struct({
  id: CatalogId,
  database: DatabaseId,
  version: CatalogVersion,
  fingerprint: SchemaFingerprint,
  entities: Schema.Array(EntityDescriptor),
  traits: Schema.Array(TraitDescriptor),
  fields: Schema.Array(FieldDescriptor),
  operations: Schema.Array(OperationDescriptor),
  traitComposition: Schema.Array(TraitComposition),
});
export type CatalogDescriptor = typeof CatalogDescriptor.Type;

/**
 * Facts and index lookups a v1 rule requires. Derived during install —
 * never taken from a template. Database-wide `exists` scans are not v1.
 *
 * `index` is the optional AVET membership catalog flag
 * (`FieldDescriptor.index === true`). Use it for many-scalar `in`/`has`
 * and unique principal-row resolution.
 *
 * `refIndex` is the mandatory implicit reverse / VAET-style membership
 * index for cardinality-many ref fields. It is independent of
 * `FieldDescriptor.index` and is the #361 contract for `me in tags` /
 * `has tags`. Do not reuse `_tag: "index"` for that path.
 */
export const RuleAccessLookup = Schema.Union([
  Schema.TaggedStruct("field", { field: FieldId }),
  Schema.TaggedStruct("entity", { entity: EntityId }),
  Schema.TaggedStruct("trait", { trait: TraitId }),
  Schema.TaggedStruct("index", { field: FieldId }),
  Schema.TaggedStruct("refIndex", { field: FieldId }),
  Schema.TaggedStruct("principal", { field: FieldId }),
]);
export type RuleAccessLookup = typeof RuleAccessLookup.Type;

export const RuleAccessPlan = Schema.Struct({
  rule: RuleId,
  lookups: Schema.Array(RuleAccessLookup),
});
export type RuleAccessPlan = typeof RuleAccessPlan.Type;
