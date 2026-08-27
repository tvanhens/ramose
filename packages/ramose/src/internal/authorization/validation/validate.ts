/**
 * Semantic validation orchestration.
 *
 * Consumes {@link BoundAuthorizationIR} and one authoritative
 * {@link CatalogDescriptor}. Catalog-dependent rules live in the sibling
 * modules; this file only prepares the catalog, applies schema-local
 * vocabularies, and walks rules/decisions.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { hashCanonicalRule } from "../decode.ts";
import {
  VALIDATED_AUTHORIZATION_IR_VERSION,
  type AuthorizationValidationInput,
  type BoundAuthorizationIR,
  type CanonicalAuthorizationRule,
  type ValidatedAuthorizationIR as ValidatedAuthorizationIRType,
} from "../ir.ts";
import type { RuleId } from "../identities.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "../version.ts";
import { invalid as invalidResult } from "./common.ts";
import { prepareAuthorizationCatalog } from "./catalog.ts";
import {
  defaultValidationLimits,
  invalid,
  tightenValidationLimits,
  type ValidationLimits,
  type ValidateFailure,
} from "./common.ts";
import { validateVocabularies } from "./descriptors.ts";
import { validateDecisions } from "./decisions.ts";
import { validateRule } from "./expression.ts";
import { meEntity } from "./traversal.ts";

export type { ValidateFailure, ValidationLimits };
export { defaultValidationLimits };

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

const boundTarget = (bound: BoundAuthorizationIR) => ({
  database: bound.database,
  catalog: bound.catalog,
  catalogVersion: bound.catalogVersion,
  schemaFingerprint: bound.schemaFingerprint,
});

const validateBoundAuthorizationWithLimits = (
  input: AuthorizationValidationInput,
  limits: ValidationLimits,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> => {
  const index = prepareAuthorizationCatalog(boundTarget(input.bound), input.descriptor);
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
    languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
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
 * Pure semantic kernel. Recomputes derived flags. Does not hash, derive
 * access plans, or assemble {@link import("../ir.ts").InstalledAuthorizationIR}.
 * Production entry: hard validation limits only. The Effect shell compares
 * rule IDs to domain-separated hashes of the canonical rule material.
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

const verifyRuleHashes = Effect.fn("Authorization.verifyRuleHashes")(function* (
  validated: ValidatedAuthorizationIRType,
): Effect.fn.Return<ValidatedAuthorizationIRType, ValidateFailure> {
  for (const rule of validated.rules) {
    const expected = yield* hashCanonicalRule(rule);
    if (rule.id !== expected) {
      return yield* Effect.fromResult(invalidResult("tampered rule id"));
    }
  }
  return validated;
});

export const validateBoundAuthorization = Effect.fn("Authorization.validateBoundAuthorization")(
  function* (
    input: AuthorizationValidationInput,
  ): Effect.fn.Return<ValidatedAuthorizationIRType, ValidateFailure> {
    const validated = yield* Effect.fromResult(validateBoundAuthorizationResult(input));
    return yield* verifyRuleHashes(validated);
  },
);
