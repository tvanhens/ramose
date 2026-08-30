/**
 * Worker glue for the experimental MCP endpoint (#484 S1).
 *
 * Authentication has already happened at the request boundary — a missing or
 * invalid credential is answered with an HTTP 401/403 challenge and never
 * reaches a tool. What is left here is the per-call authorization every other
 * external route performs: resolve `at` from the caller's one authorized root
 * through the same graph-path traversal (#325), and run the tool against only
 * the filtered `Db` and sealed unit that traversal produced (#419/#421/#423).
 *
 * Writes go through {@link invokeAuthoritativeOperation} — the same
 * claim/execute/complete/replay receipt path `/op` uses (#487). There is no
 * second executor, digest, or receipt here.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  executeAuthorizedGraphPathTarget,
  type AuthenticatedCaller,
  type AuthorizedGraphPathTarget,
  type DatabaseRouteDerivation,
  type ResolvedDatabaseRoute,
  type DatabaseCatalogBindings,
} from "../internal/authorization/index.ts";
import {
  decodeOperationVersionToken,
  parseAt,
  parseMutateArgs,
  parseQueryDocument,
  requireArgs,
  toolFailure,
} from "../mcp/contract.ts";
import { describeGraph, publicMutateResult, runQueryDocument } from "../mcp/kernel.ts";
import { handleMcpRequest } from "../mcp/server.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import { acquireCurrentDb, provisionResolvedDatabase, queryMaxCells } from "./authorized-read.ts";
import { invokeAuthoritativeOperation } from "./authorized-operation.ts";
import { Internal, OperationRejected, UpstreamError, Unauthorized } from "./errors.ts";

export type McpRouteInput = {
  readonly env: RamoseEnv;
  readonly request: Request;
  readonly bindings: DatabaseCatalogBindings;
  readonly root: ResolvedDatabaseRoute;
  readonly caller: AuthenticatedCaller;
  readonly headers: Record<string, string>;
};

/** Every path failure — hidden, absent, or unauthorized — reads the same. */
const inaccessible = () =>
  toolFailure("inaccessible", "nothing addressable is available there");

const resolveTarget = async (
  input: McpRouteInput,
  at: readonly string[],
): Promise<AuthorizedGraphPathTarget> => {
  // The traversal's whole failure channel is already the collapsed denial
  // (`opaqueGraphPathDenial`): hidden, absent, and unauthorized arrive here
  // identical. A defect is something else and must not read as a denial.
  let resolved;
  try {
    resolved = await Effect.runPromise(
      executeAuthorizedGraphPathTarget(
        {
          authenticate: Effect.succeed(input.caller),
          bindings: input.bindings,
          root: input.root,
          path: at,
          currentDb: acquireCurrentDb(input.env, input.request, {
            bypassBasisCache: true,
            authoritativeBasisFence: true,
          }),
          provision: (
            route: ResolvedDatabaseRoute,
            derivation: DatabaseRouteDerivation,
          ) => provisionResolvedDatabase(input.env, route, derivation),
        },
        (target) => Effect.succeed(target),
      ).pipe(Effect.result),
    );
  } catch {
    throw toolFailure("internal_error", "the graph could not be read");
  }
  if (Result.isFailure(resolved)) throw inaccessible();
  return resolved.success;
};

/** Restate a thrown invocation failure without engine, codec, or route detail. */
const mutateTransportFailure = (cause: unknown): never => {
  if (cause instanceof OperationRejected) {
    throw toolFailure("operation_rejected", cause.message);
  }
  if (cause instanceof Unauthorized) throw inaccessible();
  if (cause instanceof UpstreamError) {
    if (cause.status === 401 || cause.status === 403) throw inaccessible();
    if (cause.status === 400) {
      throw toolFailure("invalid_input", "the operation refused this input");
    }
    if (cause.status === 409) {
      throw toolFailure("operation_rejected", "the operation refused the request");
    }
  }
  throw toolFailure("internal_error", "the operation could not be invoked");
};

const mcpTools = (input: McpRouteInput) => ({
  describe: async (raw: unknown) => {
    const args = requireArgs(raw ?? {});
    const at = parseAt(args.at);
    const target = await resolveTarget(input, at);
    return describeGraph(target.context, input.caller, at);
  },
  query: async (raw: unknown) => {
    const args = requireArgs(raw);
    const at = parseAt(args.at);
    const document = parseQueryDocument(args.query);
    const target = await resolveTarget(input, at);
    return runQueryDocument(target.context, document, {
      maxCells: queryMaxCells(input.env),
    });
  },
  mutate: async (raw: unknown) => {
    const args = parseMutateArgs(raw);
    const operationVersion = decodeOperationVersionToken(args.operation.version)!;
    const target = await resolveTarget(input, args.at);
    const result = await invokeAuthoritativeOperation(
      input.env,
      target.route.database,
      {
        catalogKey: target.route.deployed.catalogKey,
        unitHash: target.route.deployed.unitHash,
        owner: args.operation.owner,
        localName: args.operation.name,
        invocationId: args.invocationId,
        operationVersion,
        input: args.input,
      },
      input.caller,
      target.derivation,
    ).catch(mutateTransportFailure);
    const projected = publicMutateResult(result);
    if ("code" in projected) throw toolFailure(projected.code, projected.message);
    return projected;
  },
});

/** Serve one experimental MCP request against this authorized root. */
export const mcpResponse = (
  input: McpRouteInput,
): Effect.Effect<Response, Internal> =>
  Effect.tryPromise({
    try: async () => {
      const response = await handleMcpRequest(input.request, mcpTools(input));
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(input.headers)) {
        headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    },
    catch: (cause) =>
      new Internal({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
