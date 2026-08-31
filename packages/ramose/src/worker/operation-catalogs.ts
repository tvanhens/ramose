import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { AnySchemaDefinition } from "../db/Schema.ts";
import {
  assembleCatalogDefinitions,
  deployCatalogDefinitions,
  type DeployedCatalogDefinitions,
} from "../internal/authorization/definitions.ts";
import {
  deployDatabaseCatalogBindings,
  unavailableDatabaseCatalogBindings,
  type DatabaseCatalogBindings,
} from "../internal/authorization/database-bindings.ts";
import type { DeployedCatalogs } from "../internal/authorization/deployed.ts";
import {
  CatalogId,
  DatabaseId,
  type CatalogUnitHash,
  type DigestHex,
} from "../internal/authorization/identities.ts";
import { sha256Hex } from "../internal/core/bytes.ts";

const OperationCatalogsTypeId = Symbol.for("ramose/worker/OperationCatalogs");

export interface OperationCatalogProof {
  readonly catalog: string;
  readonly unitHash: string;
}

export interface OperationCatalogs {
  readonly [OperationCatalogsTypeId]: typeof OperationCatalogsTypeId;
  readonly proof: (database: string) => OperationCatalogProof | undefined;
}

export interface OperationCatalogDeployment {
  readonly database: string;
  readonly catalogKey?: string;
}

export interface DeployOperationCatalogsInput {
  readonly root: AnySchemaDefinition;
  readonly deployments: readonly OperationCatalogDeployment[];
}

export class OperationCatalogDeploymentError extends Data.TaggedError(
  "OperationCatalogDeploymentError",
)<{ readonly message: string }> {}

type OperationCatalogState = {
  readonly deployed: DeployedCatalogDefinitions;
  readonly bindings: DatabaseCatalogBindings;
};

const registries = new WeakMap<OperationCatalogs, OperationCatalogState>();

const deploymentError = (cause: unknown): OperationCatalogDeploymentError =>
  new OperationCatalogDeploymentError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

const DEPLOYMENT_ID_DOMAIN = "ramose:worker-deployment:v1\0";
const textEncoder = new TextEncoder();

const UNAVAILABLE_MESSAGE =
  "ramose: this Worker instance started without a deployment version " +
  "(CF_VERSION_METADATA.id was empty — Cloudflare's upload-validation " +
  "instance); it cannot serve catalog-bound requests";

const startedWithoutDeploymentVersion = (metadata: unknown): boolean => {
  if (typeof metadata !== "object" || metadata === null) return false;
  const id = (metadata as { readonly id?: unknown }).id;
  return id === "" || id === undefined;
};

const unavailable = (): never => {
  throw new OperationCatalogDeploymentError({ message: UNAVAILABLE_MESSAGE });
};

const unavailableState = (): OperationCatalogState => {
  const catalogs: DeployedCatalogs = Object.freeze({
    requireDatabase: unavailable,
    databases: unavailable,
  });
  return {
    deployed: Object.freeze({
      catalogs,
      requireDatabase: unavailable,
      databases: unavailable,
    }),
    bindings: unavailableDatabaseCatalogBindings(unavailable),
  };
};

const artifactHashForDeployment = (
  metadata: unknown,
): Effect.Effect<DigestHex, OperationCatalogDeploymentError> => {
  const id = typeof metadata === "object" && metadata !== null
    ? (metadata as { readonly id?: unknown }).id
    : undefined;
  if (typeof id !== "string" || !/^[\x21-\x7e]{1,256}$/.test(id)) {
    return Effect.fail(new OperationCatalogDeploymentError({
      message:
        "CF_VERSION_METADATA.id must be a non-empty deployment version string",
    }));
  }
  return Effect.tryPromise({
    try: () => sha256Hex(textEncoder.encode(`${DEPLOYMENT_ID_DOMAIN}${id}`)),
    catch: deploymentError,
  }).pipe(Effect.map((digest) => digest as DigestHex));
};

const wrapOperationCatalogs = (
  deployed: DeployedCatalogDefinitions,
  bindings: DatabaseCatalogBindings,
): OperationCatalogs => {
  const operationCatalogs: OperationCatalogs = Object.freeze({
    [OperationCatalogsTypeId]: OperationCatalogsTypeId as typeof OperationCatalogsTypeId,
    proof: (database: string): OperationCatalogProof | undefined => {
      const bound = Result.getOrUndefined(
        deployed.requireDatabase(DatabaseId.make(database)),
      );
      return bound === undefined
        ? undefined
        : Object.freeze({
          catalog: bound.definition.catalogKey,
          unitHash: bound.definition.unitHash,
        });
    },
  });
  registries.set(operationCatalogs, { deployed, bindings });
  return operationCatalogs;
};

export const deployedCatalogProof = (
  operationCatalogs: OperationCatalogs,
  database: string,
): {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
} | undefined => {
  const state = registries.get(operationCatalogs);
  if (state === undefined) return undefined;
  const bound = Result.getOrUndefined(
    state.deployed.requireDatabase(DatabaseId.make(database)),
  );
  return bound === undefined ? undefined : Object.freeze({
    catalogKey: bound.definition.catalogKey,
    unitHash: bound.definition.unitHash,
  });
};

export const deployedOperationCatalogs = (
  operationCatalogs: OperationCatalogs,
): DeployedCatalogDefinitions => {
  const state = registries.get(operationCatalogs);
  if (state === undefined) {
    throw new Error("operation catalogs were not created by deployOperationCatalogs");
  }
  return state.deployed;
};

export const deployedDatabaseCatalogBindings = (
  operationCatalogs: OperationCatalogs,
): DatabaseCatalogBindings => {
  const state = registries.get(operationCatalogs);
  if (state === undefined) {
    throw new Error("operation catalogs were not created by deployOperationCatalogs");
  }
  return state.bindings;
};

export const deployOperationCatalogsForVersion = Effect.fn(
  "Worker.deployOperationCatalogs",
)(function* (
  input: DeployOperationCatalogsInput,
  versionMetadata: unknown,
) {
  if (startedWithoutDeploymentVersion(versionMetadata)) {
    const state = unavailableState();
    return wrapOperationCatalogs(state.deployed, state.bindings);
  }
  const artifactHash = yield* artifactHashForDeployment(versionMetadata);
  const definitions = yield* assembleCatalogDefinitions({
    root: input.root,
    artifactHash,
  });
  const deployed = yield* Effect.fromResult(deployCatalogDefinitions(
    definitions,
    input.deployments.map((deployment) => ({
      database: DatabaseId.make(deployment.database),
      catalogKey: CatalogId.make(deployment.catalogKey ?? input.root.key),
    })),
  ));
  const bindings = yield* Effect.fromResult(
    deployDatabaseCatalogBindings(definitions, deployed),
  );
  return wrapOperationCatalogs(deployed, bindings);
}, Effect.mapError(deploymentError));
