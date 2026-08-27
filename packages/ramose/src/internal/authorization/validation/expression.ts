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
): Result.Result<Derived, ValidateFailure> => {
  const derived = emptyDerived();
  const charged = charge(derived, spent, 1, limits.maxStaticWork);
  if (Result.isFailure(charged)) return Result.fail(charged.failure);

  switch (expr._tag) {
    case "const":
      return Result.succeed(derived);
    case "hasClass":
      if (!classes.has(expr.class)) return invalid(`undeclared class '${expr.class}'`);
      return Result.succeed(derived);
    case "and":
    case "or": {
      for (const child of expr.exprs) {
        const part = walkExpr(index, child, resource, me, classes, claims, limits, spent);
        if (Result.isFailure(part)) return Result.fail(part.failure);
        mergeDerived(derived, part.success);
      }
      return Result.succeed(derived);
    }
    case "not": {
      const child = walkExpr(index, expr.expr, resource, me, classes, claims, limits, spent);
      if (Result.isFailure(child)) return Result.fail(child.failure);
      mergeDerived(derived, child.success);
      return Result.succeed(derived);
    }
    case "eq": {
      const left = walkValue(index, expr.left, resource, me, claims, limits, spent);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      const right = walkValue(index, expr.right, resource, me, claims, limits, spent);
      if (Result.isFailure(right)) return Result.fail(right.failure);
      mergeDerived(derived, left.success.derived);
      mergeDerived(derived, right.success.derived);
      if (!eqCompatible(index, left.success.shape, right.success.shape)) {
        return invalid("incompatible equality operands");
      }
      return Result.succeed(derived);
    }
    case "has": {
      const term = walkValue(index, expr.term, resource, me, claims, limits, spent);
      if (Result.isFailure(term)) return Result.fail(term.failure);
      mergeDerived(derived, term.success.derived);
      return Result.succeed(derived);
    }
    case "in": {
      const value = walkValue(index, expr.value, resource, me, claims, limits, spent);
      if (Result.isFailure(value)) return Result.fail(value.failure);
      const collection = walkValue(index, expr.collection, resource, me, claims, limits, spent);
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      mergeDerived(derived, value.success.derived);
      mergeDerived(derived, collection.success.derived);
      const element = collectionElement(collection.success.shape);
      if (Result.isFailure(element)) return Result.fail(element.failure);
      if (element.success === undefined) return invalid("membership requires a collection");
      if (!eqCompatible(index, value.success.shape, element.success)) {
        return invalid("incompatible membership operands");
      }
      return Result.succeed(derived);
    }
  }
};

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
): Result.Result<void, ValidateFailure> => {
  switch (focus._tag) {
    case "entity": {
      const entity = requireEntity(index, focus.entity, "rule focus entity");
      return Result.isFailure(entity) ? Result.fail(entity.failure) : Result.succeed(undefined);
    }
    case "trait": {
      const trait = requireTrait(index, focus.trait, "rule focus trait");
      return Result.isFailure(trait) ? Result.fail(trait.failure) : Result.succeed(undefined);
    }
    case "field": {
      const field = requireField(index, focus.field, "rule focus field");
      return Result.isFailure(field) ? Result.fail(field.failure) : Result.succeed(undefined);
    }
  }
};

export const validateRule = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  principal: InstalledPrincipalResolution,
  classes: ReadonlySet<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
): Result.Result<CanonicalAuthorizationRule, ValidateFailure> => {
  const focusOk = validateFocus(index, rule.focus);
  if (Result.isFailure(focusOk)) return Result.fail(focusOk.failure);
  const resource = resourceFocus(index, rule.focus);
  if (Result.isFailure(resource)) return Result.fail(resource.failure);
  const me = meEntity(index, principal);
  if (Result.isFailure(me)) return Result.fail(me.failure);

  const derived = walkExpr(
    index,
    rule.expr,
    resource.success,
    me.success,
    classes,
    claims,
    limits,
    { count: 0 },
  );
  if (Result.isFailure(derived)) return Result.fail(derived.failure);

  const compared = compareDerived(rule, derived.success, limits);
  if (Result.isFailure(compared)) return Result.fail(compared.failure);

  return Result.succeed({
    id: rule.id,
    focus: rule.focus,
    expr: rule.expr,
    usesResource: derived.success.usesResource,
    usesMe: derived.success.usesMe,
    usesSubject: derived.success.usesSubject,
    traversalDepth: derived.success.traversalDepth,
  });
};
