/**
 * Two-stage authorization IR.
 *
 * {@link PolicyTemplateIR} is catalog-relative compiler output. It is not
 * executable runtime policy. {@link InstalledAuthorizationIR} is the bound,
 * sealed form runtime accepts. The types are distinct: a template is not
 * assignable where installed IR is required.
 *
 * Effect Schema is the source of truth. This module defines the models —
 * no parser, binder, installer, hash, or decodeUnknownEffect workflow.
 */

import * as Schema from "effect/Schema";
import {
  CatalogDescriptor,
  OperationDescriptor,
  RuleAccessPlan,
  TraitComposition,
} from "./catalog.ts";
import { CanonicalAuthorizationExpr, RelativeAuthorizationExpr } from "./expr.ts";
import {
  CanonicalIdentitySchemas,
  CatalogId,
  CatalogVersion,
  DatabaseId,
  PolicyHash,
  RelativeIdentitySchemas,
  RuleId,
  SchemaFingerprint,
  type AnyIdentitySchemaSpace,
  type CanonicalIdentities,
  type IdentitySpace,
  type RelativeIdentities,
} from "./identities.ts";
import {
  ClaimVocabulary,
  ClassVocabulary,
  InstalledPrincipalResolution,
  PrincipalResolutionConfig,
} from "./principal.ts";

export const POLICY_TEMPLATE_IR_VERSION = 1 as const;
export const INSTALLED_AUTHORIZATION_IR_VERSION = 1 as const;

export const PolicyTemplateIRVersion = Schema.Literal(POLICY_TEMPLATE_IR_VERSION);
export type PolicyTemplateIRVersion = typeof PolicyTemplateIRVersion.Type;

export const InstalledAuthorizationIRVersion = Schema.Literal(INSTALLED_AUTHORIZATION_IR_VERSION);
export type InstalledAuthorizationIRVersion = typeof InstalledAuthorizationIRVersion.Type;

export const RuleFocus = <
  Entity extends Schema.Top,
  Trait extends Schema.Top,
  Field extends Schema.Top,
  Operation extends Schema.Top,
>(
  ids: AnyIdentitySchemaSpace<Entity, Trait, Field, Operation>,
) =>
  Schema.Union([
    Schema.TaggedStruct("entity", { entity: ids.entity }),
    Schema.TaggedStruct("trait", { trait: ids.trait }),
    Schema.TaggedStruct("field", { field: ids.field }),
    Schema.TaggedStruct("operation", { operation: ids.operation }),
  ]);

/**
 * Derived flags are part of the document shape. The semantic validator
 * (#358) recomputes them; parsers must not trust author-supplied values.
 */
export const AuthorizationRule = <
  Entity extends Schema.Top,
  Trait extends Schema.Top,
  Field extends Schema.Top,
  Operation extends Schema.Top,
  Expr extends Schema.Top,
>(
  ids: AnyIdentitySchemaSpace<Entity, Trait, Field, Operation>,
  expr: Expr,
) =>
  Schema.Struct({
    id: RuleId,
    focus: RuleFocus(ids),
    expr,
    usesResource: Schema.Boolean,
    usesInput: Schema.Boolean,
    usesMe: Schema.Boolean,
    usesSubject: Schema.Boolean,
    traversalDepth: Schema.Natural,
    existsDepth: Schema.Natural,
    dependencies: Schema.Array(RuleId),
  });

/**
 * `.allow(a, b)` is OR. Explicit deny wins. Missing decision is deny (POL-4).
 * Keys are identities, never wire names alone.
 */
export const Decision = Schema.Struct({
  allow: Schema.Array(RuleId),
  deny: Schema.Array(RuleId),
});
export type Decision = typeof Decision.Type;

export const DecisionEntry = <Target extends Schema.Top>(target: Target) =>
  Schema.Struct({
    target,
    decision: Decision,
  });

export const AuthorizationDecisions = <
  Entity extends Schema.Top,
  Trait extends Schema.Top,
  Field extends Schema.Top,
  Operation extends Schema.Top,
>(
  ids: AnyIdentitySchemaSpace<Entity, Trait, Field, Operation>,
) =>
  Schema.Struct({
    entities: Schema.Array(DecisionEntry(ids.entity)),
    traits: Schema.Array(DecisionEntry(ids.trait)),
    fields: Schema.Array(DecisionEntry(ids.field)),
    operations: Schema.Array(DecisionEntry(ids.operation)),
  });

export const InstalledIdentityTable = Schema.Struct({
  entities: Schema.Array(CanonicalIdentitySchemas.entity),
  traits: Schema.Array(CanonicalIdentitySchemas.trait),
  fields: Schema.Array(CanonicalIdentitySchemas.field),
  operations: Schema.Array(CanonicalIdentitySchemas.operation),
});
export type InstalledIdentityTable = typeof InstalledIdentityTable.Type;

/**
 * Catalog-relative, data-only template. Contains no functions, closures,
 * symbols, prototypes, Effects, or executable callbacks. The read
 * authorizer must not accept this form.
 */
export const PolicyTemplateIR = Schema.TaggedStruct("PolicyTemplateIR", {
  version: PolicyTemplateIRVersion,
  classes: ClassVocabulary,
  claims: ClaimVocabulary,
  principal: PrincipalResolutionConfig,
  rules: Schema.Array(AuthorizationRule(RelativeIdentitySchemas, RelativeAuthorizationExpr)),
  decisions: AuthorizationDecisions(RelativeIdentitySchemas),
});
export type PolicyTemplateIR = typeof PolicyTemplateIR.Type;

/**
 * Bound, sealed installed artifact. Runtime accepts only this form.
 * Catalog identity, version, schema fingerprint, and policy hash are
 * mandatory so a template cannot be passed in their place.
 */
export const InstalledAuthorizationIR = Schema.TaggedStruct("InstalledAuthorizationIR", {
  version: InstalledAuthorizationIRVersion,
  database: DatabaseId,
  catalog: CatalogId,
  catalogVersion: CatalogVersion,
  schemaFingerprint: SchemaFingerprint,
  policyHash: PolicyHash,
  classes: ClassVocabulary,
  claims: ClaimVocabulary,
  principal: InstalledPrincipalResolution,
  identities: InstalledIdentityTable,
  traitComposition: Schema.Array(TraitComposition),
  operations: Schema.Array(OperationDescriptor),
  rules: Schema.Array(AuthorizationRule(CanonicalIdentitySchemas, CanonicalAuthorizationExpr)),
  decisions: AuthorizationDecisions(CanonicalIdentitySchemas),
  accessPlans: Schema.Array(RuleAccessPlan),
});
export type InstalledAuthorizationIR = typeof InstalledAuthorizationIR.Type;

/** Input later slices pass to the Effectful catalog binder. */
export const CatalogBindingInput = Schema.Struct({
  /** Database this catalog is being installed into. Not derivable from catalog id. */
  database: DatabaseId,
  catalog: CatalogDescriptor,
  template: PolicyTemplateIR,
});
export type CatalogBindingInput = typeof CatalogBindingInput.Type;

export const RelativeRuleFocus = RuleFocus(RelativeIdentitySchemas);
export type RelativeRuleFocus = typeof RelativeRuleFocus.Type;
export const CanonicalRuleFocus = RuleFocus(CanonicalIdentitySchemas);
export type CanonicalRuleFocus = typeof CanonicalRuleFocus.Type;

export const RelativeAuthorizationRule = AuthorizationRule(
  RelativeIdentitySchemas,
  RelativeAuthorizationExpr,
);
export type RelativeAuthorizationRule = typeof RelativeAuthorizationRule.Type;
export const CanonicalAuthorizationRule = AuthorizationRule(
  CanonicalIdentitySchemas,
  CanonicalAuthorizationExpr,
);
export type CanonicalAuthorizationRule = typeof CanonicalAuthorizationRule.Type;

export const RelativeAuthorizationDecisions = AuthorizationDecisions(RelativeIdentitySchemas);
export type RelativeAuthorizationDecisions = typeof RelativeAuthorizationDecisions.Type;
export const CanonicalAuthorizationDecisions = AuthorizationDecisions(CanonicalIdentitySchemas);
export type CanonicalAuthorizationDecisions = typeof CanonicalAuthorizationDecisions.Type;

export type RuleFocus<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalRuleFocus
  : RelativeRuleFocus;

export type AuthorizationRule<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalAuthorizationRule
  : RelativeAuthorizationRule;

export type AuthorizationDecisions<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalAuthorizationDecisions
  : RelativeAuthorizationDecisions;

export type DecisionEntry<Target extends Schema.Top> = ReturnType<
  typeof DecisionEntry<Target>
>["Type"];
