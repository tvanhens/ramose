/** Sealed installed authorization artifact. Runtime accepts only this form. */

import type { INSTALLED_AUTHORIZATION_VERSION } from "./bounds.ts";
import type { Expr, RuleFocus, RuleMetadata } from "./expr.ts";
import type {
  CanonicalEntityRef,
  CanonicalFieldRef,
  CanonicalOperationRef,
  CanonicalTraitRef,
  CatalogId,
  CatalogVersion,
  RelativeFieldRef,
  RelativeOperationRef,
  RuleId,
} from "./identity.ts";
import type { DecisionAccessPlan, RuleAccessPlan } from "./plan.ts";

export const InstalledBrand: unique symbol = Symbol.for(
  "ramose.InstalledAuthorizationIR",
);

export interface InstalledDecision {
  readonly allow: readonly RuleId[];
  readonly deny: readonly RuleId[];
}

export interface InstalledRule extends RuleMetadata {
  readonly id: RuleId;
  readonly focus: RuleFocus;
  readonly expr: Expr;
  readonly dependencies: readonly string[];
  readonly accessPlan: RuleAccessPlan;
}

export interface InstalledPrincipal {
  readonly subjectClaim: string;
  readonly entity?: CanonicalFieldRef;
}

export interface InstalledIdentities {
  readonly entities: readonly CanonicalEntityRef[];
  readonly traits: readonly CanonicalTraitRef[];
  readonly fields: readonly CanonicalFieldRef[];
  readonly operations: readonly CanonicalOperationRef[];
}

export interface InstalledOperationDescriptor {
  readonly identity: CanonicalOperationRef;
  readonly inputKeys: readonly string[];
}

export interface InstalledDecisions {
  readonly rows: Readonly<Record<string, InstalledDecision>>;
  readonly traits: Readonly<Record<string, InstalledDecision>>;
  readonly fields: Readonly<Record<string, InstalledDecision>>;
  readonly operations: Readonly<Record<string, InstalledDecision>>;
}

/**
 * Bound, sealed policy. Name-to-identity happens at bind time. Runtime
 * operation decisions are never keyed by wire name alone.
 */
export interface InstalledAuthorizationIR {
  readonly _tag: "InstalledAuthorizationIR";
  readonly version: typeof INSTALLED_AUTHORIZATION_VERSION;
  readonly catalogId: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly catalogFingerprint: string;
  readonly policyHash: string;
  readonly principal: InstalledPrincipal;
  readonly classes: readonly string[];
  readonly claims: readonly string[];
  readonly identities: InstalledIdentities;
  readonly traitComposition: Readonly<Record<string, readonly string[]>>;
  readonly operationDescriptors: readonly InstalledOperationDescriptor[];
  readonly rules: readonly InstalledRule[];
  readonly decisions: InstalledDecisions;
  readonly accessPlans: readonly DecisionAccessPlan[];
}

export type SealedInstalledAuthorizationIR = InstalledAuthorizationIR & {
  readonly [InstalledBrand]: typeof InstalledBrand;
};

export const isInstalledAuthorizationIR = (
  value: unknown,
): value is InstalledAuthorizationIR =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "InstalledAuthorizationIR";

export const isSealedInstalled = (
  value: unknown,
): value is SealedInstalledAuthorizationIR =>
  isInstalledAuthorizationIR(value) &&
  (value as { readonly [InstalledBrand]?: unknown })[InstalledBrand] ===
    InstalledBrand;

export type { RelativeFieldRef, RelativeOperationRef };
