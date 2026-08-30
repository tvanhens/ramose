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
import type { RamoseEnv } from "../RamoseEnv.ts";
import type { RuntimeBoundaries } from "../internal/runtime-boundaries.ts";
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
  readonly boundaries?: RuntimeBoundaries;
};

/** Every path failure — hidden, absent, or unauthorized — reads the same. */
const inaccessible = () =>
  toolFailure("inaccessible", "nothing addressable is available there");

/** A tool body's own failure, carried out through the traversal's channel. */
class ToolBodyFailure {
  constructor(readonly cause: unknown) {}
}

/**
 * Resolve `at` and run `use` **inside** the authorization lease.
 *
 * `executeAuthorizedGraphPathTarget` holds the lease only for the duration of
 * its callback: it fences JWT expiry and caps how long one authorized read may
 * run. Returning the target and reading afterwards would let an expired
 * credential — or an unbounded read — finish against the retained snapshot,
 * so the whole read happens in the callback, exactly as `runOneShotRead` does
 * on `/query`, `/pull`, and `/entity`.
 */
const withAuthorizedTarget = async <A>(
  input: McpRouteInput,
  at: readonly string[],
  use: (target: AuthorizedGraphPathTarget) => Promise<A>,
): Promise<A> => {
  // The traversal's own failure channel is already the collapsed denial
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
        (target) =>
          Effect.tryPromise({
            try: () => use(target),
            catch: (cause) => new ToolBodyFailure(cause),
          }),
      ).pipe(Effect.result),
    );
  } catch {
    throw toolFailure("internal_error", "the graph could not be read");
  }
  if (Result.isSuccess(resolved)) return resolved.success;
  // The body's own refusal is already public; only the traversal collapses.
  if (resolved.failure instanceof ToolBodyFailure) throw resolved.failure.cause;
  throw inaccessible();
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
  describe: (raw: unknown) => {
    const args = requireArgs(raw ?? {});
    const at = parseAt(args.at);
    return withAuthorizedTarget(input, at, (target) =>
      describeGraph(target.context, input.caller, at));
  },
  query: (raw: unknown) => {
    const args = requireArgs(raw);
    const at = parseAt(args.at);
    const document = parseQueryDocument(args.query);
    return withAuthorizedTarget(input, at, (target) =>
      runQueryDocument(target.context, input.caller, document, {
        maxCells: queryMaxCells(input.env),
      }));
  },
  mutate: async (raw: unknown) => {
    const args = parseMutateArgs(raw);
    const operationVersion = decodeOperationVersionToken(args.operation.version)!;
    // Path resolution is the same short read lease `/op` uses, and — as there
    // — the invocation deliberately runs after it: the authoritative
    // Transactor owns the operation's own JWT-expiry fence, and a trusted
    // body must not be capped by a read lease merely because its database is
    // nested. What the lease does supply is the sealed unit whose declared
    // output contract the result is projected through.
    const resolved = await withAuthorizedTarget(input, args.at, (target) => {
      const descriptor = target.context.unit.catalog.operations.find(
        (candidate) =>
          candidate.id.owner.kind === args.operation.owner.kind &&
          candidate.id.owner.name === args.operation.owner.name &&
          candidate.id.localName === args.operation.name,
      );
      // Without the declared contract the output cannot be proven free of
      // storage ids, so there is nothing safe to invoke toward. The
      // Transactor refuses an unknown operation the same way.
      if (descriptor === undefined) throw inaccessible();
      return Promise.resolve({
        output: descriptor.output,
        route: target.route,
        derivation: target.derivation,
      });
    });
    const result = await invokeAuthoritativeOperation(
      input.env,
      resolved.route.database,
      // The public origin the opaque-handle scope is bound to (#475/#566).
      // Same source `/op` uses: the request the caller was authenticated on,
      // never anything from the body.
      new URL(input.request.url).origin,
      {
        catalogKey: resolved.route.deployed.catalogKey,
        unitHash: resolved.route.deployed.unitHash,
        owner: args.operation.owner,
        localName: args.operation.name,
        invocationId: args.invocationId,
        operationVersion,
        input: args.input,
      },
      input.caller,
      resolved.derivation,
    ).catch(mutateTransportFailure);
    // The Transactor fences expiry before commit and acknowledgement; this is
    // the same final Worker checkpoint `/op` takes after that awaited hop, so
    // a credential that lapsed mid-flight cannot disclose output that may be
    // derived from data the caller can no longer read. As on `/op` the write
    // stays committed and only the response is suppressed.
    await input.boundaries?.checkpoint("operation.response");
    if (
      !Number.isSafeInteger(input.caller.exp) ||
      input.caller.exp * 1_000 <= Date.now()
    ) {
      // Deliberately *not* the collapsed denial. By this point the invocation
      // has run and its receipt is stored, so a `retryable: false` refusal
      // would tell an agent the intent never happened — and the honest way to
      // act on that is to mint a fresh invocationId, which executes the same
      // intent twice. `invocation_indeterminate` is the existing
      // outcome-uncertain code and carries the one safe recovery: the same
      // invocationId, whose #487 replay returns the original receipt. It
      // asserts nothing about whether the write landed, so it discloses
      // nothing the collapsed denial would not have.
      throw toolFailure(
        "invocation_indeterminate",
        "authorization expired before this result could be returned; " +
          "reauthenticate and retry with the same invocationId",
      );
    }
    const projected = publicMutateResult(result, resolved.output);
    if ("code" in projected) throw toolFailure(projected.code, projected.message);
    return projected;
  },
});

/**
 * Serve one experimental MCP request against this authorized root.
 *
 * The MCP SDK is reached through a dynamic import so it is evaluated on the
 * first MCP request and never otherwise. Its module graph builds a large
 * schema object at module scope, and every Ramose Worker shares this file:
 * evaluating that eagerly would charge the cost to every isolate — including
 * ones that only ever serve queries, operations, or replication — for a route
 * they never receive.
 */
export const mcpResponse = (
  input: McpRouteInput,
): Effect.Effect<Response, Internal> =>
  Effect.tryPromise({
    try: async () => {
      const { handleMcpRequest } = await import("../mcp/server.ts");
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
