/**
 * Prepared catalog lookup view and catalog-dependent invariants.
 *
 * {@link CatalogDescriptor} is structurally decoded by its schema first.
 * This module indexes one descriptor, recomputes trait closure from direct
 * composition, rejects composition cycles, and compares declared
 * `traitComposition.transitive` to that closure. Every direct entity/trait
 * edge must have a compiled composition row. Operation owners must exist.
 * Every field owner and typed ref target must exist.
 * The result is consumed by semantic validation; binding can adopt the same
 * view later without changing this kernel.
 */

import * as Result from "effect/Result";
import type {
  CatalogDescriptor,
  FieldDescriptor,
  FieldRefTarget,
  OperationDescriptor,
} from "../catalog.ts";
import type { EntityId, FieldId, OperationId, OwnerRef, TraitId } from "../identities.ts";
import type { CatalogBindingTarget } from "../ir.ts";
import {
  fieldKey,
  invalid,
  mismatch,
  operationKey,
  SEPARATOR,
  type ValidateFailure,
} from "./common.ts";
import { validateInputShapeKeys } from "./descriptors.ts";

export type RowFocus =
  | { readonly _tag: "entity"; readonly entity: EntityId }
  | { readonly _tag: "trait"; readonly trait: TraitId };

export type PreparedAuthorizationCatalog = {
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

const closeTraits = (
  edges: Map<string, Set<string>>,
): Result.Result<Map<string, Set<string>>, ValidateFailure> => {
  const closed = new Map<string, Set<string>>();
  const visit = (
    name: string,
    active: string[],
    done: Set<string>,
  ): Result.Result<void, ValidateFailure> => {
    if (active.includes(name)) {
      return invalid(`trait composition cycle: ${[...active, name].join(" → ")}`);
    }
    if (done.has(name)) return Result.succeed(undefined);
    active.push(name);
    const nested = edges.get(name);
    if (nested !== undefined) {
      for (const child of nested) {
        const ok = visit(child, active, done);
        if (Result.isFailure(ok)) return Result.fail(ok.failure);
      }
    }
    active.pop();
    done.add(name);
    return Result.succeed(undefined);
  };
  for (const [name, direct] of edges) {
    const done = new Set<string>();
    for (const child of direct) {
      const ok = visit(child, [], done);
      if (Result.isFailure(ok)) return Result.fail(ok.failure);
    }
    closed.set(name, done);
  }
  return Result.succeed(closed);
};

const validateFieldRefTarget = (
  refTarget: FieldRefTarget,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
): Result.Result<void, ValidateFailure> => {
  if (refTarget._tag === "self" || refTarget._tag === "untargeted") {
    return Result.succeed(undefined);
  }
  if (refTarget._tag === "entity") {
    const scoped = catalogOfIdentity(refTarget.entity, target, "field ref target");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (!entities.has(refTarget.entity.name)) {
      return invalid(`missing field ref target entity '${refTarget.entity.name}'`);
    }
    return Result.succeed(undefined);
  }
  const scoped = catalogOfIdentity(refTarget.trait, target, "field ref target");
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  if (!traits.has(refTarget.trait.name)) {
    return invalid(`missing field ref target trait '${refTarget.trait.name}'`);
  }
  return Result.succeed(undefined);
};

export const prepareAuthorizationCatalog = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<PreparedAuthorizationCatalog, ValidateFailure> => {
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
    const owner = field.id.owner;
    if (owner.kind === "entity") {
      if (!entities.has(owner.name)) {
        return invalid(`missing owner entity '${owner.name}' for field '${field.id.localName}'`);
      }
    } else if (!traits.has(owner.name)) {
      return invalid(`missing owner trait '${owner.name}' for field '${field.id.localName}'`);
    }
    if (field.valueType === "ref") {
      const refs = validateFieldRefTarget(field.refTarget, target, entities, traits);
      if (Result.isFailure(refs)) return Result.fail(refs.failure);
    }
    fields.set(key, field);
  }

  for (const operation of descriptor.operations) {
    const scoped = catalogOfIdentity(operation.id, target, "operation");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    const key = operationKey(operation.id);
    if (operations.has(key)) return invalid(`ambiguous operation '${key}'`);
    const owner = operation.id.owner;
    if (owner.kind === "entity") {
      if (!entities.has(owner.name)) {
        return invalid(`missing operation owner entity '${owner.name}'`);
      }
    } else if (!traits.has(owner.name)) {
      return invalid(`missing operation owner trait '${owner.name}'`);
    }
    const keys = validateInputShapeKeys(operation.input);
    if (Result.isFailure(keys)) return Result.fail(keys.failure);
    operations.set(key, operation);
  }

  const closed = closeTraits(traitTraitEdges);
  if (Result.isFailure(closed)) return Result.fail(closed.failure);
  const traitTraits = closed.success;
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
      return invalid(`duplicate trait composition '${row.composer.name}'/'${row.trait.name}'`);
    }
    seenComposition.add(compositionKey);
    const computed = entityTraits.get(row.composer.name);
    if (computed === undefined || !computed.has(row.trait.name)) {
      return invalid(`entity '${row.composer.name}' does not compose trait '${row.trait.name}'`);
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

  for (const [entityName, direct] of entityTraitEdges) {
    for (const traitName of direct) {
      if (!seenComposition.has(`${entityName}${SEPARATOR}${traitName}`)) {
        return invalid(`missing trait composition for '${entityName}'/'${traitName}'`);
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

export const requireEntity = (
  index: PreparedAuthorizationCatalog,
  id: EntityId,
  label: string,
): Result.Result<EntityId, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.entities.get(id.name);
  if (found === undefined) return invalid(`stale identity: missing ${label} '${id.name}'`);
  return Result.succeed(found);
};

export const requireTrait = (
  index: PreparedAuthorizationCatalog,
  id: TraitId,
  label: string,
): Result.Result<TraitId, ValidateFailure> => {
  const scoped = catalogOfIdentity(id, index.target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  const found = index.traits.get(id.name);
  if (found === undefined) return invalid(`stale identity: missing ${label} '${id.name}'`);
  return Result.succeed(found);
};

export const requireField = (
  index: PreparedAuthorizationCatalog,
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

export const requireOperation = (
  index: PreparedAuthorizationCatalog,
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

export const entityComposes = (
  index: PreparedAuthorizationCatalog,
  entity: EntityId,
  traitName: string,
): boolean => index.entityTraits.get(entity.name)?.has(traitName) === true;

export const traitComposes = (
  index: PreparedAuthorizationCatalog,
  trait: TraitId,
  otherName: string,
): boolean => trait.name === otherName || index.traitTraits.get(trait.name)?.has(otherName) === true;

export const traitReachable = (index: PreparedAuthorizationCatalog, trait: TraitId): boolean => {
  for (const composed of index.entityTraits.values()) {
    if (composed.has(trait.name)) return true;
  }
  return false;
};

export const requireTargetlessTraitReachable = (
  index: PreparedAuthorizationCatalog,
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

export const ownerHasTrait = (
  index: PreparedAuthorizationCatalog,
  owner: OwnerRef,
  traitName: string,
): boolean => {
  if (owner.kind === "trait") {
    if (owner.name === traitName) return true;
    const id = index.traits.get(owner.name);
    return id !== undefined && traitComposes(index, id, traitName);
  }
  const id = index.entities.get(owner.name);
  return id !== undefined && entityComposes(index, id, traitName);
};

export const fieldAccessibleFrom = (
  index: PreparedAuthorizationCatalog,
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

export const ownerFocus = (
  index: PreparedAuthorizationCatalog,
  owner: OwnerRef,
): Result.Result<RowFocus, ValidateFailure> => {
  if (owner.kind === "entity") {
    const entity = index.entities.get(owner.name);
    if (entity === undefined) return invalid(`missing owner entity '${owner.name}'`);
    return Result.succeed({ _tag: "entity", entity });
  }
  const trait = index.traits.get(owner.name);
  if (trait === undefined) return invalid(`missing owner trait '${owner.name}'`);
  return Result.succeed({ _tag: "trait", trait });
};

export const sameRow = (
  index: PreparedAuthorizationCatalog,
  left: RowFocus,
  right: RowFocus,
): boolean => {
  if (left._tag === "entity" && right._tag === "entity") {
    return left.entity.catalog === right.entity.catalog && left.entity.name === right.entity.name;
  }
  if (left._tag === "trait" && right._tag === "trait") {
    if (left.trait.catalog !== right.trait.catalog) return false;
    return (
      traitComposes(index, left.trait, right.trait.name) ||
      traitComposes(index, right.trait, left.trait.name)
    );
  }
  if (left._tag === "entity" && right._tag === "trait") {
    return entityComposes(index, left.entity, right.trait.name);
  }
  if (left._tag === "trait" && right._tag === "entity") {
    return entityComposes(index, right.entity, left.trait.name);
  }
  return false;
};
