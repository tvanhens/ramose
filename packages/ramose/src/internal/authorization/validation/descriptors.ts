/**
 * Local structural validation of claim and operation-input descriptors.
 *
 * Canonical schemas are the source of truth. This module only applies those
 * codecs and maps failures onto {@link InvalidIR}. Catalog-dependent typing
 * stays in the semantic walker.
 */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { OperationInputShape } from "../catalog.ts";
import { OperationInputShape as OperationInputShapeSchema } from "../catalog.ts";
import { InvalidIR } from "../failures.ts";
import {
  ClaimVocabulary,
  ClassVocabulary,
  SubjectClaim,
  type ClaimDescriptor,
} from "../principal.ts";
import { invalid, type ValidateFailure } from "./common.ts";

const schemaFailure = (error: { readonly message: string }): Result.Result<never, ValidateFailure> =>
  Result.fail(new InvalidIR({ message: error.message }));

export const validateVocabularies = (
  subjectClaim: string,
  classes: ReadonlyArray<string>,
  claims: ReadonlyArray<ClaimDescriptor>,
): Result.Result<void, ValidateFailure> => {
  const subject = Schema.decodeUnknownResult(SubjectClaim)(subjectClaim);
  if (Result.isFailure(subject)) return schemaFailure(subject.failure);
  const classVocab = Schema.decodeUnknownResult(ClassVocabulary)(classes);
  if (Result.isFailure(classVocab)) return schemaFailure(classVocab.failure);
  const claimVocab = Schema.decodeUnknownResult(ClaimVocabulary)(claims);
  if (Result.isFailure(claimVocab)) return schemaFailure(claimVocab.failure);
  return Result.succeed(undefined);
};

export const validateInputShapeKeys = (
  shape: OperationInputShape,
): Result.Result<void, ValidateFailure> => {
  const decoded = Schema.decodeUnknownResult(OperationInputShapeSchema)(shape);
  if (Result.isFailure(decoded)) return schemaFailure(decoded.failure);
  return Result.succeed(undefined);
};

export const claimByKey = (
  claims: ReadonlyArray<ClaimDescriptor>,
  key: string,
): Result.Result<ClaimDescriptor, ValidateFailure> => {
  const found = claims.filter((claim) => claim.key === key);
  if (found.length === 0) return invalid(`undeclared claim '${key}'`);
  if (found.length > 1) return invalid(`ambiguous claim '${key}'`);
  return Result.succeed(found[0]!);
};
