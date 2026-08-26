/**
 * Semantic validation kernel.
 *
 * Consumes {@link BoundAuthorizationIR} and one authoritative
 * {@link CatalogDescriptor}. Recomputes every security-owned rule property
 * from the bound expression. Template-supplied flags, depths, dependencies,
 * and rule IDs are never trusted.
 *
 * Pure and synchronous. Effect wraps only the typed failure boundary.
 * Failures stay {@link InvalidIR} / {@link CatalogMismatch} — this layer
 * does not convert them to {@link import("./failures.ts").AuthorizationDenied}.
 *
 * The result is {@link ValidatedAuthorizationIR}: non-executable, not
 * accepted by runtime authorization, and distinct from
 * {@link InstalledAuthorizationIR}. Access-plan derivation is #386.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  DEFAULT_AUTHORIZATION_BUDGET,
  MAX_EXISTS_DEPTH,
  MAX_TRAVERSAL_DEPTH,
} from "./bounds.ts";
import type {
  CatalogDescriptor,
  FieldCardinality,
  FieldDescriptor,
  FieldRefTarget,
  OperationDescriptor,
  OperationInputShape,
  ScalarValueType,
} from "./catalog.ts";
import { hashCanonicalRuleSync } from "./decode.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalRefTerm,
  CanonicalValueTerm,
} from "./expr.ts";
import { CatalogMismatch, InvalidIR } from "./failures.ts";
import type {
  EntityId,
  FieldId,
  OperationId,
  OwnerRef,
  RuleId,
  TraitId,
} from "./identities.ts";
import {
  VALIDATED_AUTHORIZATION_IR_VERSION,
  type AuthorizationValidationInput,
  type BoundAuthorizationIR,
  type CanonicalAuthorizationDecisions,
  type CanonicalAuthorizationRule,
  type CanonicalRuleFocus,
  type CatalogBindingTarget,
  type Decision,
  type ValidatedAuthorizationIR as ValidatedAuthorizationIRType,
} from "./ir.ts";
import type { ClaimDescriptor, ClaimShape, InstalledPrincipalResolution } from "./principal.ts";

export type ValidateFailure = InvalidIR | CatalogMismatch;

export type ValidationLimits = {
  readonly maxTraversalDepth: number;
  readonly maxExistsDepth: number;
  readonly maxDependencies: number;
  readonly maxStaticWork: number;
};

export const defaultValidationLimits: ValidationLimits = {
  maxTraversalDepth: MAX_TRAVERSAL_DEPTH,
  maxExistsDepth: MAX_EXISTS_DEPTH,
  maxDependencies: 0,
  maxStaticWork: DEFAULT_AUTHORIZATION_BUDGET,
};

const SEPARATOR = "\u0000";

const entityKey = (id: EntityId): string => `${id.catalog}${SEPARATOR}${id.name}`;

const traitKey = (id: TraitId): string => `${id.catalog}${SEPARATOR}${id.name}`;

const fieldKey = (id: FieldId): string =>
  `${id.catalog}${SEPARATOR}${id.owner.kind}${SEPARATOR}${id.owner.name}${SEPARATOR}${id.localName}`;

const operationKey = (id: OperationId): string =>
  `${id.catalog}${SEPARATOR}${id.owner.kind}${SEPARATOR}${id.owner.name}${SEPARATOR}${id.localName}${SEPARATOR}${id.target}`;

const invalid = (message: string): Result.Result<never, ValidateFailure> =>
  Result.fail(new InvalidIR({ message }));

const mismatch = (
  fields: ConstructorParameters<typeof CatalogMismatch>[0],
): Result.Result<never, ValidateFailure> => Result.fail(new CatalogMismatch(fields));

type RowFocus =
  | { readonly _tag: "entity"; readonly entity: EntityId }
  | { readonly _tag: "trait"; readonly trait: TraitId };

type TermShape =
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
  | { readonly _tag: "input"; readonly shape: OperationInputShape }
  | { readonly _tag: "opaque" };

type Derived = {
  usesResource: boolean;
  usesInput: boolean;
  usesMe: boolean;
  usesSubject: boolean;
  traversalDepth: number;
  existsDepth: number;
  dependencies: RuleId[];
  staticWork: number;
};

const emptyDerived = (): Derived => ({
  usesResource: false,
  usesInput: false,
  usesMe: false,
  usesSubject: false,
  traversalDepth: 0,
  existsDepth: 0,
  dependencies: [],
  staticWork: 0,
});

const mergeDerived = (into: Derived, part: Derived): void => {
  into.usesResource ||= part.usesResource;
  into.usesInput ||= part.usesInput;
  into.usesMe ||= part.usesMe;
  into.usesSubject ||= part.usesSubject;
  if (part.traversalDepth > into.traversalDepth) into.traversalDepth = part.traversalDepth;
  if (part.existsDepth > into.existsDepth) into.existsDepth = part.existsDepth;
  for (const dep of part.dependencies) into.dependencies.push(dep);
  into.staticWork += part.staticWork;
};

const charge = (derived: Derived, nodes: number): Result.Result<void, ValidateFailure> => {
  derived.staticWork += nodes;
  return Result.succeed(undefined);
};

type CatalogIndex = {
  readonly target: CatalogBindingTarget;
  readonly entities: ReadonlyMap<string, EntityId>;
  readonly traits: ReadonlyMap<string, TraitId>;
  readonly fields: ReadonlyMap<string, FieldDescriptor>;
  readonly operations: ReadonlyMap<string, OperationDescriptor>;
  readonly entityTraits: ReadonlyMap<string, ReadonlySet<string>>;
  readonly traitTraits: ReadonlyMap<string, ReadonlySet<string>>;
};

const catalogOfIdentity = (
  identity: { readonly catalog: string },
  expected: CatalogBindingTarget,
  label: string,
): Result.Result<void, ValidateFailure> => {
  if (identity.catalog !== expected.catalog) {
    return mismatch({
      message: `stale identity: cross-catalog ${label}`,
      expected: expected.catalog,
      actual: identity.catalog as typeof expected.catalog,
    });
  }
  return Result.succeed(undefined);
};

const validateTarget = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<void, ValidateFailure> => {
  if (target.database !== descriptor.database) {
    return mismatch({
      message: "cross-database catalog",
      expectedDatabase: target.database,
      actualDatabase: descriptor.database,
    });
  }
  if (target.catalog !== descriptor.id) {
    return mismatch({
      message: "cross-catalog descriptor",
      expected: target.catalog,
      actual: descriptor.id,
    });
  }
  if (target.catalogVersion !== descriptor.version) {
    return mismatch({
      message: "stale catalog version",
      expected: target.catalog,
      actual: descriptor.id,
      expectedVersion: target.catalogVersion,
      actualVersion: descriptor.version,
    });
  }
  if (target.schemaFingerprint !== descriptor.fingerprint) {
    return mismatch({
      message: "schema fingerprint mismatch",
      expected: target.catalog,
      actual: descriptor.id,
      expectedFingerprint: target.schemaFingerprint,
      actualFingerprint: descriptor.fingerprint,
    });
  }
  return Result.succeed(undefined);
};

const closeTraits = (edges: Map<string, Set<string>>): Map<string, Set<string>> => {
  const closed = new Map<string, Set<string>>();
  for (const [name, direct] of edges) {
    const seen = new Set<string>();
    const stack = [...direct];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const nested = edges.get(next);
      if (nested !== undefined) {
        for (const child of nested) stack.push(child);
      }
    }
    closed.set(name, seen);
  }
  return closed;
};

const indexCatalog = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<CatalogIndex, ValidateFailure> => {
  const targetOk = validateTarget(target, descriptor);
  if (Result.isFailure(targetOk)) return Result.fail(targetOk.failure);

  const entities = new Map<string, EntityId>();
  const traits = new Map<string, TraitId>();
  const fields = new Map<string, FieldDescriptor>();
  const operations = new Map<string, OperationDescriptor>();
  const entityTraitEdges = new Map<string, Set<string>>();
  const traitTraitEdges = new Map<string, Set<string>>();

  for (const entity of descriptor.entities) {
    const scoped = catalogOfIdentity(entity.id, target, "entity");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (entities.has(entity.id.name)) return invalid(`ambiguous entity '${entity.id.name}'`);
    entities.set(entity.id.name, entity.id);
    const composed = new Set<string>();
    for (const trait of entity.traits) {
      const traitScoped = catalogOfIdentity(trait, target, "entity trait");
      if (Result.isFailure(traitScoped)) return Result.fail(traitScoped.failure);
      composed.add(trait.name);
    }
    entityTraitEdges.set(entity.id.name, composed);
  }

  for (const trait of descriptor.traits) {
    const scoped = catalogOfIdentity(trait.id, target, "trait");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (traits.has(trait.id.name)) return invalid(`ambiguous trait '${trait.id.name}'`);
    traits.set(trait.id.name, trait.id);
    const composed = new Set<string>();
    for (const nested of trait.traits) {
      const nestedScoped = catalogOfIdentity(nested, target, "trait composition");
      if (Result.isFailure(nestedScoped)) return Result.fail(nestedScoped.failure);
      composed.add(nested.name);
    }
    traitTraitEdges.set(trait.id.name, composed);
  }

  for (const field of descriptor.fields) {
    const scoped = catalogOfIdentity(field.id, target, "field");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    const key = fieldKey(field.id);
    if (fields.has(key)) return invalid(`ambiguous field '${key}'`);
    fields.set(key, field);
  }

  for (const operation of descriptor.operations) {
    const scoped = catalogOfIdentity(operation.id, target, "operation");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    const key = operationKey(operation.id);
    if (operations.has(key)) return invalid(`ambiguous operation '${key}'`);
    operations.set(key, operation);
  }

  for (const row of descriptor.traitComposition) {
    const composerOk = catalogOfIdentity(row.composer, target, "trait-composition composer");
    if (Result.isFailure(composerOk)) return Result.fail(composerOk.failure);
    const traitOk = catalogOfIdentity(row.trait, target, "trait-composition trait");
    if (Result.isFailure(traitOk)) return Result.fail(traitOk.failure);
    if (!entities.has(row.composer.name)) {
      return invalid(`missing composer entity '${row.composer.name}'`);
    }
    if (!traits.has(row.trait.name)) {
      return invalid(`missing composed trait '${row.trait.name}'`);
    }
    const composed = entityTraitEdges.get(row.composer.name) ?? new Set<string>();
    composed.add(row.trait.name);
    for (const transitive of row.transitive) {
      const scoped = catalogOfIdentity(transitive, target, "trait-composition transitive");
      if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
      if (!traits.has(transitive.name)) {
        return invalid(`missing transitive trait '${transitive.name}'`);
      }
      composed.add(transitive.name);
    }
    entityTraitEdges.set(row.composer.name, composed);
  }

  const traitTraits = closeTraits(traitTraitEdges);
  const entityTraits = new Map<string, Set<string>>();
  for (const [name, direct] of entityTraitEdges) {
    const seen = new Set<string>();
    for (const trait of direct) {
      seen.add(trait);
      const nested = traitTraits.get(trait);
      if (nested !== undefined) {
        for (const child of nested) seen.add(child);
      }
    }
    entityTraits.set(name, seen);
  }

  return Result.succeed({
    target,
    entities,
    traits,
    fields,
    operations,
    entityTraits,
    traitTraits,
  });
};

const requireEntity = (
  index: CatalogIndex,
  id: EntityId,
  label: string,
): Result.Result<EntityId, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.entities.get(id.name);
  if (found === undefined) return invalid(`stale identity: missing ${label} '${id.name}'`);
  return Result.succeed(found);
};

const requireTrait = (
  index: CatalogIndex,
  id: TraitId,
  label: string,
): Result.Result<TraitId, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.traits.get(id.name);
  if (found === undefined) return invalid(`stale identity: missing ${label} '${id.name}'`);
  return Result.succeed(found);
};

const requireField = (
  index: CatalogIndex,
  id: FieldId,
  label: string,
): Result.Result<FieldDescriptor, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.fields.get(fieldKey(id));
  if (found === undefined) {
    return invalid(
      `stale identity: missing ${label} '${id.owner.kind}:${id.owner.name}.${id.localName}'`,
    );
  }
  return Result.succeed(found);
};

const requireOperation = (
  index: CatalogIndex,
  id: OperationId,
  label: string,
): Result.Result<OperationDescriptor, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.operations.get(operationKey(id));
  if (found === undefined) {
    return invalid(
      `stale identity: missing ${label} '${id.owner.kind}:${id.owner.name}.${id.localName}:${id.target}'`,
    );
  }
  return Result.succeed(found);
};

const entityComposes = (index: CatalogIndex, entity: EntityId, traitName: string): boolean =>
  index.entityTraits.get(entity.name)?.has(traitName) === true;

const traitComposes = (index: CatalogIndex, trait: TraitId, otherName: string): boolean =>
  trait.name === otherName || index.traitTraits.get(trait.name)?.has(otherName) === true;

const traitReachable = (index: CatalogIndex, trait: TraitId): boolean => {
  for (const composed of index.entityTraits.values()) {
    if (composed.has(trait.name)) return true;
  }
  return false;
};

const ownerHasTrait = (index: CatalogIndex, owner: OwnerRef, traitName: string): boolean => {
  if (owner.kind === "trait") {
    if (owner.name === traitName) return true;
    const id = index.traits.get(owner.name);
    return id !== undefined && traitComposes(index, id, traitName);
  }
  const id = index.entities.get(owner.name);
  return id !== undefined && entityComposes(index, id, traitName);
};

const fieldAccessibleFrom = (
  index: CatalogIndex,
  focus: RowFocus,
  field: FieldDescriptor,
): boolean => {
  const owner = field.id.owner;
  if (focus._tag === "entity") {
    if (owner.kind === "entity") return owner.name === focus.entity.name;
    return entityComposes(index, focus.entity, owner.name);
  }
  if (owner.kind === "entity") return false;
  return traitComposes(index, focus.trait, owner.name);
};

const ownerFocus = (index: CatalogIndex, owner: OwnerRef): Result.Result<RowFocus, ValidateFailure> => {
  if (owner.kind === "entity") {
    const entity = index.entities.get(owner.name);
    if (entity === undefined) return invalid(`missing owner entity '${owner.name}'`);
    return Result.succeed({ _tag: "entity", entity });
  }
  const trait = index.traits.get(owner.name);
  if (trait === undefined) return invalid(`missing owner trait '${owner.name}'`);
  return Result.succeed({ _tag: "trait", trait });
};

const sameRow = (left: RowFocus, right: RowFocus): boolean => {
  if (left._tag !== right._tag) return false;
  if (left._tag === "entity" && right._tag === "entity") {
    return left.entity.catalog === right.entity.catalog && left.entity.name === right.entity.name;
  }
  if (left._tag === "trait" && right._tag === "trait") {
    return left.trait.catalog === right.trait.catalog && left.trait.name === right.trait.name;
  }
  return false;
};

const rowFromRefTarget = (
  index: CatalogIndex,
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

const refCompatibleWithRow = (target: FieldRefTarget, row: RowFocus): boolean => {
  if (target._tag === "entity" && row._tag === "entity") {
    return target.entity.catalog === row.entity.catalog && target.entity.name === row.entity.name;
  }
  if (target._tag === "trait" && row._tag === "trait") {
    return target.trait.catalog === row.trait.catalog && target.trait.name === row.trait.name;
  }
  return false;
};

const sameRefTarget = (left: FieldRefTarget, right: FieldRefTarget): boolean => {
  if (left._tag !== right._tag) return false;
  if (left._tag === "entity" && right._tag === "entity") {
    return left.entity.catalog === right.entity.catalog && left.entity.name === right.entity.name;
  }
  if (left._tag === "trait" && right._tag === "trait") {
    return left.trait.catalog === right.trait.catalog && left.trait.name === right.trait.name;
  }
  return left._tag === "self" || left._tag === "untargeted";
};

const claimScalar = (shape: ClaimShape): ScalarValueType | undefined =>
  shape._tag === "scalar" ? shape.valueType : undefined;

const inputScalar = (shape: OperationInputShape): ScalarValueType | undefined =>
  shape._tag === "scalar" ? shape.valueType : undefined;

const litScalar = (value: string | number | boolean | null): TermShape => {
  if (value === null) return { _tag: "scalar", valueType: "null" };
  if (typeof value === "boolean") return { _tag: "scalar", valueType: "boolean" };
  if (typeof value === "number") return { _tag: "scalar", valueType: "number" };
  return { _tag: "scalar", valueType: "string" };
};

const scalarAssignable = (expected: ScalarValueType | "null" | "number", actual: TermShape): boolean => {
  if (actual._tag === "subject") return expected === "string";
  if (actual._tag !== "scalar") return false;
  if (expected === actual.valueType) return true;
  if (expected === "number") return actual.valueType === "long" || actual.valueType === "double";
  if (actual.valueType === "number") return expected === "long" || expected === "double";
  if (expected === "string" && actual.valueType === "uuid") return true;
  if (expected === "uuid" && actual.valueType === "string") return true;
  return false;
};

const eqCompatible = (left: TermShape, right: TermShape): boolean => {
  const pair = (a: TermShape, b: TermShape): boolean => {
    if (a._tag === "opaque" || b._tag === "opaque") return false;
    if (a._tag === "boolean" || b._tag === "boolean") return false;
    if (a._tag === "ref" && a.cardinality === "many") return false;
    if (b._tag === "ref" && b.cardinality === "many") return false;
    if (a._tag === "me") {
      if (b._tag === "me") return true;
      if (b._tag === "row" && b.focus._tag === "entity") {
        return a.entity === undefined || a.entity.name === b.focus.entity.name;
      }
      if (b._tag === "ref" && b.target._tag === "entity") {
        return a.entity === undefined || a.entity.name === b.target.entity.name;
      }
      if (b._tag === "input" && b.shape._tag === "ref" && b.shape.refTarget._tag === "entity") {
        return a.entity === undefined || a.entity.name === b.shape.refTarget.entity.name;
      }
      return false;
    }
    if (a._tag === "subject") {
      return (
        b._tag === "subject" ||
        scalarAssignable("string", b) ||
        (b._tag === "claim" && claimScalar(b.shape) === "string") ||
        (b._tag === "input" && inputScalar(b.shape) === "string")
      );
    }
    if (a._tag === "row") {
      if (b._tag === "row") return sameRow(a.focus, b.focus);
      if (b._tag === "ref") return refCompatibleWithRow(b.target, a.focus);
      if (b._tag === "input" && b.shape._tag === "ref") {
        return refCompatibleWithRow(b.shape.refTarget, a.focus);
      }
      return false;
    }
    if (a._tag === "ref") {
      if (b._tag === "ref") return sameRefTarget(a.target, b.target);
      if (b._tag === "input" && b.shape._tag === "ref") {
        return sameRefTarget(a.target, b.shape.refTarget);
      }
      return false;
    }
    if (a._tag === "scalar") {
      if (b._tag === "scalar") return scalarAssignable(a.valueType, b);
      if (b._tag === "claim") {
        const scalar = claimScalar(b.shape);
        return scalar !== undefined && scalarAssignable(a.valueType, { _tag: "scalar", valueType: scalar });
      }
      if (b._tag === "input") {
        const scalar = inputScalar(b.shape);
        return scalar !== undefined && scalarAssignable(a.valueType, { _tag: "scalar", valueType: scalar });
      }
      return false;
    }
    if (a._tag === "claim") {
      const scalar = claimScalar(a.shape);
      if (scalar === undefined) return false;
      return eqCompatible({ _tag: "scalar", valueType: scalar }, b);
    }
    if (a._tag === "input") {
      if (a.shape._tag === "scalar") {
        return eqCompatible({ _tag: "scalar", valueType: a.shape.valueType }, b);
      }
      if (a.shape._tag === "ref" && b._tag === "input" && b.shape._tag === "ref") {
        return sameRefTarget(a.shape.refTarget, b.shape.refTarget);
      }
      return false;
    }
    return false;
  };
  return pair(left, right) || pair(right, left);
};

const collectionElement = (shape: TermShape): TermShape | undefined => {
  if (shape._tag === "ref" && shape.cardinality === "many") {
    return { _tag: "ref", target: shape.target, cardinality: "one" };
  }
  if (shape._tag === "input" && shape.shape._tag === "array") {
    return inputShapeType(shape.shape.items);
  }
  if (shape._tag === "claim" && shape.shape._tag === "array") {
    return { _tag: "claim", shape: shape.shape.items };
  }
  return undefined;
};

const inputShapeType = (shape: OperationInputShape): TermShape => {
  switch (shape._tag) {
    case "scalar":
      return { _tag: "scalar", valueType: shape.valueType };
    case "ref":
      return { _tag: "ref", target: shape.refTarget, cardinality: "one" };
    case "opaque":
      return { _tag: "opaque" };
    case "array":
      return { _tag: "input", shape };
    case "struct":
      return { _tag: "input", shape };
  }
};

const walkInputPath = (
  shape: OperationInputShape,
  path: ReadonlyArray<string>,
): Result.Result<TermShape, ValidateFailure> => {
  if (path.length === 0) return Result.succeed(inputShapeType(shape));
  switch (shape._tag) {
    case "struct": {
      const key = path[0]!;
      const field = shape.fields.find((entry) => entry.key === key);
      if (field === undefined) return invalid(`unknown operation input path '${path.join(".")}'`);
      return walkInputPath(field.shape, path.slice(1));
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

const claimByKey = (
  claims: ReadonlyArray<ClaimDescriptor>,
  key: string,
): Result.Result<ClaimDescriptor, ValidateFailure> => {
  const found = claims.filter((claim) => claim.key === key);
  if (found.length === 0) return invalid(`undeclared claim '${key}'`);
  if (found.length > 1) return invalid(`ambiguous claim '${key}'`);
  return Result.succeed(found[0]!);
};

const validateVocabularies = (
  classes: ReadonlyArray<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
): Result.Result<void, ValidateFailure> => {
  const seenClass = new Set<string>();
  for (const name of classes) {
    if (name.length === 0) return invalid("blank class name");
    if (seenClass.has(name)) return invalid(`duplicate class '${name}'`);
    seenClass.add(name);
  }
  const seenClaim = new Set<string>();
  for (const claim of claims) {
    if (claim.key.length === 0) return invalid("blank claim key");
    if (seenClaim.has(claim.key)) return invalid(`duplicate claim '${claim.key}'`);
    seenClaim.add(claim.key);
  }
  return Result.succeed(undefined);
};

const resourceFocus = (
  index: CatalogIndex,
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

const operationInput = (
  index: CatalogIndex,
  focus: CanonicalRuleFocus,
): Result.Result<OperationInputShape | undefined, ValidateFailure> => {
  if (focus._tag !== "operation") return Result.succeed(undefined);
  const operation = requireOperation(index, focus.operation, "rule focus operation");
  if (Result.isFailure(operation)) return Result.fail(operation.failure);
  return Result.succeed(operation.success.input);
};

const meEntity = (
  index: CatalogIndex,
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
  const entity = index.entities.get(field.success.id.owner.name);
  if (entity === undefined) return invalid("missing principal entity");
  return Result.succeed(entity);
};

const walkRef = (
  index: CatalogIndex,
  term: CanonicalRefTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  limits: ValidationLimits,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const derived = emptyDerived();
  derived.staticWork = 1 + term.steps.length;
  if (term.steps.length > limits.maxTraversalDepth) {
    return invalid(`traversal depth ${term.steps.length} exceeds ${limits.maxTraversalDepth}`);
  }
  derived.traversalDepth = term.steps.length;

  let current: RowFocus | undefined;
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
      current = bound;
      break;
    }
  }

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
    return Result.succeed({
      shape: {
        _tag: "ref",
        target: last.refTarget,
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
      },
      derived,
    });
  }
  return Result.succeed({
    shape: { _tag: "scalar", valueType: last.valueType },
    derived,
  });
};

const walkValue = (
  index: CatalogIndex,
  term: CanonicalValueTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  input: OperationInputShape | undefined,
  claims: ReadonlyArray<ClaimDescriptor>,
  limits: ValidationLimits,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  switch (term._tag) {
    case "ref":
      return walkRef(index, term, resource, me, binds, limits);
    case "lit":
      return Result.succeed({ shape: litScalar(term.value), derived: { ...emptyDerived(), staticWork: 1 } });
    case "subject":
      return Result.succeed({
        shape: { _tag: "subject" },
        derived: { ...emptyDerived(), usesSubject: true, staticWork: 1 },
      });
    case "me":
      return Result.succeed({
        shape: { _tag: "me", entity: me },
        derived: { ...emptyDerived(), usesMe: true, staticWork: 1 },
      });
    case "claim": {
      const claim = claimByKey(claims, term.key);
      if (Result.isFailure(claim)) return Result.fail(claim.failure);
      return Result.succeed({
        shape: { _tag: "claim", shape: claim.success.shape },
        derived: { ...emptyDerived(), staticWork: 1 },
      });
    }
    case "input": {
      if (input === undefined) return invalid("operation input is not available in this rule focus");
      const shape = walkInputPath(input, term.path);
      if (Result.isFailure(shape)) return Result.fail(shape.failure);
      return Result.succeed({
        shape: shape.success,
        derived: { ...emptyDerived(), usesInput: true, staticWork: 1 + term.path.length },
      });
    }
    case "bind": {
      const bound = binds.get(term.name);
      if (bound === undefined) return invalid(`unbound name '${term.name}'`);
      return Result.succeed({
        shape: { _tag: "row", focus: bound },
        derived: { ...emptyDerived(), staticWork: 1 },
      });
    }
  }
};

const walkExpr = (
  index: CatalogIndex,
  expr: CanonicalAuthorizationExpr,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, RowFocus>,
  input: OperationInputShape | undefined,
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
      if (!eqCompatible(left.success.shape, right.success.shape)) {
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
      const element = collectionElement(collection.success.shape);
      if (element === undefined) return invalid("membership requires a collection");
      if (!eqCompatible(value.success.shape, element)) {
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
      if (shape._tag !== "ref") return invalid("some requires a ref collection");
      const lastStep = expr.collection.steps[expr.collection.steps.length - 1];
      if (lastStep === undefined) return invalid("some requires a ref traversal");
      const row = rowFromRefTarget(index, shape.target, lastStep.field.owner);
      if (Result.isFailure(row)) return Result.fail(row.failure);
      if (row.success === undefined) {
        return invalid("some cannot bind an untargeted ref");
      }
      const nextBinds = new Map(binds);
      nextBinds.set(expr.bind, row.success);
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
      const leftEl = collectionElement(left.success.shape);
      const rightEl = collectionElement(right.success.shape);
      if (leftEl === undefined || rightEl === undefined) {
        return invalid("overlaps requires two collections");
      }
      if (!eqCompatible(leftEl, rightEl)) return invalid("incompatible overlaps operands");
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
      nextBinds.set(expr.bind, { _tag: "entity", entity: entity.success });
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

const dependencyCycle = (
  nodes: ReadonlyArray<{ readonly id: RuleId; readonly dependencies: ReadonlyArray<RuleId> }>,
): "self" | "cycle" | undefined => {
  const edges = new Map<RuleId, ReadonlyArray<RuleId>>();
  for (const node of nodes) edges.set(node.id, node.dependencies);
  const visiting = new Set<RuleId>();
  const visited = new Set<RuleId>();
  const visit = (id: RuleId): "self" | "cycle" | undefined => {
    if (visited.has(id)) return undefined;
    if (visiting.has(id)) return "cycle";
    visiting.add(id);
    for (const dep of edges.get(id) ?? []) {
      if (dep === id) return "self";
      const nested = visit(dep);
      if (nested !== undefined) return nested;
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const node of nodes) {
    const found = visit(node.id);
    if (found !== undefined) return found;
  }
  return undefined;
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
  if (!sameIds(rule.dependencies, derived.dependencies)) {
    const cycle = dependencyCycle([{ id: rule.id, dependencies: rule.dependencies }]);
    if (cycle === "self") return invalid("recursive named-rule invocation");
    if (cycle === "cycle") return invalid("dependency cycle");
    return invalid("tampered dependencies");
  }
  if (derived.dependencies.length > limits.maxDependencies) {
    return invalid(
      `named-rule dependencies ${derived.dependencies.length} exceed ${limits.maxDependencies}`,
    );
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
  index: CatalogIndex,
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
      if (operation.success.id.owner.kind === "trait" && operation.success.id.target === "none") {
        const trait = index.traits.get(operation.success.id.owner.name);
        if (trait === undefined || !traitReachable(index, trait)) {
          return invalid(
            `targetless trait operation '${operation.success.id.localName}' is not reachable`,
          );
        }
      }
      return Result.succeed(undefined);
    }
  }
};

const validateRule = (
  index: CatalogIndex,
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

const uniqueDecisionIds = (
  ids: ReadonlyArray<RuleId>,
  label: string,
): Result.Result<void, ValidateFailure> => {
  const seen = new Set<RuleId>();
  for (const id of ids) {
    if (seen.has(id)) return invalid(`duplicate ${label} rule`);
    seen.add(id);
  }
  return Result.succeed(undefined);
};

const fieldOwnerMatchesEntity = (
  index: CatalogIndex,
  field: FieldDescriptor,
  entity: EntityId,
): boolean => {
  if (field.id.owner.kind === "entity") return field.id.owner.name === entity.name;
  return entityComposes(index, entity, field.id.owner.name);
};

const fieldOwnerMatchesTrait = (
  index: CatalogIndex,
  field: FieldDescriptor,
  trait: TraitId,
): boolean => {
  if (field.id.owner.kind === "trait") return traitComposes(index, trait, field.id.owner.name);
  return false;
};

const ruleFitsEntity = (
  index: CatalogIndex,
  rule: CanonicalAuthorizationRule,
  target: EntityId,
): boolean => {
  if (rule.focus._tag === "entity") {
    return rule.focus.entity.catalog === target.catalog && rule.focus.entity.name === target.name;
  }
  if (rule.focus._tag === "trait") return entityComposes(index, target, rule.focus.trait.name);
  return false;
};

const ruleFitsTrait = (
  index: CatalogIndex,
  rule: CanonicalAuthorizationRule,
  target: TraitId,
): boolean => {
  if (rule.focus._tag !== "trait") return false;
  return traitComposes(index, target, rule.focus.trait.name);
};

const ruleFitsField = (
  index: CatalogIndex,
  rule: CanonicalAuthorizationRule,
  field: FieldDescriptor,
): boolean => {
  if (rule.focus._tag === "field") return fieldKey(rule.focus.field) === fieldKey(field.id);
  if (rule.focus._tag === "entity") return fieldOwnerMatchesEntity(index, field, rule.focus.entity);
  if (rule.focus._tag === "trait") return fieldOwnerMatchesTrait(index, field, rule.focus.trait);
  return false;
};

const ruleFitsOperation = (
  index: CatalogIndex,
  rule: CanonicalAuthorizationRule,
  operation: OperationDescriptor,
): Result.Result<void, ValidateFailure> => {
  if (operation.id.target === "none" && rule.usesResource) {
    return invalid("resource-dependent rule cannot authorize a targetless operation");
  }
  if (rule.focus._tag === "operation") {
    return operationKey(rule.focus.operation) === operationKey(operation.id)
      ? Result.succeed(undefined)
      : invalid("rule focus is incompatible with operation decision");
  }
  if (rule.focus._tag === "entity") {
    const owner = operation.id.owner;
    if (owner.kind === "entity" && owner.name === rule.focus.entity.name) {
      return Result.succeed(undefined);
    }
    return invalid("rule focus is incompatible with operation decision");
  }
  if (rule.focus._tag === "trait") {
    if (ownerHasTrait(index, operation.id.owner, rule.focus.trait.name)) {
      return Result.succeed(undefined);
    }
    return invalid("rule focus is incompatible with operation decision");
  }
  return invalid("rule focus is incompatible with operation decision");
};

const lookupRule = (
  rules: ReadonlyMap<RuleId, CanonicalAuthorizationRule>,
  id: RuleId,
): Result.Result<CanonicalAuthorizationRule, ValidateFailure> => {
  const found = rules.get(id);
  if (found === undefined) return invalid(`unknown rule '${id}'`);
  return Result.succeed(found);
};

const validateDecisionRules = (
  index: CatalogIndex,
  decision: Decision,
  rules: ReadonlyMap<RuleId, CanonicalAuthorizationRule>,
  compatible: (rule: CanonicalAuthorizationRule) => Result.Result<void, ValidateFailure>,
): Result.Result<void, ValidateFailure> => {
  const allowOk = uniqueDecisionIds(decision.allow, "allow");
  if (Result.isFailure(allowOk)) return Result.fail(allowOk.failure);
  const denyOk = uniqueDecisionIds(decision.deny, "deny");
  if (Result.isFailure(denyOk)) return Result.fail(denyOk.failure);
  const seen = new Set<RuleId>();
  for (const id of decision.allow) {
    seen.add(id);
    const rule = lookupRule(rules, id);
    if (Result.isFailure(rule)) return Result.fail(rule.failure);
    const fit = compatible(rule.success);
    if (Result.isFailure(fit)) return Result.fail(fit.failure);
  }
  for (const id of decision.deny) {
    if (seen.has(id)) return invalid("contradictory allow and deny rule");
    const rule = lookupRule(rules, id);
    if (Result.isFailure(rule)) return Result.fail(rule.failure);
    const fit = compatible(rule.success);
    if (Result.isFailure(fit)) return Result.fail(fit.failure);
  }
  return Result.succeed(undefined);
};

const validateDecisions = (
  index: CatalogIndex,
  decisions: CanonicalAuthorizationDecisions,
  rules: ReadonlyMap<RuleId, CanonicalAuthorizationRule>,
): Result.Result<void, ValidateFailure> => {
  const seenEntities = new Set<string>();
  for (const entry of decisions.entities) {
    const target = requireEntity(index, entry.target, "entity decision target");
    if (Result.isFailure(target)) return Result.fail(target.failure);
    const key = entityKey(target.success);
    if (seenEntities.has(key)) return invalid("duplicate entity decision target");
    seenEntities.add(key);
    const ok = validateDecisionRules(index, entry.decision, rules, (rule) =>
      ruleFitsEntity(index, rule, target.success)
        ? Result.succeed(undefined)
        : invalid("rule focus is incompatible with entity decision"),
    );
    if (Result.isFailure(ok)) return Result.fail(ok.failure);
  }

  const seenTraits = new Set<string>();
  for (const entry of decisions.traits) {
    const target = requireTrait(index, entry.target, "trait decision target");
    if (Result.isFailure(target)) return Result.fail(target.failure);
    const key = traitKey(target.success);
    if (seenTraits.has(key)) return invalid("duplicate trait decision target");
    seenTraits.add(key);
    const ok = validateDecisionRules(index, entry.decision, rules, (rule) =>
      ruleFitsTrait(index, rule, target.success)
        ? Result.succeed(undefined)
        : invalid("rule focus is incompatible with trait decision"),
    );
    if (Result.isFailure(ok)) return Result.fail(ok.failure);
  }

  const seenFields = new Set<string>();
  for (const entry of decisions.fields) {
    const target = requireField(index, entry.target, "field decision target");
    if (Result.isFailure(target)) return Result.fail(target.failure);
    const key = fieldKey(target.success.id);
    if (seenFields.has(key)) return invalid("duplicate field decision target");
    seenFields.add(key);
    const ok = validateDecisionRules(index, entry.decision, rules, (rule) =>
      ruleFitsField(index, rule, target.success)
        ? Result.succeed(undefined)
        : invalid("rule focus is incompatible with field decision"),
    );
    if (Result.isFailure(ok)) return Result.fail(ok.failure);
  }

  const seenOperations = new Set<string>();
  for (const entry of decisions.operations) {
    const target = requireOperation(index, entry.target, "operation decision target");
    if (Result.isFailure(target)) return Result.fail(target.failure);
    const key = operationKey(target.success.id);
    if (seenOperations.has(key)) return invalid("duplicate operation decision target");
    seenOperations.add(key);
    const ok = validateDecisionRules(index, entry.decision, rules, (rule) =>
      ruleFitsOperation(index, rule, target.success),
    );
    if (Result.isFailure(ok)) return Result.fail(ok.failure);
  }
  return Result.succeed(undefined);
};

const clonePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clonePlain(item)) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = clonePlain((value as Record<string, unknown>)[key]);
  }
  return copy as T;
};

const freezePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezePlain(item);
  } else {
    for (const key of Object.keys(value)) {
      freezePlain((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
};

const freezeValidated = <T>(value: T): T => freezePlain(clonePlain(value));

const boundTarget = (bound: BoundAuthorizationIR): CatalogBindingTarget => ({
  database: bound.database,
  catalog: bound.catalog,
  catalogVersion: bound.catalogVersion,
  schemaFingerprint: bound.schemaFingerprint,
});

/**
 * Pure semantic kernel. Recomputes rule hashes and derived flags. Does not
 * derive access plans or assemble {@link import("./ir.ts").InstalledAuthorizationIR}.
 */
export const validateBoundAuthorizationResult = (
  input: AuthorizationValidationInput,
  limits: ValidationLimits = defaultValidationLimits,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> => {
  const index = indexCatalog(boundTarget(input.bound), input.descriptor);
  if (Result.isFailure(index)) return Result.fail(index.failure);

  const vocab = validateVocabularies(input.bound.classes, input.bound.claims);
  if (Result.isFailure(vocab)) return Result.fail(vocab.failure);

  const principalOk = meEntity(index.success, input.bound.principal);
  if (Result.isFailure(principalOk)) return Result.fail(principalOk.failure);

  const classes = new Set(input.bound.classes);
  const rules: CanonicalAuthorizationRule[] = [];
  const byId = new Map<RuleId, CanonicalAuthorizationRule>();
  for (const rule of input.bound.rules) {
    const validated = validateRule(
      index.success,
      rule,
      input.bound.principal,
      classes,
      input.bound.claims,
      limits,
    );
    if (Result.isFailure(validated)) return Result.fail(validated.failure);
    if (byId.has(validated.success.id)) {
      return invalid(`duplicate rule identity: ${validated.success.id}`);
    }
    byId.set(validated.success.id, validated.success);
    rules.push(validated.success);
  }

  const cycle = dependencyCycle(rules);
  if (cycle === "self") return invalid("recursive named-rule invocation");
  if (cycle === "cycle") return invalid("dependency cycle");

  const decisions = validateDecisions(index.success, input.bound.decisions, byId);
  if (Result.isFailure(decisions)) return Result.fail(decisions.failure);

  const validated: ValidatedAuthorizationIRType = {
    _tag: "ValidatedAuthorizationIR",
    version: VALIDATED_AUTHORIZATION_IR_VERSION,
    database: input.bound.database,
    catalog: input.bound.catalog,
    catalogVersion: input.bound.catalogVersion,
    schemaFingerprint: input.bound.schemaFingerprint,
    classes: input.bound.classes,
    claims: input.bound.claims,
    principal: input.bound.principal,
    rules,
    decisions: input.bound.decisions,
  };
  return Result.succeed(freezeValidated(validated));
};

export const validateBoundAuthorization = Effect.fn("Authorization.validateBoundAuthorization")(
  function* (
    input: AuthorizationValidationInput,
    limits: ValidationLimits = defaultValidationLimits,
  ): Effect.fn.Return<ValidatedAuthorizationIRType, ValidateFailure> {
    return yield* Effect.fromResult(validateBoundAuthorizationResult(input, limits));
  },
);
