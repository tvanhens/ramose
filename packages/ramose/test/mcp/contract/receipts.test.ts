/** The public projection of the merged invocation receipt (#485, #487, #527). */

import { describe, expect, test } from "bun:test";
import {
  INVOCATION_RECEIPT_VERSION,
  type AuthoritativeInvocationResult,
  type PublicInvocationReceipt,
} from "../../../src/internal/authorization/invocation-receipts.ts";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MESSAGE_TRUNCATION_MARKER,
  MUTATION_RECEIPT_STATUSES,
  assertSealedPublicJson,
  boundedRejectionMessage,
  isMutateOutput,
  mutationOutcome,
  mutationReceipt,
} from "../../../src/mcp/contract/index.ts";

const invocationId = "01K5Q0R7VYX3S6ZB2A9C4D8E1F";

const receipt = <Status extends PublicInvocationReceipt["status"]>(
  status: Status,
): PublicInvocationReceipt & { readonly status: Status } => ({
  version: INVOCATION_RECEIPT_VERSION,
  invocationId,
  status,
});

const wireResult = (outcome: ReturnType<typeof mutationOutcome>) =>
  outcome.ok
    ? { ok: true as const, at: [], receipt: outcome.receipt, output: outcome.output }
    : {
      ok: false as const,
      error: outcome.error,
      ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
    };

describe("mutationReceipt", () => {
  test("publishes the caller's key and the durable status, and nothing else", () => {
    const projected = mutationReceipt(receipt("completed"));
    expect(Object.keys(projected).sort()).toEqual(["invocationId", "status"]);
    expect(projected).toEqual({ invocationId, status: "completed" });
  });

  test("drops the durable receipt generation", () => {
    expect(Object.hasOwn(mutationReceipt(receipt("failed")), "version"))
      .toBe(false);
  });

  test("covers every durable terminal status the engine can reach", () => {
    for (const status of MUTATION_RECEIPT_STATUSES) {
      expect(mutationReceipt(receipt(status)).status).toBe(status);
    }
  });
});

describe("mutationOutcome", () => {
  test("a completed invocation carries the receipt and the declared output", () => {
    const outcome = mutationOutcome({
      _tag: "Completed",
      receipt: receipt("completed"),
      committedT: 42,
      output: { closed: true },
    });
    expect(outcome).toEqual({
      ok: true,
      receipt: { invocationId, status: "completed" },
      output: { closed: true },
    });
  });

  test("the private writer position never reaches the wire", () => {
    const outcome = mutationOutcome({
      _tag: "Completed",
      receipt: receipt("completed"),
      committedT: 42,
      output: null,
    });
    expect(JSON.stringify(outcome).includes("42")).toBe(false);
    expect(() => assertSealedPublicJson(wireResult(outcome))).not.toThrow();
  });

  test("an unauthorized refusal collapses into inaccessible", () => {
    const outcome = mutationOutcome({
      _tag: "Rejected",
      receipt: receipt("rejected"),
      rejection: { kind: "unauthorized" },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("inaccessible");
    expect(outcome.receipt?.status).toBe("rejected");
  });

  test("an operation's own refusal keeps its author-written message", () => {
    const outcome = mutationOutcome({
      _tag: "Rejected",
      receipt: receipt("rejected"),
      rejection: {
        kind: "operation_rejected",
        message: "This issue is already closed.",
        operation: "close",
      },
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("operation_rejected");
    expect(outcome.error.message).toBe("This issue is already closed.");
  });

  test("is total over an author message the engine will happily store", () => {
    // The engine has no public bound on an author's rejection message. If the
    // projection forwarded a long one verbatim, the authoritative rejected
    // outcome would fail its own output schema and the transport would have
    // nothing schema-valid to return — after the operation already ran.
    const oversized = "x".repeat(MAX_ERROR_MESSAGE_LENGTH * 3);
    const outcome = mutationOutcome({
      _tag: "Rejected",
      receipt: receipt("rejected"),
      rejection: {
        kind: "operation_rejected",
        message: oversized,
        operation: "close",
      },
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.message.length).toBe(MAX_ERROR_MESSAGE_LENGTH);
    expect(outcome.error.message.endsWith(MESSAGE_TRUNCATION_MARKER)).toBe(true);
    expect(isMutateOutput(wireResult(outcome))).toBe(true);
  });

  test("truncation is deterministic and keeps the start of what the author wrote", () => {
    const message = `Refused: ${"detail ".repeat(400)}`;
    expect(boundedRejectionMessage(message))
      .toBe(boundedRejectionMessage(message));
    expect(boundedRejectionMessage(message).startsWith("Refused: ")).toBe(true);
    expect(boundedRejectionMessage(message)).toContain(
      MESSAGE_TRUNCATION_MARKER,
    );
  });

  test("a message exactly at the bound is passed through untouched", () => {
    const exact = "y".repeat(MAX_ERROR_MESSAGE_LENGTH);
    expect(boundedRejectionMessage(exact)).toBe(exact);
  });

  test("an empty or missing message becomes the sealed refusal, not an invalid result", () => {
    for (const raw of ["", undefined, null, 42]) {
      expect(boundedRejectionMessage(raw))
        .toBe("The operation refused this request.");
    }
    const outcome = mutationOutcome({
      _tag: "Rejected",
      receipt: receipt("rejected"),
      rejection: {
        kind: "operation_rejected",
        message: "",
        operation: "close",
      },
    });
    expect(isMutateOutput(wireResult(outcome))).toBe(true);
  });

  test("a malformed request refusal points at the input argument", () => {
    const outcome = mutationOutcome({
      _tag: "Rejected",
      receipt: receipt("rejected"),
      rejection: { kind: "invalid_request" },
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.path).toEqual(["input"]);
  });

  test("failed and indeterminate ask for a retry on the same invocationId", () => {
    for (const tag of ["Failed", "Indeterminate"] as const) {
      const outcome = mutationOutcome({
        _tag: tag,
        receipt: receipt(tag === "Failed" ? "failed" : "indeterminate"),
      } as AuthoritativeInvocationResult);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.error.hint).toContain("same invocationId");
      expect(outcome.receipt?.invocationId).toBe(invocationId);
    }
  });

  test("a conflicting invocation id is invocation_conflict, with no receipt", () => {
    const outcome = mutationOutcome({ _tag: "Conflict" });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("invocation_conflict");
    expect(outcome.error.path).toEqual(["invocationId"]);
    expect(outcome.receipt).toBeUndefined();
  });

  test("a moved operation is operation_changed with no effect and no receipt", () => {
    for (const tag of ["OperationChanged", "UpdateRequired"] as const) {
      const outcome = mutationOutcome({ _tag: tag });
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.error.code).toBe("operation_changed");
      expect(outcome.error.path).toEqual(["operation", "version"]);
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.receipt).toBeUndefined();
      // Sealed: the refusal never names the deployed operation.
      expect(outcome.error.message).not.toContain("close");
    }
  });

  test("every outcome validates as mutate structuredContent", () => {
    const results: readonly AuthoritativeInvocationResult[] = [
      { _tag: "Completed", receipt: receipt("completed"), committedT: 1, output: {} },
      {
        _tag: "Rejected",
        receipt: receipt("rejected"),
        rejection: { kind: "request_rejected" },
      },
      { _tag: "Failed", receipt: receipt("failed") },
      { _tag: "Indeterminate", receipt: receipt("indeterminate") },
      { _tag: "Conflict" },
      { _tag: "OperationChanged" },
      { _tag: "UpdateRequired" },
    ];
    for (const result of results) {
      const wire = wireResult(mutationOutcome(result));
      expect({ tag: result._tag, valid: isMutateOutput(wire) })
        .toEqual({ tag: result._tag, valid: true });
      expect(() => assertSealedPublicJson(wire)).not.toThrow();
    }
  });
});
