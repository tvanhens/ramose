/** Compile authoring output into a validated PolicyTemplateIR. */

import * as Effect from "effect/Effect";
import type * as SchemaNS from "effect/Schema";
import type { AnySchema } from "../db/Schema.ts";
import { POLICY_TEMPLATE_VERSION } from "../internal/authorization/bounds.ts";
import { canonicalRuleBody } from "../internal/authorization/canonical.ts";
import {
  HashFailure,
  InvalidTemplate,
  RuleIdentityCollision,
} from "../internal/authorization/errors.ts";
import type { Expr, Operand, RuleFocus } from "../internal/authorization/expr.ts";
import { analyzeExpr, collectExprDependencies } from "../internal/authorization/expr.ts";
import { AuthorizationHash } from "../internal/authorization/services.ts";
import type {
  PolicyTemplateIR,
  TemplateDecision,
  TemplateRule,
} from "../internal/authorization/template.ts";
import { semanticallyValidateTemplate } from "../internal/authorization/validate.ts";
import {
  authorPolicy,
  type DecisionBuilder,
  type PolicyHelpers,
  type PolicyOptions,
  type AuthRule,
  type PolicyBinding,
} from "./authoring.ts";
import { catalogDescriptorFrom } from "./catalog.ts";
import { isAuthExpr, resetBindSeq, type AuthExpr, type ClaimCell } from "./expr.ts";

const rewriteSelf = (expr: Expr, focus: RuleFocus): Expr => {
  const rewriteOperand = (operand: Operand): Operand => {
    if (operand._tag !== "path") return operand;
    const steps = operand.path.steps.map((step) => {
      if (step.field.owner.name !== "*" || step.field.localName !== "id") return step;
      if (focus._tag === "entity") {
        return {
          field: { owner: { kind: "entity" as const, name: focus.name }, localName: "id" },
        };
      }
      if (focus._tag === "operation" && focus.target === "required") {
        return {
          field: { owner: focus.owner, localName: "id" },
        };
      }
      throw new InvalidTemplate({
        message: "self is only valid on an entity or targeted operation",
      });
    });
    return { ...operand, path: { ...operand.path, steps } };
  };
  switch (expr._tag) {
    case "and":
    case "or":
      return { ...expr, exprs: expr.exprs.map((child) => rewriteSelf(child, focus)) };
    case "not":
      return { ...expr, expr: rewriteSelf(expr.expr, focus) };
    case "eq":
      return { ...expr, left: rewriteOperand(expr.left), right: rewriteOperand(expr.right) };
    case "has":
      return { ...expr, operand: rewriteOperand(expr.operand) };
    case "some":
    case "exists":
      return { ...expr, pred: rewriteSelf(expr.pred, focus) };
    default:
      return expr;
  }
};

const ruleFromArm = (
  arm: AuthRule | AuthExpr,
  binding: PolicyBinding,
): { readonly focus: RuleFocus; readonly expr: Expr } => {
  if (isAuthExpr(arm)) {
    const focus: RuleFocus =
      binding.kind === "row"
        ? { _tag: "entity", name: binding.key }
        : binding.kind === "trait"
          ? { _tag: "trait", name: binding.key }
          : binding.kind === "operation"
            ? (() => {
                const [ownerPart, rest] = binding.key.split("/") as [string, string];
                const [kind, name] = ownerPart.split(":") as ["entity" | "trait", string];
                const [localName, target] = rest.split(":") as [string, "required" | "none"];
                return {
                  _tag: "operation" as const,
                  owner: { kind, name },
                  localName,
                  target,
                };
              })()
            : binding.key.startsWith("trait:")
              ? { _tag: "trait", name: binding.key.slice("trait:".length).split("/")[0]! }
              : { _tag: "entity", name: binding.key.slice("entity:".length).split("/")[0]! };
    return { focus, expr: rewriteSelf(arm.expr, focus) };
  }
  return { focus: arm.irFocus, expr: rewriteSelf(arm.expr.expr, arm.irFocus) };
};

export type CompileFailure = InvalidTemplate | RuleIdentityCollision | HashFailure;

export const compileAuthoring = (
  authored: ReturnType<typeof authorPolicy>,
): Effect.Effect<PolicyTemplateIR, CompileFailure, AuthorizationHash> =>
  Effect.gen(function* () {
    const hash = yield* AuthorizationHash;
    const catalog = catalogDescriptorFrom({
      catalogId: "relative",
      catalogVersion: "authoring",
      schema: authored.schema,
      operations: authored.operations,
    });

    const rawRules = authored.bindings.flatMap((binding) =>
      [...binding.allow, ...binding.deny].map((arm) => ruleFromArm(arm, binding)),
    );

    const rules: TemplateRule[] = [];
    const byBody = new Map<string, TemplateRule>();
    for (const raw of rawRules) {
      const body = canonicalRuleBody(raw);
      const existing = byBody.get(body);
      if (existing !== undefined) continue;
      const id = yield* hash.digest(body);
      const meta = analyzeExpr(raw.expr);
      const rule: TemplateRule = {
        id,
        focus: raw.focus,
        expr: raw.expr,
        dependencies: collectExprDependencies(raw.expr),
        ...meta,
      };
      byBody.set(body, rule);
      rules.push(rule);
    }

    const idOf = (arm: AuthRule | AuthExpr, binding: PolicyBinding): string => {
      const raw = ruleFromArm(arm, binding);
      const body = canonicalRuleBody(raw);
      const rule = byBody.get(body);
      if (rule === undefined) {
        throw new InvalidTemplate({ message: "compiled arm is missing a rule id" });
      }
      return rule.id;
    };

    const decisions = {
      rows: {} as Record<string, TemplateDecision>,
      traits: {} as Record<string, TemplateDecision>,
      fields: {} as Record<string, TemplateDecision>,
      operations: {} as Record<string, TemplateDecision>,
    };

    for (const binding of authored.bindings) {
      const decision: TemplateDecision = {
        allow: binding.allow.map((arm) => idOf(arm, binding)),
        deny: binding.deny.map((arm) => idOf(arm, binding)),
      };
      const map =
        binding.kind === "row"
          ? decisions.rows
          : binding.kind === "trait"
            ? decisions.traits
            : binding.kind === "field"
              ? decisions.fields
              : decisions.operations;
      if (map[binding.key] !== undefined) {
        throw new InvalidTemplate({
          message: `duplicate ${binding.kind} decision ${binding.key}`,
          path: binding.key,
        });
      }
      map[binding.key] = decision;
    }

    const template: PolicyTemplateIR = {
      _tag: "PolicyTemplateIR",
      version: POLICY_TEMPLATE_VERSION,
      principal: {
        subjectClaim: authored.options.principal.subjectClaim,
        entity: authored.principalField,
      },
      classes: authored.classes,
      claims: authored.claimKeys,
      rules,
      decisions,
    };

    const digest = (canonical: string): string => Effect.runSync(hash.digest(canonical));
    return semanticallyValidateTemplate(template, catalog, digest);
  });

export const Policy = <
  C extends AnySchema,
  CF extends SchemaNS.Struct.Fields | undefined,
  const Classes extends string,
>(
  schema: C,
  options: PolicyOptions<CF, Classes>,
  body: (
    helpers: PolicyHelpers<C, { readonly [K in keyof CF]: ClaimCell }, Classes>,
  ) => readonly DecisionBuilder[],
): Effect.Effect<PolicyTemplateIR, CompileFailure, AuthorizationHash> =>
  Effect.suspend(() => {
    try {
      resetBindSeq();
      return compileAuthoring(authorPolicy(schema, options, body as never));
    } catch (cause) {
      return Effect.fail(
        cause instanceof InvalidTemplate
          ? cause
          : new InvalidTemplate({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    }
  });
