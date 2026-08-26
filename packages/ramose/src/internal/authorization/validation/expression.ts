/**
 * Recursive expression validation, derived-metadata recomputation, and limits.
 */

import * as Result from "effect/Result";
import { hashCanonicalRuleSync } from "../decode.ts";
import type { CanonicalAuthorizationExpr } from "../expr.ts";
import type { EntityId, OwnerRef, RuleId } from "../identities.ts";
import type { CanonicalAuthorizationRule, CanonicalRuleFocus } from "../ir.ts";
import type { ClaimDescriptor, InstalledPrincipalResolution } from "../principal.ts";
import type { OperationInputShape } from "../catalog.ts";
import {
  requireEntity,
  requireField,
  requireOperation,
  requireTargetlessTraitReachable,
  requireTrait,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "./catalog.ts";
import { invalid, type ValidationLimits, type ValidateFailure } from "./common.ts";
import {
  meEntity,
  operationInput,
  resourceFocus,
  walkRef,
  walkValue,
} from "./traversal.ts";
import {
  charge,
  collectionElement,
  emptyDerived,
  eqCompatible,
  mergeDerived,
  rowFromRefTarget,
  type Binding,
  type Derived,
} from "./types.ts";

export const walkExpr = (
  index: PreparedAuthorizationCatalog,
  expr: CanonicalAuthorizationExpr,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, Binding>,
  input: { readonly shape: OperationInputShape; readonly owner: OwnerRef } | undefined,
  classes: ReadonlySet<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
  existsDepth: number,
): Result.Result<Derived, ValidateFailure> => {
  const derived = emptyDerived();
  const charged = charge(derived, 1);
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
        const part = walkExpr(
          index,
          child,
          resource,
          me,
          binds,
          input,
          classes,
          claims,
          limits,
          existsDepth,
        );
        if (Result.isFailure(part)) return Result.fail(part.failure);
        mergeDerived(derived, part.success);
      }
      return Result.succeed(derived);
    }
    case "not": {
      const child = walkExpr(
        index,
        expr.expr,
        resource,
        me,
        binds,
        input,
        classes,
        claims,
        limits,
        existsDepth,
      );
      if (Result.isFailure(child)) return Result.fail(child.failure);
      mergeDerived(derived, child.success);
      return Result.succeed(derived);
    }
    case "eq": {
      const left = walkValue(index, expr.left, resource, me, binds, input, claims, limits);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      const right = walkValue(index, expr.right, resource, me, binds, input, claims, limits);
      if (Result.isFailure(right)) return Result.fail(right.failure);
      mergeDerived(derived, left.success.derived);
      mergeDerived(derived, right.success.derived);
      if (!eqCompatible(index, left.success.shape, right.success.shape)) {
        return invalid("incompatible equality operands");
      }
      return Result.succeed(derived);
    }
    case "has": {
      const term = walkValue(index, expr.term, resource, me, binds, input, claims, limits);
      if (Result.isFailure(term)) return Result.fail(term.failure);
      mergeDerived(derived, term.success.derived);
      return Result.succeed(derived);
    }
    case "in": {
      const value = walkValue(index, expr.value, resource, me, binds, input, claims, limits);
      if (Result.isFailure(value)) return Result.fail(value.failure);
      const collection = walkValue(
        index,
        expr.collection,
        resource,
        me,
        binds,
        input,
        claims,
        limits,
      );
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      mergeDerived(derived, value.success.derived);
      mergeDerived(derived, collection.success.derived);
      const element = collectionElement(index, collection.success.shape);
      if (Result.isFailure(element)) return Result.fail(element.failure);
      if (element.success === undefined) return invalid("membership requires a collection");
      if (!eqCompatible(index, value.success.shape, element.success)) {
        return invalid("incompatible membership operands");
      }
      return Result.succeed(derived);
    }
    case "some": {
      const collection = walkRef(index, expr.collection, resource, me, binds, limits);
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      mergeDerived(derived, collection.success.derived);
      if (expr.bind.length === 0) return invalid("blank binding name");
      if (binds.has(expr.bind)) return invalid(`duplicate binding '${expr.bind}'`);
      const shape = collection.success.shape;
      if (shape._tag !== "ref" || shape.cardinality !== "many") {
        return invalid("some requires a many-valued ref collection");
      }
      const lastStep = expr.collection.steps[expr.collection.steps.length - 1];
      if (lastStep === undefined) return invalid("some requires a ref traversal");
      const row = rowFromRefTarget(index, shape.target, lastStep.field.owner);
      if (Result.isFailure(row)) return Result.fail(row.failure);
      if (row.success === undefined) {
        return invalid("some cannot bind an untargeted ref");
      }
      const nextBinds = new Map(binds);
      nextBinds.set(expr.bind, {
        focus: row.success,
        traversalDepth: collection.success.derived.traversalDepth,
      });
      const pred = walkExpr(
        index,
        expr.pred,
        resource,
        me,
        nextBinds,
        input,
        classes,
        claims,
        limits,
        existsDepth,
      );
      if (Result.isFailure(pred)) return Result.fail(pred.failure);
      mergeDerived(derived, pred.success);
      return Result.succeed(derived);
    }
    case "overlaps": {
      const left = walkRef(index, expr.left, resource, me, binds, limits);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      const right = walkRef(index, expr.right, resource, me, binds, limits);
      if (Result.isFailure(right)) return Result.fail(right.failure);
      mergeDerived(derived, left.success.derived);
      mergeDerived(derived, right.success.derived);
      const leftEl = collectionElement(index, left.success.shape);
      if (Result.isFailure(leftEl)) return Result.fail(leftEl.failure);
      const rightEl = collectionElement(index, right.success.shape);
      if (Result.isFailure(rightEl)) return Result.fail(rightEl.failure);
      if (leftEl.success === undefined || rightEl.success === undefined) {
        return invalid("overlaps requires two collections");
      }
      if (!eqCompatible(index, leftEl.success, rightEl.success)) {
        return invalid("incompatible overlaps operands");
      }
      return Result.succeed(derived);
    }
    case "exists": {
      const nextDepth = existsDepth + 1;
      if (nextDepth > limits.maxExistsDepth) {
        return invalid(`exists depth ${nextDepth} exceeds ${limits.maxExistsDepth}`);
      }
      derived.existsDepth = nextDepth;
      const entity = requireEntity(index, expr.entity, "exists entity");
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      if (expr.bind.length === 0) return invalid("blank binding name");
      if (binds.has(expr.bind)) return invalid(`duplicate binding '${expr.bind}'`);
      const nextBinds = new Map(binds);
      nextBinds.set(expr.bind, {
        focus: { _tag: "entity", entity: entity.success },
        traversalDepth: 0,
      });
      const pred = walkExpr(
        index,
        expr.pred,
        resource,
        me,
        nextBinds,
        input,
        classes,
        claims,
        limits,
        nextDepth,
      );
      if (Result.isFailure(pred)) return Result.fail(pred.failure);
      mergeDerived(derived, pred.success);
      if (pred.success.existsDepth > derived.existsDepth) {
        derived.existsDepth = pred.success.existsDepth;
      }
      return Result.succeed(derived);
    }
  }
};

const sortedIds = (ids: ReadonlyArray<RuleId>): RuleId[] =>
  [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const sameIds = (left: ReadonlyArray<RuleId>, right: ReadonlyArray<RuleId>): boolean => {
  if (left.length !== right.length) return false;
  const a = sortedIds(left);
  const b = sortedIds(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const compareDerived = (
  rule: CanonicalAuthorizationRule,
  derived: Derived,
  limits: ValidationLimits,
): Result.Result<void, ValidateFailure> => {
  if (rule.usesResource !== derived.usesResource) return invalid("tampered usesResource");
  if (rule.usesInput !== derived.usesInput) return invalid("tampered usesInput");
  if (rule.usesMe !== derived.usesMe) return invalid("tampered usesMe");
  if (rule.usesSubject !== derived.usesSubject) return invalid("tampered usesSubject");
  if (rule.traversalDepth !== derived.traversalDepth) return invalid("tampered traversalDepth");
  if (rule.existsDepth !== derived.existsDepth) return invalid("tampered existsDepth");
  if (rule.dependencies.length > 0 || derived.dependencies.length > 0) {
    return invalid("named-rule dependencies must be empty");
  }
  if (!sameIds(rule.dependencies, derived.dependencies)) {
    return invalid("tampered dependencies");
  }
  if (derived.traversalDepth > limits.maxTraversalDepth) {
    return invalid(`traversal depth ${derived.traversalDepth} exceeds ${limits.maxTraversalDepth}`);
  }
  if (derived.existsDepth > limits.maxExistsDepth) {
    return invalid(`exists depth ${derived.existsDepth} exceeds ${limits.maxExistsDepth}`);
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
    case "operation": {
      const operation = requireOperation(index, focus.operation, "rule focus operation");
      if (Result.isFailure(operation)) return Result.fail(operation.failure);
      return requireTargetlessTraitReachable(index, operation.success);
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
  const input = operationInput(index, rule.focus);
  if (Result.isFailure(input)) return Result.fail(input.failure);
  const me = meEntity(index, principal);
  if (Result.isFailure(me)) return Result.fail(me.failure);

  const derived = walkExpr(
    index,
    rule.expr,
    resource.success,
    me.success,
    new Map(),
    input.success,
    classes,
    claims,
    limits,
    0,
  );
  if (Result.isFailure(derived)) return Result.fail(derived.failure);

  if (rule.focus._tag === "operation" && rule.focus.operation.target === "none") {
    if (derived.success.usesResource) {
      return invalid("resource-dependent rule cannot authorize a targetless operation");
    }
  }

  const compared = compareDerived(rule, derived.success, limits);
  if (Result.isFailure(compared)) return Result.fail(compared.failure);

  const recomputed: CanonicalAuthorizationRule = {
    id: rule.id,
    focus: rule.focus,
    expr: rule.expr,
    usesResource: derived.success.usesResource,
    usesInput: derived.success.usesInput,
    usesMe: derived.success.usesMe,
    usesSubject: derived.success.usesSubject,
    traversalDepth: derived.success.traversalDepth,
    existsDepth: derived.success.existsDepth,
    dependencies: sortedIds(derived.success.dependencies),
  };
  const expectedId = hashCanonicalRuleSync(recomputed);
  if (rule.id !== expectedId) return invalid("tampered rule id");
  return Result.succeed({ ...recomputed, id: expectedId });
};
