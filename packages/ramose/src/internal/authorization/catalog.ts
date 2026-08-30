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
  traits: Schema.Array(TraitId),
  doc: Schema.optionalKey(Schema.String),
});
export type EntityDescriptor = typeof EntityDescriptor.Type;

export const TraitDescriptor = Schema.Struct({
  id: TraitId,
  traits: Schema.Array(TraitId),
  doc: Schema.optionalKey(Schema.String),
});
export type TraitDescriptor = typeof TraitDescriptor.Type;

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
  index: Schema.Boolean,
  optional: Schema.Boolean,
  owned: Schema.Boolean,
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

export const OperationInputDescriptor = OperationInputShape;
export type OperationInputDescriptor = OperationInputShape;

const OperationRevision = Schema.Int.check(
  Schema.makeFilter((value: number) =>
    value < 1 ? "operation revision must be a positive integer" : undefined
  ),
);

export const AllocationSlotDescriptor = Schema.Struct({
  slot: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)),
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
});
export type AllocationSlotDescriptor = typeof AllocationSlotDescriptor.Type;

export const OperationDescriptor = Schema.Struct({
  id: OperationId,
  input: OperationInputShape,
  output: OperationInputShape,
  version: OperationVersion,
  revision: OperationRevision,
  inputSchemaHash: DigestHex,
  outputSchemaHash: DigestHex,
  bodyHash: DigestHex,
  composers: Schema.Array(EntityId),
  writes: Schema.Array(EntityId),
  allocations: Schema.optionalKey(Schema.Array(AllocationSlotDescriptor)),
  doc: Schema.optionalKey(Schema.String),
});
export type OperationDescriptor = typeof OperationDescriptor.Type;

export const TraitComposition = Schema.Struct({
  composer: EntityId,
  trait: TraitId,
  transitive: Schema.Array(TraitId),
});
export type TraitComposition = typeof TraitComposition.Type;

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
