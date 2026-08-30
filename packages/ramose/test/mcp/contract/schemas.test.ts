/** Published kernel tool schemas (#485). */

import { describe, expect, test } from "bun:test";
import {
  DESCRIBE_TOOL,
  ERROR_CODES,
  JSON_SCHEMA_DIALECT_URI,
  KERNEL_TOOLS,
  KERNEL_TOOL_NAMES,
  MAX_PAGE_SIZE,
  MUTATE_TOOL,
  QUERY_TOOL,
  RESERVED_MRTR_ARGUMENT_NAMES,
  assertNoReservedArgumentNames,
  isDescribeInput,
  isDescribeOutput,
  isMutateInput,
  isMutateOutput,
  isQueryInput,
  isQueryOutput,
  kernelTool,
} from "../../../src/mcp/contract/index.ts";
import {
  catalogToken,
  closeIssue,
  describeCard,
  describeListing,
  mutateRequest,
  mutateResult,
  queryRequest,
  queryResult,
  supportPath,
} from "./examples.ts";

type Node = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const everySchemaNode = (root: Node): readonly [string, Node][] => {
  const found: [string, Node][] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!isObject(node)) return;
    found.push([path, node]);
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
  };
  walk(root, "");
  return found;
};

const allRefs = (root: Node): readonly string[] =>
  everySchemaNode(root)
    .map(([, node]) => node.$ref)
    .filter((ref): ref is string => typeof ref === "string");

describe("kernel tool list", () => {
  test("is exactly describe, query, and mutate", () => {
    expect(KERNEL_TOOLS.map((tool) => tool.name)).toEqual([
      "describe",
      "query",
      "mutate",
    ]);
    expect([...KERNEL_TOOL_NAMES]).toEqual(["describe", "query", "mutate"]);
  });

  test("is reachable by name", () => {
    expect(kernelTool("query")).toBe(QUERY_TOOL);
    expect(() => kernelTool("nope" as never)).toThrow(/no kernel tool/);
  });

  test("annotates the read-only tools honestly and mutate conservatively", () => {
    for (const tool of [DESCRIBE_TOOL, QUERY_TOOL]) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.idempotentHint).toBe(true);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    expect(MUTATE_TOOL.annotations.readOnlyHint).toBe(false);
    expect(MUTATE_TOOL.annotations.destructiveHint).toBe(true);
    expect(MUTATE_TOOL.annotations.openWorldHint).toBe(true);
    // Reusing an invocationId replays rather than repeats.
    expect(MUTATE_TOOL.annotations.idempotentHint).toBe(true);
  });
});

describe("every published schema", () => {
  for (const tool of KERNEL_TOOLS) {
    test(`${tool.name}: input schema root is a JSON object`, () => {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_DIALECT_URI);
    });

    test(`${tool.name}: output schema declares the 2020-12 dialect`, () => {
      expect(tool.outputSchema.$schema).toBe(JSON_SCHEMA_DIALECT_URI);
    });

    for (const which of ["inputSchema", "outputSchema"] as const) {
      test(`${tool.name}.${which}: every definition is described`, () => {
        const root = tool[which] as Node;
        expect(typeof root.description).toBe("string");
        const defs = (root.$defs ?? {}) as Node;
        for (const [name, definition] of Object.entries(defs)) {
          expect(isObject(definition)).toBe(true);
          expect(
            typeof (definition as Node).description === "string",
          ).toBe(true);
          // Names are contract types, never generator inventions.
          expect(name).toMatch(/^[A-Z][A-Za-z0-9]*V1$/);
        }
      });

      test(`${tool.name}.${which}: every $ref resolves inside the document`, () => {
        const root = tool[which] as Node;
        const defs = (root.$defs ?? {}) as Node;
        for (const ref of allRefs(root)) {
          expect(ref.startsWith("#/$defs/")).toBe(true);
          expect(Object.hasOwn(defs, ref.slice("#/$defs/".length))).toBe(true);
        }
      });

      test(`${tool.name}.${which}: no reserved MRTR argument name`, () => {
        expect(() =>
          assertNoReservedArgumentNames(tool[which], `${tool.name}.${which}`)
        ).not.toThrow();
        for (const reserved of RESERVED_MRTR_ARGUMENT_NAMES) {
          const serialized = JSON.stringify(tool[which]);
          expect(serialized.includes(`"${reserved}"`)).toBe(false);
        }
      });
    }
  }

  test("refuses a schema that declares a reserved MRTR argument", () => {
    expect(() =>
      assertNoReservedArgumentNames(
        {
          type: "object",
          properties: { requestState: { type: "string" } },
        },
        "application schema",
      )
    ).toThrow(/requestState/);
    expect(() =>
      assertNoReservedArgumentNames(
        {
          type: "object",
          properties: {
            nested: { type: "object", properties: { inputResponses: {} } },
          },
        },
        "application schema",
      )
    ).toThrow(/inputResponses/);
  });
});

describe("required argument sets", () => {
  const required = (schema: Node): readonly string[] =>
    [...((schema.required ?? []) as readonly string[])].sort();

  // Locked on purpose. Adding a required input argument is a new contract
  // version, so this test is the thing that has to be edited deliberately.
  test("describe requires nothing: an agent can start with no arguments", () => {
    expect(required(DESCRIBE_TOOL.inputSchema)).toEqual([]);
  });

  test("query requires only the document", () => {
    expect(required(QUERY_TOOL.inputSchema)).toEqual(["query"]);
  });

  test("every tool accepts an optional catalog pin", () => {
    for (const tool of KERNEL_TOOLS) {
      const properties = tool.inputSchema.properties as Node;
      expect({ tool: tool.name, pins: Object.hasOwn(properties, "ifCatalog") })
        .toEqual({ tool: tool.name, pins: true });
      expect(required(tool.inputSchema)).not.toContain("ifCatalog");
    }
  });

  test("mutate requires the versioned operation and an invocation id", () => {
    expect(required(MUTATE_TOOL.inputSchema)).toEqual([
      "invocationId",
      "operation",
    ]);
    const operationRef =
      (MUTATE_TOOL.inputSchema.$defs as Node).OperationRefV1 as Node;
    expect([...((operationRef.required ?? []) as readonly string[])].sort())
      .toEqual(["name", "owner", "version"]);
  });
});

describe("output unions", () => {
  const arms = (schema: Node): readonly string[] =>
    ((schema.anyOf ?? []) as readonly Node[]).map((arm) => String(arm.$ref));

  test("each tool output is a union of its success and error envelopes", () => {
    expect(arms(DESCRIBE_TOOL.outputSchema)).toEqual([
      "#/$defs/DescribeListingV1",
      "#/$defs/DescribeCardResultV1",
      "#/$defs/ToolErrorResultV1",
    ]);
    expect(arms(QUERY_TOOL.outputSchema)).toEqual([
      "#/$defs/QuerySuccessV1",
      "#/$defs/ToolErrorResultV1",
    ]);
    expect(arms(MUTATE_TOOL.outputSchema)).toEqual([
      "#/$defs/MutateSuccessV1",
      "#/$defs/MutateErrorResultV1",
    ]);
  });

  test("every arm carries the ok discriminator", () => {
    for (const tool of KERNEL_TOOLS) {
      const defs = tool.outputSchema.$defs as Node;
      for (const ref of arms(tool.outputSchema)) {
        const arm = defs[ref.slice("#/$defs/".length)] as Node;
        const properties = arm.properties as Node;
        expect(Object.hasOwn(properties, "ok")).toBe(true);
        expect(
          ((arm.required ?? []) as readonly string[]).includes("ok"),
        ).toBe(true);
      }
    }
  });

  test("the error envelope publishes exactly the nine v1 codes", () => {
    const defs = QUERY_TOOL.outputSchema.$defs as Node;
    const envelope = defs.ErrorEnvelopeV1 as Node;
    const code = (envelope.properties as Node).code as Node;
    expect(code.enum).toEqual([...ERROR_CODES]);
    expect([...((envelope.required ?? []) as readonly string[])].sort())
      .toEqual(["code", "message", "path", "retryable"]);
  });
});

describe("explicit bounds", () => {
  test("page limits are bounded on every paged tool", () => {
    for (const tool of [DESCRIBE_TOOL, QUERY_TOOL]) {
      const limit = (tool.outputSchema.$defs as Node).PageLimitV1 as Node;
      expect(limit.maximum).toBe(MAX_PAGE_SIZE);
      expect(limit.minimum).toBe(1);
    }
  });

  test("every contract-owned collection in a result declares a maximum", () => {
    // The one exemption is JsonValueV1: it carries application data an
    // operation or query author shaped, and a wire bound the server does not
    // actually enforce on that data would be a schema that lies. Arbitrary
    // JSON is bounded at the engine's trust boundary instead.
    const exempt = ".$defs.JsonValueV1";
    const unbounded: string[] = [];
    for (const tool of KERNEL_TOOLS) {
      for (const [path, node] of everySchemaNode(tool.outputSchema as Node)) {
        if (node.type !== "array" || node.maxItems !== undefined) continue;
        unbounded.push(`${tool.name}${path}`);
      }
    }
    expect(unbounded.every((path) => path.includes(exempt))).toBe(true);
  });
});

describe("structuredContent validation", () => {
  test("accepts the published success examples", () => {
    expect(isDescribeOutput(describeListing)).toBe(true);
    expect(isDescribeOutput(describeCard)).toBe(true);
    expect(isQueryOutput(queryResult)).toBe(true);
    expect(isMutateOutput(mutateResult)).toBe(true);
  });

  test("accepts the published request examples", () => {
    expect(isQueryInput(queryRequest)).toBe(true);
    expect(isMutateInput(mutateRequest)).toBe(true);
    expect(isDescribeInput({})).toBe(true);
    expect(isDescribeInput({ at: [], limit: 20, search: "close issue" }))
      .toBe(true);
  });

  test("accepts the recoverable error envelopes", () => {
    const envelope = {
      ok: false,
      error: {
        code: "catalog_changed",
        path: ["ifCatalog"],
        message: "The pinned catalog is no longer current.",
        hint: "Re-run describe and resend with the returned catalogToken.",
        retryable: true,
      },
    };
    expect(isDescribeOutput(envelope)).toBe(true);
    expect(isQueryOutput(envelope)).toBe(true);
    expect(isMutateOutput(envelope)).toBe(true);
  });

  test("rejects a mutation that omits the operation version", () => {
    expect(
      isMutateInput({
        ...mutateRequest,
        operation: { owner: closeIssue.owner, name: closeIssue.name },
      }),
    ).toBe(false);
  });

  test("rejects a mutation that omits the invocation id", () => {
    const { invocationId: _dropped, ...withoutId } = mutateRequest;
    expect(isMutateInput(withoutId)).toBe(false);
  });

  test("rejects a query document that is a string, not an object", () => {
    expect(isQueryInput({ at: supportPath, query: "from issue" })).toBe(false);
  });

  test("rejects a query document without its language version", () => {
    expect(isQueryInput({ query: { from: { entity: "issue" } } })).toBe(false);
    expect(isQueryInput({ query: { version: 2 } })).toBe(false);
  });

  test("rejects an unknown error code", () => {
    expect(
      isQueryOutput({
        ok: false,
        error: {
          code: "teapot",
          path: [],
          message: "no",
          retryable: false,
        },
      }),
    ).toBe(false);
  });

  test("rejects a page over the published limit", () => {
    expect(
      isDescribeInput({ limit: MAX_PAGE_SIZE + 1 }),
    ).toBe(false);
  });

  test("rejects an opaque handle from the wrong family", () => {
    expect(isDescribeInput({ ifCatalog: "cur_abc" })).toBe(false);
    expect(isDescribeInput({ cursor: catalogToken })).toBe(false);
  });
});
