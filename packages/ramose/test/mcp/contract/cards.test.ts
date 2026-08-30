/** Capability cards and the canonical mutate template (#485). */

import { describe, expect, test } from "bun:test";
import {
  DESCRIBE_TOOL,
  MUTATE_TEMPLATE_FILL_FIELDS,
  MUTATE_TOOL,
  assertNoReservedArgumentNames,
  assertSealedPublicJson,
  isDescribeOutput,
  isMutateInput,
  mutateTemplate,
  pageInfo,
} from "../../../src/mcp/contract/index.ts";
import {
  catalogToken,
  closeIssue,
  closeIssueCard,
  describeCard,
  describeListing,
  listingCursor,
  supportPath,
} from "./examples.ts";

describe("mutateTemplate", () => {
  test("fixes the path and the versioned operation, and asks for the rest", () => {
    const template = mutateTemplate({
      at: supportPath,
      operation: closeIssue,
      target: "required",
      hasInput: true,
    });
    expect(template.tool).toBe("mutate");
    expect(template.arguments).toEqual({
      at: supportPath,
      operation: closeIssue,
    });
    expect([...template.fill]).toEqual(["target", "input", "invocationId"]);
  });

  test("carries the catalog the card was projected from, when there is one", () => {
    const template = mutateTemplate({
      at: supportPath,
      operation: closeIssue,
      target: "required",
      hasInput: true,
      ifCatalog: catalogToken,
    });
    expect(template.arguments.ifCatalog).toBe(catalogToken);
  });

  test("omits the pin entirely when the projection did not supply one", () => {
    const template = mutateTemplate({
      at: supportPath,
      operation: closeIssue,
      target: "none",
      hasInput: false,
    });
    expect(Object.hasOwn(template.arguments, "ifCatalog")).toBe(false);
  });

  test("omits target for a targetless operation and input when there is none", () => {
    expect([
      ...mutateTemplate({
        at: [],
        operation: closeIssue,
        target: "none",
        hasInput: false,
      }).fill,
    ]).toEqual(["invocationId"]);
  });

  test("always asks for an invocation id", () => {
    for (const target of ["required", "none"] as const) {
      for (const hasInput of [true, false]) {
        expect(
          mutateTemplate({ at: [], operation: closeIssue, target, hasInput })
            .fill,
        ).toContain("invocationId");
      }
    }
  });

  test("only ever asks for fields the mutate input schema defines", () => {
    const properties = Object.keys(
      MUTATE_TOOL.inputSchema.properties as Record<string, unknown>,
    );
    for (const field of MUTATE_TEMPLATE_FILL_FIELDS) {
      expect(properties).toContain(field);
    }
  });
});

describe("lowering a card to a call", () => {
  /**
   * The point of the template: a client that merges the fill values into the
   * server-supplied arguments produces a request that the published mutate
   * input schema accepts, with no client-side knowledge of Ramose.
   */
  const filled = {
    ...closeIssueCard.mutateTemplate.arguments,
    target: { entity: "issue", id: "ISSUE-8472" },
    input: { reason: "duplicate" },
    invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
  };

  test("the completed template is a valid mutate request", () => {
    expect(isMutateInput(filled)).toBe(true);
  });

  test("it carries the exact version the card published", () => {
    expect(filled.operation.version).toBe(closeIssue.version);
  });

  test("the catalog pin survives the round trip into the request", () => {
    // The whole point of the flow Codex described: the agent inspected a
    // capability under one catalog and the write is fenced to that catalog.
    expect(closeIssueCard.mutateTemplate.arguments.ifCatalog)
      .toBe(catalogToken);
    expect(isMutateInput(filled)).toBe(true);
    expect((filled as { readonly ifCatalog?: string }).ifCatalog)
      .toBe(catalogToken);
  });

  test("dropping the pin is still a valid request: it is a fence, not a credential", () => {
    const { ifCatalog: _dropped, ...unpinned } = filled;
    expect(isMutateInput(unpinned)).toBe(true);
  });

  test("a generated alias would lower to the identical canonical request", () => {
    // #542's aliases are derived views: an alias call supplies exactly the
    // fill fields and nothing else, so it cannot produce a different request.
    const viaAlias = {
      ...mutateTemplate({
        at: supportPath,
        operation: closeIssue,
        target: "required",
        hasInput: true,
        ifCatalog: catalogToken,
      }).arguments,
      target: { entity: "issue", id: "ISSUE-8472" },
      input: { reason: "duplicate" },
      invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
    };
    expect(viaAlias).toEqual(filled);
  });

  test("the template completes with a non-object input just as well", () => {
    // An operation declaring a scalar or array input lowers through the same
    // template; only the value the caller fills in differs.
    for (const input of ["duplicate", ["a", "b"], 7]) {
      const call = { ...closeIssueCard.mutateTemplate.arguments, ...{
        target: { entity: "issue", id: "ISSUE-8472" },
        input,
        invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
      } };
      expect({ input, valid: isMutateInput(call) })
        .toEqual({ input, valid: true });
    }
  });

  test("an incomplete template is refused, not guessed at", () => {
    const { invocationId: _dropped, ...withoutId } = filled;
    expect(isMutateInput(withoutId)).toBe(false);
  });
});

describe("operation cards", () => {
  test("validate as describe structuredContent", () => {
    expect(isDescribeOutput(describeCard)).toBe(true);
  });

  test("carry no internal identity", () => {
    expect(() => assertSealedPublicJson(closeIssueCard as never)).not.toThrow();
  });

  test("an application input schema may not claim a reserved MCP argument", () => {
    expect(() =>
      assertNoReservedArgumentNames(closeIssueCard.inputSchema, "card")
    ).not.toThrow();
    expect(() =>
      assertNoReservedArgumentNames(
        {
          ...closeIssueCard.inputSchema,
          properties: { requestState: { type: "string" } },
        },
        "card",
      )
    ).toThrow(/requestState/);
  });
});

describe("listing summaries bind each kind to its reference shape", () => {
  const listing = (kind: string, ref: unknown) => ({
    ok: true,
    result: "listing",
    at: supportPath,
    catalogToken,
    items: [{ kind, ref, at: supportPath }],
    page: pageInfo({ limit: 25, returned: 1 }),
  });

  const refs = {
    graph: { kind: "graph", name: "support" },
    entity: { kind: "entity", name: "issue" },
    trait: { kind: "trait", name: "taggable" },
    field: { kind: "field", owner: { kind: "entity", name: "issue" }, name: "title" },
    operation: closeIssue,
    function: { namespace: "text", name: "lower" },
  } as const;

  test("each kind accepts exactly its own reference", () => {
    for (const [kind, ref] of Object.entries(refs)) {
      expect({ kind, valid: isDescribeOutput(listing(kind, ref)) })
        .toEqual({ kind, valid: true });
    }
  });

  test("a kind paired with another kind's reference is rejected", () => {
    // The reported case: kind says operation, so a client reads ref.owner and
    // ref.version — but the value is a function reference.
    expect(isDescribeOutput(listing("operation", refs.function))).toBe(false);
    expect(isDescribeOutput(listing("function", refs.operation))).toBe(false);
    expect(isDescribeOutput(listing("entity", refs.trait))).toBe(false);
    expect(isDescribeOutput(listing("trait", refs.entity))).toBe(false);
    expect(isDescribeOutput(listing("field", refs.entity))).toBe(false);
    expect(isDescribeOutput(listing("graph", refs.field))).toBe(false);
  });

  test("the published schema really is six discriminated arms", () => {
    const defs = DESCRIBE_TOOL.outputSchema.$defs as Record<string, {
      readonly anyOf?: readonly { readonly $ref?: string }[];
    }>;
    const summary = defs.CapabilitySummaryV1;
    expect(summary?.anyOf).toHaveLength(6);
  });

  test("every published summary example still validates", () => {
    expect(isDescribeOutput(describeListing)).toBe(true);
  });
});

describe("pageInfo", () => {
  test("says hasMore exactly when it hands back a cursor", () => {
    expect(pageInfo({ limit: 25, returned: 25, cursor: listingCursor }))
      .toEqual({
        limit: 25,
        returned: 25,
        hasMore: true,
        cursor: listingCursor,
      });
    expect(pageInfo({ limit: 25, returned: 3 }))
      .toEqual({ limit: 25, returned: 3, hasMore: false });
  });

  test("refuses to describe a page that returned more than it allowed", () => {
    expect(() => pageInfo({ limit: 10, returned: 11 }))
      .toThrow(/exceeds its limit/);
  });

  test("refuses a limit outside the published bounds", () => {
    expect(() => pageInfo({ limit: 0, returned: 0 })).toThrow(/public bounds/);
    expect(() => pageInfo({ limit: 10_000, returned: 0 }))
      .toThrow(/public bounds/);
  });
});
