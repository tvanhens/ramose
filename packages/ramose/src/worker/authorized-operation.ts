/** Public `/op` parsing and the Worker -> authoritative Transactor hop. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  DatabaseId,
  MAX_INVOCATION_ID_LENGTH,
  OperationVersion,
  parseAuthoritativeInvocationResult,
  parseInvocationAllocations,
  sealOutputEntityRefs,
  type AuthoritativeInvocationResult,
  type AuthoritativeOperationInvocation,
  type AuthenticatedCaller,
  type DatabaseRouteDerivation,
  type OperationInvocation,
} from "../internal/authorization/index.ts";
import { fromJson, toJson } from "../internal/core/json.ts";
import type { EntityIdScope } from "../internal/replication/entity-id.ts";
import type { ServerSealingKey } from "../internal/replication/server-identity.ts";
import { makeEntityIdScope } from "../internal/replication/identity.ts";
import { internalHeaders } from "../internal/transactor/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { serverSealingKey } from "./server-identity.ts";
import {
  BadRequest,
  OperationRejected,
  Unauthorized,
  UpstreamError,
} from "./errors.ts";
import {
  isEntityRef,
  parseCatalogProofForPath,
  parseGraphPath,
} from "./authorized-read.ts";
import { invalidateBasis } from "./peer.ts";

export type ParsedOperationRequest = Omit<
  OperationInvocation,
  | "database"
  | "caller"
  | "catalogKey"
  | "unitHash"
  | "routeDerivation"
  | "entityIdScope"
> & {
  readonly path: readonly string[];
  readonly invocationId: string;
  readonly catalogKey?: OperationInvocation["catalogKey"];
  readonly unitHash?: OperationInvocation["unitHash"];
};

type RoutedOperationRequest = Omit<ParsedOperationRequest, "path"> & {
  readonly catalogKey: OperationInvocation["catalogKey"];
  readonly unitHash: OperationInvocation["unitHash"];
};

/** Serialize only the target through Ramose's entity-ref transport vocabulary. */
export const serializeOperationInvocation = (
  invocation: AuthoritativeOperationInvocation,
): string => {
  const wireInvocation = {
    ...invocation,
    ...(invocation.target === undefined
      ? {}
      : { target: toJson(invocation.target) }),
  };
  return JSON.stringify({ invocation: wireInvocation });
};

const bad = (message: string): BadRequest => new BadRequest({ message });
const deny = (): Unauthorized => new Unauthorized({ status: 403 });

/** Operation input is owned by its deployed codec, not Ramose transport tags. */
const readOperationJsonObject = (
  request: Request,
): Effect.Effect<Record<string, unknown>, BadRequest> =>
  Effect.tryPromise({
    try: async () => {
      const text = await request.text();
      if (text.trim().length === 0) throw bad("body must be a JSON object");
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw bad("body must be a JSON object");
      }
      return value as Record<string, unknown>;
    },
    catch: (cause) =>
      cause instanceof BadRequest ? cause : bad("body must be a JSON object"),
  });

const privateFailure = (
  status = 500,
  headers?: Record<string, string>,
): UpstreamError => new UpstreamError({
  status,
  body: JSON.stringify({ error: "operation execution failed" }),
  ...(headers === undefined ? {} : { headers }),
});

const operationRejectedOf = (text: string): OperationRejected | undefined => {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (
      body.tag !== "OperationRejected" ||
      typeof body.message !== "string" ||
      typeof body.operation !== "string"
    ) return undefined;
    return new OperationRejected({
      message: body.message,
      operation: body.operation,
      ...(typeof body.step === "string" ? { step: body.step } : {}),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
  } catch {
    return undefined;
  }
};

/** Restate only intentional public refusals; scrub engine and runtime detail. */
export const operationFailureFromResponse = (
  response: Response,
  text: string,
): UpstreamError | OperationRejected => {
  if (response.status === 409) {
    return operationRejectedOf(text) ?? privateFailure(409);
  }
  if (response.status === 503) {
    const retryAfter = response.headers.get("retry-after");
    return privateFailure(
      503,
      retryAfter === null ? undefined : { "retry-after": retryAfter },
    );
  }
  return privateFailure(response.status >= 500 ? 500 : response.status);
};

const parseOwner = (
  value: unknown,
): Result.Result<{ readonly kind: "entity" | "trait"; readonly name: string }, BadRequest> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.fail(bad("operation.owner must be { kind, name }"));
  }
  const owner = value as Record<string, unknown>;
  if (
    (owner.kind !== "entity" && owner.kind !== "trait") ||
    typeof owner.name !== "string" || owner.name.length === 0
  ) {
    return Result.fail(bad("operation.owner must be { kind: entity|trait, name }"));
  }
  return Result.succeed({ kind: owner.kind, name: owner.name });
};

export const parseOperationRequest = Effect.fn("parseOperationRequest")(function* (
  request: Request,
): Effect.fn.Return<ParsedOperationRequest, BadRequest | import("./errors.ts").Unauthorized> {
  const body = yield* readOperationJsonObject(request);
  const path = yield* Effect.fromResult(
    parseGraphPath(body, new URL(request.url).searchParams),
  );
  const proof = yield* Effect.fromResult(
    parseCatalogProofForPath(path, body, request.headers),
  ).pipe(
    Effect.mapError(() => deny()),
  );
  const operation = body.operation;
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    return yield* bad("body.operation must be { owner, localName }");
  }
  const record = operation as Record<string, unknown>;
  const owner = yield* Effect.fromResult(parseOwner(record.owner));
  if (typeof record.localName !== "string" || record.localName.length === 0) {
    return yield* bad("operation.localName must be a non-empty string");
  }
  if (
    typeof body.invocationId !== "string" || body.invocationId.length === 0 ||
    body.invocationId.length > MAX_INVOCATION_ID_LENGTH
  ) {
    return yield* bad(
      `invocationId must be a non-empty string of at most ${MAX_INVOCATION_ID_LENGTH} characters`,
    );
  }
  if (
    body.operationVersion !== undefined &&
    (typeof body.operationVersion !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.operationVersion))
  ) {
    return yield* bad(
      "operationVersion must be a canonical operation version digest",
    );
  }
  // An opaque sealed handle is the offline queue's durable target (#475).
  //
  // *Every* string target is one, well-formed or not, and is recognized before
  // `fromJson` so a handle is never mistaken for an ordinary opaque scalar. A
  // truncated, respelled, or forged handle must be indistinguishable from a
  // wrong-scope one and from an unauthorized one, so it goes to the
  // authoritative resolver and comes back as the same sealed denial rather
  // than as a shape complaint here. It is mutually exclusive with the
  // numeric/lookup form: two targets are two different invocations.
  const sealedTarget = typeof body.target === "string" ? body.target : undefined;
  const target = body.target === undefined || sealedTarget !== undefined
    ? undefined
    : fromJson(body.target);
  if (
    target !== undefined &&
    !(
      typeof target === "number" && Number.isSafeInteger(target) && target >= 0
    ) &&
    !(Array.isArray(target) && isEntityRef(target))
  ) {
    return yield* bad(
      "operation target must be an entity id, an eid, or a lookup ref",
    );
  }
  const allocations = parseInvocationAllocations(body.allocations);
  if (allocations === undefined) {
    return yield* bad(
      "allocations must be unique { slot, clientRef } pairs",
    );
  }
  return {
    ...proof,
    path,
    owner,
    localName: record.localName,
    invocationId: body.invocationId,
    ...(body.operationVersion === undefined ? {} : {
      operationVersion: OperationVersion.make(body.operationVersion as string),
    }),
    ...(target === undefined ? {} : {
      target: target as Exclude<OperationInvocation["target"], undefined>,
    }),
    ...(sealedTarget === undefined ? {} : { sealedTarget }),
    ...(allocations.length === 0 ? {} : { allocations }),
    input: body.input,
  };
});

/**
 * The stable `{ server, principal, database }` scope an opaque handle is bound
 * to, derived from the *authenticated* request and never from its body.
 *
 * It is exactly the scope logical replication derives, so a handle minted by
 * one and resolved by the other names the same entity. Its callers derive it
 * only when this invocation actually uses opaque handles — as a target, as an
 * allocation, or in an output that holds an entity reference — so every other
 * operation keeps its previous cost, including the durable-root lookup it
 * never performed.
 */
const deriveEntityIdScope = async (
  env: RamoseEnv,
  database: string,
  origin: string,
  caller: AuthenticatedCaller,
): Promise<EpochBoundSealing> => {
  let sealing;
  try {
    sealing = await serverSealingKey(env);
  } catch {
    // The root lives in another Durable Object, so a cold Worker isolate has to
    // fetch it. That is the identical dependency the Transactor answers 503
    // for; classifying it as an internal 500 here only because the Worker
    // happened to notice first would tell a client its invocation failed when
    // it never ran, and a client that retries only 503/429 would abandon it.
    throw privateFailure(503, { "retry-after": "1" });
  }
  return {
    // The key the scope was derived under travels with it. Every component of
    // the scope is a PRF of the root, so a handle sealed under a *different*
    // epoch but scoped by these strings could never be opened again — and the
    // client would already have stored the mapping durably. The writer refuses
    // that mismatch rather than minting one.
    sealing,
    scope: await makeEntityIdScope(sealing, {
      origin,
      caller,
      database: DatabaseId.make(database),
    }),
  };
};

/** The sealing root and the scope it produced, never one without the other. */
type EpochBoundSealing = {
  readonly sealing: ServerSealingKey;
  readonly scope: EntityIdScope;
};

const invocationEntityIdScope = async (
  env: RamoseEnv,
  database: string,
  origin: string,
  parsed: RoutedOperationRequest,
  caller: AuthenticatedCaller,
): Promise<EpochBoundSealing | undefined> => {
  if (
    parsed.sealedTarget === undefined &&
    (parsed.allocations === undefined || parsed.allocations.length === 0)
  ) return undefined;
  return deriveEntityIdScope(env, database, origin, caller);
};

/**
 * Seal every entity reference in one completed result's output (#475).
 *
 * The durable receipt keeps the resolved eids and is never rewritten — it is
 * the exact replay, and the invocation digest and replay comparison are over
 * those bytes — so the frozen "no numeric eid crosses the operation boundary"
 * rule is satisfied here instead, at the public projection. Sealing is
 * deterministic in `(root, scope, eid)`, so a receipt written before this
 * existed projects exactly the handles the commit that wrote it would have:
 * nothing stored is migrated and nothing stored is touched.
 *
 * The root is derived only when the output actually holds a reference, so an
 * operation that returns none keeps its previous cost — including the durable
 * root lookup it never performed. When this invocation already derived a scope
 * for its own handles, that *same* epoch is reused: a response whose mappings
 * and whose output named one entity under two different epochs would hand a
 * durable client two handles for one thing.
 */
const sealPublicEntityRefs = async (
  env: RamoseEnv,
  database: string,
  origin: string,
  caller: AuthenticatedCaller,
  derived: EpochBoundSealing | undefined,
  result: AuthoritativeInvocationResult,
): Promise<AuthoritativeInvocationResult> => {
  if (result._tag !== "Completed") return result;
  const { outputRefPaths, ...projected } = result;
  if (outputRefPaths === undefined || outputRefPaths.length === 0) {
    return projected;
  }
  const bound = derived ??
    await deriveEntityIdScope(env, database, origin, caller);
  try {
    return {
      ...projected,
      output: await sealOutputEntityRefs(
        bound.sealing,
        bound.scope,
        result.output,
        outputRefPaths,
      ),
    };
  } catch {
    // The invocation committed; only the projection failed. A private 500 is
    // what a durable queue reads as "ask again", and the next attempt consumes
    // the exact replay — so the answer is recovered rather than lost, and no
    // raw eid is published in the meantime.
    throw privateFailure();
  }
};

export const invokeAuthoritativeOperation = async (
  env: RamoseEnv,
  database: string,
  origin: string,
  parsed: RoutedOperationRequest,
  caller: AuthenticatedCaller,
  routeDerivation?: DatabaseRouteDerivation,
): Promise<AuthoritativeInvocationResult> => {
  const sealingScope = await invocationEntityIdScope(
    env,
    database,
    origin,
    parsed,
    caller,
  );
  const invocation: AuthoritativeOperationInvocation = {
    ...parsed,
    database: DatabaseId.make(database),
    caller,
    ...(sealingScope === undefined ? {} : {
      entityIdScope: sealingScope.scope,
      entityIdKeyId: sealingScope.sealing.keyId,
    }),
    ...(routeDerivation === undefined ? {} : { routeDerivation }),
  };
  const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(database));
  let response: Response;
  let text: string;
  try {
    response = await stub.fetch(
      `https://transactor/invoke?db=${encodeURIComponent(database)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...internalHeaders(env),
        },
        // The invocation envelope is ordinary JSON except for the target.
        // Input and claims remain codec/application-owned exact JSON.
        body: serializeOperationInvocation(invocation),
      },
    );
    text = await response.text();
  } catch {
    // A DO abort may carry storage or authorization-fence detail. None of it
    // is public operation output, even in non-production stages.
    throw privateFailure();
  }
  if (!response.ok) {
    throw operationFailureFromResponse(response, text);
  }
  // The Transactor already materialized output as exact JSON before commit.
  // Decode only the acknowledgement envelope; interpreting transport-tag
  // shaped output here would silently change the declared codec result.
  let result: AuthoritativeInvocationResult;
  try {
    result = parseAuthoritativeInvocationResult(
      JSON.parse(text),
      invocation.invocationId,
    );
  } catch {
    throw new UpstreamError({
      status: 502,
      body: JSON.stringify({ error: "transactor returned an invalid operation result" }),
    });
  }
  if (result._tag === "Completed") invalidateBasis(database);
  return sealPublicEntityRefs(env, database, origin, caller, sealingScope, result);
};

export type PublicOperationResult = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

/** One sealed HTTP projection used by `/op`; MCP and offline map the same outcome. */
export const publicOperationResult = (
  result: AuthoritativeInvocationResult,
): PublicOperationResult => {
  if (result._tag === "Conflict") {
    return {
      status: 409,
      body: { error: "request rejected", code: "invocation_conflict" },
    };
  }
  if (result._tag === "OperationChanged") {
    return {
      status: 409,
      body: { error: "request rejected", code: "operation_changed" },
    };
  }
  if (result._tag === "UpdateRequired") {
    return {
      status: 409,
      body: { error: "request rejected", code: "invocation_update_required" },
    };
  }
  if (result._tag === "Completed") {
    return {
      status: 200,
      body: {
        result: result.output,
        receipt: result.receipt,
        // Exact `{ clientRef, entityId }` mappings for the slots this caller
        // bound, sealed. Absent when nothing was bound; an exact replay
        // returns the identical list without a second commit (#475).
        ...(result.mappings === undefined ? {} : { mappings: result.mappings }),
      },
    };
  }
  if (result._tag === "Failed") {
    return {
      status: 500,
      body: {
        error: "internal error",
        code: "invocation_failed",
        receipt: result.receipt,
      },
    };
  }
  if (result._tag === "Indeterminate") {
    return {
      status: 409,
      body: {
        error: "request state is indeterminate",
        code: "invocation_indeterminate",
        receipt: result.receipt,
      },
    };
  }
  switch (result.rejection.kind) {
    case "unauthorized":
      return {
        status: 403,
        body: { error: "unauthorized", receipt: result.receipt },
      };
    case "invalid_request":
      return {
        status: 400,
        body: { error: "invalid request", receipt: result.receipt },
      };
    case "request_rejected":
      return {
        status: 409,
        body: { error: "request rejected", receipt: result.receipt },
      };
    case "operation_rejected":
      return {
        status: 409,
        body: {
          error: result.rejection.message,
          tag: "OperationRejected",
          message: result.rejection.message,
          operation: result.rejection.operation,
          ...(result.rejection.step === undefined
            ? {}
            : { step: result.rejection.step }),
          ...(result.rejection.reason === undefined
            ? {}
            : { reason: result.rejection.reason }),
          receipt: result.receipt,
        },
      };
  }
};
