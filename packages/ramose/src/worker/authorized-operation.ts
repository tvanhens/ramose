/** Public `/op` parsing and the Worker -> authoritative Transactor hop. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  DatabaseId,
  type AuthenticatedCaller,
  type OperationInvocation,
} from "../internal/authorization/index.ts";
import { parseJson, stringifyJson } from "../internal/core/json.ts";
import { internalHeaders } from "../internal/transactor/index.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { BadRequest, UpstreamError } from "./errors.ts";
import {
  isEntityRef,
  parseCatalogProof,
  readJsonObject,
} from "./authorized-read.ts";
import { invalidateBasis } from "./peer.ts";

export type ParsedOperationRequest = Omit<
  OperationInvocation,
  "database" | "caller"
>;

const bad = (message: string): BadRequest => new BadRequest({ message });

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
  const body = yield* readJsonObject(request);
  const proof = yield* Effect.fromResult(parseCatalogProof(body, request.headers));
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
    body.target !== undefined &&
    !(
      typeof body.target === "number" && Number.isSafeInteger(body.target) && body.target >= 0
    ) &&
    !(Array.isArray(body.target) && isEntityRef(body.target))
  ) {
    return yield* bad("operation target must be an eid or lookup ref");
  }
  return {
    ...proof,
    owner,
    localName: record.localName,
    ...(body.target === undefined ? {} : {
      target: body.target as Exclude<OperationInvocation["target"], undefined>,
    }),
    input: body.input,
  };
});

export const invokeAuthoritativeOperation = async (
  env: RamoseEnv,
  database: string,
  parsed: ParsedOperationRequest,
  caller: AuthenticatedCaller,
): Promise<{ readonly t: number; readonly output: unknown }> => {
  const invocation: OperationInvocation = {
    ...parsed,
    database: DatabaseId.make(database),
    caller,
  };
  const stub = env.TRANSACTOR.get(env.TRANSACTOR.idFromName(database));
  const privateFailure = (): UpstreamError => new UpstreamError({
    status: 500,
    body: JSON.stringify({ error: "operation execution failed" }),
  });
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
        body: stringifyJson({ invocation }),
      },
    );
    text = await response.text();
  } catch {
    // A DO abort may carry storage or authorization-fence detail. None of it
    // is public operation output, even in non-production stages.
    throw privateFailure();
  }
  if (!response.ok) {
    if (response.status >= 500) throw privateFailure();
    throw new UpstreamError({
      status: response.status,
      body: text,
      headers: Object.fromEntries(response.headers),
    });
  }
  const ack = parseJson(text) as { readonly t?: unknown; readonly output?: unknown };
  if (!Number.isSafeInteger(ack.t) || (ack.t as number) < 0) {
    throw new UpstreamError({
      status: 502,
      body: JSON.stringify({ error: "transactor returned an invalid operation result" }),
    });
  }
  invalidateBasis(database);
  return { t: ack.t as number, output: ack.output };
};
