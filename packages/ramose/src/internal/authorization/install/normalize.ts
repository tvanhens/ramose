/**
 * Pure normalization of authoritative installed v1 tables.
 *
 * Deterministically orders identities, composition, rules, decisions,
 * and access-plan lookups. Rejects duplicates, contradictory
 * composition, conflicting decisions, and missing plans. No Effect.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { compareCanonicalKeys, canonicalizeJson } from "../canonical-json.ts";
import {
  OperationDescriptor,
  TraitComposition,
  type CatalogDescriptor,
  type RuleAccessPlan,
} from "../catalog.ts";
import type {
  EntityId,
  FieldId,
  RuleId,
  TraitId,
} from "../identities.ts";
import { CanonicalIdentitySchemas, OperationId } from "../identities.ts";
import type {
  CanonicalAuthorizationDecisions,
  CanonicalAuthorizationRule,
  Decision,
  InstalledIdentityTable,
  ValidatedAuthorizationIR,
} from "../ir.ts";
import type { JsonValue } from "../json.ts";
import type { ClaimDescriptor } from "../principal.ts";
import { invalid, type ValidateFailure } from "../validation/common.ts";

const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const canonicalKey = (value: unknown): Result.Result<string, ValidateFailure> => {
  try {
    return Result.succeed(canonicalizeJson(encodedJson(value)));
  } catch (cause) {
    return invalid(
      `ambiguous installed identity: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const compareCanonical = (left: string, right: string): number => compareCanonicalKeys(left, right);

const sortByCanonical = <T>(
  items: ReadonlyArray<T>,
  encode: (item: T) => unknown,
): Result.Result<ReadonlyArray<T>, ValidateFailure> => {
  const keyed: Array<{ readonly key: string; readonly item: T }> = [];
  for (const item of items) {
    const key = canonicalKey(encode(item));
    if (Result.isFailure(key)) return Result.fail(key.failure);
    keyed.push({ key: key.success, item });
  }
  keyed.sort((left, right) => compareCanonical(left.key, right.key));
  return Result.succeed(keyed.map((entry) => entry.item));
};

const uniqueSorted = <T>(
  items: ReadonlyArray<T>,
  encode: (item: T) => unknown,
  label: string,
): Result.Result<ReadonlyArray<T>, ValidateFailure> => {
  const sorted = sortByCanonical(items, encode);
  if (Result.isFailure(sorted)) return Result.fail(sorted.failure);
  const seen = new Set<string>();
  for (const item of sorted.success) {
    const key = canonicalKey(encode(item));
    if (Result.isFailure(key)) return Result.fail(key.failure);
    if (seen.has(key.success)) return invalid(`duplicate ${label}`);
    seen.add(key.success);
  }
  return sorted;
};

const encodeEntity = (id: EntityId): unknown =>
  Schema.encodeUnknownSync(CanonicalIdentitySchemas.entity)(id);
const encodeTrait = (id: TraitId): unknown =>
  Schema.encodeUnknownSync(CanonicalIdentitySchemas.trait)(id);
const encodeField = (id: FieldId): unknown =>
  Schema.encodeUnknownSync(CanonicalIdentitySchemas.field)(id);
const encodeOperationId = (id: OperationId): unknown =>
  Schema.encodeUnknownSync(OperationId)(id);
const encodeOperation = (operation: CatalogDescriptor["operations"][number]): unknown =>
  Schema.encodeUnknownSync(OperationDescriptor)(operation);
const encodeComposition = (row: TraitComposition): unknown =>
  Schema.encodeUnknownSync(TraitComposition)(row);

const sortRuleIds = (ids: ReadonlyArray<RuleId>): ReadonlyArray<RuleId> =>
  [...ids].sort((left, right) => compareCanonical(left, right));

const normalizeDecision = (decision: Decision): Decision => ({
  allow: sortRuleIds(decision.allow),
  deny: sortRuleIds(decision.deny),
});

const normalizeDecisionEntries = <Target>(
  entries: ReadonlyArray<{ readonly target: Target; readonly decision: Decision }>,
  encodeTarget: (target: Target) => unknown,
  label: string,
): Result.Result<ReadonlyArray<{ readonly target: Target; readonly decision: Decision }>, ValidateFailure> => {
  const normalized = entries.map((entry) => ({
    target: entry.target,
    decision: normalizeDecision(entry.decision),
  }));
  return uniqueSorted(normalized, (entry) => encodeTarget(entry.target), label);
};

export const normalizeClasses = (
  classes: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<string>, ValidateFailure> =>
  uniqueSorted(classes, (name) => name, "class");

export const normalizeClaims = (
  claims: ReadonlyArray<ClaimDescriptor>,
): Result.Result<ReadonlyArray<ClaimDescriptor>, ValidateFailure> =>
  uniqueSorted(claims, (claim) => claim.key, "claim");

export const normalizeIdentities = (
  descriptor: CatalogDescriptor,
): Result.Result<InstalledIdentityTable, ValidateFailure> => {
  const entities = uniqueSorted(
    descriptor.entities.map((entity) => entity.id),
    encodeEntity,
    "entity identity",
  );
  if (Result.isFailure(entities)) return Result.fail(entities.failure);
  const traits = uniqueSorted(
    descriptor.traits.map((trait) => trait.id),
    encodeTrait,
    "trait identity",
  );
  if (Result.isFailure(traits)) return Result.fail(traits.failure);
  const fields = uniqueSorted(
    descriptor.fields.map((field) => field.id),
    encodeField,
    "field identity",
  );
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const operations = uniqueSorted(
    descriptor.operations.map((operation) => operation.id),
    encodeOperationId,
    "operation identity",
  );
  if (Result.isFailure(operations)) return Result.fail(operations.failure);
  return Result.succeed({
    entities: entities.success,
    traits: traits.success,
    fields: fields.success,
    operations: operations.success,
  });
};

export const normalizeTraitComposition = (
  rows: ReadonlyArray<TraitComposition>,
): Result.Result<ReadonlyArray<TraitComposition>, ValidateFailure> => {
  const closed: TraitComposition[] = [];
  for (const row of rows) {
    const transitive = uniqueSorted(row.transitive, encodeTrait, "transitive trait");
    if (Result.isFailure(transitive)) return Result.fail(transitive.failure);
    closed.push({
      composer: row.composer,
      trait: row.trait,
      transitive: transitive.success,
    });
  }
  const sorted = uniqueSorted(
    closed,
    (row) => ({ composer: encodeEntity(row.composer), trait: encodeTrait(row.trait) }),
    "trait-composition identity",
  );
  if (Result.isFailure(sorted)) return Result.fail(sorted.failure);
  const encoded = uniqueSorted(sorted.success, encodeComposition, "trait-composition row");
  if (Result.isFailure(encoded)) return Result.fail(encoded.failure);
  return encoded;
};

export const normalizeOperations = (
  operations: CatalogDescriptor["operations"],
): Result.Result<ReadonlyArray<CatalogDescriptor["operations"][number]>, ValidateFailure> =>
  uniqueSorted(operations, encodeOperation, "operation identity");

export const normalizeRules = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): Result.Result<ReadonlyArray<CanonicalAuthorizationRule>, ValidateFailure> =>
  uniqueSorted(rules, (rule) => rule.id, "rule identity");

export const normalizeDecisions = (
  decisions: CanonicalAuthorizationDecisions,
): Result.Result<CanonicalAuthorizationDecisions, ValidateFailure> => {
  const entities = normalizeDecisionEntries(
    decisions.entities,
    encodeEntity,
    "entity decision target",
  );
  if (Result.isFailure(entities)) return Result.fail(entities.failure);
  const traits = normalizeDecisionEntries(decisions.traits, encodeTrait, "trait decision target");
  if (Result.isFailure(traits)) return Result.fail(traits.failure);
  const fields = normalizeDecisionEntries(decisions.fields, encodeField, "field decision target");
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  return Result.succeed({
    entities: entities.success,
    traits: traits.success,
    fields: fields.success,
  });
};

export const normalizeAccessPlans = (
  plans: ReadonlyArray<RuleAccessPlan>,
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): Result.Result<ReadonlyArray<RuleAccessPlan>, ValidateFailure> => {
  const sorted = uniqueSorted(plans, (plan) => plan.rule, "access-plan identity");
  if (Result.isFailure(sorted)) return Result.fail(sorted.failure);
  if (sorted.success.length !== rules.length) {
    return invalid("missing access plan");
  }
  const expected = new Set(rules.map((rule) => rule.id));
  for (const plan of sorted.success) {
    if (!expected.has(plan.rule)) return invalid(`conflicting access plan for '${plan.rule}'`);
    expected.delete(plan.rule);
  }
  if (expected.size !== 0) return invalid("missing access plan");
  return sorted;
};

export const normalizeValidatedTables = (
  validated: ValidatedAuthorizationIR,
  descriptor: CatalogDescriptor,
  plans: ReadonlyArray<RuleAccessPlan>,
) => {
  const classes = normalizeClasses(validated.classes);
  if (Result.isFailure(classes)) return Result.fail(classes.failure);
  const claims = normalizeClaims(validated.claims);
  if (Result.isFailure(claims)) return Result.fail(claims.failure);
  const identities = normalizeIdentities(descriptor);
  if (Result.isFailure(identities)) return Result.fail(identities.failure);
  const traitComposition = normalizeTraitComposition(descriptor.traitComposition);
  if (Result.isFailure(traitComposition)) return Result.fail(traitComposition.failure);
  const operations = normalizeOperations(descriptor.operations);
  if (Result.isFailure(operations)) return Result.fail(operations.failure);
  const rules = normalizeRules(validated.rules);
  if (Result.isFailure(rules)) return Result.fail(rules.failure);
  const decisions = normalizeDecisions(validated.decisions);
  if (Result.isFailure(decisions)) return Result.fail(decisions.failure);
  const accessPlans = normalizeAccessPlans(plans, rules.success);
  if (Result.isFailure(accessPlans)) return Result.fail(accessPlans.failure);
  return Result.succeed({
    classes: classes.success,
    claims: claims.success,
    identities: identities.success,
    traitComposition: traitComposition.success,
    operations: operations.success,
    rules: rules.success,
    decisions: decisions.success,
    accessPlans: accessPlans.success,
  });
};
