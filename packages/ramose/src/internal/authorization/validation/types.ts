/**
 * Value and reference compatibility for catalog-aware terms.
 *
 * Ref.self resolution, collection-element typing, and trait/entity
 * compatibility stay here — they need the prepared catalog, not Schema.
 */

import * as Result from "effect/Result";
import type {
  FieldCardinality,
  FieldRefTarget,
  OperationInputShape,
  ScalarValueType,
} from "../catalog.ts";
import type { EntityId, OwnerRef, RuleId } from "../identities.ts";
import type { ClaimShape } from "../principal.ts";
import { invalid, type ValidateFailure } from "./common.ts";
import {
  ownerFocus,
  requireEntity,
  requireTrait,
  sameRow,
  type PreparedAuthorizationCatalog,
  type RowFocus,
} from "./catalog.ts";

export type { RowFocus };

export type Binding = {
  readonly focus: RowFocus;
  readonly traversalDepth: number;
};

export type TermShape =
  | { readonly _tag: "boolean" }
  | { readonly _tag: "subject" }
  | { readonly _tag: "scalar"; readonly valueType: ScalarValueType | "null" | "number" }
  | { readonly _tag: "row"; readonly focus: RowFocus }
  | { readonly _tag: "me"; readonly entity: EntityId | undefined }
  | {
      readonly _tag: "ref";
      readonly target: FieldRefTarget;
      readonly cardinality: FieldCardinality;
    }
  | { readonly _tag: "claim"; readonly shape: ClaimShape }
  | { readonly _tag: "input"; readonly shape: OperationInputShape; readonly owner: OwnerRef }
  | { readonly _tag: "opaque" };

export type Derived = {
  usesResource: boolean;
  usesInput: boolean;
  usesMe: boolean;
  usesSubject: boolean;
  traversalDepth: number;
  existsDepth: number;
  dependencies: RuleId[];
  staticWork: number;
};

export const emptyDerived = (): Derived => ({
  usesResource: false,
  usesInput: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
  existsDepth: 0,
  dependencies: [],
  staticWork: 0,
});

export const mergeDerived = (into: Derived, part: Derived): void => {
  into.usesResource ||= part.usesResource;
  into.usesInput ||= part.usesInput;
  into.usesMe ||= part.usesMe;
  into.usesSubject ||= part.usesSubject;
  if (part.traversalDepth > into.traversalDepth) into.traversalDepth = part.traversalDepth;
  if (part.existsDepth > into.existsDepth) into.existsDepth = part.existsDepth;
  for (const dep of part.dependencies) into.dependencies.push(dep);
  into.staticWork += part.staticWork;
};

export type StaticWork = { count: number };

export const takeWork = (
  spent: StaticWork,
  nodes: number,
  maxStaticWork: number,
): Result.Result<void, ValidateFailure> => {
  spent.count += nodes;
  if (spent.count > maxStaticWork) {
    return invalid(`static work ${spent.count} exceeds ${maxStaticWork}`);
  }
  return Result.succeed(undefined);
};

export const charge = (
  derived: Derived,
  spent: StaticWork,
  nodes: number,
  maxStaticWork: number,
): Result.Result<void, ValidateFailure> => {
  derived.staticWork += nodes;
  return takeWork(spent, nodes, maxStaticWork);
};

export const rowFromRefTarget = (
  index: PreparedAuthorizationCatalog,
  target: FieldRefTarget,
  owner: OwnerRef,
): Result.Result<RowFocus | undefined, ValidateFailure> => {
  switch (target._tag) {
    case "entity": {
      const entity = requireEntity(index, target.entity, "ref target");
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      return Result.succeed({ _tag: "entity", entity: entity.success });
    }
    case "trait": {
      const trait = requireTrait(index, target.trait, "ref target");
      if (Result.isFailure(trait)) return Result.fail(trait.failure);
      return Result.succeed({ _tag: "trait", trait: trait.success });
    }
    case "self":
      return ownerFocus(index, owner);
    case "untargeted":
      return Result.succeed(undefined);
  }
};

export const refTargetAsFocus = (target: FieldRefTarget): RowFocus | undefined => {
  if (target._tag === "entity") return { _tag: "entity", entity: target.entity };
  if (target._tag === "trait") return { _tag: "trait", trait: target.trait };
  return undefined;
};

export const resolveRefTarget = (
  index: PreparedAuthorizationCatalog,
  target: FieldRefTarget,
  owner: OwnerRef,
): Result.Result<FieldRefTarget, ValidateFailure> => {
  if (target._tag === "self") {
    const focus = ownerFocus(index, owner);
    if (Result.isFailure(focus)) return Result.fail(focus.failure);
    return Result.succeed(
      focus.success._tag === "entity"
        ? { _tag: "entity", entity: focus.success.entity }
        : { _tag: "trait", trait: focus.success.trait },
    );
  }
  if (target._tag === "entity") {
    const entity = requireEntity(index, target.entity, "ref target");
    if (Result.isFailure(entity)) return Result.fail(entity.failure);
    return Result.succeed({ _tag: "entity", entity: entity.success });
  }
  if (target._tag === "trait") {
    const trait = requireTrait(index, target.trait, "ref target");
    if (Result.isFailure(trait)) return Result.fail(trait.failure);
    return Result.succeed({ _tag: "trait", trait: trait.success });
  }
  return Result.succeed(target);
};

export const refCompatibleWithRow = (
  index: PreparedAuthorizationCatalog,
  target: FieldRefTarget,
  row: RowFocus,
): boolean => {
  const focus = refTargetAsFocus(target);
  return focus !== undefined && sameRow(index, focus, row);
};

export const sameRefTarget = (
  index: PreparedAuthorizationCatalog,
  left: FieldRefTarget,
  right: FieldRefTarget,
): boolean => {
  const leftFocus = refTargetAsFocus(left);
  const rightFocus = refTargetAsFocus(right);
  if (leftFocus !== undefined && rightFocus !== undefined) {
    return sameRow(index, leftFocus, rightFocus);
  }
  return left._tag === "untargeted" && right._tag === "untargeted";
};

export const claimScalar = (shape: ClaimShape): ScalarValueType | undefined =>
  shape._tag === "scalar" ? shape.valueType : undefined;

export const inputScalar = (shape: OperationInputShape): ScalarValueType | undefined =>
  shape._tag === "scalar" ? shape.valueType : undefined;

export const litScalar = (value: string | number | boolean | null): TermShape => {
  if (value === null) return { _tag: "scalar", valueType: "null" };
  if (typeof value === "boolean") return { _tag: "scalar", valueType: "boolean" };
  if (typeof value === "number") return { _tag: "scalar", valueType: "number" };
  return { _tag: "scalar", valueType: "string" };
};

export const scalarAssignable = (
  expected: ScalarValueType | "null" | "number",
  actual: TermShape,
): boolean => {
  if (actual._tag === "subject") return expected === "string";
  if (actual._tag !== "scalar") return false;
  if (expected === actual.valueType) return true;
  if (expected === "number") return actual.valueType === "long" || actual.valueType === "double";
  if (actual.valueType === "number") return expected === "long" || expected === "double";
  if (expected === "string" && actual.valueType === "uuid") return true;
  if (expected === "uuid" && actual.valueType === "string") return true;
  return false;
};

export const meCompatibleWith = (
  index: PreparedAuthorizationCatalog,
  me: EntityId | undefined,
  other: TermShape,
): boolean => {
  if (other._tag === "me") return true;
  if (other._tag === "row") {
    return me === undefined || sameRow(index, { _tag: "entity", entity: me }, other.focus);
  }
  if (other._tag === "ref") {
    const focus = refTargetAsFocus(other.target);
    return (
      focus !== undefined && (me === undefined || sameRow(index, { _tag: "entity", entity: me }, focus))
    );
  }
  if (other._tag === "input" && other.shape._tag === "ref") {
    const resolved = resolveRefTarget(index, other.shape.refTarget, other.owner);
    if (Result.isFailure(resolved)) return false;
    const focus = refTargetAsFocus(resolved.success);
    return (
      focus !== undefined && (me === undefined || sameRow(index, { _tag: "entity", entity: me }, focus))
    );
  }
  return false;
};

export const eqCompatible = (
  index: PreparedAuthorizationCatalog,
  left: TermShape,
  right: TermShape,
): boolean => {
  const pair = (a: TermShape, b: TermShape): boolean => {
    if (a._tag === "opaque" || b._tag === "opaque") return false;
    if (a._tag === "boolean" || b._tag === "boolean") return false;
    if (a._tag === "ref" && a.cardinality === "many") return false;
    if (b._tag === "ref" && b.cardinality === "many") return false;
    if (a._tag === "me") return meCompatibleWith(index, a.entity, b);
    if (a._tag === "subject") {
      if (b._tag === "subject") return true;
      if (scalarAssignable("string", b)) return true;
      if (b._tag === "claim") {
        const scalar = claimScalar(b.shape);
        return (
          scalar !== undefined && scalarAssignable("string", { _tag: "scalar", valueType: scalar })
        );
      }
      if (b._tag === "input") {
        const scalar = inputScalar(b.shape);
        return (
          scalar !== undefined && scalarAssignable("string", { _tag: "scalar", valueType: scalar })
        );
      }
      return false;
    }
    if (a._tag === "row") {
      if (b._tag === "row") return sameRow(index, a.focus, b.focus);
      if (b._tag === "ref") return refCompatibleWithRow(index, b.target, a.focus);
      if (b._tag === "input" && b.shape._tag === "ref") {
        const target = resolveRefTarget(index, b.shape.refTarget, b.owner);
        return Result.isSuccess(target) && refCompatibleWithRow(index, target.success, a.focus);
      }
      return false;
    }
    if (a._tag === "ref") {
      if (b._tag === "ref") return sameRefTarget(index, a.target, b.target);
      if (b._tag === "input" && b.shape._tag === "ref") {
        const target = resolveRefTarget(index, b.shape.refTarget, b.owner);
        return Result.isSuccess(target) && sameRefTarget(index, a.target, target.success);
      }
      return false;
    }
    if (a._tag === "scalar") {
      if (b._tag === "scalar") return scalarAssignable(a.valueType, b);
      if (b._tag === "claim") {
        const scalar = claimScalar(b.shape);
        return (
          scalar !== undefined && scalarAssignable(a.valueType, { _tag: "scalar", valueType: scalar })
        );
      }
      if (b._tag === "input") {
        const scalar = inputScalar(b.shape);
        return (
          scalar !== undefined && scalarAssignable(a.valueType, { _tag: "scalar", valueType: scalar })
        );
      }
      return false;
    }
    if (a._tag === "claim") {
      const scalar = claimScalar(a.shape);
      if (scalar === undefined) return false;
      return eqCompatible(index, { _tag: "scalar", valueType: scalar }, b);
    }
    if (a._tag === "input") {
      if (a.shape._tag === "scalar") {
        return eqCompatible(index, { _tag: "scalar", valueType: a.shape.valueType }, b);
      }
      if (a.shape._tag === "ref" && b._tag === "input" && b.shape._tag === "ref") {
        const leftTarget = resolveRefTarget(index, a.shape.refTarget, a.owner);
        const rightTarget = resolveRefTarget(index, b.shape.refTarget, b.owner);
        return (
          Result.isSuccess(leftTarget) &&
          Result.isSuccess(rightTarget) &&
          sameRefTarget(index, leftTarget.success, rightTarget.success)
        );
      }
      return false;
    }
    return false;
  };
  return pair(left, right) || pair(right, left);
};

export const collectionElement = (
  index: PreparedAuthorizationCatalog,
  shape: TermShape,
): Result.Result<TermShape | undefined, ValidateFailure> => {
  if (shape._tag === "ref" && shape.cardinality === "many") {
    return Result.succeed({ _tag: "ref", target: shape.target, cardinality: "one" });
  }
  if (shape._tag === "input" && shape.shape._tag === "array") {
    const items = shape.shape.items;
    if (items._tag === "scalar") {
      return Result.succeed({ _tag: "scalar", valueType: items.valueType });
    }
    if (items._tag === "ref") {
      const target = resolveRefTarget(index, items.refTarget, shape.owner);
      if (Result.isFailure(target)) return Result.fail(target.failure);
      return Result.succeed({ _tag: "ref", target: target.success, cardinality: "one" });
    }
    if (items._tag === "opaque") return Result.succeed({ _tag: "opaque" });
    return Result.succeed({ _tag: "input", shape: items, owner: shape.owner });
  }
  if (shape._tag === "claim" && shape.shape._tag === "array") {
    return Result.succeed({ _tag: "claim", shape: shape.shape.items });
  }
  return Result.succeed(undefined);
};
