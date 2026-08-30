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
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> =>
  Result.gen(function* () {
    const index = yield* prepareAuthorizationCatalog(boundTarget(input.bound), input.descriptor);
    yield* validateVocabularies(
      input.bound.principal.subjectClaim,
      input.bound.classes,
      input.bound.claims,
    );
    yield* meEntity(index, input.bound.principal);

    const classes = new Set(input.bound.classes);
    const rules: CanonicalAuthorizationRule[] = [];
    const byId = new Map<RuleId, CanonicalAuthorizationRule>();
    for (const rule of input.bound.rules) {
      const validated = yield* validateRule(
        index,
        rule,
        input.bound.principal,
        classes,
        input.bound.claims,
        limits,
      );
      if (byId.has(validated.id)) {
        return yield* invalid(`duplicate rule identity: ${validated.id}`);
      }
      byId.set(validated.id, validated);
      rules.push(validated);
    }

    yield* validateDecisions(index, input.bound.decisions, byId);
    return freezeValidated({
      _tag: "ValidatedAuthorizationIR" as const,
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
    });
  });

export const validateBoundAuthorizationResult = (
  input: AuthorizationValidationInput,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> =>
  validateBoundAuthorizationWithLimits(input, defaultValidationLimits);

export const validateBoundAuthorizationResultForTest = (
  input: AuthorizationValidationInput,
  limits: Partial<ValidationLimits>,
): Result.Result<ValidatedAuthorizationIRType, ValidateFailure> =>
  Result.gen(function* () {
    const tightened = yield* tightenValidationLimits(limits);
    return yield* validateBoundAuthorizationWithLimits(input, tightened);
  });

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
