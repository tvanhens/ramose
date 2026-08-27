/**
 * Ramose peer Worker — HTTP API and edge executor.
 *
 *   GET  /health              { ok, service, stage, time, operations: string[] }
 *   *    /db/:name/*          verified JWT admission, then fail-closed until catalog + filtered Db
 *
 * `/health` is the only unauthenticated route (AUTH-1, AUTH-6).
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

/** Build a peer Worker. Verified requests stay closed pending catalog policy. */
export const createServer = (options: ServerOptions = {}) => ({
  async fetch(request: Request, env: RamoseEnv, _ctx?: ExecutionContext): Promise<Response> {
    return runFetch(request, env, options);
  },
});

export default createServer();
