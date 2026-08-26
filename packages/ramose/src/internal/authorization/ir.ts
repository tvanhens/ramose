/**
 * Two-stage authorization IR type shapes.
 *
 * {@link PolicyTemplateIR} is catalog-relative compiler output. It is not
 * executable runtime policy. {@link InstalledAuthorizationIR} is the bound,
 * sealed form runtime accepts. The types are distinct: a template is not
 * assignable where installed IR is required.
 *
 * This module is data shapes only — no parser, binder, installer, or hash.
 */

import type {
  CatalogDescriptor,
  OperationDescriptor,
  RuleAccessPlan,
  TraitComposition,
} from "./catalog.ts";
import type { AuthorizationExpr } from "./expr.ts";
import type {
  CanonicalIdentities,
  CatalogId,
  CatalogVersion,
  DatabaseId,
  IdentitySpace,
  PolicyHash,
  RelativeIdentities,
  RuleId,
  SchemaFingerprint,
} from "./identities.ts";
import type {
  ClaimVocabulary,
  ClassVocabulary,
  InstalledPrincipalResolution,
  PrincipalResolutionConfig,
} from "./principal.ts";

export const POLICY_TEMPLATE_IR_VERSION = 1 as const;
export const INSTALLED_AUTHORIZATION_IR_VERSION = 1 as const;

export type PolicyTemplateIRVersion = typeof POLICY_TEMPLATE_IR_VERSION;
export type InstalledAuthorizationIRVersion = typeof INSTALLED_AUTHORIZATION_IR_VERSION;

export type RuleFocus<I extends IdentitySpace = RelativeIdentities> =
  | { readonly _tag: "entity"; readonly entity: I["entity"] }
  | { readonly _tag: "trait"; readonly trait: I["trait"] }
  | { readonly _tag: "field"; readonly field: I["field"] }
  | { readonly _tag: "operation"; readonly operation: I["operation"] };

/**
 * Derived flags are part of the document shape. The semantic validator
 * (#358) recomputes them; parsers must not trust author-supplied values.
 */
export type AuthorizationRule<I extends IdentitySpace = RelativeIdentities> = {
  readonly id: RuleId;
  readonly focus: RuleFocus<I>;
  readonly expr: AuthorizationExpr<I>;
  readonly usesResource: boolean;
  readonly usesInput: boolean;
  readonly usesMe: boolean;
  readonly usesSubject: boolean;
  readonly traversalDepth: number;
  readonly existsDepth: number;
  readonly dependencies: readonly RuleId[];
};

/**
 * `.allow(a, b)` is OR. Explicit deny wins. Missing decision is deny (POL-4).
 * Keys are identities, never wire names alone.
 */
export type Decision = {
  readonly allow: readonly RuleId[];
  readonly deny: readonly RuleId[];
};

export type DecisionEntry<Target> = {
  readonly target: Target;
  readonly decision: Decision;
};

export type AuthorizationDecisions<I extends IdentitySpace = RelativeIdentities> = {
  readonly entities: readonly DecisionEntry<I["entity"]>[];
  readonly traits: readonly DecisionEntry<I["trait"]>[];
  readonly fields: readonly DecisionEntry<I["field"]>[];
  readonly operations: readonly DecisionEntry<I["operation"]>[];
};

export type InstalledIdentityTable = {
  readonly entities: readonly CanonicalIdentities["entity"][];
  readonly traits: readonly CanonicalIdentities["trait"][];
  readonly fields: readonly CanonicalIdentities["field"][];
  readonly operations: readonly CanonicalIdentities["operation"][];
};

/**
 * Catalog-relative, data-only template. Contains no functions, closures,
 * symbols, prototypes, Effects, or executable callbacks. The read
 * authorizer must not accept this form.
 */
export type PolicyTemplateIR = {
  readonly _tag: "PolicyTemplateIR";
  readonly version: PolicyTemplateIRVersion;
  readonly classes: ClassVocabulary;
  readonly claims: ClaimVocabulary;
  readonly principal: PrincipalResolutionConfig;
  readonly rules: readonly AuthorizationRule<RelativeIdentities>[];
  readonly decisions: AuthorizationDecisions<RelativeIdentities>;
};

/**
 * Bound, sealed installed artifact. Runtime accepts only this form.
 * Catalog identity, version, schema fingerprint, and policy hash are
 * mandatory so a template cannot be passed in their place.
 */
export type InstalledAuthorizationIR = {
  readonly _tag: "InstalledAuthorizationIR";
  readonly version: InstalledAuthorizationIRVersion;
  readonly database: DatabaseId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly schemaFingerprint: SchemaFingerprint;
  readonly policyHash: PolicyHash;
  readonly classes: ClassVocabulary;
  readonly claims: ClaimVocabulary;
  readonly principal: InstalledPrincipalResolution;
  readonly identities: InstalledIdentityTable;
  readonly traitComposition: readonly TraitComposition[];
  readonly operations: readonly OperationDescriptor[];
  readonly rules: readonly AuthorizationRule<CanonicalIdentities>[];
  readonly decisions: AuthorizationDecisions<CanonicalIdentities>;
  readonly accessPlans: readonly RuleAccessPlan[];
};

/** Input later slices pass to the Effectful catalog binder. */
export type CatalogBindingInput = {
  /** Database this catalog is being installed into. Not derivable from catalog id. */
  readonly database: DatabaseId;
  readonly catalog: CatalogDescriptor;
  readonly template: PolicyTemplateIR;
};
