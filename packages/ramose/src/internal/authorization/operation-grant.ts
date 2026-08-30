import type { OperationDescriptor } from "./catalog.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalValueTerm,
} from "./expr.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import type { AuthenticatedCaller } from "./request.ts";
import { operationKey } from "./validation/common.ts";

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

export const principalValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => Object.is(value, right[index]));
};

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
    case "me":
    case "ref":
      return invalid;
  }
};

const equal = principalValuesEqual;
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
