/** Capability cards and the canonical mutate template (#485). */

import { describe, expect, test } from "bun:test";
import {
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
  closeIssue,
  closeIssueCard,
  describeCard,
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

  test("a generated alias would lower to the identical canonical request", () => {
    // #542's aliases are derived views: an alias call supplies exactly the
    // fill fields and nothing else, so it cannot produce a different request.
    const viaAlias = {
      ...mutateTemplate({
        at: supportPath,
        operation: closeIssue,
        target: "required",
        hasInput: true,
      }).arguments,
      target: { entity: "issue", id: "ISSUE-8472" },
      input: { reason: "duplicate" },
      invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
    };
    expect(viaAlias).toEqual(filled);
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
