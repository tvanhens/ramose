/**
 * Schema-backed installed catalog unit and the only seal path.
 *
 * One immutable document nests the canonical {@link CatalogDescriptor}
 * and a lean installed read policy. Catalog identity, schema tables, and
 * trait composition live only on the descriptor. Type-to-trait lookup
 * indexes are derived at validation and assembly — they are not persisted
 * as application datoms. Structural decode of {@link InstalledCatalogUnit}
 * is not {@link InstalledCatalogUnitV2}; only {@link sealInstalledCatalogUnit}
 * and verified load may produce the brand.
 */

import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  CatalogDescriptor,
  EntityDescriptor,
  FieldDescriptor,
  OperationDescriptor,
  OperationInputShape,
  TraitComposition,
  TraitDescriptor,
  RuleAccessPlan,
  type CatalogDescriptor as CatalogDescriptorType,
} from "./catalog.ts";
import {
  canonicalizeInstalledCatalogUnit,
  decodeInstalledCatalogUnitResult,
  encodeInstalledCatalogUnit,
  hashCanonicalRule,
  hashCatalogSchemaFingerprint,
  hashInstalledAuthorization,
  hashInstalledCatalogUnit,
} from "./decode.ts";
import { CatalogMismatch, CatalogUnitCorrupt, InvalidIR } from "./failures.ts";
import {
  CatalogId,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  OperationId,
  SchemaFingerprint,
} from "./identities.ts";
import {
  BOUND_AUTHORIZATION_IR_VERSION,
  CanonicalAuthorizationDecisions,
  CanonicalAuthorizationRule,
  INSTALLED_AUTHORIZATION_IR_VERSION,
  InstalledAuthorizationIR,
  type BoundAuthorizationIR,
  type InstalledAuthorizationIR as InstalledAuthorizationIRType,
  type InstalledAuthorizationIRV1 as InstalledAuthorizationIRV1Type,
} from "./ir.ts";
import {
  normalizeAccessPlans,
  normalizeClasses,
  normalizeClaims,
  normalizeDecisions,
  normalizeEntities,
  normalizeFields,
  normalizeOperations,
  normalizeRules,
  normalizeTraitComposition,
  normalizeTraits,
} from "./install/normalize.ts";
import { ClaimDescriptor, ClassVocabulary } from "./principal.ts";
import { deriveRuleAccessPlan } from "./install/plan.ts";
import { validateBoundAuthorizationResult } from "./validate.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";
import { invalid, type ValidateFailure } from "./validation/common.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "./version.ts";
import type { JsonValue } from "./json.ts";
import { canonicalizeJson } from "./canonical-json.ts";

export const INSTALLED_CATALOG_UNIT_VERSION = 2 as const;
export const InstalledCatalogUnitVersion = Schema.Literal(INSTALLED_CATALOG_UNIT_VERSION);
export type InstalledCatalogUnitVersion = typeof InstalledCatalogUnitVersion.Type;

/**
 * Complete installed catalog document. Decode checks shape and identity
 * collisions only — not {@link unitHash} or component completeness at
 * the storage boundary. This is not a publishable brand.
 */
export const InstalledCatalogUnit = Schema.TaggedStruct("InstalledCatalogUnit", {
  version: InstalledCatalogUnitVersion,
  catalog: CatalogDescriptor,
  policy: InstalledAuthorizationIR,
  unitHash: CatalogUnitHash,
});
export type InstalledCatalogUnit = typeof InstalledCatalogUnit.Type;

/**
 * Read-only decoder shape for persisted v1 units. V1 operation rows carried
 * only identity and input shape, so a nonempty v1 table cannot be upgraded
 * without the deployed definitions and must be rebuilt by deployment.
 */
const LegacyOperationDescriptorV1 = Schema.Struct({
  id: OperationId,
  input: OperationInputShape,
});

const LegacyCatalogDescriptorV1 = Schema.Struct({
  id: CatalogId,
  database: DatabaseId,
  version: CatalogVersion,
  fingerprint: SchemaFingerprint,
  entities: Schema.Array(EntityDescriptor),
  traits: Schema.Array(TraitDescriptor),
  fields: Schema.Array(FieldDescriptor),
  operations: Schema.Array(LegacyOperationDescriptorV1),
  traitComposition: Schema.Array(TraitComposition),
});

export const LegacyInstalledCatalogUnitV1 = Schema.TaggedStruct(
  "InstalledCatalogUnit",
  {
    version: Schema.Literal(1),
    catalog: LegacyCatalogDescriptorV1,
    policy: InstalledAuthorizationIR,
    unitHash: CatalogUnitHash,
  },
);
export type LegacyInstalledCatalogUnitV1 =
  typeof LegacyInstalledCatalogUnitV1.Type;

/**
 * Verified/sealed v2 catalog unit. Distinct from Schema-decoded
 * structural output. Only {@link sealInstalledCatalogUnit} and the
 * hash-verified load path produce this brand.
 */
export type InstalledCatalogUnitV2 = InstalledCatalogUnit &
  Brand.Brand<"InstalledCatalogUnitV2">;

export type AssembleCatalogUnitFailure = ValidateFailure;

const PLACEHOLDER_UNIT_HASH = CatalogUnitHash.make("0".repeat(64));

const verifiedInstalledCatalogUnit = Brand.nominal<InstalledCatalogUnitV2>();

type UnhashedCatalogUnitTables = Omit<InstalledCatalogUnit, "_tag" | "unitHash">;

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

const encodedJson = (encoded: unknown): JsonValue => encoded as JsonValue;

const canonicalEqual = (
  left: unknown,
  right: unknown,
  message: string,
): Result.Result<void, ValidateFailure> => {
  try {
    if (canonicalizeJson(encodedJson(left)) === canonicalizeJson(encodedJson(right))) {
      return Result.succeed(undefined);
    }
  } catch (cause) {
    return invalid(
      `ambiguous ${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return Result.fail(new CatalogMismatch({ message }));
};

const catalogTableMismatch = (label: string): string =>
  `installed catalog ${label} do not match normalized catalog descriptor`;

const policyOrderMismatch = (label: string): string =>
  `installed policy ${label} are not in install-canonical order`;

const policyDerivedMismatch = (label: string): string =>
  `installed policy ${label} do not match re-derived policy tables`;

const requirePresent = (value: unknown, label: string): Result.Result<void, ValidateFailure> => {
  if (value === undefined || value === null) {
    return invalid(`missing ${label}`);
  }
  return Result.succeed(undefined);
};

const requireDescriptorTables = (
  descriptor: CatalogDescriptorType,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* requirePresent(descriptor, "catalog descriptor");
    yield* requirePresent(descriptor.entities, "entities");
    yield* requirePresent(descriptor.traits, "traits");
    yield* requirePresent(descriptor.fields, "fields");
    yield* requirePresent(descriptor.operations, "operations");
    yield* requirePresent(descriptor.traitComposition, "traitComposition");
    if (!Array.isArray(descriptor.entities)) return yield* invalid("missing entities");
    if (!Array.isArray(descriptor.traits)) return yield* invalid("missing traits");
    if (!Array.isArray(descriptor.fields)) return yield* invalid("missing fields");
    if (!Array.isArray(descriptor.operations)) return yield* invalid("missing operations");
    if (!Array.isArray(descriptor.traitComposition)) {
      return yield* invalid("missing traitComposition");
    }
  });

const requirePolicyPresent = (
  policy: InstalledAuthorizationIRType | undefined,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* requirePresent(policy, "installed policy");
    if (typeof policy !== "object") return yield* invalid("missing installed policy");
    yield* requirePresent(policy.accessPlans, "accessPlans");
    yield* requirePresent(policy.rules, "rules");
    yield* requirePresent(policy.decisions, "decisions");
    yield* requirePresent(policy.classes, "classes");
    yield* requirePresent(policy.claims, "claims");
  });

const encodeEntities = (
  entities: ReadonlyArray<EntityDescriptor>,
): unknown => entities.map((entity) => Schema.encodeUnknownSync(EntityDescriptor)(entity));

const encodeTraits = (
  traits: ReadonlyArray<TraitDescriptor>,
): unknown => traits.map((trait) => Schema.encodeUnknownSync(TraitDescriptor)(trait));

const encodeFields = (
  fields: ReadonlyArray<FieldDescriptor>,
): unknown => fields.map((field) => Schema.encodeUnknownSync(FieldDescriptor)(field));

const encodeOperations = (
  operations: ReadonlyArray<CatalogDescriptorType["operations"][number]>,
): unknown => operations.map((operation) => Schema.encodeUnknownSync(OperationDescriptor)(operation));

const encodeComposition = (rows: ReadonlyArray<TraitComposition>): unknown =>
  rows.map((row) => Schema.encodeUnknownSync(TraitComposition)(row));

const encodeAccessPlans = (
  plans: InstalledAuthorizationIRType["accessPlans"],
): unknown => plans.map((plan) => Schema.encodeUnknownSync(RuleAccessPlan)(plan));

const encodeRules = (
  rules: ReadonlyArray<CanonicalAuthorizationRule>,
): unknown => rules.map((rule) => Schema.encodeUnknownSync(CanonicalAuthorizationRule)(rule));

const encodeClasses = (
  classes: ReadonlyArray<string>,
): unknown => Schema.encodeUnknownSync(ClassVocabulary)(classes);

const encodeClaims = (
  claims: ReadonlyArray<ClaimDescriptor>,
): unknown => claims.map((claim) => Schema.encodeUnknownSync(ClaimDescriptor)(claim));

const encodeDecisions = (
  decisions: CanonicalAuthorizationDecisions,
): unknown => Schema.encodeUnknownSync(CanonicalAuthorizationDecisions)(decisions);

const catalogBindingTarget = (catalog: CatalogDescriptorType) => ({
  database: catalog.database,
  catalog: catalog.id,
  catalogVersion: catalog.version,
  schemaFingerprint: catalog.fingerprint,
});

const boundAuthorizationFromPolicy = (
  catalog: CatalogDescriptorType,
  policy: InstalledAuthorizationIRType,
): BoundAuthorizationIR => ({
  _tag: "BoundAuthorizationIR",
  version: BOUND_AUTHORIZATION_IR_VERSION,
  languageVersion: policy.languageVersion,
  database: catalog.database,
  catalog: catalog.id,
  catalogVersion: catalog.version,
  schemaFingerprint: catalog.fingerprint,
  classes: policy.classes,
  claims: policy.claims,
  principal: policy.principal,
  rules: policy.rules,
  decisions: policy.decisions,
});

/**
 * Normalize catalog-owned tables into install-canonical order. Nested
 * trait sets and operation input keys are sorted with the tables.
 */
const normalizeCatalogDescriptor = (
  descriptor: CatalogDescriptorType,
): Result.Result<CatalogDescriptorType, ValidateFailure> =>
  Result.gen(function* () {
    yield* requireDescriptorTables(descriptor);
    const [entities, traits, fields, operations, traitComposition] = yield* Result.all([
      normalizeEntities(descriptor.entities),
      normalizeTraits(descriptor.traits),
      normalizeFields(descriptor.fields),
      normalizeOperations(descriptor.operations),
      normalizeTraitComposition(descriptor.traitComposition),
    ]);
    return {
      id: descriptor.id,
      database: descriptor.database,
      version: descriptor.version,
      fingerprint: descriptor.fingerprint,
      entities,
      traits,
      fields,
      operations,
      traitComposition,
    };
  });

const requireCatalogAlreadyCanonical = (
  catalog: CatalogDescriptorType,
  normalized: CatalogDescriptorType,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* canonicalEqual(
      encodeEntities(normalized.entities),
      encodeEntities(catalog.entities),
      catalogTableMismatch("entities"),
    );
    yield* canonicalEqual(
      encodeTraits(normalized.traits),
      encodeTraits(catalog.traits),
      catalogTableMismatch("traits"),
    );
    yield* canonicalEqual(
      encodeFields(normalized.fields),
      encodeFields(catalog.fields),
      catalogTableMismatch("fields"),
    );
    yield* canonicalEqual(
      encodeOperations(normalized.operations),
      encodeOperations(catalog.operations),
      catalogTableMismatch("operations"),
    );
    yield* canonicalEqual(
      encodeComposition(normalized.traitComposition),
      encodeComposition(catalog.traitComposition),
      catalogTableMismatch("traitComposition"),
    );
  });

/**
 * Revalidate the embedded policy against the one normalized catalog.
 * Stored classes, claims, rules, and decisions must already be in
 * install-canonical order. Access plans are re-derived and must match.
 */
const requirePolicyReferences = (
  catalog: CatalogDescriptorType,
  policy: InstalledAuthorizationIRType,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    const index = yield* prepareAuthorizationCatalog(catalogBindingTarget(catalog), catalog);
    const validated = yield* validateBoundAuthorizationResult({
      bound: boundAuthorizationFromPolicy(catalog, policy),
      descriptor: catalog,
    });
    const rules = yield* normalizeRules(validated.rules);
    yield* canonicalEqual(encodeRules(rules), encodeRules(policy.rules), policyOrderMismatch("rules"));
    const classes = yield* normalizeClasses(policy.classes);
    yield* canonicalEqual(
      encodeClasses(classes),
      encodeClasses(policy.classes),
      policyOrderMismatch("classes"),
    );
    const claims = yield* normalizeClaims(policy.claims);
    yield* canonicalEqual(encodeClaims(claims), encodeClaims(policy.claims), policyOrderMismatch("claims"));
    const decisions = yield* normalizeDecisions(policy.decisions);
    yield* canonicalEqual(
      encodeDecisions(decisions),
      encodeDecisions(policy.decisions),
      policyOrderMismatch("decisions"),
    );

    const derived = [];
    for (const rule of policy.rules) {
      const plan = yield* deriveRuleAccessPlan(index, rule, policy.principal);
      derived.push(plan);
    }
    const accessPlans = yield* normalizeAccessPlans(derived, policy.rules);
    yield* canonicalEqual(
      encodeAccessPlans(accessPlans),
      encodeAccessPlans(policy.accessPlans),
      policyDerivedMismatch("accessPlans"),
    );
  });

export type NormalizeCatalogUnitOptions = {
  /**
   * When true (verify), stored catalog tables must already be in
   * install-canonical order. Seal passes false so permuted descriptor
   * input can normalize inside this kernel.
   */
  readonly requireCatalogAlreadyCanonical?: boolean;
};

/**
 * Shared normalize-and-validate kernel used by assemble/seal and verify.
 * Structural versions, catalog normalization, semantic catalog
 * validation, and policy-reference checks live here. Hash and
 * fingerprint digests stay in the Effect shells.
 */
export const normalizeAndValidateCatalogUnit = (
  catalog: CatalogDescriptorType,
  policy: InstalledAuthorizationIRType,
  version: number = INSTALLED_CATALOG_UNIT_VERSION,
  options: NormalizeCatalogUnitOptions = {},
): Result.Result<UnhashedCatalogUnitTables, AssembleCatalogUnitFailure> =>
  Result.gen(function* () {
    yield* requireDescriptorTables(catalog);
    yield* requirePolicyPresent(policy);
    if (version !== INSTALLED_CATALOG_UNIT_VERSION) {
      return yield* invalid("unsupported catalog unit version");
    }
    if (policy.version !== INSTALLED_AUTHORIZATION_IR_VERSION) {
      return yield* invalid("unsupported installed policy version");
    }
    yield* requireLanguageVersion(policy.languageVersion, "embedded policy");

    const normalized = yield* normalizeCatalogDescriptor(catalog);
    yield* requirePolicyReferences(normalized, policy);
    if (options.requireCatalogAlreadyCanonical === true) {
      yield* requireCatalogAlreadyCanonical(catalog, normalized);
    }

    return freezePlain({
      version: INSTALLED_CATALOG_UNIT_VERSION,
      catalog: freezePlain(clonePlain(normalized)),
      policy: freezePlain(clonePlain(policy)),
    });
  });

/**
 * Private-shaped pure assembly. Returns tables without `_tag` or
 * `unitHash` so the result is not a runtime-acceptable catalog unit.
 * Permuted catalog tables are normalized inside the shared kernel.
 */
export const assembleInstalledCatalogUnit = (
  descriptor: CatalogDescriptorType,
  policy: InstalledAuthorizationIRType,
): Result.Result<UnhashedCatalogUnitTables, AssembleCatalogUnitFailure> =>
  Result.gen(function* () {
    const descriptorSnapshot = freezePlain(clonePlain(descriptor));
    const policySnapshot = freezePlain(clonePlain(policy));
    return yield* normalizeAndValidateCatalogUnit(
      descriptorSnapshot,
      policySnapshot,
      INSTALLED_CATALOG_UNIT_VERSION,
    );
  });

/**
 * Bind `catalog.fingerprint` to the digest of the normalized
 * catalog-owned schema tables. Verify cannot take a live catalog, so the
 * claimed fingerprint must be recomputed from the stored tables.
 */
const requireBoundSchemaFingerprint = Effect.fn("Authorization.requireBoundSchemaFingerprint")(
  function* (
    catalog: CatalogDescriptorType,
  ): Effect.fn.Return<void, AssembleCatalogUnitFailure> {
    const digest = yield* hashCatalogSchemaFingerprint(catalog);
    if (digest !== catalog.fingerprint) {
      return yield* new CatalogMismatch({
        message: "schema fingerprint does not match catalog tables",
        expectedFingerprint: digest,
        actualFingerprint: catalog.fingerprint,
      });
    }
  },
);

const requireEmbeddedPolicyHashes = Effect.fn("Authorization.requireEmbeddedPolicyHashes")(
  function* (
    policy: InstalledAuthorizationIRType,
    catalogId: CatalogId,
  ): Effect.fn.Return<void, InvalidIR | CatalogUnitCorrupt> {
    const policyHash = yield* hashInstalledAuthorization(policy);
    if (policyHash !== policy.policyHash) {
      return yield* new CatalogUnitCorrupt({
        message: "installed policy hash mismatch",
        catalog: catalogId,
      });
    }
    for (const rule of policy.rules) {
      const id = yield* hashCanonicalRule(rule);
      if (id !== rule.id) {
        return yield* new CatalogUnitCorrupt({
          message: "catalog unit rule hash mismatch",
          catalog: catalogId,
        });
      }
    }
  },
);

/**
 * Hash and fingerprint checks shared by seal and verify. The semantic
 * kernel does not hash; these Effect steps consume its normalized output.
 */
const requireCatalogUnitDigests = Effect.fn("Authorization.requireCatalogUnitDigests")(
  function* (
    tables: UnhashedCatalogUnitTables,
  ): Effect.fn.Return<void, AssembleCatalogUnitFailure | CatalogUnitCorrupt> {
    yield* requireBoundSchemaFingerprint(tables.catalog);
    yield* requireEmbeddedPolicyHashes(tables.policy, tables.catalog.id);
  },
);

/**
 * The only producer of {@link InstalledCatalogUnitV2} besides verified
 * load. Bind the complete descriptor to a sealed policy, hash the
 * canonical document minus `unitHash`, and freeze the brand.
 */
export const sealInstalledCatalogUnit = Effect.fn("Authorization.sealInstalledCatalogUnit")(
  function* (
    descriptor: CatalogDescriptorType,
    policy: InstalledAuthorizationIRV1Type,
  ): Effect.fn.Return<InstalledCatalogUnitV2, AssembleCatalogUnitFailure | CatalogUnitCorrupt> {
    const tables = yield* Effect.fromResult(assembleInstalledCatalogUnit(descriptor, policy));
    const snapshot = freezePlain(clonePlain(tables));
    yield* requireCatalogUnitDigests(snapshot);
    const hashingDocument: InstalledCatalogUnit = {
      _tag: "InstalledCatalogUnit",
      ...snapshot,
      unitHash: PLACEHOLDER_UNIT_HASH,
    };
    const unitHash = yield* hashInstalledCatalogUnit(hashingDocument);
    const assembled: InstalledCatalogUnit = {
      _tag: "InstalledCatalogUnit",
      ...snapshot,
      unitHash,
    };
    const decoded = yield* Effect.fromResult(
      decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(assembled)),
    );
    return verifiedInstalledCatalogUnit(freezePlain(clonePlain(decoded)));
  },
);

/**
 * Hash-verify a structural catalog unit and brand it. Structural decode
 * alone is not {@link InstalledCatalogUnitV2}. The shared kernel, hash,
 * and an encode/decode round-trip must all succeed before the brand.
 */
export const verifyInstalledCatalogUnit = Effect.fn("Authorization.verifyInstalledCatalogUnit")(
  function* (
    document: InstalledCatalogUnit,
  ): Effect.fn.Return<InstalledCatalogUnitV2, AssembleCatalogUnitFailure | CatalogUnitCorrupt> {
    const snapshot = freezePlain(clonePlain(document));
    const tables = yield* Effect.fromResult(
      normalizeAndValidateCatalogUnit(snapshot.catalog, snapshot.policy, snapshot.version, {
        requireCatalogAlreadyCanonical: true,
      }),
    );
    yield* requireCatalogUnitDigests(tables);
    const digest = yield* hashInstalledCatalogUnit(snapshot);
    if (digest !== snapshot.unitHash) {
      return yield* new CatalogUnitCorrupt({
        message: "catalog unit hash mismatch",
        catalog: snapshot.catalog.id,
      });
    }
    const decoded = yield* Effect.fromResult(
      decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(snapshot)),
    );
    return verifiedInstalledCatalogUnit(freezePlain(clonePlain(decoded)));
  },
);

export const catalogUnitCanonicalBytes = (document: InstalledCatalogUnit): Uint8Array =>
  new TextEncoder().encode(canonicalizeInstalledCatalogUnit(document));
