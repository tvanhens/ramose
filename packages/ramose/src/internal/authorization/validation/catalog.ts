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
  OperationInputShape,
} from "../catalog.ts";
import type { EntityId, FieldId, OwnerRef, TraitId } from "../identities.ts";
import type { CatalogBindingTarget } from "../ir.ts";
import {
  fieldKey,
  invalid,
  isBlank,
  mismatch,
  operationKey,
  requireNonBlank,
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
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* Result.all([
      requireNonBlank(target.database, "database"),
      requireNonBlank(target.catalog, "catalog id"),
      requireNonBlank(target.catalogVersion, "catalog version"),
      requireNonBlank(target.schemaFingerprint, "schema fingerprint"),
      requireNonBlank(descriptor.database, "descriptor database"),
      requireNonBlank(descriptor.id, "descriptor catalog id"),
      requireNonBlank(descriptor.version, "descriptor catalog version"),
      requireNonBlank(descriptor.fingerprint, "descriptor schema fingerprint"),
    ]);

    if (target.database !== descriptor.database) {
      return yield* mismatch({
        message: "cross-database catalog",
        expectedDatabase: target.database,
        actualDatabase: descriptor.database,
      });
    }
    if (target.catalog !== descriptor.id) {
      return yield* mismatch({
        message: "cross-catalog descriptor",
        expected: target.catalog,
        actual: descriptor.id,
      });
    }
    if (target.catalogVersion !== descriptor.version) {
      return yield* mismatch({
        message: "stale catalog version",
        expected: target.catalog,
        actual: descriptor.id,
        expectedVersion: target.catalogVersion,
        actualVersion: descriptor.version,
      });
    }
    if (target.schemaFingerprint !== descriptor.fingerprint) {
      return yield* mismatch({
        message: "schema fingerprint mismatch",
        expected: target.catalog,
        actual: descriptor.id,
        expectedFingerprint: target.schemaFingerprint,
        actualFingerprint: descriptor.fingerprint,
      });
    }
  });

const closeTraits = (
  edges: Map<string, Set<string>>,
): Result.Result<Map<string, Set<string>>, ValidateFailure> =>
  Result.gen(function* () {
    const closed = new Map<string, Set<string>>();
    const visit = (
      name: string,
      active: string[],
      done: Set<string>,
    ): Result.Result<void, ValidateFailure> =>
      Result.gen(function* () {
        if (active.includes(name)) {
          return yield* invalid(`trait composition cycle: ${[...active, name].join(" → ")}`);
        }
        if (done.has(name)) return;
        active.push(name);
        const nested = edges.get(name);
        if (nested !== undefined) {
          for (const child of nested) {
            yield* visit(child, active, done);
          }
        }
        active.pop();
        done.add(name);
      });
    for (const [name, direct] of edges) {
      const done = new Set<string>();
      for (const child of direct) {
        yield* visit(child, [], done);
      }
      closed.set(name, done);
    }
    return closed;
  });

const validateFieldRefTarget = (
  refTarget: FieldRefTarget,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    if (refTarget._tag === "self" || refTarget._tag === "untargeted") {
      return;
    }
    if (refTarget._tag === "entity") {
      yield* catalogOfIdentity(refTarget.entity, target, "field ref target");
      if (!entities.has(refTarget.entity.name)) {
        return yield* invalid(`missing field ref target entity '${refTarget.entity.name}'`);
      }
      return;
    }
    yield* catalogOfIdentity(refTarget.trait, target, "field ref target");
    if (!traits.has(refTarget.trait.name)) {
      return yield* invalid(`missing field ref target trait '${refTarget.trait.name}'`);
    }
  });

const validateOperationShape = (
  shape: OperationInputShape,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
  allowSelf: boolean,
  operationName: string,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    switch (shape._tag) {
      case "scalar":
      case "opaque":
        return;
      case "ref":
        if (shape.refTarget._tag === "self" && !allowSelf) {
          return yield* invalid(
            `targetless operation '${operationName}' cannot reference self`,
          );
        }
        return yield* validateFieldRefTarget(
          shape.refTarget,
          target,
          entities,
          traits,
        );
      case "array":
        return yield* validateOperationShape(
          shape.items,
          target,
          entities,
          traits,
          allowSelf,
          operationName,
        );
      case "struct":
        yield* Result.all(
          shape.fields.map((field) =>
            validateOperationShape(
              field.shape,
              target,
              entities,
              traits,
              allowSelf,
              operationName,
            )
          ),
        );
    }
  });

export const prepareAuthorizationCatalog = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<PreparedAuthorizationCatalog, ValidateFailure> =>
  Result.gen(function* () {
    yield* validateTarget(target, descriptor);

    const entities = new Map<string, EntityId>();
    const traits = new Map<string, TraitId>();
    const fields = new Map<string, FieldDescriptor>();
    const operations = new Map<string, OperationDescriptor>();
    const entityTraitEdges = new Map<string, Set<string>>();
    const traitTraitEdges = new Map<string, Set<string>>();

    for (const entity of descriptor.entities) {
      yield* catalogOfIdentity(entity.id, target, "entity");
      if (isBlank(entity.id.name)) return yield* invalid("blank entity name");
      if (entities.has(entity.id.name)) {
        return yield* invalid(`ambiguous entity '${entity.id.name}'`);
      }
      entities.set(entity.id.name, entity.id);
      const composed = new Set<string>();
      for (const trait of entity.traits) {
        yield* catalogOfIdentity(trait, target, "entity trait");
        if (isBlank(trait.name)) return yield* invalid("blank trait name");
        composed.add(trait.name);
      }
      entityTraitEdges.set(entity.id.name, composed);
    }

    for (const trait of descriptor.traits) {
      yield* catalogOfIdentity(trait.id, target, "trait");
      if (isBlank(trait.id.name)) return yield* invalid("blank trait name");
      if (traits.has(trait.id.name)) {
        return yield* invalid(`ambiguous trait '${trait.id.name}'`);
      }
      traits.set(trait.id.name, trait.id);
      const composed = new Set<string>();
      for (const nested of trait.traits) {
        yield* catalogOfIdentity(nested, target, "trait composition");
        if (isBlank(nested.name)) return yield* invalid("blank trait name");
        composed.add(nested.name);
      }
      traitTraitEdges.set(trait.id.name, composed);
    }

    for (const field of descriptor.fields) {
      yield* catalogOfIdentity(field.id, target, "field");
      if (isBlank(field.id.localName)) return yield* invalid("blank field local name");
      if (isBlank(field.id.owner.name)) return yield* invalid("blank field owner name");
      const key = fieldKey(field.id);
      if (fields.has(key)) return yield* invalid(`ambiguous field '${key}'`);
      const owner = field.id.owner;
      if (owner.kind === "entity") {
        if (!entities.has(owner.name)) {
          return yield* invalid(
            `missing owner entity '${owner.name}' for field '${field.id.localName}'`,
          );
        }
      } else if (!traits.has(owner.name)) {
        return yield* invalid(
          `missing owner trait '${owner.name}' for field '${field.id.localName}'`,
        );
      }
      if (field.valueType === "ref") {
        yield* validateFieldRefTarget(field.refTarget, target, entities, traits);
      }
      fields.set(key, field);
    }

    for (const operation of descriptor.operations) {
      yield* catalogOfIdentity(operation.id, target, "operation");
      if (isBlank(operation.id.localName)) return yield* invalid("blank operation local name");
      if (isBlank(operation.id.owner.name)) return yield* invalid("blank operation owner name");
      const key = operationKey(operation.id);
      if (operations.has(key)) return yield* invalid(`ambiguous operation '${key}'`);
      const owner = operation.id.owner;
      if (owner.kind === "entity") {
        if (!entities.has(owner.name)) {
          return yield* invalid(`missing operation owner entity '${owner.name}'`);
        }
      } else if (!traits.has(owner.name)) {
        return yield* invalid(`missing operation owner trait '${owner.name}'`);
      }
      if (operation.doc !== undefined && isBlank(operation.doc)) {
        return yield* invalid(`blank operation doc for '${owner.name}.${operation.id.localName}'`);
      }
      yield* validateInputShapeKeys(operation.input);
      yield* validateInputShapeKeys(operation.output);
      yield* Result.all([
        validateOperationShape(
          operation.input,
          target,
          entities,
          traits,
          operation.id.target === "required",
          `${owner.name}.${operation.id.localName}`,
        ),
        validateOperationShape(
          operation.output,
          target,
          entities,
          traits,
          operation.id.target === "required",
          `${owner.name}.${operation.id.localName}`,
        ),
      ]);
      const declaredComposers = new Set<string>();
      for (const composer of operation.composers) {
        yield* catalogOfIdentity(composer, target, "operation composer");
        if (!entities.has(composer.name)) {
          return yield* invalid(`missing operation composer entity '${composer.name}'`);
        }
        if (declaredComposers.has(composer.name)) {
          return yield* invalid(`duplicate operation composer '${composer.name}'`);
        }
        declaredComposers.add(composer.name);
      }
      if (
        operation.id.target === "none" ||
        operation.id.owner.kind === "entity"
      ) {
        if (operation.composers.length !== 0) {
          return yield* invalid(
            `operation '${owner.name}.${operation.id.localName}' cannot declare composers`,
          );
        }
      }
      operations.set(key, operation);
    }

    const traitTraits = yield* closeTraits(traitTraitEdges);
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

    for (const operation of operations.values()) {
      if (operation.id.owner.kind !== "trait") continue;
      const ownerName = operation.id.owner.name;
      const expected = [...entityTraits]
        .filter(([, composed]) => composed.has(ownerName))
        .map(([entityName]) => entityName)
        .sort();
      if (expected.length === 0) {
        return yield* invalid(
          `unreachable trait operation owner '${ownerName}' for '${operation.id.localName}'`,
        );
      }
      if (operation.id.target === "none") continue;
      const declared = operation.composers.map((composer) => composer.name).sort();
      if (
        declared.length !== expected.length ||
        expected.some((name, index) => declared[index] !== name)
      ) {
        return yield* invalid(
          `contradictory operation composers for '${ownerName}.${operation.id.localName}'`,
        );
      }
    }

    const seenComposition = new Set<string>();
    for (const row of descriptor.traitComposition) {
      yield* catalogOfIdentity(row.composer, target, "trait-composition composer");
      yield* catalogOfIdentity(row.trait, target, "trait-composition trait");
      if (!entities.has(row.composer.name)) {
        return yield* invalid(`missing composer entity '${row.composer.name}'`);
      }
      if (!traits.has(row.trait.name)) {
        return yield* invalid(`missing composed trait '${row.trait.name}'`);
      }
      const compositionKey = `${row.composer.name}${SEPARATOR}${row.trait.name}`;
      if (seenComposition.has(compositionKey)) {
        return yield* invalid(
          `duplicate trait composition '${row.composer.name}'/'${row.trait.name}'`,
        );
      }
      seenComposition.add(compositionKey);
      const computed = entityTraits.get(row.composer.name);
      if (computed === undefined || !computed.has(row.trait.name)) {
        return yield* invalid(
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
        yield* catalogOfIdentity(transitive, target, "trait-composition transitive");
        if (!traits.has(transitive.name)) {
          return yield* invalid(`missing transitive trait '${transitive.name}'`);
        }
        if (declared.has(transitive.name)) {
          return yield* invalid(`duplicate transitive trait '${transitive.name}'`);
        }
        declared.add(transitive.name);
      }
      if (expected.size !== declared.size) {
        return yield* invalid(
          `contradictory trait composition for '${row.composer.name}'/'${row.trait.name}'`,
        );
      }
      for (const name of expected) {
        if (!declared.has(name)) {
          return yield* invalid(
            `contradictory trait composition for '${row.composer.name}'/'${row.trait.name}'`,
          );
        }
      }
    }

    for (const [entityName, direct] of entityTraitEdges) {
      for (const traitName of direct) {
        if (!seenComposition.has(`${entityName}${SEPARATOR}${traitName}`)) {
          return yield* invalid(`missing trait composition for '${entityName}'/'${traitName}'`);
        }
      }
    }

    return {
      target,
      entities,
      traits,
      fields,
      entityTraits,
      traitTraits,
    };
  });

export const requireEntity = (
  index: PreparedAuthorizationCatalog,
  id: EntityId,
  label: string,
): Result.Result<EntityId, ValidateFailure> =>
  Result.gen(function* () {
    yield* catalogOfIdentity(id, index.target, label);
    const found = index.entities.get(id.name);
    if (found === undefined) return yield* invalid(`stale identity: missing ${label} '${id.name}'`);
    return found;
  });

export const requireTrait = (
  index: PreparedAuthorizationCatalog,
  id: TraitId,
  label: string,
): Result.Result<TraitId, ValidateFailure> =>
  Result.gen(function* () {
    yield* catalogOfIdentity(id, index.target, label);
    const found = index.traits.get(id.name);
    if (found === undefined) return yield* invalid(`stale identity: missing ${label} '${id.name}'`);
    return found;
  });

export const requireField = (
  index: PreparedAuthorizationCatalog,
  id: FieldId,
  label: string,
): Result.Result<FieldDescriptor, ValidateFailure> =>
  Result.gen(function* () {
    yield* catalogOfIdentity(id, index.target, label);
    const found = index.fields.get(fieldKey(id));
    if (found === undefined) {
      return yield* invalid(
        `stale identity: missing ${label} '${id.owner.kind}:${id.owner.name}.${id.localName}'`,
      );
    }
    return found;
  });

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
