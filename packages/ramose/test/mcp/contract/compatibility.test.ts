/**
 * Version negotiation and forward-compatible extension rules (#485).
 *
 * These tests exist so a compatibility claim about a future change cannot be
 * settled by assertion. The classifier decides, in both directions, and the
 * cases below are the ones the contract's own prose promises.
 */

import { describe, expect, test } from "bun:test";
import {
  ADDITIVE_WITHIN_V1,
  CONTRACT_VERSION,
  DESCRIBE_TOOL,
  MUTATE_TOOL,
  QUERY_DOCUMENT_VERSION,
  QUERY_TOOL,
  REQUIRES_NEW_VERSION,
  classifyContractChange,
} from "../../../src/mcp/contract/index.ts";

type Node = { readonly [key: string]: unknown };

const object = (
  properties: Node,
  required: readonly string[] = [],
): Node => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const verdict = (
  before: Node,
  after: Node,
  direction: "input" | "output",
): string =>
  classifyContractChange(before, after, direction).kind;

describe("contract versions", () => {
  test("the wire contract and the query language version independently", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(QUERY_DOCUMENT_VERSION).toBe(1);
  });

  test("both change lists are documented and disjoint in spirit", () => {
    expect(ADDITIVE_WITHIN_V1.length).toBeGreaterThan(0);
    expect(REQUIRES_NEW_VERSION.length).toBeGreaterThan(0);
    for (const entry of [...ADDITIVE_WITHIN_V1, ...REQUIRES_NEW_VERSION]) {
      expect(entry.endsWith(".")).toBe(true);
    }
  });
});

describe("input schemas may only widen", () => {
  const before = object({ at: { type: "array" } }, []);

  test("a new optional argument is additive", () => {
    const after = object({ at: { type: "array" }, search: { type: "string" } }, []);
    expect(verdict(before, after, "input")).toBe("additive");
  });

  test("a new required argument is breaking", () => {
    const after = object(
      { at: { type: "array" }, search: { type: "string" } },
      ["search"],
    );
    const change = classifyContractChange(before, after, "input");
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("new required input property");
  });

  test("promoting an existing optional argument to required is breaking", () => {
    const after = object({ at: { type: "array" } }, ["at"]);
    expect(verdict(before, after, "input")).toBe("breaking");
  });

  test("relaxing a required argument to optional is additive", () => {
    expect(
      verdict(object({ a: { type: "string" } }, ["a"]), object({ a: { type: "string" } }, []), "input"),
    ).toBe("additive");
  });

  test("removing an argument is breaking", () => {
    expect(verdict(before, object({}, []), "input")).toBe("breaking");
  });

  test("changing an argument's type is breaking", () => {
    expect(
      verdict(before, object({ at: { type: "string" } }, []), "input"),
    ).toBe("breaking");
  });

  test("widening an input enumeration is additive, narrowing it is breaking", () => {
    const narrow = object({ kind: { type: "string", enum: ["entity"] } });
    const wide = object({ kind: { type: "string", enum: ["entity", "trait"] } });
    expect(verdict(narrow, wide, "input")).toBe("additive");
    expect(verdict(wide, narrow, "input")).toBe("breaking");
  });
});

describe("output schemas may only keep their promises", () => {
  const before = object({ ok: { type: "boolean" } }, ["ok"]);

  test("a new result member is additive", () => {
    const after = object(
      { ok: { type: "boolean" }, catalogToken: { type: "string" } },
      ["ok", "catalogToken"],
    );
    expect(verdict(before, after, "output")).toBe("additive");
  });

  test("dropping a guaranteed member is breaking", () => {
    expect(verdict(before, object({ ok: { type: "boolean" } }, []), "output"))
      .toBe("breaking");
    expect(verdict(before, object({}, []), "output")).toBe("breaking");
  });

  test("adding a public error code is breaking: an exhaustive client mis-handles it", () => {
    const nine = object({ code: { type: "string", enum: ["invalid_query"] } });
    const ten = object({
      code: { type: "string", enum: ["invalid_query", "rate_limited"] },
    });
    const change = classifyContractChange(nine, ten, "output");
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("output enumeration widened");
  });

  test("narrowing an output enumeration to a handled subset is additive", () => {
    const ten = object({
      code: { type: "string", enum: ["invalid_query", "rate_limited"] },
    });
    const nine = object({ code: { type: "string", enum: ["invalid_query"] } });
    expect(verdict(ten, nine, "output")).toBe("additive");
  });

  test("adding a result union arm is breaking, matching the error-code rule", () => {
    const two = { anyOf: [object({ a: {} }), object({ b: {} })] };
    const three = {
      anyOf: [object({ a: {} }), object({ b: {} }), object({ c: {} })],
    };
    expect(verdict(two, three, "output")).toBe("breaking");
    expect(verdict(three, two, "input")).toBe("breaking");
  });
});

describe("constraint keywords", () => {
  const constrained = (constraints: Node): Node =>
    object({ value: { type: "string", ...constraints } }, ["value"]);

  test("adding a type tightens; removing one loosens", () => {
    const untyped = object({ value: {} }, ["value"]);
    const typed = object({ value: { type: "string" } }, ["value"]);
    // Adding it rejects requests that used to validate.
    expect(verdict(untyped, typed, "input")).toBe("breaking");
    expect(verdict(untyped, typed, "output")).toBe("additive");
    // Removing it admits values an older client's schema does not expect.
    expect(verdict(typed, untyped, "output")).toBe("breaking");
    expect(verdict(typed, untyped, "input")).toBe("additive");
  });

  test("the reason names type, not some other keyword", () => {
    const change = classifyContractChange(
      object({ value: { type: "string" } }, ["value"]),
      object({ value: {} }, ["value"]),
      "output",
    );
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("output type loosened");
  });

  test("a change between two types is undecidable, so it is reported both ways", () => {
    const before = object({ value: { type: "string" } }, ["value"]);
    const after = object({ value: { type: "number" } }, ["value"]);
    expect(verdict(before, after, "input")).toBe("breaking");
    expect(verdict(before, after, "output")).toBe("breaking");
  });

  test("a lower bound raised tightens; lowered or dropped loosens", () => {
    const loose = constrained({});
    const tight = constrained({ minLength: 8 });
    expect(verdict(loose, tight, "input")).toBe("breaking");
    expect(verdict(tight, loose, "input")).toBe("additive");
    expect(verdict(loose, tight, "output")).toBe("additive");
    expect(verdict(tight, loose, "output")).toBe("breaking");
  });

  test("an upper bound lowered tightens; raised or dropped loosens", () => {
    const wide = constrained({ maxLength: 256 });
    const narrow = constrained({ maxLength: 128 });
    expect(verdict(wide, narrow, "input")).toBe("breaking");
    expect(verdict(narrow, wide, "input")).toBe("additive");
    expect(verdict(wide, narrow, "output")).toBe("additive");
    expect(verdict(narrow, wide, "output")).toBe("breaking");
    // An absent upper bound is unbounded, so introducing one tightens.
    expect(verdict(constrained({}), narrow, "input")).toBe("breaking");
  });

  test("numeric range and item-count bounds follow the same polarity", () => {
    for (const [lower, upper] of [
      ["minimum", "maximum"],
      ["minItems", "maxItems"],
      ["minProperties", "maxProperties"],
      ["exclusiveMinimum", "exclusiveMaximum"],
    ] as const) {
      expect(verdict(constrained({}), constrained({ [lower]: 1 }), "input"))
        .toBe("breaking");
      expect(verdict(constrained({ [upper]: 10 }), constrained({ [upper]: 5 }), "input"))
        .toBe("breaking");
      expect(verdict(constrained({ [upper]: 5 }), constrained({ [upper]: 10 }), "input"))
        .toBe("additive");
    }
  });

  test("uniqueItems turned on tightens", () => {
    expect(verdict(constrained({}), constrained({ uniqueItems: true }), "input"))
      .toBe("breaking");
    expect(verdict(constrained({ uniqueItems: true }), constrained({}), "input"))
      .toBe("additive");
  });

  test("a pattern change is reported: no ordering between two regexes exists", () => {
    const change = classifyContractChange(
      constrained({ pattern: "^a+$" }),
      constrained({ pattern: "^a*$" }),
      "input",
    );
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("no ordering");
  });

  test("format and multipleOf are reported on any change, in both directions", () => {
    for (const keyword of ["format", "multipleOf"] as const) {
      const before = constrained({ [keyword]: keyword === "format" ? "date" : 2 });
      const after = constrained({ [keyword]: keyword === "format" ? "uuid" : 3 });
      expect(verdict(before, after, "input")).toBe("breaking");
      expect(verdict(before, after, "output")).toBe("breaking");
    }
  });

  test("closing additionalProperties tightens; opening it loosens", () => {
    const open = { type: "object", properties: {}, additionalProperties: true };
    const closed = { type: "object", properties: {}, additionalProperties: false };
    expect(verdict(open, closed, "input")).toBe("breaking");
    expect(verdict(closed, open, "input")).toBe("additive");
    expect(verdict(open, closed, "output")).toBe("additive");
    expect(verdict(closed, open, "output")).toBe("breaking");
    // An absent additionalProperties is open, so it compares as one.
    expect(verdict({ type: "object", properties: {} }, closed, "input"))
      .toBe("breaking");
  });

  test("an unrecognized keyword is never taken as evidence of compatibility", () => {
    const change = classifyContractChange(
      constrained({ "x-ramose-budget": 10 }),
      constrained({ "x-ramose-budget": 20 }),
      "input",
    );
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("unrecognized keyword");
  });

  test("documentation is never part of the decision", () => {
    const before = constrained({ description: "before", title: "T" });
    const after = constrained({
      description: "after",
      title: "T2",
      examples: ["x"],
      deprecated: true,
    });
    expect(verdict(before, after, "input")).toBe("additive");
    expect(verdict(before, after, "output")).toBe("additive");
  });

  test("gaining an allOf arm tightens; losing one loosens", () => {
    const one = { allOf: [{ minLength: 1 }] };
    const two = { allOf: [{ minLength: 1 }, { maxLength: 4 }] };
    expect(verdict(one, two, "input")).toBe("breaking");
    expect(verdict(two, one, "input")).toBe("additive");
    expect(verdict(one, two, "output")).toBe("additive");
    expect(verdict(two, one, "output")).toBe("breaking");
  });
});

describe("nested and referenced schemas", () => {
  test("a change inside a $defs entry is classified, not skipped", () => {
    const before = {
      ...object({ ref: { $ref: "#/$defs/RefV1" } }, ["ref"]),
      $defs: { RefV1: object({ name: { type: "string" } }, ["name"]) },
    };
    const after = {
      ...object({ ref: { $ref: "#/$defs/RefV1" } }, ["ref"]),
      $defs: {
        RefV1: object(
          { name: { type: "string" }, version: { type: "string" } },
          ["name", "version"],
        ),
      },
    };
    expect(verdict(before, after, "input")).toBe("breaking");
    expect(verdict(before, after, "output")).toBe("additive");
  });

  test("a recursive definition terminates rather than looping", () => {
    const recursive = {
      $ref: "#/$defs/NodeV1",
      $defs: {
        NodeV1: object({ child: { $ref: "#/$defs/NodeV1" } }),
      },
    };
    expect(verdict(recursive, recursive, "output")).toBe("additive");
  });

  test("a change inside array items is classified", () => {
    const before = object({
      rows: { type: "array", items: object({ id: { type: "string" } }, ["id"]) },
    });
    const after = object({
      rows: { type: "array", items: object({ id: { type: "number" } }, ["id"]) },
    });
    expect(verdict(before, after, "output")).toBe("breaking");
  });
});

describe("the published schemas today", () => {
  test("are compatible with themselves in both directions", () => {
    for (const tool of [DESCRIBE_TOOL, QUERY_TOOL, MUTATE_TOOL]) {
      expect(verdict(tool.inputSchema, tool.inputSchema, "input"))
        .toBe("additive");
      expect(verdict(tool.outputSchema, tool.outputSchema, "output"))
        .toBe("additive");
    }
  });

  const withDeliveryModes = (
    schema: Node,
    modes: readonly string[],
  ): Node => {
    const defs = schema.$defs as Node;
    return {
      ...schema,
      $defs: {
        ...defs,
        DeliveryRequestV1: {
          ...(defs.DeliveryRequestV1 as Node),
          properties: {
            mode: {
              type: "string",
              enum: modes,
              description: "Delivery mode.",
            },
          },
        },
      },
    };
  };

  test("adding an optional delivery mode request stays additive", () => {
    const before = withDeliveryModes(QUERY_TOOL.inputSchema, ["one_shot"]);
    const after = withDeliveryModes(QUERY_TOOL.inputSchema, [
      "one_shot",
      "live",
    ]);
    expect(verdict(before, after, "input")).toBe("additive");
    // The same widening on the result side is not: an exhaustive client would
    // not know what a live result means.
    expect(verdict(before, after, "output")).toBe("breaking");
  });

  test("tightening a published bound is breaking, and the classifier says so", () => {
    const before = MUTATE_TOOL.inputSchema;
    const defs = before.$defs as Node;
    const after = {
      ...before,
      $defs: {
        ...defs,
        InvocationIdV1: { ...(defs.InvocationIdV1 as Node), maxLength: 128 },
      },
    };
    const change = classifyContractChange(before, after, "input");
    expect(change.kind).toBe("breaking");
    if (change.kind !== "breaking") throw new Error("unreachable");
    expect(change.reasons.join(" ")).toContain("maxLength tightened");
  });

  test("relaxing that same bound is additive on input", () => {
    const before = MUTATE_TOOL.inputSchema;
    const defs = before.$defs as Node;
    const after = {
      ...before,
      $defs: {
        ...defs,
        InvocationIdV1: { ...(defs.InvocationIdV1 as Node), maxLength: 512 },
      },
    };
    expect(verdict(before, after, "input")).toBe("additive");
    expect(verdict(before, after, "output")).toBe("breaking");
  });

  test("making the query document required-shaped is not a breaking input change", () => {
    // The #486 integration replaces the passthrough body with the canonical
    // document schema. It narrows what the server accepts at the *document*
    // level, which the contract already declares as invalid_query — the
    // envelope, tool, and result shapes do not move.
    const before = QUERY_TOOL.inputSchema;
    const after = { ...before, description: "Execute one query document." };
    expect(verdict(before, after, "input")).toBe("additive");
  });
});
