/**
 * The experimental MCP transport surface (#484 S1).
 *
 * One stateless Streamable HTTP endpoint served by the official TypeScript
 * SDK's web-standard handler. No sessions, no resumability, no server-initiated
 * stream: every request stands alone, which is what lets the same Worker answer
 * it without holding state across the edge.
 *
 * Failure classes are kept apart deliberately. Malformed envelopes, unknown
 * methods, and unknown tool names are **protocol** errors; missing or invalid
 * credentials are an **HTTP challenge** raised before this module is reached;
 * everything recoverable — validation, sealing, conflicts, refusals — is a
 * *completed* tool result with `isError: true` carrying the shared envelope,
 * because the agent that made the call is the party that can act on it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  MAX_QUERY_LIMIT,
  McpToolFailure,
  errorEnvelope,
  type ErrorEnvelopeV1,
} from "./contract.ts";

/** Tool bodies. Each resolves a public value or throws {@link McpToolFailure}. */
export type KernelTools = {
  readonly describe: (args: unknown) => Promise<unknown>;
  readonly query: (args: unknown) => Promise<unknown>;
  readonly mutate: (args: unknown) => Promise<unknown>;
};

const EXPERIMENTAL =
  "EXPERIMENTAL: Ramose's MCP surface makes no compatibility promise yet. " +
  "Tool shapes, error codes, and results may change without notice.";

const INSTRUCTIONS = `${EXPERIMENTAL}

Three tools reach this application's whole authorized surface. Every call takes
"at": a path of graph names relative to your authorized root ([] is the root).

1. describe — visible entity names, invocable operations, and child graph names.
2. query — read rows of one entity with equality filters and a field projection.
3. mutate — invoke one discovered operation with the version describe returned
   and your own invocationId. Repeating the same invocationId replays the first
   outcome exactly rather than acting twice.

Anything you cannot see is reported as if it did not exist.`;

const AT_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1 },
  maxItems: 16,
  description:
    "Graph names from your authorized root. [] selects the root itself.",
} as const;

const TOOLS = Object.freeze([
  {
    name: "describe",
    title: "Describe visible capabilities",
    description:
      "List the entity names, invocable operations, and child graph names visible " +
      "to you at one graph path. Names only; lists are capped and report truncated.",
    inputSchema: {
      type: "object",
      properties: { at: AT_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: "query",
    title: "Query application state",
    description:
      "Read rows of one entity. The query document is { version: 1, from: " +
      "{ entity }, where?: equality on field names, select?: field names, limit? }. " +
      "Anything you cannot see reads as absent.",
    inputSchema: {
      type: "object",
      properties: {
        at: AT_SCHEMA,
        query: {
          type: "object",
          properties: {
            version: { const: 1 },
            from: {
              type: "object",
              properties: { entity: { type: "string", minLength: 1 } },
              required: ["entity"],
              additionalProperties: false,
            },
            where: {
              type: "object",
              additionalProperties: {
                type: ["string", "number", "boolean"],
              },
              description: "Field name to required value. Equality only.",
            },
            select: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 64,
            },
            limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_LIMIT },
          },
          required: ["version", "from"],
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mutate",
    title: "Invoke one declared operation",
    description:
      "Invoke exactly one operation describe listed, pinned to the version it " +
      "returned. Supply your own invocationId; sending it again replays the first " +
      "outcome instead of acting twice.",
    inputSchema: {
      type: "object",
      properties: {
        at: AT_SCHEMA,
        operation: {
          type: "object",
          properties: {
            owner: {
              type: "object",
              properties: {
                kind: { enum: ["entity", "trait"] },
                name: { type: "string", minLength: 1 },
              },
              required: ["kind", "name"],
              additionalProperties: false,
            },
            name: { type: "string", minLength: 1 },
            version: {
              type: "string",
              description: "Opaque version from describe. Send it back verbatim.",
            },
          },
          required: ["owner", "name", "version"],
          additionalProperties: false,
        },
        input: { type: "object", description: "The operation's declared input." },
        invocationId: {
          type: "string",
          minLength: 1,
          description: "Your idempotency key for this one intent.",
        },
      },
      required: ["operation", "input", "invocationId"],
      additionalProperties: false,
    },
  },
]);

/**
 * The SDK constructs an Ajv validator eagerly, and Ajv compiles schemas with
 * `new Function`, which Workers forbid. Nothing on this surface declares an
 * elicitation form — the only place the SDK consults it — so an inert provider
 * is both correct and the only one that can be constructed here.
 */
const INERT_VALIDATOR: jsonSchemaValidator = {
  getValidator: () => () => ({
    valid: false,
    data: undefined,
    errorMessage: "ramose/mcp: schema validation is not available on this surface",
  }),
};

const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

const failedResult = (envelope: ErrorEnvelopeV1) => ({
  ...toolResult(envelope),
  isError: true,
});

/**
 * Answer one MCP request. `tools` closes over the verified principal and the
 * authorized root, so nothing about identity is read from the JSON-RPC body.
 */
export const handleMcpRequest = async (
  request: Request,
  tools: KernelTools,
): Promise<Response> => {
  const server = new Server(
    { name: "ramose", title: "Ramose (experimental)", version: "experimental" },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      jsonSchemaValidator: INERT_VALIDATOR,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const body = tools[call.params.name as keyof KernelTools];
    if (body === undefined || !Object.hasOwn(tools, call.params.name)) {
      throw new McpError(ErrorCode.InvalidParams, "unknown tool");
    }
    try {
      return toolResult(await body(call.params.arguments));
    } catch (cause) {
      if (cause instanceof McpToolFailure) return failedResult(cause.envelope);
      if (cause instanceof McpError) throw cause;
      // Nothing else may reach the wire: an unclassified failure could carry
      // storage, catalog, or codec detail.
      return failedResult(errorEnvelope("internal_error", "the request failed"));
    }
  });
  // No `sessionIdGenerator` is stateless mode: no session id is minted, none
  // is validated, and nothing survives the request. One transport per request
  // is required in that mode and is also what the edge can honestly provide.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};
