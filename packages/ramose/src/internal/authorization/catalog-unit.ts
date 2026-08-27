/**
 * Schema-backed installed catalog unit and the only seal path.
 *
 * One immutable document holds schema tables, canonical identities,
 * operation descriptors, and the installed read policy. Partial
 * components cannot be assembled or sealed independently.
 * Structural decode of {@link InstalledCatalogUnit} is not
 * {@link InstalledCatalogUnitV1}; only {@link sealInstalledCatalogUnit}
 * and verified load may produce the brand.
 */

import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  EntityDescriptor,
  OperationDescriptor,
  TraitComposition,
  TraitDescriptor,
  FieldDescriptor,
  type CatalogDescriptor,
} from "./catalog.ts";
import {
  canonicalizeInstalledCatalogUnit,
  decodeInstalledCatalogUnitResult,
  encodeInstalledCatalogUnit,
  hashInstalledCatalogUnit,
} from "./decode.ts";
import { CatalogMismatch, CatalogUnitCorrupt, InvalidIR } from "./failures.ts";
import {
  CatalogId,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  SchemaFingerprint,
} from "./identities.ts";
import {
  InstalledAuthorizationIR,
  InstalledIdentityTable,
  type InstalledAuthorizationIR as InstalledAuthorizationIRType,
  type InstalledAuthorizationIRV1 as InstalledAuthorizationIRV1Type,
  type InstalledIdentityTable as InstalledIdentityTableType,
} from "./ir.ts";
import {
  normalizeIdentities,
  normalizeOperations,
  normalizeTraitComposition,
} from "./install/normalize.ts";
import { prepareAuthorizationCatalog } from "./validation/catalog.ts";
import { invalid, mismatch, type ValidateFailure } from "./validation/common.ts";
import { AUTHORIZATION_LANGUAGE_VERSION, AuthorizationLanguageVersion } from "./version.ts";
import type { JsonValue } from "./json.ts";
import { canonicalizeJson } from "./canonical-json.ts";

export const INSTALLED_CATALOG_UNIT_VERSION = 1 as const;
export const InstalledCatalogUnitVersion = Schema.Literal(INSTALLED_CATALOG_UNIT_VERSION);
export type InstalledCatalogUnitVersion = typeof InstalledCatalogUnitVersion.Type;

/**
 * Complete installed catalog document. Decode checks shape and identity
 * collisions only — not {@link unitHash} or component completeness at
 * the storage boundary. This is not a publishable brand.
 */
export const InstalledCatalogUnit = Schema.TaggedStruct("InstalledCatalogUnit", {
  version: InstalledCatalogUnitVersion,
  languageVersion: AuthorizationLanguageVersion,
  database: DatabaseId,
  catalog: CatalogId,
  catalogVersion: CatalogVersion,
  schemaFingerprint: SchemaFingerprint,
  unitHash: CatalogUnitHash,
  entities: Schema.Array(EntityDescriptor),
  traits: Schema.Array(TraitDescriptor),
  fields: Schema.Array(FieldDescriptor),
  traitComposition: Schema.Array(TraitComposition),
  identities: InstalledIdentityTable,
  operations: Schema.Array(OperationDescriptor),
  policy: InstalledAuthorizationIR,
});
export type InstalledCatalogUnit = typeof InstalledCatalogUnit.Type;

/**
 * Verified/sealed v1 catalog unit. Distinct from Schema-decoded
 * structural output. Only {@link sealInstalledCatalogUnit} and the
 * hash-verified load path produce this brand.
 */
export type InstalledCatalogUnitV1 = InstalledCatalogUnit & Brand.Brand<"InstalledCatalogUnitV1">;

export type AssembleCatalogUnitFailure = ValidateFailure;

const PLACEHOLDER_UNIT_HASH = CatalogUnitHash.make("0".repeat(64));

const verifiedInstalledCatalogUnit = Brand.nominal<InstalledCatalogUnitV1>();

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

const canonicalEqual = (left: unknown, right: unknown, label: string): Result.Result<void, ValidateFailure> => {
  try {
    if (canonicalizeJson(encodedJson(left)) === canonicalizeJson(encodedJson(right))) {
      return Result.succeed(undefined);
    }
  } catch (cause) {
    return invalid(
      `ambiguous ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return mismatch({
    message: `installed policy ${label} do not match catalog descriptor`,
  });
};

const requirePresent = (value: unknown, label: string): Result.Result<void, ValidateFailure> => {
  if (value === undefined || value === null) {
    return invalid(`missing ${label}`);
  }
  return Result.succeed(undefined);
};

const requireIdentityTable = (
  identities: InstalledIdentityTableType | undefined,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* requirePresent(identities, "identity table");
    yield* requirePresent(identities!.entities, "entity identity table");
    yield* requirePresent(identities!.traits, "trait identity table");
    yield* requirePresent(identities!.fields, "field identity table");
    yield* requirePresent(identities!.operations, "operation identity table");
  });

const requireDescriptorTables = (
  descriptor: CatalogDescriptor,
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
    yield* requireIdentityTable(policy.identities);
    yield* requirePresent(policy.operations, "policy operations");
    yield* requirePresent(policy.traitComposition, "policy traitComposition");
  });

type CatalogIdentity = {
  readonly database: InstalledCatalogUnit["database"];
  readonly catalog: InstalledCatalogUnit["catalog"];
  readonly catalogVersion: InstalledCatalogUnit["catalogVersion"];
  readonly schemaFingerprint: InstalledCatalogUnit["schemaFingerprint"];
};

const requireMatchingIdentityFields = (
  expected: CatalogIdentity,
  actual: CatalogIdentity,
): Result.Result<void, ValidateFailure> => {
  if (expected.catalog !== actual.catalog) {
    return mismatch({
      message: "catalog does not match installed policy",
      expected: expected.catalog,
      actual: actual.catalog,
    });
  }
  if (expected.database !== actual.database) {
    return mismatch({
      message: "database does not match installed policy",
      expectedDatabase: expected.database,
      actualDatabase: actual.database,
    });
  }
  if (expected.catalogVersion !== actual.catalogVersion) {
    return mismatch({
      message: "catalog version does not match installed policy",
      expectedVersion: expected.catalogVersion,
      actualVersion: actual.catalogVersion,
    });
  }
  if (expected.schemaFingerprint !== actual.schemaFingerprint) {
    return mismatch({
      message: "schema fingerprint does not match installed policy",
      expectedFingerprint: expected.schemaFingerprint,
      actualFingerprint: actual.schemaFingerprint,
    });
  }
  return Result.succeed(undefined);
};

const requireMatchingIdentity = (
  descriptor: CatalogDescriptor,
  policy: InstalledAuthorizationIRType,
): Result.Result<void, ValidateFailure> =>
  requireMatchingIdentityFields(
    {
      database: descriptor.database,
      catalog: descriptor.id,
      catalogVersion: descriptor.version,
      schemaFingerprint: descriptor.fingerprint,
    },
    {
      database: policy.database,
      catalog: policy.catalog,
      catalogVersion: policy.catalogVersion,
      schemaFingerprint: policy.schemaFingerprint,
    },
  );

const encodeIdentities = (table: InstalledIdentityTableType): unknown =>
  Schema.encodeUnknownSync(InstalledIdentityTable)(table);

const encodeOperations = (
  operations: ReadonlyArray<CatalogDescriptor["operations"][number]>,
): unknown => operations.map((operation) => Schema.encodeUnknownSync(OperationDescriptor)(operation));

const encodeComposition = (rows: ReadonlyArray<TraitComposition>): unknown =>
  rows.map((row) => Schema.encodeUnknownSync(TraitComposition)(row));

const schemaDescriptorFromUnit = (document: InstalledCatalogUnit): CatalogDescriptor => ({
  id: document.catalog,
  database: document.database,
  version: document.catalogVersion,
  fingerprint: document.schemaFingerprint,
  entities: document.entities,
  traits: document.traits,
  fields: document.fields,
  operations: document.operations,
  traitComposition: document.traitComposition,
});

/**
 * Fail-closed document kernel shared by assemble and verify. Top-level
 * identity, language versions, required tables, and schema-derived
 * identities/operations/traitComposition must agree with both the unit
 * tables and the embedded policy.
 */
export const requireUnitCoherence = (
  document: InstalledCatalogUnit,
): Result.Result<void, ValidateFailure> =>
  Result.gen(function* () {
    yield* requirePresent(document.entities, "entities");
    yield* requirePresent(document.traits, "traits");
    yield* requirePresent(document.fields, "fields");
    yield* requirePresent(document.operations, "operations");
    yield* requirePresent(document.traitComposition, "traitComposition");
    if (!Array.isArray(document.entities)) return yield* invalid("missing entities");
    if (!Array.isArray(document.traits)) return yield* invalid("missing traits");
    if (!Array.isArray(document.fields)) return yield* invalid("missing fields");
    if (!Array.isArray(document.operations)) return yield* invalid("missing operations");
    if (!Array.isArray(document.traitComposition)) {
      return yield* invalid("missing traitComposition");
    }
    yield* requirePolicyPresent(document.policy);
    yield* requireIdentityTable(document.identities);
    yield* prepareAuthorizationCatalog(
      {
        database: document.database,
        catalog: document.catalog,
        catalogVersion: document.catalogVersion,
        schemaFingerprint: document.schemaFingerprint,
      },
      schemaDescriptorFromUnit(document),
    );
    yield* requireLanguageVersion(document.languageVersion, "catalog unit");
    yield* requireLanguageVersion(document.policy.languageVersion, "embedded policy");
    yield* requireMatchingIdentityFields(
      {
        database: document.database,
        catalog: document.catalog,
        catalogVersion: document.catalogVersion,
        schemaFingerprint: document.schemaFingerprint,
      },
      {
        database: document.policy.database,
        catalog: document.policy.catalog,
        catalogVersion: document.policy.catalogVersion,
        schemaFingerprint: document.policy.schemaFingerprint,
      },
    );

    const [identities, operations, traitComposition] = yield* Result.all([
      normalizeIdentities(schemaDescriptorFromUnit(document)),
      normalizeOperations(document.operations),
      normalizeTraitComposition(document.traitComposition),
    ]);

    yield* canonicalEqual(encodeIdentities(identities), encodeIdentities(document.identities), "identities");
    yield* canonicalEqual(
      encodeIdentities(identities),
      encodeIdentities(document.policy.identities),
      "identities",
    );
    yield* canonicalEqual(encodeOperations(operations), encodeOperations(document.operations), "operations");
    yield* canonicalEqual(
      encodeOperations(operations),
      encodeOperations(document.policy.operations),
      "operations",
    );
    yield* canonicalEqual(
      encodeComposition(traitComposition),
      encodeComposition(document.traitComposition),
      "traitComposition",
    );
    yield* canonicalEqual(
      encodeComposition(traitComposition),
      encodeComposition(document.policy.traitComposition),
      "traitComposition",
    );
  });

/**
 * Private-shaped pure assembly. Returns tables without `_tag` or
 * `unitHash` so the result is not a runtime-acceptable catalog unit.
 */
export const assembleInstalledCatalogUnit = (
  descriptor: CatalogDescriptor,
  policy: InstalledAuthorizationIRType,
): Result.Result<UnhashedCatalogUnitTables, AssembleCatalogUnitFailure> =>
  Result.gen(function* () {
    yield* requireDescriptorTables(descriptor);
    yield* requirePolicyPresent(policy);
    yield* requireLanguageVersion(policy.languageVersion, "installed policy");
    yield* requireLanguageVersion(AUTHORIZATION_LANGUAGE_VERSION, "catalog unit");
    yield* requireMatchingIdentity(descriptor, policy);

    const [identities, operations, traitComposition] = yield* Result.all([
      normalizeIdentities(descriptor),
      normalizeOperations(descriptor.operations),
      normalizeTraitComposition(descriptor.traitComposition),
    ]);

    yield* canonicalEqual(encodeIdentities(policy.identities), encodeIdentities(identities), "identities");
    yield* canonicalEqual(encodeOperations(policy.operations), encodeOperations(operations), "operations");
    yield* canonicalEqual(
      encodeComposition(policy.traitComposition),
      encodeComposition(traitComposition),
      "traitComposition",
    );

    const tables = {
      version: INSTALLED_CATALOG_UNIT_VERSION,
      languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
      database: descriptor.database,
      catalog: descriptor.id,
      catalogVersion: descriptor.version,
      schemaFingerprint: descriptor.fingerprint,
      entities: descriptor.entities,
      traits: descriptor.traits,
      fields: descriptor.fields,
      traitComposition,
      identities,
      operations,
      policy,
    };
    yield* requireUnitCoherence({
      _tag: "InstalledCatalogUnit",
      ...tables,
      unitHash: PLACEHOLDER_UNIT_HASH,
    });
    return tables;
  });

/**
 * The only producer of {@link InstalledCatalogUnitV1} besides verified
 * load. Bind the complete descriptor to a sealed policy, hash the
 * canonical document minus `unitHash`, and freeze the brand.
 */
export const sealInstalledCatalogUnit = Effect.fn("Authorization.sealInstalledCatalogUnit")(
  function* (
    descriptor: CatalogDescriptor,
    policy: InstalledAuthorizationIRV1Type,
  ): Effect.fn.Return<InstalledCatalogUnitV1, AssembleCatalogUnitFailure> {
    const tables = yield* Effect.fromResult(assembleInstalledCatalogUnit(descriptor, policy));
    const hashingDocument: InstalledCatalogUnit = {
      _tag: "InstalledCatalogUnit",
      ...tables,
      unitHash: PLACEHOLDER_UNIT_HASH,
    };
    const unitHash = yield* hashInstalledCatalogUnit(hashingDocument);
    const assembled: InstalledCatalogUnit = {
      _tag: "InstalledCatalogUnit",
      ...clonePlain(tables),
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
 * alone is not {@link InstalledCatalogUnitV1}. Coherence, hash, and an
 * encode/decode round-trip must all succeed before the brand is applied.
 */
export const verifyInstalledCatalogUnit = Effect.fn("Authorization.verifyInstalledCatalogUnit")(
  function* (
    document: InstalledCatalogUnit,
  ): Effect.fn.Return<InstalledCatalogUnitV1, InvalidIR | CatalogMismatch | CatalogUnitCorrupt> {
    yield* Effect.fromResult(requireUnitCoherence(document));
    const digest = yield* hashInstalledCatalogUnit(document);
    if (digest !== document.unitHash) {
      return yield* new CatalogUnitCorrupt({
        message: "catalog unit hash mismatch",
        catalog: document.catalog,
      });
    }
    const decoded = yield* Effect.fromResult(
      decodeInstalledCatalogUnitResult(encodeInstalledCatalogUnit(document)),
    );
    return verifiedInstalledCatalogUnit(freezePlain(clonePlain(decoded)));
  },
);

export const catalogUnitCanonicalBytes = (document: InstalledCatalogUnit): Uint8Array =>
  new TextEncoder().encode(canonicalizeInstalledCatalogUnit(document));
