/**
 * Normalize installed identity, composition, operation, rule, decision,
 * and access-plan tables. Order is deterministic and independent of
 * catalog or object-key iteration. Duplicates and conflicting descriptors
 * fail closed.
 */

import * as Result from "effect/Result";
import type {
  CatalogDescriptor,
  OperationDescriptor,
  RuleAccessPlan,
  TraitComposition,
} from "../catalog.ts";
import type { EntityId, FieldId, OperationId, RuleId, TraitId } from "../identities.ts";
import type {
  CanonicalAuthorizationDecisions,
  CanonicalAuthorizationRule,
  Decision,
  InstalledIdentityTable,
} from "../ir.ts";
import type { PreparedAuthorizationCatalog } from "../validation/catalog.ts";
import {
  entityKey,
  fieldKey,
  invalid,
  operationKey,
  traitKey,
  type ValidateFailure,
} from "../validation/common.ts";
import { validateDecisions } from "../validation/decisions.ts";

export type AssembleFailure = ValidateFailure;

const sameEntity = (left: EntityId, right: EntityId): boolean =>
  left.catalog === right.catalog && left.name === right.name;

const sameTrait = (left: TraitId, right: TraitId): boolean =>
  left.catalog === right.catalog && left.name === right.name;

const sameField = (left: FieldId, right: FieldId): boolean =>
  left.catalog === right.catalog &&
  left.owner.kind === right.owner.kind &&
  left.owner.name === right.owner.name &&
  left.localName === right.localName;

const sameOperation = (left: OperationId, right: OperationId): boolean =>
  left.catalog === right.catalog &&
  left.owner.kind === right.owner.kind &&
  left.owner.name === right.owner.name &&
  left.localName === right.localName &&
  left.target === right.target;

const sorted = <T>(values: Iterable<T>, key: (value: T) => string): T[] =>
  [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });

const sortedIds = (ids: ReadonlyArray<RuleId>): RuleId[] =>
  [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const sortDecision = (decision: Decision): Decision => ({
  allow: sortedIds(decision.allow),
  deny: sortedIds(decision.deny),
});

const collectFromFocus = (
  rule: CanonicalAuthorizationRule,
  entities: Map<string, EntityId>,
  traits: Map<string, TraitId>,
  fields: Map<string, FieldId>,
  operations: Map<string, OperationId>,
): Result.Result<void, AssembleFailure> => {
  switch (rule.focus._tag) {
    case "entity":
      return internAllowDuplicate(
        entities,
        entityKey(rule.focus.entity),
        rule.focus.entity,
        sameEntity,
        "conflicting installed entity identity",
      );
    case "trait":
      return internAllowDuplicate(
        traits,
        traitKey(rule.focus.trait),
        rule.focus.trait,
        sameTrait,
        "conflicting installed trait identity",
      );
    case "field":
      return internAllowDuplicate(
        fields,
        fieldKey(rule.focus.field),
        rule.focus.field,
        sameField,
        "conflicting installed field identity",
      );
    case "operation":
      return internAllowDuplicate(
        operations,
        operationKey(rule.focus.operation),
        rule.focus.operation,
        sameOperation,
        "conflicting installed operation identity",
      );
  }
};

const internAllowDuplicate = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  same: (left: V, right: V) => boolean,
  conflict: string,
): Result.Result<void, AssembleFailure> => {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
    return Result.succeed(undefined);
  }
  if (!same(existing, value)) return invalid(conflict);
  return Result.succeed(undefined);
};

const collectOwner = (
  index: PreparedAuthorizationCatalog,
  owner: FieldId["owner"],
  entities: Map<string, EntityId>,
  traits: Map<string, TraitId>,
): Result.Result<void, AssembleFailure> => {
  if (owner.kind === "entity") {
    const entity = index.entities.get(owner.name);
    if (entity === undefined) return invalid(`missing owner entity '${owner.name}'`);
    return internAllowDuplicate(
      entities,
      entityKey(entity),
      entity,
      sameEntity,
      "conflicting installed entity identity",
    );
  }
  const trait = index.traits.get(owner.name);
  if (trait === undefined) return invalid(`missing owner trait '${owner.name}'`);
  return internAllowDuplicate(
    traits,
    traitKey(trait),
    trait,
    sameTrait,
    "conflicting installed trait identity",
  );
};

const collectPlanIdentities = (
  index: PreparedAuthorizationCatalog,
  plans: ReadonlyArray<RuleAccessPlan>,
  entities: Map<string, EntityId>,
  fields: Map<string, FieldId>,
  traits: Map<string, TraitId>,
): Result.Result<void, AssembleFailure> => {
  for (const plan of plans) {
    for (const lookup of plan.lookups) {
      switch (lookup._tag) {
        case "entity":
        case "exists": {
          const added = internAllowDuplicate(
            entities,
            entityKey(lookup.entity),
            lookup.entity,
            sameEntity,
            "conflicting installed entity identity",
          );
          if (Result.isFailure(added)) return Result.fail(added.failure);
          if (lookup._tag === "exists") {
            for (const field of lookup.fields) {
              const fieldOk = internAllowDuplicate(
                fields,
                fieldKey(field),
                field,
                sameField,
                "conflicting installed field identity",
              );
              if (Result.isFailure(fieldOk)) return Result.fail(fieldOk.failure);
              const ownerOk = collectOwner(index, field.owner, entities, traits);
              if (Result.isFailure(ownerOk)) return Result.fail(ownerOk.failure);
            }
          }
          break;
        }
        case "field":
        case "index": {
          const fieldOk = internAllowDuplicate(
            fields,
            fieldKey(lookup.field),
            lookup.field,
            sameField,
            "conflicting installed field identity",
          );
          if (Result.isFailure(fieldOk)) return Result.fail(fieldOk.failure);
          const ownerOk = collectOwner(index, lookup.field.owner, entities, traits);
          if (Result.isFailure(ownerOk)) return Result.fail(ownerOk.failure);
          break;
        }
      }
    }
  }
  return Result.succeed(undefined);
};

const collectDecisionTargets = (
  decisions: CanonicalAuthorizationDecisions,
  entities: Map<string, EntityId>,
  traits: Map<string, TraitId>,
  fields: Map<string, FieldId>,
  operations: Map<string, OperationId>,
): Result.Result<void, AssembleFailure> => {
  for (const entry of decisions.entities) {
    const added = internAllowDuplicate(
      entities,
      entityKey(entry.target),
      entry.target,
      sameEntity,
      "conflicting installed entity identity",
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
  }
  for (const entry of decisions.traits) {
    const added = internAllowDuplicate(
      traits,
      traitKey(entry.target),
      entry.target,
      sameTrait,
      "conflicting installed trait identity",
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
  }
  for (const entry of decisions.fields) {
    const added = internAllowDuplicate(
      fields,
      fieldKey(entry.target),
      entry.target,
      sameField,
      "conflicting installed field identity",
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
  }
  for (const entry of decisions.operations) {
    const added = internAllowDuplicate(
      operations,
      operationKey(entry.target),
      entry.target,
      sameOperation,
      "conflicting installed operation identity",
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
  }
  return Result.succeed(undefined);
};

const collectPrincipal = (
  index: PreparedAuthorizationCatalog,
  field: FieldId | undefined,
  entities: Map<string, EntityId>,
  fields: Map<string, FieldId>,
  traits: Map<string, TraitId>,
): Result.Result<void, AssembleFailure> => {
  if (field === undefined) return Result.succeed(undefined);
  const added = internAllowDuplicate(
    fields,
    fieldKey(field),
    field,
    sameField,
    "conflicting installed field identity",
  );
  if (Result.isFailure(added)) return Result.fail(added.failure);
  return collectOwner(index, field.owner, entities, traits);
};

const compositionRows = (
  index: PreparedAuthorizationCatalog,
  descriptor: CatalogDescriptor,
  entities: Map<string, EntityId>,
  traits: Map<string, TraitId>,
): Result.Result<ReadonlyArray<TraitComposition>, AssembleFailure> => {
  const rows: TraitComposition[] = [];
  const seen = new Set<string>();
  for (const row of descriptor.traitComposition) {
    if (!entities.has(entityKey(row.composer)) && !traits.has(traitKey(row.trait))) {
      continue;
    }
    const composer = index.entities.get(row.composer.name);
    const trait = index.traits.get(row.trait.name);
    if (composer === undefined) return invalid(`missing composer entity '${row.composer.name}'`);
    if (trait === undefined) return invalid(`missing composed trait '${row.trait.name}'`);
    const composerOk = internAllowDuplicate(
      entities,
      entityKey(composer),
      composer,
      sameEntity,
      "conflicting installed entity identity",
    );
    if (Result.isFailure(composerOk)) return Result.fail(composerOk.failure);
    const key = `${entityKey(composer)}\0${traitKey(trait)}`;
    if (seen.has(key)) {
      return invalid(`duplicate trait-composition identity: ${row.composer.name}/${row.trait.name}`);
    }
    seen.add(key);
    const computed = index.entityTraits.get(composer.name);
    if (computed === undefined || !computed.has(trait.name)) {
      return invalid(`incomplete composition closure for '${composer.name}'/'${trait.name}'`);
    }
    const transitive: TraitId[] = [];
    const expected = new Set<string>([trait.name]);
    const nested = index.traitTraits.get(trait.name);
    if (nested !== undefined) {
      for (const name of nested) expected.add(name);
    }
    for (const name of expected) {
      const id = index.traits.get(name);
      if (id === undefined) return invalid(`missing transitive trait '${name}'`);
      transitive.push(id);
      const traitOk = internAllowDuplicate(
        traits,
        traitKey(id),
        id,
        sameTrait,
        "conflicting installed trait identity",
      );
      if (Result.isFailure(traitOk)) return Result.fail(traitOk.failure);
    }
    rows.push({
      composer,
      trait,
      transitive: sorted(transitive, traitKey),
    });
  }

  for (const [entityName, direct] of index.entityTraits) {
    const entity = index.entities.get(entityName);
    if (entity === undefined || !entities.has(entityKey(entity))) continue;
    for (const traitName of direct) {
      const trait = index.traits.get(traitName);
      if (trait === undefined) return invalid(`missing composed trait '${traitName}'`);
      if (!seen.has(`${entityKey(entity)}\0${traitKey(trait)}`)) {
        return invalid(`incomplete composition closure for '${entityName}'/'${traitName}'`);
      }
    }
  }
  return Result.succeed(sorted(rows, (row) => `${entityKey(row.composer)}\0${traitKey(row.trait)}`));
};

const operationDescriptors = (
  index: PreparedAuthorizationCatalog,
  operations: ReadonlyMap<string, OperationId>,
): Result.Result<ReadonlyArray<OperationDescriptor>, AssembleFailure> => {
  const rows: OperationDescriptor[] = [];
  const seen = new Set<string>();
  for (const id of operations.values()) {
    const key = operationKey(id);
    const descriptor = index.operations.get(key);
    if (descriptor === undefined) {
      return invalid(
        `missing operation descriptor '${id.owner.kind}:${id.owner.name}.${id.localName}:${id.target}'`,
      );
    }
    if (seen.has(key)) return invalid(`duplicate operation identity: ${key}`);
    seen.add(key);
    if (!sameOperation(descriptor.id, id)) {
      return invalid("conflicting installed operation identity");
    }
    rows.push(descriptor);
  }
  return Result.succeed(sorted(rows, (row) => operationKey(row.id)));
};

const normalizeRules = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): Result.Result<ReadonlyArray<CanonicalAuthorizationRule>, AssembleFailure> => {
  const seen = new Set<RuleId>();
  for (const rule of rules) {
    if (seen.has(rule.id)) return invalid(`duplicate rule identity: ${rule.id}`);
    seen.add(rule.id);
    if (rule.dependencies.length > 0) return invalid("named-rule dependencies must be empty");
  }
  return Result.succeed(
    sorted(rules, (rule) => rule.id).map((rule) => ({
      ...rule,
      dependencies: sortedIds(rule.dependencies),
    })),
  );
};

const normalizeDecisions = (
  index: PreparedAuthorizationCatalog,
  decisions: CanonicalAuthorizationDecisions,
  rules: ReadonlyMap<RuleId, CanonicalAuthorizationRule>,
): Result.Result<CanonicalAuthorizationDecisions, AssembleFailure> => {
  const ok = validateDecisions(index, decisions, rules);
  if (Result.isFailure(ok)) return Result.fail(ok.failure);
  return Result.succeed({
    entities: sorted(decisions.entities, (entry) => entityKey(entry.target)).map((entry) => ({
      target: entry.target,
      decision: sortDecision(entry.decision),
    })),
    traits: sorted(decisions.traits, (entry) => traitKey(entry.target)).map((entry) => ({
      target: entry.target,
      decision: sortDecision(entry.decision),
    })),
    fields: sorted(decisions.fields, (entry) => fieldKey(entry.target)).map((entry) => ({
      target: entry.target,
      decision: sortDecision(entry.decision),
    })),
    operations: sorted(decisions.operations, (entry) => operationKey(entry.target)).map((entry) => ({
      target: entry.target,
      decision: sortDecision(entry.decision),
    })),
  });
};

const normalizePlans = (
  plans: ReadonlyArray<RuleAccessPlan>,
  rules: ReadonlySet<RuleId>,
): Result.Result<ReadonlyArray<RuleAccessPlan>, AssembleFailure> => {
  const seen = new Set<RuleId>();
  for (const plan of plans) {
    if (!rules.has(plan.rule)) {
      return invalid(`access plan for unknown rule '${plan.rule}'`);
    }
    if (seen.has(plan.rule)) return invalid(`duplicate access-plan identity: ${plan.rule}`);
    seen.add(plan.rule);
  }
  for (const id of rules) {
    if (!seen.has(id)) return invalid(`missing access plan for rule '${id}'`);
  }
  return Result.succeed(sorted(plans, (plan) => plan.rule));
};

export type NormalizedInstalledTables = {
  readonly identities: InstalledIdentityTable;
  readonly traitComposition: ReadonlyArray<TraitComposition>;
  readonly operations: ReadonlyArray<OperationDescriptor>;
  readonly rules: ReadonlyArray<CanonicalAuthorizationRule>;
  readonly decisions: CanonicalAuthorizationDecisions;
  readonly accessPlans: ReadonlyArray<RuleAccessPlan>;
};

export const normalizeInstalledTables = (
  index: PreparedAuthorizationCatalog,
  descriptor: CatalogDescriptor,
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
  decisions: CanonicalAuthorizationDecisions,
  plans: ReadonlyArray<RuleAccessPlan>,
  principalField: FieldId | undefined,
): Result.Result<NormalizedInstalledTables, AssembleFailure> => {
  const entities = new Map<string, EntityId>();
  const traits = new Map<string, TraitId>();
  const fields = new Map<string, FieldId>();
  const operations = new Map<string, OperationId>();

  const normalizedRules = normalizeRules(rules);
  if (Result.isFailure(normalizedRules)) return Result.fail(normalizedRules.failure);
  const byId = new Map<RuleId, CanonicalAuthorizationRule>();
  for (const rule of normalizedRules.success) {
    byId.set(rule.id, rule);
    const focusOk = collectFromFocus(rule, entities, traits, fields, operations);
    if (Result.isFailure(focusOk)) return Result.fail(focusOk.failure);
  }

  const normalizedDecisions = normalizeDecisions(index, decisions, byId);
  if (Result.isFailure(normalizedDecisions)) return Result.fail(normalizedDecisions.failure);
  const decisionOk = collectDecisionTargets(
    normalizedDecisions.success,
    entities,
    traits,
    fields,
    operations,
  );
  if (Result.isFailure(decisionOk)) return Result.fail(decisionOk.failure);

  const principalOk = collectPrincipal(index, principalField, entities, fields, traits);
  if (Result.isFailure(principalOk)) return Result.fail(principalOk.failure);

  const planIds = new Set(normalizedRules.success.map((rule) => rule.id));
  const normalizedPlans = normalizePlans(plans, planIds);
  if (Result.isFailure(normalizedPlans)) return Result.fail(normalizedPlans.failure);
  const planOk = collectPlanIdentities(index, normalizedPlans.success, entities, fields, traits);
  if (Result.isFailure(planOk)) return Result.fail(planOk.failure);

  const composition = compositionRows(index, descriptor, entities, traits);
  if (Result.isFailure(composition)) return Result.fail(composition.failure);

  const descriptors = operationDescriptors(index, operations);
  if (Result.isFailure(descriptors)) return Result.fail(descriptors.failure);

  for (const field of fields.values()) {
    const ownerOk = collectOwner(index, field.owner, entities, traits);
    if (Result.isFailure(ownerOk)) return Result.fail(ownerOk.failure);
  }
  for (const operation of operations.values()) {
    const ownerOk = collectOwner(index, operation.owner, entities, traits);
    if (Result.isFailure(ownerOk)) return Result.fail(ownerOk.failure);
  }

  return Result.succeed({
    identities: {
      entities: sorted(entities.values(), entityKey),
      traits: sorted(traits.values(), traitKey),
      fields: sorted(fields.values(), fieldKey),
      operations: sorted(operations.values(), operationKey),
    },
    traitComposition: composition.success,
    operations: descriptors.success,
    rules: normalizedRules.success,
    decisions: normalizedDecisions.success,
    accessPlans: normalizedPlans.success,
  });
};
