/**
 * Path resolution and traversal constraints against the prepared catalog.
 */

import * as Result from "effect/Result";
import type { FieldDescriptor } from "../catalog.ts";
import type { CanonicalRefTerm, CanonicalValueTerm } from "../expr.ts";
import type { EntityId } from "../identities.ts";
import type { CanonicalRuleFocus } from "../ir.ts";
import type { ClaimDescriptor, InstalledPrincipalResolution } from "../principal.ts";
import {
  fieldAccessibleFrom,
  ownerFocus,
  requireEntity,
  requireField,
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
  type Derived,
  type StaticWork,
  type TermShape,
} from "./types.ts";

export const resourceFocus = (
  index: PreparedAuthorizationCatalog,
  focus: CanonicalRuleFocus,
): Result.Result<RowFocus, ValidateFailure> => {
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
  }
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

export const walkRef = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalRefTerm,
  resource: RowFocus,
  me: EntityId | undefined,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const derived = emptyDerived();
  derived.staticWork = 1 + term.steps.length;
  const charged = takeWork(spent, derived.staticWork, limits.maxStaticWork);
  if (Result.isFailure(charged)) return Result.fail(charged.failure);

  let current: RowFocus;
  switch (term.root._tag) {
    case "resource":
      derived.usesResource = true;
      current = resource;
      break;
    case "me":
      derived.usesMe = true;
      if (me === undefined) {
        return invalid("structurally invalid me traversal without a principal entity");
      }
      current = { _tag: "entity", entity: me };
      break;
  }

  const depth = term.steps.length;
  if (depth > limits.maxTraversalDepth) {
    return invalid(`traversal depth ${depth} exceeds ${limits.maxTraversalDepth}`);
  }
  derived.traversalDepth = depth;

  if (term.steps.length === 0) {
    return Result.succeed({ shape: { _tag: "row", focus: current }, derived });
  }

  let last: FieldDescriptor | undefined;
  for (let i = 0; i < term.steps.length; i++) {
    const step = term.steps[i]!;
    const field = requireField(index, step.field, "traversal field");
    if (Result.isFailure(field)) return Result.fail(field.failure);
    if (!fieldAccessibleFrom(index, current, field.success)) {
      return invalid(
        `wrong owner for field '${step.field.owner.kind}:${step.field.owner.name}.${step.field.localName}'`,
      );
    }
    const isLast = i === term.steps.length - 1;
    if (!isLast) {
      if (field.success.cardinality === "many") {
        return invalid("intermediate many-valued traversal is not supported");
      }
      if (field.success.valueType !== "ref") {
        return invalid(`non-ref traversal through '${step.field.localName}'`);
      }
      const next = rowFromRefTarget(index, field.success.refTarget, field.success.id.owner);
      if (Result.isFailure(next)) return Result.fail(next.failure);
      if (next.success === undefined) {
        return invalid(`cannot traverse from an untargeted ref through '${step.field.localName}'`);
      }
      current = next.success;
    }
    last = field.success;
  }

  if (last === undefined) return invalid("empty traversal has no field");
  if (last.valueType === "ref") {
    const target = resolveRefTarget(index, last.refTarget, last.id.owner);
    if (Result.isFailure(target)) return Result.fail(target.failure);
    return Result.succeed({
      shape: {
        _tag: "ref",
        target: target.success,
        cardinality: last.cardinality,
      },
      derived,
    });
  }
  if (last.cardinality === "many") {
    return Result.succeed({
      shape: {
        _tag: "collection",
        element: { _tag: "scalar", valueType: last.valueType },
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
  resource: RowFocus,
  me: EntityId | undefined,
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
      return walkRef(index, term, resource, me, limits, spent);
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
  }
};
