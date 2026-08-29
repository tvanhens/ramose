/**
 * Ramose peer Worker — HTTP API and edge executor.
 *
 *   GET  /health              { ok, service }
 *   *    /db/:name/*          verified JWT + deployed catalog → filtered Db;
 *                             one-shot query/pull/entity, leased live output,
 *                             and versioned opaque replication run on that
 *                             value only. writes, info, and raw sessions stay
 *                             fail-closed.
 *
 * `/health` is the only unauthenticated public route (AUTH-1, AUTH-6). The
 * supported package graph contains no test or admin assembly.
 */

import { env } from "cloudflare:workers";
import type { RamoseEnv } from "../RamoseEnv.ts";
import {
  createTransactorDO as createInternalTransactorDO,
  TransactorDO as InternalTransactorDO,
} from "../internal/transactor/transactor-do.ts";
import { QueryReplicaDO as InternalQueryReplicaDO } from "../internal/replica/index.ts";
import { runFetch, type ServerOptions as RuntimeServerOptions } from "./handle.ts";
import {
  deployedDatabaseCatalogBindings,
  deployedOperationCatalogs,
  deployOperationCatalogsForVersion,
  type DeployOperationCatalogsInput,
  type OperationCatalogs,
} from "./operation-catalogs.ts";
type WorkerDurableObjectClass = new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject;

/** Cloudflare class exports with the internal binding shape erased. */
export const TransactorDO = InternalTransactorDO as unknown as WorkerDurableObjectClass;
export const QueryReplicaDO = InternalQueryReplicaDO as unknown as WorkerDurableObjectClass;
/**
 * Assemble native catalogs against Cloudflare's immutable Worker version.
 * Requires the `CF_VERSION_METADATA` binding that `Ramose.Server` installs.
 */
export const deployOperationCatalogs = (input: DeployOperationCatalogsInput) =>
  deployOperationCatalogsForVersion(
    input,
    (env as Partial<RamoseEnv>).CF_VERSION_METADATA,
  );
/** Build the Transactor class from the same opaque registry as `createServer`. */
export const createTransactorDO = (
  operationCatalogs: OperationCatalogs,
): WorkerDurableObjectClass =>
  createInternalTransactorDO(
    deployedOperationCatalogs(operationCatalogs),
    deployedDatabaseCatalogBindings(operationCatalogs),
  ) as unknown as WorkerDurableObjectClass;
export {
  OperationCatalogDeploymentError,
  type DeployOperationCatalogsInput,
  type OperationCatalogDeployment,
  type OperationCatalogProof,
  type OperationCatalogs,
} from "./operation-catalogs.ts";

/** Opaque runtime assembly accepted by the supported Worker entry. */
export interface ServerOptions {
  readonly operationCatalogs?: OperationCatalogs;
}

/** Build a peer Worker. One-shot reads consume the filtered request `Db`. */
export const createServer = (options: ServerOptions = {}) => ({
  async fetch(request: Request, env: unknown, _ctx?: ExecutionContext): Promise<Response> {
    return runFetch(request, env as RamoseEnv, options as RuntimeServerOptions);
  },
});

export default createServer();
