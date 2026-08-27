/**
 * Ramose peer Worker — HTTP API and edge executor.
 *
 *   GET  /health              { ok, service, stage, time, operations: string[] }
 *   *    /db/:name/*          JWT verified; data plane fail-closed until catalog + filtered Db (#421/#423)
 *
 * External `/db/*` verifies a JWT then still denies until an installed
 * catalog and a filtered `Db`. `/health` is the only unauthenticated
 * route (AUTH-1, AUTH-6).
 */

import { Histogram, RateMeter, componentLogger, setTelemetryLevel, toJson } from "../internal/core/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { TransactorDO } from "../internal/transactor/transactor-do.ts";
import { QueryReplicaDO } from "../internal/replica/index.ts";
import { AuthenticationAdmission } from "../internal/authorization/runtime/authentication.ts";
import { authenticationLayer } from "../internal/authorization/runtime/layer.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Analytics, type Route, bindingOf, fromBinding, httpPoint, routeOf } from "./analytics.ts";
import { type AnyOperations, operationNames } from "../db/Operation.ts";
import { bearerOf } from "./auth.ts";
import {
  BadRequest,
  type Internal,
  NotFound,
  OperationRejected,
  type QueryBudgetExceeded,
  type RamoseError,
  Unauthorized,
  type UpstreamError,
  toHttp,
} from "./errors.ts";
import { isUnrecognizedWrites } from "../writes.ts";
export { resolveWrites } from "../writes.ts";

export interface ServerOptions {
  readonly operations?: AnyOperations;
}

export { TransactorDO, QueryReplicaDO };
export type { RamoseEnv } from "../RamoseEnv.ts";
export { type ErrorHttp, errorResponse, errorToHttp, statusOf, toDbError } from "../errorHttp.ts";
export { toHttp, fromThrown, isRamoseError } from "./errors.ts";

const plog = componentLogger("peer");
const peerMetrics = {
  queries: new RateMeter(10_000),
  transacts: new RateMeter(10_000),
  queryMs: new Histogram(),
  transactMs: new Histogram(),
  budgetAborts: 0,
  errors: 0,
  aeWrites: 0,
};
let levelApplied = false;
const writesWarned = new Set<string>();
const unrecognizedWritesWarned = new Set<string>();

/** Test hook: forget writes-mode warnings. */
export const clearWritesWarning = (): void => {
  writesWarned.clear();
  unrecognizedWritesWarned.clear();
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra },
  });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "content-type,authorization,upgrade,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-min-t",
  "access-control-expose-headers":
    "x-ramose-ms,x-ramose-r2-gets,x-ramose-cache-hits,x-ramose-basis-t,x-ramose-basis-hit,x-ramose-basis-reason,x-ramose-basis-calls,x-ramose-basis-behind,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-colo",
};

interface RequestInfo {
  db: string;
  path: string;
  route: Route;
}

function respond(err: RamoseError): Response {
  const h = toHttp(err);
  if (h.raw !== undefined)
    return new Response(h.raw, {
      status: h.status,
      headers: h.headers ?? { "content-type": "application/json", ...CORS },
    });
  return json(h.body ?? {}, h.status);
}

const recover = (info: RequestInfo, t0: number) => ({
  NotFound: (e: NotFound) => Effect.sync(() => respond(e)),
  BadRequest: (e: BadRequest) => Effect.sync(() => respond(e)),
  Unauthorized: (e: Unauthorized) => Effect.sync(() => respond(e)),
  UpstreamError: (e: UpstreamError) => Effect.sync(() => respond(e)),
  QueryBudgetExceeded: (e: QueryBudgetExceeded) =>
    Effect.sync(() => {
      peerMetrics.budgetAborts++;
      plog.warn("query.budget-exceeded", {
        db: info.db,
        clause: e.clause,
        cells: e.cells,
        limit: e.limit,
        spentBy: e.spentBy ?? "caller",
        ms: Date.now() - t0,
      });
      return respond(e);
    }),
  Internal: (e: Internal) =>
    Effect.sync(() => {
      peerMetrics.errors++;
      plog.error("request.error", { db: info.db, path: info.path, error: e.message });
      return respond(e);
    }),
  OperationRejected: (e: OperationRejected) => Effect.sync(() => respond(e)),
});

const recordHttp = (request: Request, info: RequestInfo, status: number, ms: number) =>
  Effect.gen(function* () {
    const ae = yield* Analytics;
    if (!ae.bound) return;
    const colo = (request as { cf?: { colo?: string } }).cf?.colo;
    yield* ae.writeDataPoint(
      httpPoint({ db: info.db, ...(colo !== undefined ? { colo } : {}), route: info.route, status, ms }),
    );
    peerMetrics.aeWrites++;
  }).pipe(Effect.ignoreCause);

const handle = (
  request: Request,
  env: RamoseEnv,
  t0: number,
  info: RequestInfo,
  peer: ServerOptions,
): Effect.Effect<Response, RamoseError, AuthenticationAdmission> =>
  Effect.gen(function* () {
    if (!levelApplied) {
      levelApplied = true;
      const lvl = env.RAMOSE_LOG_LEVEL;
      if (lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error") setTelemetryLevel(lvl);
    }
    const url = new URL(request.url);
    info.path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return yield* new NotFound({});
    }
    if (url.pathname === "/health") {
      info.route = "health";
      if (isUnrecognizedWrites(env.RAMOSE_WRITES)) {
        const key = String(env.RAMOSE_WRITES);
        if (!unrecognizedWritesWarned.has(key)) {
          unrecognizedWritesWarned.add(key);
          plog.warn("writes.unrecognized", {
            value: key,
            using: "operations",
            message: `RAMOSE_WRITES=${JSON.stringify(key)} is not "all" or "operations"; using "operations"`,
          });
        }
      }
      return json({
        ok: true,
        service: "ramose",
        stage: env.RAMOSE_STAGE ?? "dev",
        time: Date.now(),
        operations: operationNames(peer.operations),
      });
    }

    const m = /^\/db\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return yield* new NotFound({});
    const db = yield* Effect.try({
      try: () => decodeURIComponent(m[1]!),
      catch: () => new Unauthorized({}),
    });
    const rest = m[2] ?? "/";
    info.db = db;
    info.path = rest;
    info.route = routeOf(rest, request.method);
    const token = bearerOf(request);
    if (token === undefined) return yield* new Unauthorized({});
    const admission = yield* AuthenticationAdmission;
    yield* admission
      .admit({
        database: db,
        token: Redacted.make(token),
        route: rest === "/session" ? "websocket" : "http",
      })
      .pipe(
        Effect.catchTags({
          AuthenticationRejected: () => Effect.fail(new Unauthorized({})),
          JwksUnavailable: () => Effect.fail(new Unauthorized({})),
        }),
      );
    return yield* new Unauthorized({});
  });

const runFetch = (request: Request, env: RamoseEnv, peer: ServerOptions): Promise<Response> => {
  const t0 = Date.now();
  const info: RequestInfo = { db: "-", path: "-", route: "other" };
  return Effect.runPromise(
    handle(request, env, t0, info, peer).pipe(
      Effect.catchTags(recover(info, t0)),
      Effect.tap((res) => recordHttp(request, info, res.status, Date.now() - t0)),
      Effect.provide(
        Layer.mergeAll(
          authenticationLayer(env),
          Layer.succeed(Analytics, fromBinding(bindingOf(env))),
        ),
      ),
    ),
  );
};

/** Build a peer Worker. External `/db/*` is fail-closed (AUTH-1). */
export const createServer = (options: ServerOptions = {}) => ({
  async fetch(request: Request, env: RamoseEnv, _ctx?: ExecutionContext): Promise<Response> {
    return runFetch(request, env, options);
  },
});

export default createServer();
