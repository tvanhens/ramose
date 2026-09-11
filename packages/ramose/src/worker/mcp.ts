import * as Result from "effect/Result";
import { resolveBoundCatalogDefinition } from "../internal/authorization/database-bindings.ts";
import { operationGrantAllows } from "../internal/authorization/operation-grant.ts";
import { encodeOperationVersionToken } from "../mcp/contract.ts";
import { requestChangeset } from "./changesets.ts";
import * as Effect from "effect/Effect";
import {
  constructAuthorizedResolvedRequestContext,
  type AuthenticatedCaller,
  type AuthorizedRequestContext,
  type DatabaseRouteDerivation,
  type ResolvedDatabaseRoute,
  type DatabaseCatalogBindings,
} from "../internal/authorization/index.ts";
import {
  decodeOperationVersionToken,
  parseMutateArgs,
  parseQueryDocument,
  requireArgs,
  toolFailure,
} from "../mcp/contract.ts";
import { describeDatabase, publicMutateResult, runQueryDocument } from "../mcp/kernel.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import type { RuntimeBoundaries } from "../internal/runtime-boundaries.ts";
import { acquireCurrentDb, queryMaxCells } from "./authorized-read.ts";
import { invokeAuthoritativeOperation } from "./authorized-operation.ts";
import { BadRequest, ChangesetRejected, Internal, OperationRejected, UpstreamError, Unauthorized } from "./errors.ts";

export type McpRouteInput = {
  readonly requiresApproval?: boolean;
  readonly env: RamoseEnv;
  readonly request: Request;
  readonly bindings: DatabaseCatalogBindings;
  readonly root: ResolvedDatabaseRoute;
  readonly caller: AuthenticatedCaller;
  readonly headers: Record<string, string>;
  readonly boundaries?: RuntimeBoundaries;
};

const inaccessible = () =>
  toolFailure("inaccessible", "nothing addressable is available there");

type AuthorizedDatabase = {
  readonly context: AuthorizedRequestContext;
  readonly route: ResolvedDatabaseRoute;
  readonly derivation: DatabaseRouteDerivation;
};

const withAuthorizedDatabase = async <A>(
  input: McpRouteInput,
  use: (target: AuthorizedDatabase) => Promise<A>,
): Promise<A> => {
  let context: AuthorizedRequestContext;
  try {
    context = await Effect.runPromise(constructAuthorizedResolvedRequestContext({
      authenticate: Effect.succeed(input.caller),
      bindings: input.bindings,
      route: input.root,
      currentDb: acquireCurrentDb(input.env, input.request, {
        bypassBasisCache: true,
        authoritativeBasisFence: true,
      }),
    }, input.caller));
  } catch {
    throw inaccessible();
  }
  return use({
    context,
    route: input.root,
    derivation: { rootDatabase: input.root.database },
  });
};

const mutateTransportFailure = (cause: unknown): never => {
  if (cause instanceof BadRequest) throw toolFailure("invalid_input", "invalid changeset request");
  if (cause instanceof ChangesetRejected) {
    throw toolFailure("operation_rejected", cause.code);
  }
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
  changeset: async (raw: unknown) => {
    const args = requireArgs(raw);
    if (args.action === "describe") return withAuthorizedDatabase(input, async (target) => {
      const deployed = Result.getOrThrow(resolveBoundCatalogDefinition(input.bindings, target.route));
      const available = deployed.definition.operations.filter((binding) => operationGrantAllows(target.context.unit, binding.descriptor, input.caller, target.context.principal.subject));
      return { truncated: available.length > 100, operations: available.slice(0, 100).map((binding) => ({
          owner: binding.descriptor.id.owner, name: binding.descriptor.id.localName,
          version: encodeOperationVersionToken(binding.descriptor.version),
          target: binding.descriptor.id.target, input: binding.descriptor.input,
          description: binding.descriptor.doc,
        })) };
    });
    if (args.action !== "list" && args.action !== "append" && args.action !== "query" && args.action !== "prepare" && args.action !== "inspect" && args.action !== "discard") {
      throw toolFailure("invalid_input", "agents can describe, query, prepare, inspect, or discard proposals; approval belongs in the application");
    }
    const operations = Array.isArray(args.operations) ? args.operations.map((raw) => {
      const parsed = parseMutateArgs({ ...requireArgs(raw), invocationId: "changeset" });
      return { operation: { owner: parsed.operation.owner, localName: parsed.operation.name },
        operationVersion: decodeOperationVersionToken(parsed.operation.version), input: parsed.input,
        ...(requireArgs(raw).target === undefined ? {} : { target: requireArgs(raw).target }) };
    }) : undefined;
    return withAuthorizedDatabase(input, async (target) => requestChangeset(
      input.env, new URL(input.request.url).origin, target.route.database,
      target.route.deployed.catalogKey, target.route.deployed.unitHash, input.caller,
      { ...args, operations },
    )).catch(mutateTransportFailure);
  },
  describe: (raw: unknown) => {
    requireArgs(raw ?? {});
    return withAuthorizedDatabase(input, (target) =>
      describeDatabase(target.context, input.caller));
  },
  query: (raw: unknown) => {
    const args = requireArgs(raw);
    const document = parseQueryDocument(args.query);
    return withAuthorizedDatabase(input, (target) =>
      runQueryDocument(target.context, input.caller, document, {
        maxCells: queryMaxCells(input.env),
      }));
  },
  mutate: async (raw: unknown) => {
    if (input.requiresApproval) throw inaccessible();
    const args = parseMutateArgs(raw);
    const operationVersion = decodeOperationVersionToken(args.operation.version)!;
    const resolved = await withAuthorizedDatabase(input, (target) => {
      const descriptor = target.context.unit.catalog.operations.find(
        (candidate) =>
          candidate.id.owner.kind === args.operation.owner.kind &&
          candidate.id.owner.name === args.operation.owner.name &&
          candidate.id.localName === args.operation.name,
      );
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
    ).catch(mutateTransportFailure);
    await input.boundaries?.checkpoint("operation.response");
    if (
      !Number.isSafeInteger(input.caller.exp) ||
      input.caller.exp * 1_000 <= Date.now()
    ) {
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

export const mcpResponse = (
  input: McpRouteInput,
): Effect.Effect<Response, Internal> =>
  Effect.tryPromise({
    try: async () => {
      const { handleMcpRequest } = await import("../mcp/server.ts");
      const tools = mcpTools(input);
      const response = await handleMcpRequest(input.request, {
        describe: tools.describe, query: tools.query, changeset: tools.changeset,
        ...(input.requiresApproval ? {} : { mutate: tools.mutate }),
      });
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
