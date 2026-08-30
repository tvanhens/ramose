/** The shared structured error envelope (#485). */

import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  ERROR_CODE_RETRYABLE,
  errorEnvelope,
  isMutateOutput,
  isQueryOutput,
  toolResult,
} from "../../../src/mcp/contract/index.ts";

describe("public error codes", () => {
  test("are exactly the nine initial codes, in a stable order", () => {
    expect([...ERROR_CODES]).toEqual([
      "invalid_query",
      "unknown_definition",
      "invalid_input",
      "inaccessible",
      "catalog_changed",
      "operation_changed",
      "query_budget_exceeded",
      "operation_rejected",
      "invocation_conflict",
    ]);
  });

  test("every code has a documented default retryability", () => {
    for (const code of ERROR_CODES) {
      expect(typeof ERROR_CODE_RETRYABLE[code]).toBe("boolean");
    }
    expect(Object.keys(ERROR_CODE_RETRYABLE).sort())
      .toEqual([...ERROR_CODES].sort());
  });

  test("only the codes with a real recovery are retryable by default", () => {
    const retryable = ERROR_CODES.filter((code) => ERROR_CODE_RETRYABLE[code]);
    expect([...retryable]).toEqual([
      "catalog_changed",
      "operation_changed",
      "query_budget_exceeded",
    ]);
  });
});

describe("errorEnvelope", () => {
  test("defaults retryable from the code", () => {
    expect(
      errorEnvelope({ code: "catalog_changed", message: "stale" }).retryable,
    ).toBe(true);
    expect(
      errorEnvelope({ code: "invalid_input", message: "bad" }).retryable,
    ).toBe(false);
  });

  test("lets a producer describe a genuinely transient instance", () => {
    expect(
      errorEnvelope({
        code: "operation_rejected",
        message: "not yet",
        retryable: true,
      }).retryable,
    ).toBe(true);
  });

  test("defaults path to the whole request and omits an absent hint", () => {
    const envelope = errorEnvelope({ code: "inaccessible", message: "no" });
    expect(envelope.path).toEqual([]);
    expect(Object.hasOwn(envelope, "hint")).toBe(false);
  });

  test("points at the caller's own argument, by name", () => {
    const envelope = errorEnvelope({
      code: "operation_changed",
      message: "moved",
      path: ["operation", "version"],
      hint: "Re-run describe.",
    });
    expect(envelope.path).toEqual(["operation", "version"]);
    expect(envelope.hint).toBe("Re-run describe.");
  });
});

describe("recoverable failures are completed tool results", () => {
  test("an error envelope validates as structuredContent for every tool", () => {
    const result = {
      ok: false as const,
      error: errorEnvelope({
        code: "query_budget_exceeded",
        message: "The query would exceed its budget.",
        path: ["query"],
        hint: "Narrow the query or request a smaller page.",
      }),
    };
    expect(isQueryOutput(result)).toBe(true);
    expect(isMutateOutput(result)).toBe(true);
  });

  test("isError mirrors ok, so a failure is never mistaken for a success", () => {
    const failure = toolResult({
      ok: false,
      error: errorEnvelope({ code: "inaccessible", message: "no" }),
    });
    expect(failure.isError).toBe(true);
    const success = toolResult({ ok: true, rows: [] });
    expect(success.isError).toBe(false);
  });
});
