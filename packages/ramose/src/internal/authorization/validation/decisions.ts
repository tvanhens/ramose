/**
 * Decision target uniqueness and rule-focus compatibility.
 */

import * as Result from "effect/Result";
import type { FieldDescriptor, OperationDescriptor } from "../catalog.ts";
import type { EntityId, RuleId, TraitId } from "../identities.ts";
import type {
  CanonicalAuthorizationDecisions,
  CanonicalAuthorizationRule,
  Decision,
} from "../ir.ts";
import {
  entityComposes,
  ownerHasTrait,
  requireEntity,
  requireField,
  requireOperation,
  requireTargetlessTraitReachable,
  requireTrait,
  traitComposes,
  type PreparedAuthorizationCatalog,
} from "./catalog.ts";
import { entityKey, fieldKey, invalid, operationKey, traitKey, type ValidateFailure } from "./common.ts";

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
  index: PreparedAuthorizationCatalog,
  field: FieldDescriptor,
  entity: EntityId,
): boolean => {
  if (field.id.owner.kind === "entity") return field.id.owner.name === entity.name;
  return entityComposes(index, entity, field.id.owner.name);
};

const fieldOwnerMatchesTrait = (
  index: PreparedAuthorizationCatalog,
  field: FieldDescriptor,
  trait: TraitId,
): boolean => {
  if (field.id.owner.kind === "trait") return traitComposes(index, trait, field.id.owner.name);
  return false;
};

const ruleFitsEntity = (
  index: PreparedAuthorizationCatalog,
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
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  target: TraitId,
): boolean => {
  if (rule.focus._tag !== "trait") return false;
  return traitComposes(index, target, rule.focus.trait.name);
};

const ruleFitsField = (
  index: PreparedAuthorizationCatalog,
  rule: CanonicalAuthorizationRule,
  field: FieldDescriptor,
): boolean => {
  if (rule.focus._tag === "field") return fieldKey(rule.focus.field) === fieldKey(field.id);
  if (rule.focus._tag === "entity") return fieldOwnerMatchesEntity(index, field, rule.focus.entity);
  if (rule.focus._tag === "trait") return fieldOwnerMatchesTrait(index, field, rule.focus.trait);
  return false;
};

const ruleFitsOperation = (
  index: PreparedAuthorizationCatalog,
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
  index: PreparedAuthorizationCatalog,
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

export const validateDecisions = (
  index: PreparedAuthorizationCatalog,
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
