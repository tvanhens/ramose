/**
 * Pure contract tests for the experimental MCP surface (#484 S1):
 * argument validation, the public operation-version projection, and the
 * restatement of authoritative invocation outcomes.
 */

import { describe, expect, test } from "bun:test";
import {
  McpToolFailure,
  decodeOperationVersionToken,
  encodeOperationVersionToken,
  parseAt,
  parseMutateArgs,
  parseQueryDocument,
} from "../../src/mcp/contract.ts";
import { publicMutateResult } from "../../src/mcp/kernel.ts";
import type { AuthoritativeInvocationResult } from "../../src/internal/authorization/invocation-receipts.ts";

const digest = (byte: string) => byte.repeat(32);

/** The code a rejected argument or document reports. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (cause) {
    if (cause instanceof McpToolFailure) return cause.envelope.code;
    throw cause;
  }
  throw new Error("expected a tool failure");
};

describe("operation version token", () => {
  test("round-trips the merged operation-scoped version", () => {
    for (const version of [digest("00"), digest("ff"), digest("9c"), digest("a3")]) {
      const token = encodeOperationVersionToken(version);
      expect(token).toMatch(/^ov_[A-Za-z0-9_-]{43}$/);
      expect(decodeOperationVersionToken(token) as string | undefined).toBe(version);
    }
    expect(encodeOperationVersionToken(digest("01")))
      .not.toBe(encodeOperationVersionToken(digest("02")));
  });

  test("is structurally not a digest, so it cannot be confused with one", () => {
    const token = encodeOperationVersionToken(digest("9c"));
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(false);
    expect(token).not.toContain(digest("9c"));
  });

  test("refuses to project anything that is not a canonical version", () => {
    expect(() => encodeOperationVersionToken("nope")).toThrow(TypeError);
    expect(() => encodeOperationVersionToken(digest("ZZ"))).toThrow(TypeError);
  });

  test("rejects malformed and non-canonical tokens instead of guessing", () => {
    expect(decodeOperationVersionToken(digest("9c"))).toBeUndefined();
    expect(decodeOperationVersionToken("ov_short")).toBeUndefined();
    expect(decodeOperationVersionToken(`ov_${"!".repeat(43)}`)).toBeUndefined();
    // Base64's unused trailing bits must be zero, or two tokens would name
    // one version and `operation_changed` would stop being decidable.
    const token = encodeOperationVersionToken(digest("00"));
    expect(decodeOperationVersionToken(`${token.slice(0, 45)}B`)).toBeUndefined();
  });
});

describe("at", () => {
  test("defaults to the authorized root and accepts bounded names", () => {
    expect(parseAt(undefined)).toEqual([]);
    expect(parseAt(["acme", "support"])).toEqual(["acme", "support"]);
  });

  test("rejects non-arrays, empty segments, and oversized paths", () => {
    expect(codeOf(() => parseAt("acme"))).toBe("invalid_input");
    expect(codeOf(() => parseAt([""]))).toBe("invalid_input");
    expect(codeOf(() => parseAt([1]))).toBe("invalid_input");
    expect(codeOf(() => parseAt(Array.from({ length: 17 }, () => "a"))))
      .toBe("invalid_input");
  });
});

describe("minimal query document", () => {
  test("accepts the whole v1 grammar", () => {
    const document = {
      version: 1 as const,
      from: { entity: "issue" },
      where: { status: "open", flagged: true, rank: 3 },
      select: ["title"],
      limit: 10,
    };
    expect(parseQueryDocument(document)).toEqual(document);
    expect(parseQueryDocument({ version: 1, from: { entity: "issue" } }))
      .toEqual({ version: 1, from: { entity: "issue" } });
  });

  test("rejects an unknown version or a malformed root", () => {
    expect(codeOf(() => parseQueryDocument({ version: 2, from: { entity: "i" } })))
      .toBe("invalid_query");
    expect(codeOf(() => parseQueryDocument({ version: 1 }))).toBe("invalid_query");
    expect(codeOf(() => parseQueryDocument({ version: 1, from: { entity: "" } })))
      .toBe("invalid_query");
  });

  test("rejects non-scalar equality operands", () => {
    expect(codeOf(() =>
      parseQueryDocument({
        version: 1,
        from: { entity: "issue" },
        where: { owner: { entity: "user" } },
      })
    )).toBe("invalid_query");
  });

  test("bounds where, select, and limit", () => {
    const where = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`f${index}`, "x"]),
    );
    expect(codeOf(() => parseQueryDocument({ version: 1, from: { entity: "i" }, where })))
      .toBe("invalid_query");
    expect(codeOf(() =>
      parseQueryDocument({
        version: 1,
        from: { entity: "i" },
        select: Array.from({ length: 65 }, () => "f"),
      })
    )).toBe("invalid_query");
    for (const limit of [0, -1, 1.5, 201]) {
      expect(codeOf(() => parseQueryDocument({ version: 1, from: { entity: "i" }, limit })))
        .toBe("invalid_query");
    }
  });
});

describe("mutate arguments", () => {
  const version = encodeOperationVersionToken(digest("9c"));
  const valid = {
    at: [],
    operation: {
      owner: { kind: "entity" as const, name: "issue" },
      name: "close",
      version,
    },
    input: { reason: "duplicate" },
    invocationId: "01K",
  };

  test("accepts a complete invocation", () => {
    expect(parseMutateArgs(valid)).toEqual(valid);
  });

  test("requires a version discovery produced, not a raw digest", () => {
    expect(codeOf(() =>
      parseMutateArgs({
        ...valid,
        operation: { ...valid.operation, version: digest("9c") },
      })
    )).toBe("invalid_input");
  });

  test("requires an owner, a name, and an invocation id", () => {
    expect(codeOf(() => parseMutateArgs({ ...valid, operation: {} })))
      .toBe("invalid_input");
    expect(codeOf(() =>
      parseMutateArgs({
        ...valid,
        operation: { ...valid.operation, owner: { kind: "graph", name: "x" } },
      })
    )).toBe("invalid_input");
    expect(codeOf(() => parseMutateArgs({ ...valid, invocationId: "" })))
      .toBe("invalid_input");
  });

  test("refuses non-object operation input in this slice", () => {
    for (const input of ["text", 3, [1], null]) {
      expect(codeOf(() => parseMutateArgs({ ...valid, input }))).toBe("invalid_input");
    }
  });
});

describe("invocation outcome projection", () => {
  const receipt = { version: 2 as const, invocationId: "01K" };
  const project = (result: unknown) =>
    publicMutateResult(result as AuthoritativeInvocationResult);

  test("projects a completed invocation without receipt internals", () => {
    const result = project({
      _tag: "Completed",
      receipt: { ...receipt, status: "completed" },
      committedT: 42,
      output: { id: 7 },
    });
    expect(result).toEqual({
      invocationId: "01K",
      status: "completed",
      outcome: { id: 7 },
    });
    expect(JSON.stringify(result)).not.toContain("42");
  });

  test("maps every transport-neutral refusal to its public code", () => {
    expect(project({ _tag: "Conflict" }))
      .toMatchObject({ code: "invocation_conflict", retryable: false });
    expect(project({ _tag: "OperationChanged" }))
      .toMatchObject({ code: "operation_changed", retryable: true });
    expect(project({ _tag: "UpdateRequired" }))
      .toMatchObject({ code: "invocation_update_required" });
    expect(project({ _tag: "Failed", receipt: { ...receipt, status: "failed" } }))
      .toMatchObject({ code: "internal_error" });
    expect(project({
      _tag: "Indeterminate",
      receipt: { ...receipt, status: "indeterminate" },
    })).toMatchObject({ code: "invocation_indeterminate" });
  });

  test("collapses an unauthorized rejection and carries a domain refusal", () => {
    const rejected = (rejection: unknown) =>
      project({ _tag: "Rejected", receipt: { ...receipt, status: "rejected" }, rejection });
    expect(rejected({ kind: "unauthorized" }))
      .toMatchObject({ code: "inaccessible", retryable: false });
    expect(rejected({ kind: "invalid_request" })).toMatchObject({ code: "invalid_input" });
    expect(rejected({
      kind: "operation_rejected",
      message: "domain refused",
      operation: "issue/close",
    })).toEqual({ code: "operation_rejected", message: "domain refused", retryable: false });
  });
});
