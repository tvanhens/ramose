/**
 * Semantic validation kernel.
 *
 * Consumes {@link BoundAuthorizationIR} and one authoritative
 * {@link CatalogDescriptor}. Recomputes every security-owned rule property
 * from the bound expression. Template-supplied flags, depths, and rule IDs
 * are never trusted. Named-rule dependencies must be empty until #382.
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

/**
 * Hard production ceilings. Callers cannot widen these. The current
 * language has no named-rule invocation, so {@link maxDependencies} is 0.
 */
export const defaultValidationLimits: ValidationLimits = {
  maxTraversalDepth: MAX_TRAVERSAL_DEPTH,
  maxExistsDepth: MAX_EXISTS_DEPTH,
  maxDependencies: 0,
  maxStaticWork: DEFAULT_AUTHORIZATION_BUDGET,
};

const isFiniteNatural = (value: number): boolean =>
  Number.isFinite(value) && Number.isInteger(value) && value >= 0;

/**
 * Test-only tightening. Each override must be a finite natural number and
 * is clamped at the corresponding hard constant so Infinity/NaN cannot
 * disable traversal, exists, or work restrictions.
 */
const tightenValidationLimits = (
  overrides: Partial<ValidationLimits> | undefined,
): Result.Result<ValidationLimits, ValidateFailure> => {
  if (overrides === undefined) return Result.succeed(defaultValidationLimits);
  const clamp = (
    key: keyof ValidationLimits,
    hard: number,
  ): Result.Result<number, ValidateFailure> => {
    const value = overrides[key];
    if (value === undefined) return Result.succeed(hard);
    if (!isFiniteNatural(value)) {
      return invalid(`invalid ${key}: must be a finite natural number`);
    }
    return Result.succeed(Math.min(value, hard));
  };
  const maxTraversalDepth = clamp("maxTraversalDepth", defaultValidationLimits.maxTraversalDepth);
  if (Result.isFailure(maxTraversalDepth)) return Result.fail(maxTraversalDepth.failure);
  const maxExistsDepth = clamp("maxExistsDepth", defaultValidationLimits.maxExistsDepth);
  if (Result.isFailure(maxExistsDepth)) return Result.fail(maxExistsDepth.failure);
  const maxDependencies = clamp("maxDependencies", defaultValidationLimits.maxDependencies);
  if (Result.isFailure(maxDependencies)) return Result.fail(maxDependencies.failure);
  const maxStaticWork = clamp("maxStaticWork", defaultValidationLimits.maxStaticWork);
  if (Result.isFailure(maxStaticWork)) return Result.fail(maxStaticWork.failure);
  return Result.succeed({
    maxTraversalDepth: maxTraversalDepth.success,
    maxExistsDepth: maxExistsDepth.success,
    maxDependencies: maxDependencies.success,
    maxStaticWork: maxStaticWork.success,
  });
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

type Binding = {
  readonly focus: RowFocus;
  readonly traversalDepth: number;
};

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
  | { readonly _tag: "input"; readonly shape: OperationInputShape; readonly owner: OwnerRef }
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
    const keys = validateInputShapeKeys(operation.input);
    if (Result.isFailure(keys)) return Result.fail(keys.failure);
    operations.set(key, operation);
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

  const seenComposition = new Set<string>();
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
    const compositionKey = `${row.composer.name}${SEPARATOR}${row.trait.name}`;
    if (seenComposition.has(compositionKey)) {
      return invalid(
        `duplicate trait composition '${row.composer.name}'/'${row.trait.name}'`,
      );
    }
    seenComposition.add(compositionKey);
    const computed = entityTraits.get(row.composer.name);
    if (computed === undefined || !computed.has(row.trait.name)) {
      return invalid(
        `entity '${row.composer.name}' does not compose trait '${row.trait.name}'`,
      );
    }
    const expected = new Set<string>([row.trait.name]);
    const nested = traitTraits.get(row.trait.name);
    if (nested !== undefined) {
      for (const child of nested) expected.add(child);
    }
    const declared = new Set<string>();
    for (const transitive of row.transitive) {
      const scoped = catalogOfIdentity(transitive, target, "trait-composition transitive");
      if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
      if (!traits.has(transitive.name)) {
        return invalid(`missing transitive trait '${transitive.name}'`);
      }
      if (declared.has(transitive.name)) {
        return invalid(`duplicate transitive trait '${transitive.name}'`);
      }
      declared.add(transitive.name);
    }
    if (expected.size !== declared.size) {
      return invalid(
        `contradictory trait composition for '${row.composer.name}'/'${row.trait.name}'`,
      );
    }
    for (const name of expected) {
      if (!declared.has(name)) {
        return invalid(
          `contradictory trait composition for '${row.composer.name}'/'${row.trait.name}'`,
        );
      }
    }
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

const requireTargetlessTraitReachable = (
  index: CatalogIndex,
  operation: OperationDescriptor,
): Result.Result<void, ValidateFailure> => {
  if (operation.id.target !== "none" || operation.id.owner.kind !== "trait") {
    return Result.succeed(undefined);
  }
  const trait = index.traits.get(operation.id.owner.name);
  if (trait === undefined || !traitReachable(index, trait)) {
    return invalid(`targetless trait operation '${operation.id.localName}' is not reachable`);
  }
  return Result.succeed(undefined);
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

const sameRow = (index: CatalogIndex, left: RowFocus, right: RowFocus): boolean => {
  if (left._tag === "entity" && right._tag === "entity") {
    return left.entity.catalog === right.entity.catalog && left.entity.name === right.entity.name;
  }
  if (left._tag === "trait" && right._tag === "trait") {
    return left.trait.catalog === right.trait.catalog && left.trait.name === right.trait.name;
  }
  if (left._tag === "entity" && right._tag === "trait") {
    return entityComposes(index, left.entity, right.trait.name);
  }
  if (left._tag === "trait" && right._tag === "entity") {
    return entityComposes(index, right.entity, left.trait.name);
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

const refTargetAsFocus = (target: FieldRefTarget): RowFocus | undefined => {
  if (target._tag === "entity") return { _tag: "entity", entity: target.entity };
  if (target._tag === "trait") return { _tag: "trait", trait: target.trait };
  return undefined;
};

const resolveRefTarget = (
  index: CatalogIndex,
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

const refCompatibleWithRow = (
  index: CatalogIndex,
  target: FieldRefTarget,
  row: RowFocus,
): boolean => {
  const focus = refTargetAsFocus(target);
  return focus !== undefined && sameRow(index, focus, row);
};

const sameRefTarget = (index: CatalogIndex, left: FieldRefTarget, right: FieldRefTarget): boolean => {
  const leftFocus = refTargetAsFocus(left);
  const rightFocus = refTargetAsFocus(right);
  if (leftFocus !== undefined && rightFocus !== undefined) {
    return sameRow(index, leftFocus, rightFocus);
  }
  return left._tag === "untargeted" && right._tag === "untargeted";
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

const meCompatibleWith = (index: CatalogIndex, me: EntityId | undefined, other: TermShape): boolean => {
  if (other._tag === "me") return true;
  if (other._tag === "row") {
    return me === undefined || sameRow(index, { _tag: "entity", entity: me }, other.focus);
  }
  if (other._tag === "ref") {
    const focus = refTargetAsFocus(other.target);
    return focus !== undefined && (me === undefined || sameRow(index, { _tag: "entity", entity: me }, focus));
  }
  if (other._tag === "input" && other.shape._tag === "ref") {
    const resolved = resolveRefTarget(index, other.shape.refTarget, other.owner);
    if (Result.isFailure(resolved)) return false;
    const focus = refTargetAsFocus(resolved.success);
    return focus !== undefined && (me === undefined || sameRow(index, { _tag: "entity", entity: me }, focus));
  }
  return false;
};

const eqCompatible = (index: CatalogIndex, left: TermShape, right: TermShape): boolean => {
  const pair = (a: TermShape, b: TermShape): boolean => {
    if (a._tag === "opaque" || b._tag === "opaque") return false;
    if (a._tag === "boolean" || b._tag === "boolean") return false;
    if (a._tag === "ref" && a.cardinality === "many") return false;
    if (b._tag === "ref" && b.cardinality === "many") return false;
    if (a._tag === "me") return meCompatibleWith(index, a.entity, b);
    if (a._tag === "subject") {
      return (
        b._tag === "subject" ||
        scalarAssignable("string", b) ||
        (b._tag === "claim" && claimScalar(b.shape) === "string") ||
        (b._tag === "input" && inputScalar(b.shape) === "string")
      );
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
      return eqCompatible(index, { _tag: "scalar", valueType: scalar }, b);
    }
    if (a._tag === "input") {
      if (a.shape._tag === "scalar") {
        return eqCompatible(index, { _tag: "scalar", valueType: a.shape.valueType }, b);
      }
      if (a.shape._tag === "ref" && b._tag === "input" && b.shape._tag === "ref") {
        const left = resolveRefTarget(index, a.shape.refTarget, a.owner);
        const right = resolveRefTarget(index, b.shape.refTarget, b.owner);
        return (
          Result.isSuccess(left) &&
          Result.isSuccess(right) &&
          sameRefTarget(index, left.success, right.success)
        );
      }
      return false;
    }
    return false;
  };
  return pair(left, right) || pair(right, left);
};

const collectionElement = (
  index: CatalogIndex,
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

const inputShapeType = (
  index: CatalogIndex,
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

const walkInputPath = (
  index: CatalogIndex,
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

const claimByKey = (
  claims: ReadonlyArray<ClaimDescriptor>,
  key: string,
): Result.Result<ClaimDescriptor, ValidateFailure> => {
  const found = claims.filter((claim) => claim.key === key);
  if (found.length === 0) return invalid(`undeclared claim '${key}'`);
  if (found.length > 1) return invalid(`ambiguous claim '${key}'`);
  return Result.succeed(found[0]!);
};

const validateKeyedShapes = (
  fields: ReadonlyArray<{ readonly key: string; readonly shape: ClaimShape | OperationInputShape }>,
  kind: "claim" | "operation input",
  nest: (shape: ClaimShape | OperationInputShape) => Result.Result<void, ValidateFailure>,
): Result.Result<void, ValidateFailure> => {
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.key.length === 0) return invalid(`blank ${kind} key`);
    if (seen.has(field.key)) return invalid(`duplicate ${kind} key '${field.key}'`);
    seen.add(field.key);
    const nested = nest(field.shape);
    if (Result.isFailure(nested)) return Result.fail(nested.failure);
  }
  return Result.succeed(undefined);
};

const validateClaimShapeKeys = (shape: ClaimShape): Result.Result<void, ValidateFailure> => {
  switch (shape._tag) {
    case "scalar":
    case "opaque":
      return Result.succeed(undefined);
    case "array":
      return validateClaimShapeKeys(shape.items);
    case "struct":
      return validateKeyedShapes(shape.fields, "claim", (nested) =>
        validateClaimShapeKeys(nested as ClaimShape),
      );
  }
};

const validateInputShapeKeys = (shape: OperationInputShape): Result.Result<void, ValidateFailure> => {
  switch (shape._tag) {
    case "scalar":
    case "opaque":
    case "ref":
      return Result.succeed(undefined);
    case "array":
      return validateInputShapeKeys(shape.items);
    case "struct":
      return validateKeyedShapes(shape.fields, "operation input", (nested) =>
        validateInputShapeKeys(nested as OperationInputShape),
      );
  }
};

const validateVocabularies = (
  subjectClaim: string,
  classes: ReadonlyArray<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
): Result.Result<void, ValidateFailure> => {
  if (subjectClaim.length === 0) return invalid("blank principal subject claim");
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
    const nested = validateClaimShapeKeys(claim.shape);
    if (Result.isFailure(nested)) return Result.fail(nested.failure);
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
): Result.Result<{ readonly shape: OperationInputShape; readonly owner: OwnerRef } | undefined, ValidateFailure> => {
  if (focus._tag !== "operation") return Result.succeed(undefined);
  const operation = requireOperation(index, focus.operation, "rule focus operation");
  if (Result.isFailure(operation)) return Result.fail(operation.failure);
  return Result.succeed({ shape: operation.success.input, owner: operation.success.id.owner });
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
  binds: ReadonlyMap<string, Binding>,
  limits: ValidationLimits,
): Result.Result<{ readonly shape: TermShape; readonly derived: Derived }, ValidateFailure> => {
  const derived = emptyDerived();
  derived.staticWork = 1 + term.steps.length;

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

const walkValue = (
  index: CatalogIndex,
  term: CanonicalValueTerm,
  resource: RowFocus | undefined,
  me: EntityId | undefined,
  binds: ReadonlyMap<string, Binding>,
  input: { readonly shape: OperationInputShape; readonly owner: OwnerRef } | undefined,
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
      const shape = walkInputPath(index, input.shape, term.path, input.owner);
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
        shape: { _tag: "row", focus: bound.focus },
        derived: { ...emptyDerived(), staticWork: 1, traversalDepth: bound.traversalDepth },
      });
    }
  }
};

const walkExpr = (
  index: CatalogIndex,
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
      return requireTargetlessTraitReachable(index, operation.success);
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
    const reachable = requireTargetlessTraitReachable(index, target.success);
    if (Result.isFailure(reachable)) return Result.fail(reachable.failure);
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

const validateBoundAuthorizationWithLimits = (
  input: AuthorizationValidationInput,
  limits: ValidationLimits,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> => {
  const index = indexCatalog(boundTarget(input.bound), input.descriptor);
  if (Result.isFailure(index)) return Result.fail(index.failure);

  const vocab = validateVocabularies(
    input.bound.principal.subjectClaim,
    input.bound.classes,
    input.bound.claims,
  );
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

/**
 * Pure semantic kernel. Recomputes rule hashes and derived flags. Does not
 * derive access plans or assemble {@link import("./ir.ts").InstalledAuthorizationIR}.
 * Production entry: hard validation limits only.
 */
export const validateBoundAuthorizationResult = (
  input: AuthorizationValidationInput,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> =>
  validateBoundAuthorizationWithLimits(input, defaultValidationLimits);

/**
 * Test-only path. Overrides must be finite natural numbers and are clamped
 * at the hard constants so callers can only tighten restrictions.
 */
export const validateBoundAuthorizationResultForTest = (
  input: AuthorizationValidationInput,
  limits: Partial<ValidationLimits>,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> => {
  const tightened = tightenValidationLimits(limits);
  if (Result.isFailure(tightened)) return Result.fail(tightened.failure);
  return validateBoundAuthorizationWithLimits(input, tightened.success);
};

export const validateBoundAuthorization = Effect.fn("Authorization.validateBoundAuthorization")(
  function* (
    input: AuthorizationValidationInput,
  ): Effect.fn.Return<ValidatedAuthorizationIRType, ValidateFailure> {
    return yield* Effect.fromResult(validateBoundAuthorizationResult(input));
  },
);
