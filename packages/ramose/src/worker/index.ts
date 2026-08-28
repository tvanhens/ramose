/**
 * Ramose peer Worker — HTTP API and edge executor.
 *
 *   GET  /health              { ok, service, stage, time, operations: string[] }
 *   POST /__test__/db/:name/* test-only (RAMOSE_TEST_HOOKS=1; 404 otherwise)
 *   *    /db/:name/*          verified JWT + deployed catalog → filtered Db;
 *                             one-shot query/pull/entity run on that value only.
 *                             writes, info, and sessions stay fail-closed.
 *
 * `/health` is the only unauthenticated public route (AUTH-1, AUTH-6).
 * `/__test__/*` is gated local instrumentation, not an external database path.
 */

import type { RamoseEnv } from "../RamoseEnv.ts";
import { TransactorDO } from "../internal/transactor/transactor-do.ts";
import { QueryReplicaDO } from "../internal/replica/index.ts";
import { runFetch, type ServerOptions } from "./handle.ts";
export { resolveWrites } from "../writes.ts";

export { TransactorDO, QueryReplicaDO };
export { clearWritesWarning } from "./handle.ts";
export type { ServerOptions } from "./handle.ts";
export type { RamoseEnv } from "../RamoseEnv.ts";
export { type ErrorHttp, errorResponse, errorToHttp, statusOf, toDbError } from "../errorHttp.ts";
export { toHttp, fromThrown, isRamoseError } from "./errors.ts";

/** Build a peer Worker. One-shot reads consume the filtered request `Db`. */
export const createServer = (options: ServerOptions = {}) => ({
  async fetch(request: Request, env: RamoseEnv, _ctx?: ExecutionContext): Promise<Response> {
    return runFetch(request, env, options);
  },
});

export default createServer();
