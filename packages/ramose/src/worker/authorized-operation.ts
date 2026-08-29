/** Public `/op` parsing and the Worker -> authoritative Transactor hop. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  DatabaseId,
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
  readonly catalogKey?: OperationInvocation["catalogKey"];
  readonly unitHash?: OperationInvocation["unitHash"];
};

type RoutedOperationRequest = Omit<ParsedOperationRequest, "path"> & {
  readonly catalogKey: OperationInvocation["catalogKey"];
  readonly unitHash: OperationInvocation["unitHash"];
};

/** Serialize only the target through Ramose's entity-ref transport vocabulary. */
export const serializeOperationInvocation = (
  invocation: OperationInvocation,
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
): Promise<{ readonly t: number; readonly output: unknown }> => {
  const invocation: OperationInvocation = {
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
  const ack = JSON.parse(text) as { readonly t?: unknown; readonly output?: unknown };
  if (!Number.isSafeInteger(ack.t) || (ack.t as number) < 0) {
    throw new UpstreamError({
      status: 502,
      body: JSON.stringify({ error: "transactor returned an invalid operation result" }),
    });
  }
  invalidateBasis(database);
  return { t: ack.t as number, output: ack.output };
};
