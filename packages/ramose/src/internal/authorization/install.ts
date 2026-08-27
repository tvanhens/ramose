/**
 * Core-v1 installed-IR assembly.
 *
 * The only production path from {@link CatalogBindingInput} to
 * {@link InstalledAuthorizationIRV1}. Binding and semantic validation
 * run through their Effect shells (hashed / verified). Plan derivation
 * and table normalization stay pure. The policy hash is recomputed
 * through the #357 RFC 8785 / Web Crypto contract and domain-separated
 * by authorization language version.
 *
 * Unhashed tables never leave this module and are not
 * {@link InstalledAuthorizationIR}.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  AuthoritativeCatalog,
  bindPolicyTemplate,
  type BindFailure,
} from "./bind.ts";
import type { CatalogDescriptor } from "./catalog.ts";
import {
  decodeInstalledAuthorizationResult,
  encodeInstalledAuthorization,
  hashInstalledAuthorization,
} from "./decode.ts";
import { PolicyHash } from "./identities.ts";
import {
  INSTALLED_AUTHORIZATION_IR_VERSION,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type InstalledAuthorizationIR as InstalledAuthorizationIRType,
  type InstalledAuthorizationIRV1 as InstalledAuthorizationIRV1Type,
  type PolicyTemplateIR,
  type ValidatedAuthorizationIR,
} from "./ir.ts";
import { validateBoundAuthorization } from "./validate.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "./version.ts";
import { normalizeValidatedTables } from "./install/normalize.ts";
import { deriveRuleAccessPlan } from "./install/plan.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";
import { invalid, type ValidateFailure } from "./validation/common.ts";

export type InstallFailure = BindFailure;

const PLACEHOLDER_POLICY_HASH = PolicyHash.make("0".repeat(64));

type UnhashedInstalledTables = Omit<
  InstalledAuthorizationIRType,
  "_tag" | "policyHash"
>;

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

const requireLanguageVersion = (
  version: string,
  label: string,
): Result.Result<void, ValidateFailure> => {
  if (version !== AUTHORIZATION_LANGUAGE_VERSION) {
    return invalid(`unsupported authorization language version in ${label}`);
  }
  return Result.succeed(undefined);
};

/**
 * Private pure assembly. Returns tables without `_tag` or `policyHash`
 * so the result is not runtime-acceptable installed IR.
 */
const assembleUnhashedTables = (
  validated: ValidatedAuthorizationIR,
  descriptor: CatalogDescriptor,
): Result.Result<UnhashedInstalledTables, ValidateFailure> => {
  const language = requireLanguageVersion(validated.languageVersion, "validated IR");
  if (Result.isFailure(language)) return Result.fail(language.failure);

  const index = prepareAuthorizationCatalog(
    {
      database: validated.database,
      catalog: validated.catalog,
      catalogVersion: validated.catalogVersion,
      schemaFingerprint: validated.schemaFingerprint,
    },
    descriptor,
  );
  if (Result.isFailure(index)) return Result.fail(index.failure);

  const plans = [];
  for (const rule of validated.rules) {
    const plan = deriveRuleAccessPlan(index.success, rule, validated.principal);
    if (Result.isFailure(plan)) return Result.fail(plan.failure);
    plans.push(plan.success);
  }

  const tables = normalizeValidatedTables(validated, descriptor, plans);
  if (Result.isFailure(tables)) return Result.fail(tables.failure);

  return Result.succeed({
    version: INSTALLED_AUTHORIZATION_IR_VERSION,
    languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
    database: validated.database,
    catalog: validated.catalog,
    catalogVersion: validated.catalogVersion,
    schemaFingerprint: validated.schemaFingerprint,
    classes: tables.success.classes,
    claims: tables.success.claims,
    principal: validated.principal,
    identities: tables.success.identities,
    traitComposition: tables.success.traitComposition,
    operations: tables.success.operations,
    rules: tables.success.rules,
    decisions: tables.success.decisions,
    accessPlans: tables.success.accessPlans,
  });
};

const sealInstalledAuthorization = Effect.fn("Authorization.sealInstalledAuthorization")(
  function* (
    validated: ValidatedAuthorizationIR,
    descriptor: CatalogDescriptor,
  ): Effect.fn.Return<InstalledAuthorizationIRV1Type, InstallFailure> {
    const tables = assembleUnhashedTables(validated, descriptor);
    if (Result.isFailure(tables)) return yield* tables.failure;
    const hashingDocument: InstalledAuthorizationIRType = {
      _tag: "InstalledAuthorizationIR",
      ...tables.success,
      policyHash: PLACEHOLDER_POLICY_HASH,
    };
    const policyHash = yield* hashInstalledAuthorization(hashingDocument);
    const installed: InstalledAuthorizationIRType = {
      _tag: "InstalledAuthorizationIR",
      ...clonePlain(tables.success),
      policyHash,
    };
    const decoded = decodeInstalledAuthorizationResult(encodeInstalledAuthorization(installed));
    if (Result.isFailure(decoded)) return yield* decoded.failure;
    return freezePlain(clonePlain(decoded.success));
  },
);

/**
 * One auditable binder entry point: catalog binding input → installed v1 IR.
 * Bind and validate run as Effect so unhashed or unverified intermediates
 * cannot reach assembly.
 */
export const installAuthorization = Effect.fn("Authorization.installAuthorization")(
  function* (
    input: CatalogBindingInput,
  ): Effect.fn.Return<InstalledAuthorizationIRV1Type, InstallFailure> {
    const templateVersion = requireLanguageVersion(
      input.template.languageVersion,
      "policy template",
    );
    if (Result.isFailure(templateVersion)) return yield* templateVersion.failure;
    const bound = yield* bindPolicyTemplate(input);
    const boundVersion = requireLanguageVersion(bound.languageVersion, "bound IR");
    if (Result.isFailure(boundVersion)) return yield* boundVersion.failure;
    const validated = yield* validateBoundAuthorization({
      bound,
      descriptor: input.descriptor,
    });
    return yield* sealInstalledAuthorization(validated, input.descriptor);
  },
);

export const installAgainstAuthoritativeCatalog = Effect.fn(
  "Authorization.installAgainstAuthoritativeCatalog",
)(function* (target: CatalogBindingTarget, template: PolicyTemplateIR) {
  const catalogs = yield* AuthoritativeCatalog;
  const descriptor = yield* catalogs.resolve(target);
  return yield* installAuthorization({ target, descriptor, template });
});
