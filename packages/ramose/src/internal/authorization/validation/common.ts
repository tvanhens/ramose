/**
 * Shared failure constructors, identity keys, and hard validation limits.
 */

import * as Result from "effect/Result";
import {
  DEFAULT_AUTHORIZATION_BUDGET,
  MAX_EXISTS_DEPTH,
  MAX_TRAVERSAL_DEPTH,
} from "../bounds.ts";
import { CatalogMismatch, InvalidIR } from "../failures.ts";
import type { EntityId, FieldId, OperationId, TraitId } from "../identities.ts";

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
export const tightenValidationLimits = (
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

export const SEPARATOR = "\u0000";

export const entityKey = (id: EntityId): string => `${id.catalog}${SEPARATOR}${id.name}`;

export const traitKey = (id: TraitId): string => `${id.catalog}${SEPARATOR}${id.name}`;

export const fieldKey = (id: FieldId): string =>
  `${id.catalog}${SEPARATOR}${id.owner.kind}${SEPARATOR}${id.owner.name}${SEPARATOR}${id.localName}`;

export const operationKey = (id: OperationId): string =>
  `${id.catalog}${SEPARATOR}${id.owner.kind}${SEPARATOR}${id.owner.name}${SEPARATOR}${id.localName}${SEPARATOR}${id.target}`;

export const invalid = (message: string): Result.Result<never, ValidateFailure> =>
  Result.fail(new InvalidIR({ message }));

export const mismatch = (
  fields: ConstructorParameters<typeof CatalogMismatch>[0],
): Result.Result<never, ValidateFailure> => Result.fail(new CatalogMismatch(fields));
