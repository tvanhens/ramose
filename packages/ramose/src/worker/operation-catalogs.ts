import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { CatalogDefinition } from "../Catalog.ts";
import {
  assembleCatalogDefinitions,
  deployCatalogDefinitions,
  type DeployedCatalogDefinitions,
} from "../internal/authorization/definitions.ts";
import {
  deployDatabaseCatalogBindings,
  type DatabaseCatalogBindings,
} from "../internal/authorization/database-bindings.ts";
import {
  CatalogId,
  DatabaseId,
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
  readonly root: CatalogDefinition;
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
