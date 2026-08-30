/** Immutable permanent-key catalog-definition assembly (#323). */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  isCatalogDefinition,
  type CatalogDefinition,
} from "../../Catalog.ts";
import { cloneBindingValue } from "../../db/Binding.ts";
import {
  compileCreationPlan,
  pairDeployedCreationDefaults,
  resolveCompiledCreationValues,
  type CompiledCreationOptions,
  type CompiledCreationPlan,
  type CompositionValueMetadata,
  type DeployedCreationDefaultBinding,
} from "../../db/creation.ts";
import { type CreationDefaultContext } from "../../db/Field.ts";
import {
  collectCodeReachability,
  type ReachableCodeDefinition,
} from "../../db/reachability.ts";
import type { CompositionIndex } from "../core/composition.ts";
import type { CatalogDescriptor } from "./catalog.ts";
import {
  type AssembleCatalogUnitFailure,
  type InstalledCatalogUnitV2,
  sealInstalledCatalogUnit,
} from "./catalog-unit.ts";
import { compositionFromUnit } from "./composition.ts";
import {
  decodePolicyTemplateResult,
  hashCatalogSchemaFingerprint,
  hashDomainSeparatedCanonicalJson,
} from "./decode.ts";
import {
  CatalogMismatch,
  CatalogUnitCorrupt,
  CatalogVersionMismatch,
  InvalidIR,
} from "./failures.ts";
import {
  CatalogId,
  type CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  type DigestHex,
  SchemaFingerprint,
} from "./identities.ts";
import { installAuthorization, type InstallFailure } from "./install.ts";
import type { JsonValue } from "./json.ts";
import { completeSchema, descriptorTables } from "./read-tables.ts";
import {
  lowerOwnedOperationSnapshots,
  pairDeployedOperations,
  snapshotOwnedOperations,
  type DeployedOperationBinding,
  type OwnedOperationSnapshot,
} from "./authoring/operations.ts";
import {
  requireCatalogKey,
  requireUnitHash,
  type CatalogBoundRef,
  type DeployedCatalog,
  type DeployedCatalogs,
} from "./deployed.ts";

export type InstalledFieldRuntime = {
  readonly cardinality: "one" | "many";
  readonly validate: (value: unknown) => void;
  readonly fixed:
    | { readonly _tag: "mutable" }
    | { readonly _tag: "fixed"; readonly value: unknown };
};

export type InstalledCatalogDefinition = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly unit: InstalledCatalogUnitV2;
  readonly composition: CompositionIndex;
  /** Sealed descriptors paired with private native codecs and executables. */
  readonly operations: readonly DeployedOperationBinding[];
  readonly path: readonly string[];
  /** Resolve authoritative creation values from assembly's binding snapshot. */
  readonly resolveCreationValues: (
    entityName: string,
    input: Readonly<Record<string, unknown>>,
    context: CreationDefaultContext,
    options?: CompiledCreationOptions,
  ) => Readonly<Record<string, unknown>>;
  /** Exact private field codec/fixed binding captured from deployed code. */
  readonly requireFieldRuntime: (
    entityName: string,
    fieldIdent: string,
  ) => InstalledFieldRuntime;
  /** Validate one definition-directed stored value with its deployed codec. */
  readonly validateFieldValue: (
    fieldIdent: string,
    value: unknown,
  ) => void;
};

export type CatalogDefinitions = {
  readonly root: CatalogId;
  readonly require: (
    catalogKey: CatalogId,
  ) => Result.Result<InstalledCatalogDefinition, CatalogMismatch>;
  readonly keys: () => readonly CatalogId[];
};

export type CatalogDefinitionDeployment = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
};

export type DeployedCatalogDefinition = {
  readonly database: DatabaseId;
  readonly definition: InstalledCatalogDefinition;
};

/**
 * Immutable deployment-owned database -> runnable definition binding. The
 * request may prove the catalog key/hash, but it never selects this pairing.
 */
export type DeployedCatalogDefinitions = {
  readonly catalogs: DeployedCatalogs;
  readonly requireDatabase: (
    database: DatabaseId,
  ) => Result.Result<DeployedCatalogDefinition, CatalogMismatch>;
  readonly databases: () => readonly DatabaseId[];
};

export type CatalogDefinitionBoundRef = {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

export type AssembleCatalogDefinitionsInput = {
  readonly root: CatalogDefinition;
  /** SHA-256 identity of the immutable deployment containing these definitions. */
  readonly artifactHash: DigestHex;
};

type AssemblyFailure =
  | AssembleCatalogUnitFailure
  | CatalogUnitCorrupt
  | InstallFailure
  | InvalidIR;

type NormalizedDefinitionSnapshot = {
  readonly catalog: CatalogId;
  readonly key: string;
  readonly path: readonly string[];
  readonly policy: CatalogDefinition["policy"];
  readonly descriptorTables: Omit<
    CatalogDescriptor,
    "database" | "version" | "fingerprint"
  >;
  readonly creationPlans: readonly CompiledCreationPlan[];
  readonly creationDefaultBindings: readonly DeployedCreationDefaultBinding[];
  readonly creationHashMaterial: JsonValue;
  readonly operationSnapshots: readonly OwnedOperationSnapshot[];
};

const invalid = (message: string): InvalidIR => new InvalidIR({ message });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const CATALOG_DEFINITION_VERSION_DOMAIN = "ramose/catalog-definition/v1\0";

const fromPure = <A>(label: string, evaluate: () => A): Effect.Effect<A, InvalidIR> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => invalid(
      `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
    ),
  });


const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { _tag: "instant", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { _tag: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort(compareText)) {
      out[key] = jsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("catalog fixed values must encode as finite stored data");
};

/** Type-explicit encoding prevents Date/bytes from colliding with JSON lookalikes. */
const creationInputHashValue = (value: unknown): JsonValue => {
  if (value === null) return { _tag: "null" };
  if (typeof value === "string") return { _tag: "string", value };
  if (typeof value === "boolean") return { _tag: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { _tag: "number", value: Object.is(value, -0) ? 0 : value };
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { _tag: "instant", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { _tag: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) {
    return { _tag: "array", value: value.map(creationInputHashValue) };
  }
  if (typeof value === "object" && value !== null) {
    return {
      _tag: "object",
      value: Object.keys(value).sort(compareText).map((key) => [
        key,
        creationInputHashValue((value as Record<string, unknown>)[key]),
      ]),
    };
  }
  throw new Error("creation default inputs must encode as supported canonical data");
};

/** Canonical identity derived from the same copied records as the runtime plan. */
const creationHashMaterial = (
  artifactHash: DigestHex,
  plans: readonly CompiledCreationPlan[],
): JsonValue => ({
  artifactHash,
  entities: [...plans].sort((left, right) => compareText(left.entity, right.entity))
    .map((plan) => ({
      name: plan.entity,
      fieldSchemas: [...plan.fields]
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          projection: field.schemaProjection as JsonValue,
        })),
      fieldDefaults: plan.fields
        .filter((field) => field.fieldDefault !== undefined)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          default: {
            id: field.fieldDefault!.id,
            artifactHash: field.fieldDefault!.artifactHash,
            revision: field.fieldDefault!.revision._tag === "artifact"
              ? "artifact"
              : creationInputHashValue(field.fieldDefault!.revision.inputs),
          },
        })),
      fixed: plan.fields
        .filter((field) => field.fixed !== undefined)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({ field: field.ident, value: jsonValue(field.fixed) })),
      defaults: plan.fields
        .filter((field) => field.defaults.length > 0)
        .sort((left, right) => compareText(left.ident, right.ident))
        .map((field) => ({
          field: field.ident,
          defaults: field.defaults.map((entry) => ({
            id: entry.id,
            artifactHash: entry.artifactHash,
            revision: entry.revision._tag === "artifact"
              ? "artifact"
              : creationInputHashValue(entry.revision.inputs),
          })),
        })),
      bindings: plan.bindings,
    })),
});


const normalizeDefinitionSnapshot = (
  reachable: ReachableCodeDefinition,
  artifactHash: DigestHex,
  metadataByEntity: ReadonlyMap<string, CompositionValueMetadata>,
): NormalizedDefinitionSnapshot => {
  if (!isCatalogDefinition(reachable.definition)) {
    throw invalid(
      `reachable key '${reachable.key}' has no runnable Catalog definition (path: ${reachable.path.join(" → ")})`,
    );
  }
  const catalog = CatalogId.make(reachable.definition.key);
  const schema = completeSchema(reachable.definition);
  const creationSnapshots = Object.freeze(
    Object.values(schema.entities)
      .sort((left, right) => compareText(left.ns, right.ns))
      .map((entity) => {
        const metadata = metadataByEntity.get(entity.ns);
        if (metadata === undefined) {
          throw invalid(`missing resolved binding metadata for entity '${entity.ns}'`);
        }
        return compileCreationPlan(entity, metadata, artifactHash);
      }),
  );
  const creationPlans = Object.freeze(
    creationSnapshots.map((snapshot) => snapshot.plan),
  );
  const creationDefaultBindings = Object.freeze(
    creationSnapshots.flatMap((snapshot) => snapshot.defaults),
  );
  const operationSnapshots = Result.getOrThrow(
    snapshotOwnedOperations(catalog, [schema], artifactHash),
  );
  return Object.freeze({
    catalog,
    key: reachable.definition.key,
    path: Object.freeze([...reachable.path]),
    policy: reachable.definition.policy,
    descriptorTables: Object.freeze(descriptorTables(catalog, schema, [])),
    creationPlans,
    creationDefaultBindings,
    creationHashMaterial: Object.freeze(
      creationHashMaterial(artifactHash, creationPlans),
    ),
    operationSnapshots,
  });
};

const assembleOne = Effect.fn("Authorization.assembleCatalogDefinition")(
  function* (
    snapshot: NormalizedDefinitionSnapshot,
  ): Effect.fn.Return<InstalledCatalogDefinition, AssemblyFailure> {
    const authoredPolicy = Effect.isEffect(snapshot.policy)
      ? yield* snapshot.policy
      : snapshot.policy;
    const template = yield* Effect.fromResult(
      decodePolicyTemplateResult(authoredPolicy),
    );
    const lowered = yield* lowerOwnedOperationSnapshots(snapshot.operationSnapshots);
    const tables = {
      ...snapshot.descriptorTables,
      operations: lowered.descriptors,
    };
    const version = CatalogVersion.make(yield* hashDomainSeparatedCanonicalJson(
      CATALOG_DEFINITION_VERSION_DOMAIN,
      snapshot.creationHashMaterial,
    ));
    const descriptorWithoutFingerprint = {
      ...tables,
      // Definition-local seal target. Concrete DatabaseId binding is #459.
      database: DatabaseId.make(`catalog-definition:${snapshot.key}`),
      version,
      fingerprint: SchemaFingerprint.make("pending"),
    } satisfies CatalogDescriptor;
    const fingerprint = yield* hashCatalogSchemaFingerprint(descriptorWithoutFingerprint);
    const descriptor: CatalogDescriptor = {
      ...descriptorWithoutFingerprint,
      fingerprint,
    };
    const policy = yield* installAuthorization({
      target: {
        database: descriptor.database,
        catalog: snapshot.catalog,
        catalogVersion: descriptor.version,
        schemaFingerprint: descriptor.fingerprint,
      },
      descriptor,
      template,
    });
    const unit = yield* sealInstalledCatalogUnit(descriptor, policy);
    const operations = yield* Effect.fromResult(
      pairDeployedOperations(unit.catalog.operations, lowered.definitions),
    );
    const creationDefaults = yield* fromPure(
      "creation default binding failed",
      () => pairDeployedCreationDefaults(
        snapshot.creationPlans,
        snapshot.creationDefaultBindings,
      ),
    );
    const composition = yield* Effect.fromResult(compositionFromUnit(unit));
    const creationByEntity = new Map(
      snapshot.creationPlans.map((plan) => [plan.entity, plan] as const),
    );
    const catalogKeyText = snapshot.key;
    const resolveCreationValues = Object.freeze((
      entityName: string,
      input: Readonly<Record<string, unknown>>,
      context: CreationDefaultContext,
      options: CompiledCreationOptions = {},
    ): Readonly<Record<string, unknown>> => {
      const plan = creationByEntity.get(entityName);
      if (plan === undefined) {
        throw new Error(
          `ramose/create: unknown entity ${JSON.stringify(entityName)} in catalog ${JSON.stringify(catalogKeyText)}`,
        );
      }
      return resolveCompiledCreationValues(
        plan,
        input,
        context,
        creationDefaults,
        options,
      );
    });
    const requireFieldRuntime = Object.freeze((
      entityName: string,
      fieldIdent: string,
    ): InstalledFieldRuntime => {
      const plan = creationByEntity.get(entityName);
      const field = plan?.fields.find((candidate) => candidate.ident === fieldIdent);
      if (field === undefined) {
        throw new Error(
          `ramose/operation: field ${JSON.stringify(fieldIdent)} is not deployed for entity ${JSON.stringify(entityName)}`,
        );
      }
      return Object.freeze({
        cardinality: field.cardinality,
        validate: (value: unknown): void => {
          field.encoder(value);
        },
        fixed: field.fixed === undefined
          ? Object.freeze({ _tag: "mutable" as const })
          : Object.freeze({
            _tag: "fixed" as const,
            value: cloneBindingValue(field.fixed),
          }),
      });
    });
    const fieldValidators = new Map<string, (value: unknown) => unknown>();
    for (const plan of snapshot.creationPlans) {
      for (const field of plan.fields) {
        if (!fieldValidators.has(field.ident)) {
          fieldValidators.set(field.ident, field.encoder);
        }
      }
    }
    const validateFieldValue = Object.freeze((
      fieldIdent: string,
      value: unknown,
    ): void => {
      const validate = fieldValidators.get(fieldIdent);
      if (validate === undefined) {
        throw new Error(
          `ramose/operation: field ${JSON.stringify(fieldIdent)} has no deployed codec`,
        );
      }
      validate(value);
    });
    return Object.freeze({
      catalogKey: snapshot.catalog,
      unitHash: unit.unitHash,
      unit,
      composition,
      operations,
      path: snapshot.path,
      resolveCreationValues,
      requireFieldRuntime,
      validateFieldValue,
    });
  },
);

const buildRegistry = (
  root: CatalogId,
  byKey: ReadonlyMap<CatalogId, InstalledCatalogDefinition>,
): CatalogDefinitions => Object.freeze({
  root,
  require: (catalogKey: CatalogId) => {
    const found = byKey.get(catalogKey);
    return found === undefined
      ? Result.fail(new CatalogMismatch({ message: "catalog definition mismatch" }))
      : Result.succeed(found);
  },
  keys: () => Object.freeze([...byKey.keys()].sort(compareText)),
});

/** Resolve a definition and require its exact immutable unit hash. */
export const resolveCatalogDefinition = (
  definitions: CatalogDefinitions,
  ref: CatalogDefinitionBoundRef,
): Result.Result<
  InstalledCatalogDefinition,
  CatalogMismatch | CatalogVersionMismatch
> => Result.gen(function* () {
  const definition = yield* definitions.require(ref.catalogKey);
  yield* requireUnitHash(ref.unitHash, definition.unitHash, definition.catalogKey);
  return definition;
});

/**
 * Startup/orchestration shell. Reachability, closure, lookup, and agreement
 * stay pure; hashing, operation lowering, policy install, and sealing use one
 * Effect boundary.
 */
export const assembleCatalogDefinitions = Effect.fn(
  "Authorization.assembleCatalogDefinitions",
)(function* (
  input: AssembleCatalogDefinitionsInput,
): Effect.fn.Return<CatalogDefinitions, AssemblyFailure> {
  if (!/^[0-9a-f]{64}$/.test(input.artifactHash)) {
    return yield* invalid("catalog artifact hash must be 64 lowercase hexadecimal characters");
  }
  const reachability = yield* fromPure(
    "catalog definition reachability failed",
    () => collectCodeReachability(input.root),
  );
  const snapshots = yield* fromPure(
    "catalog definition authoring snapshot failed",
    () => reachability.definitions.map((reachable) => {
      const metadataByEntity = new Map<string, CompositionValueMetadata>();
      for (const creation of reachability.creation) {
        if (creation.catalogKey === reachable.key) {
          metadataByEntity.set(creation.entity, creation.metadata);
        }
      }
      return normalizeDefinitionSnapshot(
        reachable,
        input.artifactHash,
        metadataByEntity,
      );
    }),
  );
  const byKey = new Map<CatalogId, InstalledCatalogDefinition>();
  for (const snapshot of snapshots) {
    const assembled = yield* assembleOne(snapshot);
    byKey.set(assembled.catalogKey, assembled);
  }
  return buildRegistry(CatalogId.make(reachability.root.key), Object.freeze(byKey));
});

/**
 * Bind assembled runnable definitions to concrete route databases once at
 * deployment startup. This is deliberately not a request or module-global
 * registration API.
 */
export const deployCatalogDefinitions = (
  definitions: CatalogDefinitions,
  deployments: readonly CatalogDefinitionDeployment[],
): Result.Result<DeployedCatalogDefinitions, CatalogMismatch | InvalidIR> =>
  Result.gen(function* () {
    const byDatabase = new Map<DatabaseId, DeployedCatalogDefinition>();
    const readCatalogs = new Map<DatabaseId, DeployedCatalog>();
    for (const deployment of deployments) {
      if (byDatabase.has(deployment.database)) {
        return yield* Result.fail(new InvalidIR({
          message: `duplicate deployed catalog definition for database '${deployment.database}'`,
        }));
      }
      const definition = yield* definitions.require(deployment.catalogKey);
      const bound = Object.freeze({
        database: deployment.database,
        definition,
      });
      byDatabase.set(deployment.database, bound);
      readCatalogs.set(deployment.database, Object.freeze({
        database: deployment.database,
        catalogKey: definition.catalogKey,
        unitHash: definition.unitHash,
        unit: definition.unit,
        composition: definition.composition,
      }));
    }
    const databases = (): readonly DatabaseId[] =>
      Object.freeze([...byDatabase.keys()].sort(compareText));
    const requireDatabase = (
      database: DatabaseId,
    ): Result.Result<DeployedCatalogDefinition, CatalogMismatch> => {
      const found = byDatabase.get(database);
      return found === undefined
        ? Result.fail(new CatalogMismatch({
          message: "catalog mismatch",
          expectedDatabase: database,
        }))
        : Result.succeed(found);
    };
    const catalogs: DeployedCatalogs = Object.freeze({
      requireDatabase: (database: DatabaseId) => {
        const found = readCatalogs.get(database);
        return found === undefined
          ? Result.fail(new CatalogMismatch({
            message: "catalog mismatch",
            expectedDatabase: database,
          }))
          : Result.succeed(found);
      },
      databases,
    });
    return Object.freeze({ catalogs, requireDatabase, databases });
  });

/** Database-first resolution of one exact runnable deployed definition. */
export const resolveDeployedCatalogDefinition = (
  deployed: DeployedCatalogDefinitions,
  ref: CatalogBoundRef,
): Result.Result<
  DeployedCatalogDefinition,
  CatalogMismatch | CatalogVersionMismatch
> => Result.gen(function* () {
  const found = yield* deployed.requireDatabase(ref.database);
  yield* requireCatalogKey(ref.catalogKey, found.definition.catalogKey);
  yield* requireUnitHash(
    ref.unitHash,
    found.definition.unitHash,
    found.definition.catalogKey,
  );
  return found;
});
