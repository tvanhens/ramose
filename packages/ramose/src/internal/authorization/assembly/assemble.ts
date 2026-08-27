/**
 * Assemble sealed {@link InstalledAuthorizationIR} from validated IR.
 *
 * Re-runs semantic validation so a forged validated document cannot skip
 * #384/#385, derives one complete access plan per rule, normalizes every
 * installed table, recomputes the policy hash, and seals through the
 * canonical InstalledAuthorizationIR schema.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  decodeInstalledAuthorizationResult,
  encodeInstalledAuthorization,
  hashInstalledAuthorizationResult,
} from "../decode.ts";
import { CatalogMismatch, InvalidIR } from "../failures.ts";
import { PolicyHash } from "../identities.ts";
import {
  BOUND_AUTHORIZATION_IR_VERSION,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  type AuthorizationAssemblyInput,
  type BoundAuthorizationIR,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type InstalledAuthorizationIR as InstalledAuthorizationIRType,
} from "../ir.ts";
import { AuthoritativeCatalog, bindPolicyTemplateResult } from "../bind.ts";
import { validateBoundAuthorizationResult } from "../validation/validate.ts";
import { prepareAuthorizationCatalog } from "../validation/catalog.ts";
import { deriveAccessPlans } from "./plan.ts";
import { normalizeInstalledTables } from "./tables.ts";

export type AssembleFailure = InvalidIR | CatalogMismatch;

const HASH_PLACEHOLDER = PolicyHash.make("0".repeat(64));

const asBound = (validated: AuthorizationAssemblyInput["validated"]): BoundAuthorizationIR => ({
  _tag: "BoundAuthorizationIR",
  version: BOUND_AUTHORIZATION_IR_VERSION,
  database: validated.database,
  catalog: validated.catalog,
  catalogVersion: validated.catalogVersion,
  schemaFingerprint: validated.schemaFingerprint,
  classes: validated.classes,
  claims: validated.claims,
  principal: validated.principal,
  rules: validated.rules,
  decisions: validated.decisions,
});

const boundTarget = (validated: AuthorizationAssemblyInput["validated"]): CatalogBindingTarget => ({
  database: validated.database,
  catalog: validated.catalog,
  catalogVersion: validated.catalogVersion,
  schemaFingerprint: validated.schemaFingerprint,
});

/**
 * Pure assembly kernel. Consumes only semantically validated IR plus the
 * same authoritative catalog. Does not accept a template.
 */
export const assembleInstalledAuthorizationResult = (
  input: AuthorizationAssemblyInput,
): Result.Result<InstalledAuthorizationIRType, AssembleFailure> => {
  const revalidated = validateBoundAuthorizationResult({
    bound: asBound(input.validated),
    descriptor: input.descriptor,
  });
  if (Result.isFailure(revalidated)) return Result.fail(revalidated.failure);

  const index = prepareAuthorizationCatalog(boundTarget(revalidated.success), input.descriptor);
  if (Result.isFailure(index)) return Result.fail(index.failure);

  const plans = deriveAccessPlans(index.success, revalidated.success.rules, revalidated.success.principal);
  if (Result.isFailure(plans)) return Result.fail(plans.failure);

  const tables = normalizeInstalledTables(
    index.success,
    input.descriptor,
    revalidated.success.rules,
    revalidated.success.decisions,
    plans.success,
    revalidated.success.principal.entity,
  );
  if (Result.isFailure(tables)) return Result.fail(tables.failure);

  const draft: InstalledAuthorizationIRType = {
    _tag: "InstalledAuthorizationIR",
    version: INSTALLED_AUTHORIZATION_IR_VERSION,
    database: revalidated.success.database,
    catalog: revalidated.success.catalog,
    catalogVersion: revalidated.success.catalogVersion,
    schemaFingerprint: revalidated.success.schemaFingerprint,
    policyHash: HASH_PLACEHOLDER,
    classes: revalidated.success.classes,
    claims: revalidated.success.claims,
    principal: revalidated.success.principal,
    identities: tables.success.identities,
    traitComposition: tables.success.traitComposition,
    operations: tables.success.operations,
    rules: tables.success.rules,
    decisions: tables.success.decisions,
    accessPlans: tables.success.accessPlans,
  };

  const digest = hashInstalledAuthorizationResult(draft);
  if (Result.isFailure(digest)) return Result.fail(digest.failure);
  const hashed: InstalledAuthorizationIRType = { ...draft, policyHash: digest.success };

  const encoded = encodeInstalledAuthorization(hashed);
  const sealed = decodeInstalledAuthorizationResult(encoded);
  if (Result.isFailure(sealed)) return Result.fail(sealed.failure);

  const again = hashInstalledAuthorizationResult(sealed.success);
  if (Result.isFailure(again)) return Result.fail(again.failure);
  if (again.success !== sealed.success.policyHash) {
    return Result.fail(new InvalidIR({ message: "installed policy hash is not recomputable" }));
  }
  return Result.succeed(sealed.success);
};

export const assembleInstalledAuthorization = Effect.fn(
  "Authorization.assembleInstalledAuthorization",
)(function* (
  input: AuthorizationAssemblyInput,
): Effect.fn.Return<InstalledAuthorizationIRType, AssembleFailure> {
  return yield* Effect.fromResult(assembleInstalledAuthorizationResult(input));
});

/**
 * One auditable binder entry: catalog-relative template → installed IR.
 * Binding, semantic validation, and access-plan assembly all succeed or
 * the result is a narrow {@link InvalidIR} / {@link CatalogMismatch}.
 */
export const bindInstalledAuthorizationResult = (
  input: CatalogBindingInput,
): Result.Result<InstalledAuthorizationIRType, AssembleFailure> => {
  const bound = bindPolicyTemplateResult(input);
  if (Result.isFailure(bound)) return Result.fail(bound.failure);
  const validated = validateBoundAuthorizationResult({
    bound: bound.success,
    descriptor: input.descriptor,
  });
  if (Result.isFailure(validated)) return Result.fail(validated.failure);
  return assembleInstalledAuthorizationResult({
    validated: validated.success,
    descriptor: input.descriptor,
  });
};

export const bindInstalledAuthorization = Effect.fn("Authorization.bindInstalledAuthorization")(
  function* (input: CatalogBindingInput): Effect.fn.Return<InstalledAuthorizationIRType, AssembleFailure> {
    return yield* Effect.fromResult(bindInstalledAuthorizationResult(input));
  },
);

export const bindInstalledAgainstAuthoritativeCatalog = Effect.fn(
  "Authorization.bindInstalledAgainstAuthoritativeCatalog",
)(function* (target: CatalogBindingTarget, template: CatalogBindingInput["template"]) {
  const catalogs = yield* AuthoritativeCatalog;
  const descriptor = yield* catalogs.resolve(target);
  return yield* Effect.fromResult(bindInstalledAuthorizationResult({ target, descriptor, template }));
});
