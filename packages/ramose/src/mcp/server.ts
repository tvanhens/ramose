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

export type KernelTools = {
  readonly describe: (args: unknown) => Promise<unknown>;
  readonly query: (args: unknown) => Promise<unknown>;
  readonly mutate: (args: unknown) => Promise<unknown>;
};

const EXPERIMENTAL =
  "EXPERIMENTAL: Ramose's MCP surface makes no compatibility promise yet. " +
  "Tool shapes, error codes, and results may change without notice.";

const INSTRUCTIONS = `${EXPERIMENTAL}

Three tools reach this application's whole authorized database surface.

1. describe — visible entity names and invocable operations.
2. query — read rows of one entity with equality filters and a field projection.
3. mutate — invoke one discovered operation with the version describe returned
   and your own invocationId. Repeating the same invocationId replays the first
   outcome exactly rather than acting twice.

Anything you cannot see is reported as if it did not exist.`;

const TOOLS = Object.freeze([
  {
    name: "describe",
    title: "Describe visible capabilities",
    description:
      "List the entity names and invocable operations visible to you. " +
      "Names only; lists are capped and report truncated.",
    inputSchema: {
      type: "object",
      properties: {},
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
      return failedResult(errorEnvelope("internal_error", "the request failed"));
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};
