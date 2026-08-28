/**
 * HTTP catalog-bound write admission: parse POST /op and commit through
 * the transactor with `fromOperation: true`. Execution is
 * {@link executeAuthorizedWrite} on the same filtered request path as reads.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  OwnerRef,
  type OperationCommitReport,
  type OperationInvocation,
} from "../internal/authorization/index.ts";
import { toJson } from "../internal/core/json.ts";
import type { TxData } from "../internal/core/tx.ts";
import { internalHeaders } from "../internal/transactor/internal.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { acquireCurrentDb, pickProof, readJsonObject } from "./authorized-read.ts";
import { BadRequest, Unauthorized, fromThrown, type RamoseError } from "./errors.ts";

const deny = (): Unauthorized => new Unauthorized({});

export type ParsedOperationRequest = {
  readonly invocation: OperationInvocation;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
};

const decodeOwner = (value: unknown): Result.Result<OwnerRef, BadRequest> => {
  const decoded = Schema.decodeUnknownResult(OwnerRef)(value);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(new BadRequest({ message: "operation.owner must be { kind, name }" }));
};

const decodeTarget = (value: unknown): Result.Result<"required" | "none", BadRequest> =>
  value === "required" || value === "none"
    ? Result.succeed(value)
    : Result.fail(new BadRequest({ message: "operation.target must be required or none" }));

const isEntityRef = (value: unknown): value is number | string | readonly [string, unknown] => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return true;
  if (typeof value === "string" && value.length > 0) return true;
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    value[0].length > 0
  );
};

const invocationOf = (
  body: Record<string, unknown>,
): Result.Result<OperationInvocation, BadRequest> => {
  const raw = body.operation;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Result.fail(new BadRequest({ message: "body must include operation" }));
  }
  const operation = raw as Record<string, unknown>;
  const owner = decodeOwner(operation.owner);
  if (Result.isFailure(owner)) return Result.fail(owner.failure);
  if (typeof operation.localName !== "string" || operation.localName.length === 0) {
    return Result.fail(new BadRequest({ message: "operation.localName is required" }));
  }
  const target = decodeTarget(operation.target);
  if (Result.isFailure(target)) return Result.fail(target.failure);
  if (body.entity !== undefined && !isEntityRef(body.entity)) {
    return Result.fail(new BadRequest({ message: "entity must be an eid, ident, or lookup ref" }));
  }
  const invocation: OperationInvocation = {
    owner: owner.success,
    localName: operation.localName,
    target: target.success,
    input: body.input ?? {},
  };
  if (body.entity === undefined) return Result.succeed(invocation);
  return Result.succeed({ ...invocation, entity: body.entity });
};

export const parseOperationRequest = Effect.fn("parseOperationRequest")(function* (
  request: Request,
  rest: string,
): Effect.fn.Return<ParsedOperationRequest, BadRequest | Unauthorized> {
  if (rest !== "/op" || request.method !== "POST") return yield* deny();
  const body = yield* readJsonObject(request);
  const proof = yield* Effect.fromResult(pickProof(body, request.headers));
  const invocation = yield* Effect.fromResult(invocationOf(body));
  return { invocation, ...proof };
});

const ackTempids = (ack: unknown): Record<string, number> => {
  if (ack === null || typeof ack !== "object") return {};
  const tempids = (ack as { readonly tempids?: unknown }).tempids;
  if (tempids === null || typeof tempids !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(tempids as Record<string, unknown>)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
};

export const commitViaTransactor = (
  env: RamoseEnv,
  database: string,
  request: Request,
): ((tx: TxData) => Effect.Effect<OperationCommitReport, RamoseError>) =>
  (tx) =>
    Effect.gen(function* () {
      const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(database));
      const response = yield* Effect.tryPromise({
        try: () =>
          stub.fetch(`https://transactor/transact?db=${encodeURIComponent(database)}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...internalHeaders(env),
            },
            body: JSON.stringify(toJson({ tx, fromOperation: true })),
          }),
        catch: (cause) => fromThrown(cause),
      });
      if (!response.ok) {
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => fromThrown(cause),
        });
        throw fromThrown(new Error(text || `transactor ${response.status}`));
      }
      const ack = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => fromThrown(cause),
      });
      const dbAfter = yield* acquireCurrentDb(env, request)(DatabaseId.make(database));
      return { tempids: ackTempids(ack), dbAfter };
    });

