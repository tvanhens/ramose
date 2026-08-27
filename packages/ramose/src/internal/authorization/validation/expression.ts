/**
 * Recursive expression validation, derived-metadata recomputation, and limits.
 */

import * as Result from "effect/Result";
import type { CanonicalAuthorizationExpr } from "../expr.ts";
import type { EntityId } from "../identities.ts";
import type { CanonicalAuthorizationRule, CanonicalRuleFocus } from "../ir.ts";
import type { ClaimDescriptor, InstalledPrincipalResolution } from "../principal.ts";
import {
  requireEntity,
  requireField,
  requireTrait,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "./catalog.ts";
import { invalid, type ValidationLimits, type ValidateFailure } from "./common.ts";
import { meEntity, resourceFocus, walkValue } from "./traversal.ts";
import {
  charge,
  collectionElement,
  emptyDerived,
  eqCompatible,
  mergeDerived,
  type Derived,
  type StaticWork,
} from "./types.ts";

export const walkExpr = (
  index: PreparedAuthorizationCatalog,
  expr: CanonicalAuthorizationExpr,
  resource: RowFocus,
  me: EntityId | undefined,
  classes: ReadonlySet<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<Derived, ValidateFailure> =>
  Result.gen(function* () {
    const derived = emptyDerived();
    yield* charge(derived, spent, 1, limits.maxStaticWork);

    switch (expr._tag) {
      case "const":
        return derived;
      case "hasClass":
        if (!classes.has(expr.class)) return yield* invalid(`undeclared class '${expr.class}'`);
        return derived;
      case "and":
      case "or": {
        for (const child of expr.exprs) {
          const part = yield* walkExpr(index, child, resource, me, classes, claims, limits, spent);
          mergeDerived(derived, part);
        }
        return derived;
      }
      case "not": {
        const child = yield* walkExpr(
          index,
          expr.expr,
          resource,
          me,
          classes,
          claims,
          limits,
          spent,
        );
        mergeDerived(derived, child);
        return derived;
      }
      case "eq": {
        const left = yield* walkValue(index, expr.left, resource, me, claims, limits, spent);
        const right = yield* walkValue(index, expr.right, resource, me, claims, limits, spent);
        mergeDerived(derived, left.derived);
        mergeDerived(derived, right.derived);
        if (!eqCompatible(index, left.shape, right.shape)) {
          return yield* invalid("incompatible equality operands");
        }
        return derived;
      }
      case "has": {
        const term = yield* walkValue(index, expr.term, resource, me, claims, limits, spent);
        mergeDerived(derived, term.derived);
        return derived;
      }
      case "in": {
        const value = yield* walkValue(index, expr.value, resource, me, claims, limits, spent);
        const collection = yield* walkValue(
          index,
          expr.collection,
          resource,
          me,
          claims,
          limits,
          spent,
        );
        mergeDerived(derived, value.derived);
        mergeDerived(derived, collection.derived);
        const element = yield* collectionElement(collection.shape);
        if (element === undefined) return yield* invalid("membership requires a collection");
        if (!eqCompatible(index, value.shape, element)) {
          return yield* invalid("incompatible membership operands");
        }
        return derived;
      }
    }
  });

const compareDerived = (
  rule: CanonicalAuthorizationRule,
  derived: Derived,
  limits: ValidationLimits,
): Result.Result<void, ValidateFailure> => {
  if (rule.usesResource !== derived.usesResource) return invalid("tampered usesResource");
  if (rule.usesMe !== derived.usesMe) return invalid("tampered usesMe");
  if (rule.usesSubject !== derived.usesSubject) return invalid("tampered usesSubject");
  if (rule.traversalDepth !== derived.traversalDepth) return invalid("tampered traversalDepth");
  if (derived.traversalDepth > limits.maxTraversalDepth) {
    return invalid(`traversal depth ${derived.traversalDepth} exceeds ${limits.maxTraversalDepth}`);
  }
  if (derived.staticWork > limits.maxStaticWork) {
    return invalid(`static work ${derived.staticWork} exceeds ${limits.maxStaticWork}`);
  }
  return Result.succeed(undefined);
};

const validateFocus = (
  index: PreparedAuthorizationCatalog,
  focus: CanonicalRuleFocus,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    switch (focus._tag) {
      case "entity":
        yield* requireEntity(index, focus.entity, "rule focus entity");
        return;
      case "trait":
        yield* requireTrait(index, focus.trait, "rule focus trait");
        return;
      case "field":
        yield* requireField(index, focus.field, "rule focus field");
        return;
    }
  });

export const validateRule = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  principal: InstalledPrincipalResolution,
  classes: ReadonlySet<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
): Result.Result<CanonicalAuthorizationRule, ValidateFailure> =>
  Result.gen(function* () {
    yield* validateFocus(index, rule.focus);
    const resource = yield* resourceFocus(index, rule.focus);
    const me = yield* meEntity(index, principal);

    const derived = yield* walkExpr(index, rule.expr, resource, me, classes, claims, limits, {
      count: 0,
    });

    yield* compareDerived(rule, derived, limits);
    return {
      id: rule.id,
      focus: rule.focus,
      expr: rule.expr,
      usesResource: derived.usesResource,
      usesMe: derived.usesMe,
      usesSubject: derived.usesSubject,
      traversalDepth: derived.traversalDepth,
    };
  });
