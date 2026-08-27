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
): Result.Result<RowFocus, ValidateFailure> =>
  Result.gen(function* () {
    switch (focus._tag) {
      case "entity": {
        const entity = yield* requireEntity(index, focus.entity, "rule focus entity");
        return { _tag: "entity" as const, entity };
      }
      case "trait": {
        const trait = yield* requireTrait(index, focus.trait, "rule focus trait");
        return { _tag: "trait" as const, trait };
      }
      case "field": {
        const field = yield* requireField(index, focus.field, "rule focus field");
        return yield* ownerFocus(index, field.id.owner);
      }
    }
  });

export const meEntity = (
  index: PreparedAuthorizationCatalog,
  principal: InstalledPrincipalResolution,
): Result.Result<EntityId | undefined, ValidateFailure> => {
  if (principal.entity === undefined) return Result.succeed(undefined);
  return Result.gen(function* () {
    const field = yield* requireField(index, principal.entity, "principal field");
    if (field.unique === undefined) {
      return yield* invalid("principal field is not unique");
    }
    if (field.id.owner.kind !== "entity") {
      return yield* invalid("principal field must be entity-owned");
    }
    if (field.valueType !== "string" && field.valueType !== "uuid") {
      return yield* invalid("principal field must be string-compatible");
    }
    const entity = index.entities.get(field.id.owner.name);
    if (entity === undefined) return yield* invalid("missing principal entity");
    return entity;
  });
};

export const walkRef = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalRefTerm,
  resource: RowFocus,
  me: EntityId | undefined,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> =>
  Result.gen(function* () {
    const derived = emptyDerived();
    derived.staticWork = 1 + term.steps.length;
    yield* takeWork(spent, derived.staticWork, limits.maxStaticWork);

    let current: RowFocus;
    switch (term.root._tag) {
      case "resource":
        derived.usesResource = true;
        current = resource;
        break;
      case "me":
        derived.usesMe = true;
        if (me === undefined) {
          return yield* invalid("structurally invalid me traversal without a principal entity");
        }
        current = { _tag: "entity", entity: me };
        break;
    }

    const depth = term.steps.length;
    if (depth > limits.maxTraversalDepth) {
      return yield* invalid(`traversal depth ${depth} exceeds ${limits.maxTraversalDepth}`);
    }
    derived.traversalDepth = depth;

    if (term.steps.length === 0) {
      return { shape: { _tag: "row" as const, focus: current }, derived };
    }

    let last: FieldDescriptor | undefined;
    for (let i = 0; i < term.steps.length; i++) {
      const step = term.steps[i]!;
      const field = yield* requireField(index, step.field, "traversal field");
      if (!fieldAccessibleFrom(index, current, field)) {
        return yield* invalid(
          `wrong owner for field '${step.field.owner.kind}:${step.field.owner.name}.${step.field.localName}'`,
        );
      }
      const isLast = i === term.steps.length - 1;
      if (!isLast) {
        if (field.cardinality === "many") {
          return yield* invalid("intermediate many-valued traversal is not supported");
        }
        if (field.valueType !== "ref") {
          return yield* invalid(`non-ref traversal through '${step.field.localName}'`);
        }
        const next = yield* rowFromRefTarget(index, field.refTarget, field.id.owner);
        if (next === undefined) {
          return yield* invalid(
            `cannot traverse from an untargeted ref through '${step.field.localName}'`,
          );
        }
        current = next;
      }
      last = field;
    }

    if (last === undefined) return yield* invalid("empty traversal has no field");
    if (last.valueType === "ref") {
      const target = yield* resolveRefTarget(index, last.refTarget, last.id.owner);
      return {
        shape: {
          _tag: "ref" as const,
          target,
          cardinality: last.cardinality,
        },
        derived,
      };
    }
    if (last.cardinality === "many") {
      return {
        shape: {
          _tag: "collection" as const,
          element: { _tag: "scalar" as const, valueType: last.valueType },
        },
        derived,
      };
    }
    return {
      shape: { _tag: "scalar" as const, valueType: last.valueType },
      derived,
    };
  });

export const walkValue = (
  index: PreparedAuthorizationCatalog,
  term: CanonicalValueTerm,
  resource: RowFocus,
  me: EntityId | undefined,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
  spent: StaticWork,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const finish = (shape: TermShape, derived: Derived) =>
    Result.gen(function* () {
      yield* takeWork(spent, derived.staticWork, limits.maxStaticWork);
      return { shape, derived };
    });
  switch (term._tag) {
    case "ref":
      return walkRef(index, term, resource, me, limits, spent);
    case "lit":
      return finish(litScalar(term.value), { ...emptyDerived(), staticWork: 1 });
    case "subject":
      return finish({ _tag: "subject" }, { ...emptyDerived(), usesSubject: true, staticWork: 1 });
    case "me":
      return finish({ _tag: "me", entity: me }, { ...emptyDerived(), usesMe: true, staticWork: 1 });
    case "claim":
      return Result.gen(function* () {
        const claim = yield* claimByKey(claims, term.key);
        return yield* finish(
          { _tag: "claim", shape: claim.shape },
          { ...emptyDerived(), staticWork: 1 },
        );
      });
  }
};
