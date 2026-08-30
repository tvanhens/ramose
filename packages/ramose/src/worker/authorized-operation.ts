/** Public `/op` parsing and the Worker -> authoritative Transactor hop. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  DatabaseId,
  MAX_INVOCATION_ID_LENGTH,
  OperationVersion,
  parseAuthoritativeInvocationResult,
  type AuthoritativeInvocationResult,
  type AuthoritativeOperationInvocation,
  type AuthenticatedCaller,
  type DatabaseRouteDerivation,
  type OperationInvocation,
} from "../internal/authorization/index.ts";
import { fromJson, toJson } from "../internal/core/json.ts";
import { internalHeaders } from "../internal/transactor/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
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
  "database" | "caller" | "catalogKey" | "unitHash" | "routeDerivation"
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
  const target = body.target === undefined ? undefined : fromJson(body.target);
  if (
    target !== undefined &&
    !(
      typeof target === "number" && Number.isSafeInteger(target) && target >= 0
    ) &&
    !(Array.isArray(target) && isEntityRef(target))
  ) {
    return yield* bad("operation target must be an eid or lookup ref");
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
    input: body.input,
  };
});

export const invokeAuthoritativeOperation = async (
  env: RamoseEnv,
  database: string,
  parsed: RoutedOperationRequest,
  caller: AuthenticatedCaller,
  routeDerivation?: DatabaseRouteDerivation,
): Promise<AuthoritativeInvocationResult> => {
  const invocation: AuthoritativeOperationInvocation = {
    ...parsed,
    database: DatabaseId.make(database),
    caller,
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
  return result;
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
      body: { result: result.output, receipt: result.receipt },
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
