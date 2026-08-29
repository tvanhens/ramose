/** Public startup assembly for native deployed operation catalogs. */

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

const OperationCatalogsTypeId = Symbol.for("ramose/worker/OperationCatalogs");

export interface OperationCatalogProof {
  readonly catalog: string;
  readonly unitHash: string;
}

/**
 * Opaque runnable registry shared by the Worker and Transactor Durable Object.
 * Construct it once with {@link deployOperationCatalogs} during startup.
 */
export interface OperationCatalogs {
  readonly [OperationCatalogsTypeId]: typeof OperationCatalogsTypeId;
  /** Exact catalog proof for requests routed to one deployed database. */
  readonly proof: (database: string) => OperationCatalogProof | undefined;
}

export interface OperationCatalogDeployment {
  readonly database: string;
  /** Defaults to the root catalog's permanent key. */
  readonly catalogKey?: string;
}

export interface DeployOperationCatalogsInput {
  readonly root: CatalogDefinition;
  /** SHA-256 of the immutable deployed bundle containing the operation bodies. */
  readonly artifactHash: string;
  readonly deployments: readonly OperationCatalogDeployment[];
}

/** One public startup failure instead of leaking authorization implementation types. */
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

/** @internal Worker plumbing; not re-exported from `ramose/worker`. */
export const deployedOperationCatalogs = (
  operationCatalogs: OperationCatalogs,
): DeployedCatalogDefinitions => {
  const state = registries.get(operationCatalogs);
  if (state === undefined) {
    throw new Error("operation catalogs were not created by deployOperationCatalogs");
  }
  return state.deployed;
};

/** @internal Graph routing plumbing; not re-exported from `ramose/worker`. */
export const deployedDatabaseCatalogBindings = (
  operationCatalogs: OperationCatalogs,
): DatabaseCatalogBindings => {
  const state = registries.get(operationCatalogs);
  if (state === undefined) {
    throw new Error("operation catalogs were not created by deployOperationCatalogs");
  }
  return state.bindings;
};

/**
 * Assemble reachable code definitions and bind them to route databases.
 * Run this Effect once in the Worker module shared with `createTransactorDO`.
 */
export const deployOperationCatalogs = Effect.fn(
  "Worker.deployOperationCatalogs",
)(function* (input: DeployOperationCatalogsInput) {
  const definitions = yield* assembleCatalogDefinitions({
    root: input.root,
    // The assembler validates the public string before using the brand.
    artifactHash: input.artifactHash as DigestHex,
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
