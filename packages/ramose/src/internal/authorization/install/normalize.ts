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
  type OperationInputShape,
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
): Result.Result<ReadonlyArray<T>, ValidateFailure> =>
  Result.gen(function* () {
    const keyed: Array<{ readonly key: string; readonly item: T }> = [];
    for (const item of items) {
      const key = yield* canonicalKey(encode(item));
      keyed.push({ key, item });
    }
    keyed.sort((left, right) => compareCanonical(left.key, right.key));
    return keyed.map((entry) => entry.item);
  });

const uniqueSorted = <T>(
  items: ReadonlyArray<T>,
  encode: (item: T) => unknown,
  label: string,
): Result.Result<ReadonlyArray<T>, ValidateFailure> =>
  Result.gen(function* () {
    const sorted = yield* sortByCanonical(items, encode);
    const seen = new Set<string>();
    for (const item of sorted) {
      const key = yield* canonicalKey(encode(item));
      if (seen.has(key)) return yield* invalid(`duplicate ${label}`);
      seen.add(key);
    }
    return sorted;
  });

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
): Result.Result<InstalledIdentityTable, ValidateFailure> =>
  Result.gen(function* () {
    const entities = yield* uniqueSorted(
      descriptor.entities.map((entity) => entity.id),
      encodeEntity,
      "entity identity",
    );
    const traits = yield* uniqueSorted(
      descriptor.traits.map((trait) => trait.id),
      encodeTrait,
      "trait identity",
    );
    const fields = yield* uniqueSorted(
      descriptor.fields.map((field) => field.id),
      encodeField,
      "field identity",
    );
    const operations = yield* uniqueSorted(
      descriptor.operations.map((operation) => operation.id),
      encodeOperationId,
      "operation identity",
    );
    return { entities, traits, fields, operations };
  });

export const normalizeTraitComposition = (
  rows: ReadonlyArray<TraitComposition>,
): Result.Result<ReadonlyArray<TraitComposition>, ValidateFailure> =>
  Result.gen(function* () {
    const closed: TraitComposition[] = [];
    for (const row of rows) {
      const transitive = yield* uniqueSorted(row.transitive, encodeTrait, "transitive trait");
      closed.push({
        composer: row.composer,
        trait: row.trait,
        transitive,
      });
    }
    const sorted = yield* uniqueSorted(
      closed,
      (row) => ({ composer: encodeEntity(row.composer), trait: encodeTrait(row.trait) }),
      "trait-composition identity",
    );
    return yield* uniqueSorted(sorted, encodeComposition, "trait-composition row");
  });

const canonicalizeInputShape = (shape: OperationInputShape): OperationInputShape => {
  switch (shape._tag) {
    case "scalar":
    case "ref":
    case "opaque":
      return shape;
    case "array":
      return { _tag: "array", items: canonicalizeInputShape(shape.items) };
    case "struct":
      return {
        _tag: "struct",
        fields: [...shape.fields]
          .sort((left, right) => compareCanonicalKeys(left.key, right.key))
          .map((field) => ({
            key: field.key,
            optional: field.optional,
            shape: canonicalizeInputShape(field.shape),
          })),
      };
  }
};

export const normalizeOperations = (
  operations: CatalogDescriptor["operations"],
): Result.Result<ReadonlyArray<CatalogDescriptor["operations"][number]>, ValidateFailure> =>
  uniqueSorted(
    operations.map((operation) => ({
      ...operation,
      input: canonicalizeInputShape(operation.input),
    })),
    encodeOperation,
    "operation identity",
  );

export const normalizeRules = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): Result.Result<ReadonlyArray<CanonicalAuthorizationRule>, ValidateFailure> =>
  uniqueSorted(rules, (rule) => rule.id, "rule identity");

export const normalizeDecisions = (
  decisions: CanonicalAuthorizationDecisions,
): Result.Result<CanonicalAuthorizationDecisions, ValidateFailure> =>
  Result.gen(function* () {
    const entities = yield* normalizeDecisionEntries(
      decisions.entities,
      encodeEntity,
      "entity decision target",
    );
    const traits = yield* normalizeDecisionEntries(
      decisions.traits,
      encodeTrait,
      "trait decision target",
    );
    const fields = yield* normalizeDecisionEntries(
      decisions.fields,
      encodeField,
      "field decision target",
    );
    return { entities, traits, fields };
  });

export const normalizeAccessPlans = (
  plans: ReadonlyArray<RuleAccessPlan>,
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): Result.Result<ReadonlyArray<RuleAccessPlan>, ValidateFailure> =>
  Result.gen(function* () {
    const sorted = yield* uniqueSorted(plans, (plan) => plan.rule, "access-plan identity");
    if (sorted.length !== rules.length) {
      return yield* invalid("missing access plan");
    }
    const expected = new Set(rules.map((rule) => rule.id));
    for (const plan of sorted) {
      if (!expected.has(plan.rule)) {
        return yield* invalid(`conflicting access plan for '${plan.rule}'`);
      }
      expected.delete(plan.rule);
    }
    if (expected.size !== 0) return yield* invalid("missing access plan");
    return sorted;
  });

export const normalizeValidatedTables = (
  validated: ValidatedAuthorizationIR,
  descriptor: CatalogDescriptor,
  plans: ReadonlyArray<RuleAccessPlan>,
) =>
  Result.gen(function* () {
    const classes = yield* normalizeClasses(validated.classes);
    const claims = yield* normalizeClaims(validated.claims);
    const identities = yield* normalizeIdentities(descriptor);
    const traitComposition = yield* normalizeTraitComposition(descriptor.traitComposition);
    const operations = yield* normalizeOperations(descriptor.operations);
    const rules = yield* normalizeRules(validated.rules);
    const decisions = yield* normalizeDecisions(validated.decisions);
    const accessPlans = yield* normalizeAccessPlans(plans, rules);
    return {
      classes,
      claims,
      identities,
      traitComposition,
      operations,
      rules,
      decisions,
      accessPlans,
    };
  });
