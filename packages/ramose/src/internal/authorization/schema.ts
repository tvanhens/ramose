/**
 * Effect Schema codecs for authorization IR. Strict JSON-only decoding,
 * version discrimination, finite literals, and structural validation.
 * Semantic catalog checks live in `validate.ts` / `install.ts`.
 */

import { Schema } from "effect";
import {
  AUTHORIZATION_IR_VERSION,
  type CatalogBinding,
  type FieldId,
  type InstalledAuthorizationIR,
  type IrDecision,
  type IrExpr,
  type IrIdentities,
  type IrOperand,
  type IrPath,
  type IrRule,
  type JsonLiteral,
  type OperationId,
  type OwnerId,
  type PathStep,
  type PolicyTemplateIR,
  type PrincipalSpec,
} from "./ir.ts";

const CardSchema = Schema.Literals(["one", "many"]);
const OwnerKindSchema = Schema.Literals(["entity", "trait"]);
const OperationTargetSchema = Schema.Literals(["none", "resource"]);

export const JsonLiteralSchema: Schema.Codec<JsonLiteral> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  Schema.Finite,
]);

export const OwnerIdSchema: Schema.Codec<OwnerId> = Schema.Struct({
  kind: OwnerKindSchema,
  ns: Schema.String.check(Schema.isNonEmpty()),
});

export const FieldIdSchema: Schema.Codec<FieldId> = Schema.Struct({
  kind: Schema.Literal("field"),
  ident: Schema.String.check(Schema.isNonEmpty()),
  owner: OwnerIdSchema,
  name: Schema.String.check(Schema.isNonEmpty()),
  cardinality: CardSchema,
  valueType: Schema.String.check(Schema.isNonEmpty()),
});

export const OperationIdSchema: Schema.Codec<OperationId> = Schema.Struct({
  kind: Schema.Literal("operation"),
  owner: OwnerIdSchema,
  localName: Schema.String.check(Schema.isNonEmpty()),
  name: Schema.String.check(Schema.isNonEmpty()),
  target: OperationTargetSchema,
});

const IdentStepSchema = Schema.Struct({
  ident: Schema.String.check(Schema.isNonEmpty()),
  cardinality: CardSchema,
  valueType: Schema.String.check(Schema.isNonEmpty()),
});

const KeyStepSchema = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty()),
  cardinality: CardSchema,
  valueType: Schema.String.check(Schema.isNonEmpty()),
});

export const PathStepSchema: Schema.Codec<PathStep> = Schema.Union([IdentStepSchema, KeyStepSchema]);

export const IrPathSchema: Schema.Codec<IrPath> = Schema.Struct({
  root: Schema.String.check(Schema.isNonEmpty()),
  steps: Schema.Array(PathStepSchema),
});

export const IrOperandSchema: Schema.Codec<IrOperand> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("me") }),
  Schema.Struct({ kind: Schema.Literal("lit"), value: JsonLiteralSchema }),
  Schema.Struct({ kind: Schema.Literal("path"), path: IrPathSchema }),
]);

export const IrExprSchema: Schema.Codec<IrExpr> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("const"), value: Schema.Boolean }),
    Schema.Struct({ kind: Schema.Literal("hasClass"), class: Schema.String.check(Schema.isNonEmpty()) }),
    Schema.Struct({ kind: Schema.Literal("eq"), left: IrOperandSchema, right: IrOperandSchema }),
    Schema.Struct({
      kind: Schema.Literal("has"),
      path: IrPathSchema,
      value: Schema.optionalKey(IrOperandSchema),
    }),
    Schema.Struct({
      kind: Schema.Literal("some"),
      path: IrPathSchema,
      bind: Schema.String.check(Schema.isNonEmpty()),
      body: IrExprSchema,
    }),
    Schema.Struct({ kind: Schema.Literal("overlaps"), left: IrPathSchema, right: IrPathSchema }),
    Schema.Struct({
      kind: Schema.Literal("exists"),
      entity: Schema.String.check(Schema.isNonEmpty()),
      bind: Schema.String.check(Schema.isNonEmpty()),
      body: IrExprSchema,
    }),
    Schema.Struct({
      kind: Schema.Literal("and"),
      exprs: Schema.Array(IrExprSchema).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("or"),
      exprs: Schema.Array(IrExprSchema).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({ kind: Schema.Literal("not"), expr: IrExprSchema }),
  ]),
);

export const IrRuleSchema: Schema.Codec<IrRule> = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  focus: OwnerIdSchema,
  expr: IrExprSchema,
  usesResource: Schema.Boolean,
  usesMe: Schema.Boolean,
  usesInput: Schema.Boolean,
  claims: Schema.Array(Schema.String),
  classes: Schema.Array(Schema.String),
  exists: Schema.Array(Schema.Struct({ entity: Schema.String.check(Schema.isNonEmpty()) })),
});

export const IrDecisionSchema: Schema.Codec<IrDecision> = Schema.Struct({
  allow: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String),
});

export const PrincipalSpecSchema: Schema.Codec<PrincipalSpec> = Schema.Struct({
  subjectClaim: Schema.Literal("sub"),
  ident: Schema.optionalKey(Schema.String),
  entity: Schema.optionalKey(Schema.String),
});

export const IdentitiesSchema: Schema.Codec<IrIdentities> = Schema.Struct({
  entities: Schema.Array(OwnerIdSchema),
  traits: Schema.Array(OwnerIdSchema),
  fields: Schema.Array(FieldIdSchema),
  operations: Schema.Array(OperationIdSchema),
});

const DecisionMapSchema = Schema.Record(Schema.String, IrDecisionSchema);

const CatalogVersionSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const CatalogBindingSchema: Schema.Codec<CatalogBinding> = Schema.Struct({
  databaseId: Schema.String.check(Schema.isNonEmpty()),
  catalogName: Schema.String.check(Schema.isNonEmpty()),
  catalogVersion: CatalogVersionSchema,
  schemaFingerprint: Schema.String.check(Schema.isNonEmpty()),
});

const PolicyBodyFields = {
  version: Schema.Literal(AUTHORIZATION_IR_VERSION),
  principal: PrincipalSpecSchema,
  classes: Schema.Array(Schema.String),
  claims: Schema.Array(Schema.String),
  identities: IdentitiesSchema,
  rules: Schema.Array(IrRuleSchema),
  rows: DecisionMapSchema,
  traits: DecisionMapSchema,
  fields: DecisionMapSchema,
  operations: DecisionMapSchema,
};

export const PolicyTemplateIRSchema: Schema.Codec<PolicyTemplateIR> = Schema.Struct({
  form: Schema.Literal("template"),
  ...PolicyBodyFields,
});

export const InstalledAuthorizationIRSchema: Schema.Codec<InstalledAuthorizationIR> = Schema.Struct({
  form: Schema.Literal("installed"),
  catalog: CatalogBindingSchema,
  policyHash: Schema.String.check(Schema.isNonEmpty()),
  ...PolicyBodyFields,
});
