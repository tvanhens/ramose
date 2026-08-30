import * as Result from "effect/Result";
import type { FieldCardinality, FieldRefTarget, ScalarValueType } from "../catalog.ts";
import type { EntityId, OwnerRef } from "../identities.ts";
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

export type TermShape =
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
  | { readonly _tag: "collection"; readonly element: TermShape };

export type Derived = {
  usesResource: boolean;
  usesMe: boolean;
  usesSubject: boolean;
  traversalDepth: number;
  staticWork: number;
};

export const emptyDerived = (): Derived => ({
  usesResource: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
  staticWork: 0,
});

export const mergeDerived = (into: Derived, part: Derived): void => {
  into.usesResource ||= part.usesResource;
  into.usesMe ||= part.usesMe;
  into.usesSubject ||= part.usesSubject;
  if (part.traversalDepth > into.traversalDepth) into.traversalDepth = part.traversalDepth;
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
): Result.Result<RowFocus | undefined, ValidateFailure> =>
  Result.gen(function* () {
    switch (target._tag) {
      case "entity": {
        const entity = yield* requireEntity(index, target.entity, "ref target");
        return { _tag: "entity" as const, entity };
      }
      case "trait": {
        const trait = yield* requireTrait(index, target.trait, "ref target");
        return { _tag: "trait" as const, trait };
      }
      case "self":
        return yield* ownerFocus(index, owner);
      case "untargeted":
        return undefined;
    }
  });

export const refTargetAsFocus = (target: FieldRefTarget): RowFocus | undefined => {
  if (target._tag === "entity") return { _tag: "entity", entity: target.entity };
  if (target._tag === "trait") return { _tag: "trait", trait: target.trait };
  return undefined;
};

export const resolveRefTarget = (
  index: PreparedAuthorizationCatalog,
  target: FieldRefTarget,
  owner: OwnerRef,
): Result.Result<FieldRefTarget, ValidateFailure> =>
  Result.gen(function* () {
    if (target._tag === "self") {
      const focus = yield* ownerFocus(index, owner);
      return focus._tag === "entity"
        ? { _tag: "entity" as const, entity: focus.entity }
        : { _tag: "trait" as const, trait: focus.trait };
    }
    if (target._tag === "entity") {
      const entity = yield* requireEntity(index, target.entity, "ref target");
      return { _tag: "entity" as const, entity };
    }
    if (target._tag === "trait") {
      const trait = yield* requireTrait(index, target.trait, "ref target");
      return { _tag: "trait" as const, trait };
    }
    return target;
  });

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
  return false;
};

export const eqCompatible = (
  index: PreparedAuthorizationCatalog,
  left: TermShape,
  right: TermShape,
): boolean => {
  const pair = (a: TermShape, b: TermShape): boolean => {
    if (a._tag === "collection" || b._tag === "collection") return false;
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
      return false;
    }
    if (a._tag === "row") {
      if (b._tag === "row") return sameRow(index, a.focus, b.focus);
      if (b._tag === "ref") return refCompatibleWithRow(index, b.target, a.focus);
      return false;
    }
    if (a._tag === "ref") {
      if (b._tag === "ref") return sameRefTarget(index, a.target, b.target);
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
      return false;
    }
    if (a._tag === "claim") {
      const scalar = claimScalar(a.shape);
      if (scalar === undefined) return false;
      return eqCompatible(index, { _tag: "scalar", valueType: scalar }, b);
    }
    return false;
  };
  return pair(left, right) || pair(right, left);
};

export const collectionElement = (
  shape: TermShape,
): Result.Result<TermShape | undefined, ValidateFailure> => {
  if (shape._tag === "ref" && shape.cardinality === "many") {
    return Result.succeed({ _tag: "ref", target: shape.target, cardinality: "one" });
  }
  if (shape._tag === "collection") return Result.succeed(shape.element);
  if (shape._tag === "claim" && shape.shape._tag === "array") {
    return Result.succeed({ _tag: "claim", shape: shape.shape.items });
  }
  return Result.succeed(undefined);
};
