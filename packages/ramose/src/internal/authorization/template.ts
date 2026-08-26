/** Catalog-relative, data-only policy template. Not executable. */

import type { POLICY_TEMPLATE_VERSION } from "./bounds.ts";
import type { Expr, RuleFocus, RuleMetadata } from "./expr.ts";
import type {
  RelativeFieldRef,
  RelativeOperationRef,
  RuleId,
} from "./identity.ts";

export interface TemplateDecision {
  readonly allow: readonly RuleId[];
  readonly deny: readonly RuleId[];
}

export interface TemplateRule extends RuleMetadata {
  readonly id: RuleId;
  readonly focus: RuleFocus;
  readonly expr: Expr;
  readonly dependencies: readonly string[];
}

export interface TemplatePrincipal {
  readonly subjectClaim: string;
  readonly entity?: RelativeFieldRef;
}

export interface TemplateDecisions {
  readonly rows: Readonly<Record<string, TemplateDecision>>;
  readonly traits: Readonly<Record<string, TemplateDecision>>;
  readonly fields: Readonly<Record<string, TemplateDecision>>;
  readonly operations: Readonly<Record<string, TemplateDecision>>;
}

/**
 * Authoring compiler output. Catalog-relative names only. Must not be
 * accepted by the read authorizer.
 */
export interface PolicyTemplateIR {
  readonly _tag: "PolicyTemplateIR";
  readonly version: typeof POLICY_TEMPLATE_VERSION;
  readonly principal: TemplatePrincipal;
  readonly classes: readonly string[];
  readonly claims: readonly string[];
  readonly rules: readonly TemplateRule[];
  readonly decisions: TemplateDecisions;
}

export const isPolicyTemplateIR = (value: unknown): value is PolicyTemplateIR =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "PolicyTemplateIR";
