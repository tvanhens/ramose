/**
 * Shared failure constructors, identity keys, and hard validation limits.
 */

import * as Result from "effect/Result";
import { DEFAULT_AUTHORIZATION_BUDGET, MAX_TRAVERSAL_DEPTH } from "../bounds.ts";
import { CatalogMismatch, InvalidIR } from "../failures.ts";
import type { EntityId, FieldId, OperationId, TraitId } from "../identities.ts";
import type { CatalogDescriptor } from "../catalog.ts";
import type { CatalogBindingTarget } from "../ir.ts";

export type ValidateFailure = InvalidIR | CatalogMismatch;

export type ValidationLimits = {
  readonly maxTraversalDepth: number;
  readonly maxStaticWork: number;
};

/** Hard production ceilings. Callers cannot widen these. */
export const defaultValidationLimits: ValidationLimits = {
  maxTraversalDepth: MAX_TRAVERSAL_DEPTH,
  maxStaticWork: DEFAULT_AUTHORIZATION_BUDGET,
};

const isFiniteNatural = (value: number): boolean =>
  Number.isFinite(value) && Number.isInteger(value) && value >= 0;

/**
 * Test-only tightening. Each override must be a finite natural number and
 * is clamped at the corresponding hard constant so Infinity/NaN cannot
 * disable traversal or work restrictions.
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
  return Result.gen(function* () {
    const maxTraversalDepth = yield* clamp(
      "maxTraversalDepth",
      defaultValidationLimits.maxTraversalDepth,
    );
    const maxStaticWork = yield* clamp("maxStaticWork", defaultValidationLimits.maxStaticWork);
    return { maxTraversalDepth, maxStaticWork };
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

export const isBlank = (value: string): boolean => value.length === 0;

export const requireNonBlank = (
  value: string,
  label: string,
): Result.Result<string, ValidateFailure> =>
  isBlank(value) ? mismatch({ message: `blank ${label}` }) : Result.succeed(value);

/** Shared binding/validation gate: target names and descriptor identity must agree. */
export const validateCatalogTarget = (
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

