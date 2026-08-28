/**
 * HTTP one-shot read admission: parse the public query/pull/entity shapes
 * and acquire current {@link Db} by the trusted route database. Execution
 * is {@link executeAuthorizedRead} on the filtered request value.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  type AuthorizedRequestView,
  type OneShotRead,
} from "../internal/authorization/index.ts";
import type { EntityRef } from "../internal/core/db.ts";
import type { Db } from "../internal/core/db.ts";
import { parseJson } from "../internal/core/json.ts";
import { dbFromBasis } from "../internal/replica/basis.ts";
import { envInt } from "../internal/transactor/env.ts";
import { DEFAULT_QUERY_MAX_CELLS } from "../internal/core/query/engine.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { BadRequest, Unauthorized, fromThrown, type RamoseError } from "./errors.ts";
import { fetchBasis, segmentSource } from "./peer.ts";

const deny = (): Unauthorized => new Unauthorized({});

const CATALOG_HEADER = "x-ramose-catalog";
const UNIT_HASH_HEADER = "x-ramose-unit-hash";

export type ParsedOneShotRead = {
  readonly read: OneShotRead;
  readonly view: AuthorizedRequestView;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

const asRecord = (value: unknown): Result.Result<Record<string, unknown>, BadRequest> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Result.succeed(value as Record<string, unknown>)
    : Result.fail(new BadRequest({ message: "body must be a JSON object" }));

const decodeCatalogId = (value: unknown): Result.Result<CatalogId, Unauthorized> => {
  const decoded = Schema.decodeUnknownResult(CatalogId)(value);
  return Result.isSuccess(decoded) && decoded.success.trim().length > 0
    ? Result.succeed(decoded.success)
    : Result.fail(deny());
};

const decodeUnitHash = (value: unknown): Result.Result<CatalogUnitHash, Unauthorized> => {
  const decoded = Schema.decodeUnknownResult(CatalogUnitHash)(value);
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(deny());
};

const pickProof = (
  body: Record<string, unknown> | undefined,
  headers: Headers,
): Result.Result<{ catalogKey: CatalogId; unitHash: CatalogUnitHash }, Unauthorized> => {
  const catalog = body?.catalog ?? headers.get(CATALOG_HEADER);
  const unitHash = body?.unitHash ?? headers.get(UNIT_HASH_HEADER);
  const catalogKey = decodeCatalogId(catalog);
  if (Result.isFailure(catalogKey)) return Result.fail(catalogKey.failure);
  const hash = decodeUnitHash(unitHash);
  if (Result.isFailure(hash)) return Result.fail(hash.failure);
  return Result.succeed({ catalogKey: catalogKey.success, unitHash: hash.success });
};

const viewOf = (
  body: Record<string, unknown> | undefined,
  search: URLSearchParams,
): AuthorizedRequestView => {
  const asOfRaw = body?.asOf ?? search.get("asOf");
  const asOf =
    typeof asOfRaw === "number"
      ? asOfRaw
      : typeof asOfRaw === "string" && asOfRaw.length > 0
        ? Number(asOfRaw)
        : undefined;
  const historyRaw = body?.history ?? search.get("history");
  const history =
    historyRaw === true || historyRaw === "true" ? true : historyRaw === false || historyRaw === "false" ? false : undefined;
  return {
    ...(typeof asOf === "number" && Number.isFinite(asOf) ? { asOf } : {}),
    ...(history === undefined ? {} : { history }),
  };
};

const isEntityRef = (value: unknown): value is EntityRef => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return true;
  if (typeof value === "string" && value.length > 0) return true;
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    value[0].length > 0
  );
};

const readFromBody = (
  rest: string,
  method: string,
  body: Record<string, unknown> | undefined,
): Result.Result<OneShotRead, BadRequest | Unauthorized> => {
  if ((rest === "/query" || rest === "/live") && method === "POST") {
    if (body?.query !== undefined && body.query !== null) {
      return Result.succeed({
        kind: "query",
        query: body.query as string | object,
        ...(Array.isArray(body.inputs) ? { inputs: body.inputs } : {}),
      });
    }
    const pullBody = body?.pull;
    if (pullBody !== null && typeof pullBody === "object" && !Array.isArray(pullBody)) {
      const pull = pullBody as Record<string, unknown>;
      if (!isEntityRef(pull.eid) || pull.pattern === undefined || pull.pattern === null) {
        return Result.fail(new BadRequest({ message: "pull needs eid and pattern" }));
      }
      return Result.succeed({
        kind: "pull",
        eid: pull.eid,
        pattern: pull.pattern as string | unknown[],
      });
    }
    if (body?.entity !== undefined) {
      if (!isEntityRef(body.entity)) {
        return Result.fail(new BadRequest({ message: "entity must be an eid, ident, or lookup ref" }));
      }
      return Result.succeed({ kind: "entity", ref: body.entity });
    }
    if (Array.isArray(body?.lookup) && isEntityRef(body.lookup)) {
      const lookup = body.lookup;
      if (!Array.isArray(lookup) || lookup.length !== 2 || typeof lookup[0] !== "string") {
        return Result.fail(new BadRequest({ message: "lookup must be [attr, value]" }));
      }
      return Result.succeed({ kind: "lookup", ref: [lookup[0], lookup[1]] });
    }
    return Result.fail(
      new BadRequest({ message: "body must be { query, inputs? } | { pull } | { entity } | { lookup }" }),
    );
  }
  if (rest === "/pull" && method === "POST") {
    if (body === undefined || !isEntityRef(body.eid) || body.pattern === undefined || body.pattern === null) {
      return Result.fail(new BadRequest({ message: "body must be { eid, pattern }" }));
    }
    return Result.succeed({
      kind: "pull",
      eid: body.eid,
      pattern: body.pattern as string | unknown[],
    });
  }
  return Result.fail(deny());
};

const entityFromPath = (rest: string): Result.Result<OneShotRead, Unauthorized> => {
  const match = /^\/entity\/(\d+)$/.exec(rest);
  if (match === null) return Result.fail(deny());
  return Result.succeed({ kind: "entity", ref: Number(match[1]) });
};

/** Decode the HTTP body with the established `$inst` / `$bytes` / `$uuid` wire contract. */
const readJsonObject = (
  request: Request,
): Effect.Effect<Record<string, unknown>, BadRequest> =>
  Effect.tryPromise({
    try: async () => {
      const text = await request.text();
      if (text.trim().length === 0) {
        throw new BadRequest({ message: "body must be a JSON object" });
      }
      return parseJson(text);
    },
    catch: (cause) =>
      cause instanceof BadRequest ? cause : new BadRequest({ message: "body must be a JSON object" }),
  }).pipe(Effect.flatMap((value) => Effect.fromResult(asRecord(value))));

export const parseOneShotReadRequest = Effect.fn("parseOneShotReadRequest")(function* (
  request: Request,
  rest: string,
): Effect.fn.Return<ParsedOneShotRead, BadRequest | Unauthorized> {
  const url = new URL(request.url);
  const method = request.method;
  const body = method === "GET" ? undefined : yield* readJsonObject(request);
  const proof = yield* Effect.fromResult(pickProof(body, request.headers));
  const read =
    method === "GET"
      ? yield* Effect.fromResult(entityFromPath(rest))
      : yield* Effect.fromResult(readFromBody(rest, method, body));
  return { read, view: viewOf(body, url.searchParams), ...proof };
});

/** Fetch the route-database snapshot. Replica 503 and other storage
 *  failures stay classified; they are not rewritten as Unauthorized. */
export const acquireCurrentDb = (
  env: RamoseEnv,
  request: Request,
): ((database: DatabaseId) => Effect.Effect<Db, RamoseError>) =>
  (database) =>
    Effect.tryPromise({
      try: async () => {
        const basis = await fetchBasis(env, database, request);
        return dbFromBasis(segmentSource(env, database), basis);
      },
      catch: (cause) => fromThrown(cause),
    });

export const queryMaxCells = (env: RamoseEnv): number =>
  envInt(env.RAMOSE_QUERY_MAX_CELLS, DEFAULT_QUERY_MAX_CELLS);
