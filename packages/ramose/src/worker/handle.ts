import { isDatabaseName } from "../db/DatabaseName.ts";
import { type AnyOperations, operationNames } from "../db/Operation.ts";
import {
  callerFromVerified,
  deployedOperationKey,
  DatabaseId,
  executeAuthorizedRead,
  OneShotReadError,
  OperationId,
  opaqueCatalogDenial,
  resolveDeployedCatalog,
  type DeployedCatalogs,
} from "../internal/authorization/index.ts";
import {
  Histogram,
  RateMeter,
  componentLogger,
  setTelemetryLevel,
  toJson,
} from "../internal/core/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { testHooksEnabled } from "../internal/test-hooks.ts";
import { isUnrecognizedWrites } from "../writes.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { authenticateRequest } from "./admit.ts";
import {
  acquireCurrentDb,
  acquireWatchedDb,
  parseCatalogProof,
  parseOneShotReadRequest,
  queryMaxCells,
} from "./authorized-read.ts";
import { authorizedLiveResponse } from "./authorized-live.ts";
import { asTestAdminError, handleTestAdmin } from "./test-admin.ts";
import {
  Analytics,
  type Route,
  bindingOf,
  fromBinding,
  httpPoint,
  routeOf,
} from "./analytics.ts";
import {
  BadRequest,
  type Internal,
  NotFound,
  OperationRejected,
  type QueryBudgetExceeded,
  type RamoseError,
  Unauthorized,
  type UpstreamError,
  fromThrown,
  isRamoseError,
  toHttp,
} from "./errors.ts";
import { JwtVerifier, fromEnv } from "./jwt.ts";
import { watchBasisChanges } from "./peer.ts";
import { internalHeaders } from "../internal/transactor/index.ts";
import { parseJson } from "../internal/core/json.ts";

export interface ServerOptions {
  readonly operations?: AnyOperations;
  /** Deployed catalog registry assembled from reachable code. Missing = deny. */
  readonly catalogs?: DeployedCatalogs;
}

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

const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(toJson(body)), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "content-type,authorization,upgrade,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-min-t,x-ramose-catalog,x-ramose-unit-hash",
  "access-control-expose-headers":
    "x-ramose-ms,x-ramose-r2-gets,x-ramose-cache-hits,x-ramose-basis-t,x-ramose-basis-hit,x-ramose-basis-reason,x-ramose-basis-calls,x-ramose-basis-behind,x-ramose-replica-hint,x-ramose-cache-basis,x-ramose-cache-mode,x-ramose-colo",
};

const DEPLOYMENT_HEADER = "x-ramose-deployment";

const deploymentVersion = (env: RamoseEnv): string | undefined => {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

export interface RequestInfo {
  /** Trusted route database from the request path. Not a JWT claim. */
  db: string;
  path: string;
  route: Route;
}

const respond = (err: RamoseError): Response => {
  const h = toHttp(err);
  if (h.raw !== undefined) {
    return new Response(h.raw, {
      status: h.status,
      headers: h.headers ?? { "content-type": "application/json", ...CORS },
    });
  }
  return json(h.body ?? {}, h.status);
};

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
      plog.error("request.error", {
        db: info.db,
        path: info.path,
        error: e.message,
      });
      return respond(e);
    }),
  OperationRejected: (e: OperationRejected) =>
    Effect.sync(() => respond(e)),
});

const recordHttp = (
  request: Request,
  info: RequestInfo,
  status: number,
  ms: number,
) =>
  Effect.gen(function* () {
    const ae = yield* Analytics;
    if (!ae.bound) return;
    const colo = (request as { cf?: { colo?: string } }).cf?.colo;
    yield* ae.writeDataPoint(
      httpPoint({
        db: info.db,
        ...(colo !== undefined ? { colo } : {}),
        route: info.route,
        status,
        ms,
      }),
    );
    peerMetrics.aeWrites++;
  }).pipe(Effect.ignoreCause);

const decodeDatabaseName = (
  encoded: string,
): Result.Result<string, BadRequest> =>
  Result.try({
    try: () => decodeURIComponent(encoded),
    catch: () => new BadRequest({ message: "invalid database name" }),
  });

const operationBody = (
  request: Request,
): Effect.Effect<Record<string, unknown>, BadRequest> =>
  Effect.tryPromise({
    try: async () => {
      const value = parseJson(await request.text());
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BadRequest({ message: "body must be a JSON object" });
      }
      return value as Record<string, unknown>;
    },
    catch: (cause) => cause instanceof BadRequest
      ? cause
      : new BadRequest({ message: "body must be a JSON object" }),
  });

const operationPolicyDenied = (): Response =>
  json({ error: "unauthorized", code: "policy" }, 403, CORS);

export const handle = (
  request: Request,
  env: RamoseEnv,
  t0: number,
  info: RequestInfo,
  peer: ServerOptions,
): Effect.Effect<Response, RamoseError, JwtVerifier> =>
  Effect.gen(function* () {
    if (!levelApplied) {
      levelApplied = true;
      const lvl = env.RAMOSE_LOG_LEVEL;
      if (
        lvl === "debug" ||
        lvl === "info" ||
        lvl === "warn" ||
        lvl === "error"
      ) {
        setTelemetryLevel(lvl);
      }
    }
    const url = new URL(request.url);
    info.path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return yield* new NotFound({});
    }
    if (url.pathname.startsWith("/__test__/")) {
      info.route = "admin";
      if (!testHooksEnabled(env)) return yield* new NotFound({});
      return yield* Effect.tryPromise({
        try: () => handleTestAdmin(request, env, url),
        catch: (e) => asTestAdminError(e),
      });
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
      const version = deploymentVersion(env);
      const testCatalogs =
        env.RAMOSE_TEST_HOOKS === "1" && env.RAMOSE_STAGE !== "prod" &&
          peer.catalogs !== undefined
          ? peer.catalogs.databases().flatMap((database) => {
            const found = peer.catalogs!.requireDatabase(database);
            return Result.isSuccess(found)
              ? [{
                database,
                catalog: found.success.catalogKey,
                unitHash: found.success.unitHash,
              }]
              : [];
          })
          : undefined;
      return json(
        {
          ok: true,
          service: "ramose",
          stage: env.RAMOSE_STAGE ?? "dev",
          time: Date.now(),
          operations: operationNames(peer.operations),
          ...(testCatalogs === undefined ? {} : { catalogs: testCatalogs }),
        },
        200,
        {
          "cache-control": "no-store",
          ...(version === undefined ? {} : { [DEPLOYMENT_HEADER]: version }),
        },
      );
    }

    const match = /^\/db\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) return yield* new NotFound({});
    const rest = match[2] ?? "/";
    info.path = rest;
    info.route = routeOf(rest, request.method);

    const verified = yield* authenticateRequest(request);

    const db = yield* Effect.fromResult(decodeDatabaseName(match[1]!));
    info.db = db;
    if (!isDatabaseName(db)) {
      return yield* new BadRequest({ message: "invalid database name" });
    }
    if (peer.catalogs === undefined) return yield* new Unauthorized({});
    if (rest === "/op" && request.method === "POST") {
      const body = yield* operationBody(request);
      const proof = yield* Effect.fromResult(parseCatalogProof(body, request.headers));
      const operationResult = Schema.decodeUnknownResult(OperationId)(body.operation);
      if (Result.isFailure(operationResult)) return yield* new Unauthorized({});
      const operation = operationResult.success;
      const deployed = yield* Effect.fromResult(resolveDeployedCatalog(peer.catalogs, {
        database: DatabaseId.make(db),
        catalogKey: proof.catalogKey,
        unitHash: proof.unitHash,
      })).pipe(Effect.mapError(opaqueCatalogDenial));
      if (
        operation.catalog !== proof.catalogKey ||
        !deployed.operations.has(deployedOperationKey(operation))
      ) return operationPolicyDenied();
      const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(db));
      return yield* Effect.tryPromise({
        try: async () => {
          const response = await stub.fetch(
            `https://transactor/operation?db=${encodeURIComponent(db)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...internalHeaders(env) },
              body: JSON.stringify(toJson({
                catalogKey: proof.catalogKey,
                unitHash: proof.unitHash,
                operation,
                caller: callerFromVerified(verified),
                principal: verified.principal,
                ...(body.target === undefined ? {} : { target: body.target }),
                input: body.input,
              })),
            },
          );
          if (response.status === 403) return operationPolicyDenied();
          return new Response(response.body, {
            status: response.status,
            headers: { ...Object.fromEntries(response.headers), ...CORS },
          });
        },
        catch: (cause) => fromThrown(cause, { stacks: env.RAMOSE_STAGE !== "prod" }),
      });
    }
    if (
      !((rest === "/query" || rest === "/pull" || rest === "/live") && request.method === "POST") &&
      !(/^\/entity\/\d+$/.test(rest) && request.method === "GET")
    ) {
      return yield* new Unauthorized({});
    }

    const parsed = yield* parseOneShotReadRequest(request, rest);
    const stacks = env.RAMOSE_STAGE !== "prod";
    const liveWatch = rest === "/live" ? watchBasisChanges(env, db, request) : undefined;
    const admissionCurrentDb = acquireCurrentDb(env, request, {
      bypassBasisCache: rest === "/live",
      authoritativeBasisFence: rest === "/live",
    });
    const input = {
      authenticate:
        rest === "/live"
          ? authenticateRequest(request).pipe(Effect.map(callerFromVerified))
          : Effect.succeed(callerFromVerified(verified)),
      ...(liveWatch === undefined ? {} : {
        basisChanges: liveWatch.changes,
        admissionCurrentDb,
      }),
      catalogs: peer.catalogs,
      routeDatabase: DatabaseId.make(db),
      catalogKey: parsed.catalogKey,
      unitHash: parsed.unitHash,
      currentDb: liveWatch === undefined
        ? admissionCurrentDb
        : acquireWatchedDb(env, liveWatch.currentBasis),
      view: parsed.view,
    };
    const mapReadError = (error: unknown): RamoseError => {
      if (error instanceof Unauthorized) return error;
      if (isRamoseError(error)) return error;
      if (error instanceof OneShotReadError) return fromThrown(error.cause, { stacks });
      return fromThrown(error, { stacks });
    };
    if (rest === "/live") {
      return yield* authorizedLiveResponse(input, parsed.read, { maxCells: queryMaxCells(env) }, CORS).pipe(
        Effect.mapError(mapReadError),
      );
    }
    const result = yield* executeAuthorizedRead(input, parsed.read, {
      maxCells: queryMaxCells(env),
    }).pipe(Effect.mapError(mapReadError));
    return json({ result });
  });

export const runFetch = (
  request: Request,
  env: RamoseEnv,
  peer: ServerOptions,
): Promise<Response> => {
  const t0 = Date.now();
  const info: RequestInfo = { db: "-", path: "-", route: "other" };
  const services = Context.make(
    Analytics,
    fromBinding(bindingOf(env)),
  ).pipe(Context.add(JwtVerifier, fromEnv(env)));
  return Effect.runPromise(
    handle(request, env, t0, info, peer).pipe(
      Effect.catchTags(recover(info, t0)),
      Effect.tap((res) =>
        recordHttp(request, info, res.status, Date.now() - t0),
      ),
      Effect.provide(services),
    ),
  );
};
