/** Principal-only evaluation for one sealed operation decision. */

import type { OperationDescriptor } from "./catalog.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalValueTerm,
} from "./expr.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import type { AuthenticatedCaller } from "./request.ts";
import { operationKey } from "./validation/common.ts";

/**
 * One value term seen from the principal alone.
 *
 * `invalid` means the term is *row-relative* — it cannot be settled without
 * the row being tested. Consumers decide what that means for them: operation
 * grants fail closed on it, while a read pre-filter treats it as "cannot say".
 */
export type PrincipalProjection =
  | { readonly _tag: "present"; readonly value: unknown }
  | { readonly _tag: "absent" }
  | { readonly _tag: "invalid" };

const absent: PrincipalProjection = { _tag: "absent" };
const invalid: PrincipalProjection = { _tag: "invalid" };
const present = (value: unknown): PrincipalProjection => ({
  _tag: "present",
  value,
});

/** Value equality as authorization rules compare it: scalars, then arrays. */
export const principalValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => Object.is(value, right[index]));
};

/**
 * Project one canonical value term against the principal.
 *
 * Shared so every principal-only reading of a rule — the operation grant here
 * and the read pre-filter in the MCP kernel — interprets terms identically
 * instead of growing a parallel rule language.
 */
export const projectPrincipalTerm = (
  term: CanonicalValueTerm,
  caller: AuthenticatedCaller,
  subject: string,
): PrincipalProjection => {
  switch (term._tag) {
    case "lit":
      return present(term.value);
    case "subject":
      return present(subject);
    case "claim":
      return Object.hasOwn(caller.claims, term.key)
        ? present(caller.claims[term.key])
        : absent;
    // Row-relative: nothing about the principal settles these.
    case "me":
    case "ref":
      return invalid;
  }
};

const equal = principalValuesEqual;
// Operation grants are validated at assembly as principal-only. Keep the
// runtime fail-closed if an unsealed/corrupt expression reaches this seam.
const project = projectPrincipalTerm;

const evaluate = (
  expr: CanonicalAuthorizationExpr,
  caller: AuthenticatedCaller,
  subject: string,
): boolean => {
  switch (expr._tag) {
    case "const":
      return expr.value;
    case "hasClass":
      return caller.classes.includes(expr.class);
    case "and":
      return expr.exprs.every((part) => evaluate(part, caller, subject));
    case "or":
      return expr.exprs.some((part) => evaluate(part, caller, subject));
    case "not":
      return !evaluate(expr.expr, caller, subject);
    case "eq": {
      const left = project(expr.left, caller, subject);
      const right = project(expr.right, caller, subject);
      return left._tag === "present" && right._tag === "present" &&
        equal(left.value, right.value);
    }
    case "has":
      return project(expr.term, caller, subject)._tag === "present";
    case "in": {
      const value = project(expr.value, caller, subject);
      const collection = project(expr.collection, caller, subject);
      return value._tag === "present" && collection._tag === "present" &&
        Array.isArray(collection.value) &&
        collection.value.some((item) => equal(value.value, item));
    }
  }
};

/** Explicit deny wins; at least one explicit allow must pass. */
export const operationGrantAllows = (
  unit: InstalledCatalogUnitV2,
  descriptor: OperationDescriptor,
  caller: AuthenticatedCaller,
  subject: string,
): boolean => {
  const decision = unit.policy.decisions.operations.find(
    (entry) => operationKey(entry.target) === operationKey(descriptor.id),
  )?.decision;
  if (decision === undefined) return false;
  const rules = new Map(unit.policy.rules.map((rule) => [rule.id, rule] as const));
  for (const id of decision.deny) {
    const rule = rules.get(id);
    if (rule === undefined || evaluate(rule.expr, caller, subject)) return false;
  }
  for (const id of decision.allow) {
    const rule = rules.get(id);
    if (rule !== undefined && evaluate(rule.expr, caller, subject)) return true;
  }
  return false;
};
