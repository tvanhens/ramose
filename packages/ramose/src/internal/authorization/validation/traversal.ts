/**
 * Path resolution and traversal constraints against the prepared catalog.
 */

import * as Result from "effect/Result";
import type { FieldDescriptor, OperationInputShape } from "../catalog.ts";
import type { CanonicalRefTerm, CanonicalValueTerm } from "../expr.ts";
import type { EntityId, OwnerRef } from "../identities.ts";
import type { CanonicalRuleFocus } from "../ir.ts";
import type { ClaimDescriptor, InstalledPrincipalResolution } from "../principal.ts";
import {
  fieldAccessibleFrom,
  ownerFocus,
  requireEntity,
  requireField,
  requireOperation,
  requireTrait,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "./catalog.ts";
import { invalid, type ValidationLimits, type ValidateFailure } from "./common.ts";
import { claimByKey } from "./descriptors.ts";
import {
  emptyDerived,
  litScalar,
  resolveRefTarget,
  rowFromRefTarget,
  takeWork,
  type Binding,
  type Derived,
  type StaticWork,
  type TermShape,
} from "./types.ts";

export const resourceFocus = (
  index: PreparedAuthorizationCatalog,
  focus: CanonicalRuleFocus,
): Result.Result<RowFocus | undefined, ValidateFailure> => {
  switch (focus._tag) {
    case "entity": {
      const entity = requireEntity(index, focus.entity, "rule focus entity");
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      return Result.succeed({ _tag: "entity", entity: entity.success });
    }
    case "trait": {
      const trait = requireTrait(index, focus.trait, "rule focus trait");
      if (Result.isFailure(trait)) return Result.fail(trait.failure);
      return Result.succeed({ _tag: "trait", trait: trait.success });
    }
    case "field": {
      const field = requireField(index, focus.field, "rule focus field");
      if (Result.isFailure(field)) return Result.fail(field.failure);
      return ownerFocus(index, field.success.id.owner);
    }
    case "operation": {
      const operation = requireOperation(index, focus.operation, "rule focus operation");
      if (Result.isFailure(operation)) return Result.fail(operation.failure);
      if (operation.success.id.target === "none") return Result.succeed(undefined);
      return ownerFocus(index, operation.success.id.owner);
    }
  }
};

export const operationInput = (
  index: PreparedAuthorizationCatalog,
  focus: CanonicalRuleFocus,
): Result.Result<
  { readonly shape: OperationInputShape; readonly owner: OwnerRef } | undefined,
  ValidateFailure
> => {
  if (focus._tag !== "operation") return Result.succeed(undefined);
  const operation = requireOperation(index, focus.operation, "rule focus operation");
  if (Result.isFailure(operation)) return Result.fail(operation.failure);
  return Result.succeed({ shape: operation.success.input, owner: operation.success.id.owner });
};

export const meEntity = (
  index: PreparedAuthorizationCatalog,
  principal: InstalledPrincipalResolution,
): Result.Result<EntityId | undefined, ValidateFailure> => {
  if (principal.entity === undefined) return Result.succeed(undefined);
  const field = requireField(index, principal.entity, "principal field");
  if (Result.isFailure(field)) return Result.fail(field.failure);
  if (field.success.unique === undefined) {
    return invalid("principal field is not unique");
  }
  if (field.success.id.owner.kind !== "entity") {
    return invalid("principal field must be entity-owned");
  }
  if (field.success.valueType !== "string" && field.success.valueType !== "uuid") {
    return invalid("principal field must be string-compatible");
  }
  const entity = index.entities.get(field.success.id.owner.name);
  if (entity === undefined) return invalid("missing principal entity");
  return Result.succeed(entity);
};

const inputShapeType = (
  index: PreparedAuthorizationCatalog,
  shape: OperationInputShape,
  owner: OwnerRef,
): Result.Result<TermShape, ValidateFailure> => {
  switch (shape._tag) {
    case "scalar":
      return Result.succeed({ _tag: "scalar", valueType: shape.valueType });
    case "ref": {
      const target = resolveRefTarget(index, shape.refTarget, owner);
      if (Result.isFailure(target)) return Result.fail(target.failure);
      return Result.succeed({ _tag: "ref", target: target.success, cardinality: "one" });
    }
    case "opaque":
      return Result.succeed({ _tag: "opaque" });
    case "array":
      return Result.succeed({ _tag: "input", shape, owner });
    case "struct":
      return Result.succeed({ _tag: "input", shape, owner });
  }
};

export const walkInputPath = (
  index: PreparedAuthorizationCatalog,
  shape: OperationInputShape,
  path: ReadonlyArray<string>,
  owner: OwnerRef,
): Result.Result<TermShape, ValidateFailure> => {
  if (path.length === 0) return inputShapeType(index, shape, owner);
  switch (shape._tag) {
    case "struct": {
      const key = path[0]!;
      if (key.length === 0) return invalid("blank operation input key");
      const matches = shape.fields.filter((entry) => entry.key === key);
      if (matches.length === 0) return invalid(`unknown operation input path '${path.join(".")}'`);
      if (matches.length > 1) return invalid(`ambiguous operation input key '${key}'`);
      return walkInputPath(index, matches[0]!.shape, path.slice(1), owner);
    }
    case "array":
      return invalid("cannot traverse operation input array by key");
    case "opaque":
      return invalid("cannot traverse opaque operation input");
    case "scalar":
      return invalid("cannot traverse scalar operation input");
    case "ref":
      return invalid("cannot traverse operation input ref by key");
  }
};

export const walkRef = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalRefTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, Binding>,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const derived = emptyDerived();
  derived.staticWork = 1 + term.steps.length;
  const charged = takeWork(spent, derived.staticWork, limits.maxStaticWork);
  if (Result.isFailure(charged)) return Result.fail(charged.failure);

  let current: RowFocus | undefined;
  let originDepth = 0;
  switch (term.root._tag) {
    case "resource":
      derived.usesResource = true;
      if (resource === undefined) {
        return invalid("resource is not available in this rule focus");
      }
      current = resource;
      break;
    case "me":
      derived.usesMe = true;
      if (me === undefined) {
        return invalid("structurally invalid me traversal without a principal entity");
      }
      current = { _tag: "entity", entity: me };
      break;
    case "bind": {
      const bound = binds.get(term.root.name);
      if (bound === undefined) return invalid(`unbound name '${term.root.name}'`);
      current = bound.focus;
      originDepth = bound.traversalDepth;
      break;
    }
  }

  const depth = originDepth + term.steps.length;
  if (depth > limits.maxTraversalDepth) {
    return invalid(`traversal depth ${depth} exceeds ${limits.maxTraversalDepth}`);
  }
  derived.traversalDepth = depth;

  if (term.steps.length === 0) {
    if (current === undefined) return invalid("empty traversal has no focus");
    return Result.succeed({ shape: { _tag: "row", focus: current }, derived });
  }

  let last: FieldDescriptor | undefined;
  let collected = false;
  for (let i = 0; i < term.steps.length; i++) {
    const step = term.steps[i]!;
    const field = requireField(index, step.field, "traversal field");
    if (Result.isFailure(field)) return Result.fail(field.failure);
    if (current === undefined) {
      return invalid(`cannot traverse from an untargeted ref through '${step.field.localName}'`);
    }
    if (!fieldAccessibleFrom(index, current, field.success)) {
      return invalid(
        `wrong owner for field '${step.field.owner.kind}:${step.field.owner.name}.${step.field.localName}'`,
      );
    }
    if (field.success.cardinality === "many") collected = true;
    const isLast = i === term.steps.length - 1;
    if (!isLast) {
      if (field.success.valueType !== "ref") {
        return invalid(`non-ref traversal through '${step.field.localName}'`);
      }
      const next = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
      if (Result.isFailure(next)) return Result.fail(next.failure);
      current = next.success;
    }
    last = field.success;
    if (isLast && field.success.valueType === "ref") {
      const target = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
      if (Result.isFailure(target)) return Result.fail(target.failure);
    }
  }

  if (last === undefined) return invalid("empty traversal has no field");
  if (last.valueType === "ref") {
    const target = resolveRefTarget(index, last.refTarget, last.id.owner);
    if (Result.isFailure(target)) return Result.fail(target.failure);
    return Result.succeed({
      shape: {
        _tag: "ref",
        target: target.success,
        cardinality: collected || last.cardinality === "many" ? "many" : "one",
      },
      derived,
    });
  }
  if (collected || last.cardinality === "many") {
    return Result.succeed({
      shape: {
        _tag: "input",
        shape: { _tag: "array", items: { _tag: "scalar", valueType: last.valueType } },
        owner: last.id.owner,
      },
      derived,
    });
  }
  return Result.succeed({
    shape: { _tag: "scalar", valueType: last.valueType },
    derived,
  });
};

export const walkValue = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalValueTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, Binding>,
  input: { readonly shape: OperationInputShape; readonly owner: OwnerRef } | undefined,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const finish = (shape: TermShape, derived: Derived) => {
    const charged = takeWork(spent, derived.staticWork, limits.maxStaticWork);
    if (Result.isFailure(charged)) return Result.fail(charged.failure);
    return Result.succeed({ shape, derived });
  };
  switch (term._tag) {
    case "ref":
      return walkRef(index, term, resource, me, binds, limits, spent);
    case "lit":
      return finish(litScalar(term.value), { ...emptyDerived(), staticWork: 1 });
    case "subject":
      return finish({ _tag: "subject" }, { ...emptyDerived(), usesSubject: true, staticWork: 1 });
    case "me":
      return finish({ _tag: "me", entity: me }, { ...emptyDerived(), usesMe: true, staticWork: 1 });
    case "claim": {
      const claim = claimByKey(claims, term.key);
      if (Result.isFailure(claim)) return Result.fail(claim.failure);
      return finish({ _tag: "claim", shape: claim.success.shape }, { ...emptyDerived(), staticWork: 1 });
    }
    case "input": {
      if (input === undefined) return invalid("operation input is not available in this rule focus");
      const shape = walkInputPath(index, input.shape, term.path, input.owner);
      if (Result.isFailure(shape)) return Result.fail(shape.failure);
      return finish(shape.success, {
        ...emptyDerived(),
        usesInput: true,
        staticWork: 1 + term.path.length,
      });
    }
    case "bind": {
      const bound = binds.get(term.name);
      if (bound === undefined) return invalid(`unbound name '${term.name}'`);
      return finish(
        { _tag: "row", focus: bound.focus },
        { ...emptyDerived(), staticWork: 1, traversalDepth: bound.traversalDepth },
      );
    }
  }
};
