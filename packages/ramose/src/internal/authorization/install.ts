import * as Brand from "effect/Brand";
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
  type InstalledAuthorizationIRV2 as InstalledAuthorizationIRV2Type,
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

const verifiedInstalledAuthorization = Brand.nominal<InstalledAuthorizationIRV2Type>();

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

const assembleUnhashedTables = (
  validated: ValidatedAuthorizationIR,
  descriptor: CatalogDescriptor,
): Result.Result<UnhashedInstalledTables, ValidateFailure> =>
  Result.gen(function* () {
    yield* requireLanguageVersion(validated.languageVersion, "validated IR");

    const index = yield* prepareAuthorizationCatalog(
      {
        database: validated.database,
        catalog: validated.catalog,
        catalogVersion: validated.catalogVersion,
        schemaFingerprint: validated.schemaFingerprint,
      },
      descriptor,
    );

    const plans = [];
    for (const rule of validated.rules) {
      const plan = yield* deriveRuleAccessPlan(index, rule, validated.principal);
      plans.push(plan);
    }

    const tables = yield* normalizeValidatedTables(validated, plans);
    return {
      version: INSTALLED_AUTHORIZATION_IR_VERSION,
      languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
      classes: tables.classes,
      claims: tables.claims,
      principal: validated.principal,
      rules: tables.rules,
      decisions: tables.decisions,
      accessPlans: tables.accessPlans,
    };
  });

const sealInstalledAuthorization = Effect.fn("Authorization.sealInstalledAuthorization")(
  function* (
    validated: ValidatedAuthorizationIR,
    descriptor: CatalogDescriptor,
  ): Effect.fn.Return<InstalledAuthorizationIRV2Type, InstallFailure> {
    const tables = yield* Effect.fromResult(assembleUnhashedTables(validated, descriptor));
    const hashingDocument: InstalledAuthorizationIRType = {
      _tag: "InstalledAuthorizationIR",
      ...tables,
      policyHash: PLACEHOLDER_POLICY_HASH,
    };
    const policyHash = yield* hashInstalledAuthorization(hashingDocument);
    const installed: InstalledAuthorizationIRType = {
      _tag: "InstalledAuthorizationIR",
      ...clonePlain(tables),
      policyHash,
    };
    const decoded = yield* Effect.fromResult(
      decodeInstalledAuthorizationResult(encodeInstalledAuthorization(installed)),
    );
    return verifiedInstalledAuthorization(freezePlain(clonePlain(decoded)));
  },
);

export const installAuthorization = Effect.fn("Authorization.installAuthorization")(
  function* (
    input: CatalogBindingInput,
  ): Effect.fn.Return<InstalledAuthorizationIRV2Type, InstallFailure> {
    yield* Effect.fromResult(
      requireLanguageVersion(input.template.languageVersion, "policy template"),
    );
    const bound = yield* bindPolicyTemplate(input);
    yield* Effect.fromResult(requireLanguageVersion(bound.languageVersion, "bound IR"));
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
