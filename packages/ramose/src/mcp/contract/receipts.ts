/**
 * The public projection of a mutation receipt (#485).
 *
 * Ramose already has exactly one durable receipt system: the table, identity,
 * state machine, and replay decision merged with #527 and re-scoped to the
 * operation-scoped `OperationVersion` by #487. This module adds no second
 * receipt, no second digest, and no second idempotency key. It only decides
 * *what part of the existing outcome is public*, and it deliberately keeps
 * that surface as small as it can be while still letting an agent recover.
 *
 * What crosses the wire:
 *
 * - `invocationId` — the caller's own key, echoed so a result can be matched
 *   to the request that produced it.
 * - `status` — which of the four durable terminal states the invocation
 *   reached.
 * - the operation's declared `output`, on completion.
 *
 * What never crosses it: the durable receipt generation, the principal id,
 * the scope digest, the invocation digest, the stored operation version, the
 * committed writer position, and the replay fence. Those are engine state;
 * publishing any of them would make a private storage detail part of a
 * contract we then could not change.
 */

import * as Schema from "effect/Schema";
import type {
  AuthoritativeInvocationResult,
  InvocationReceiptStatus,
  PublicInvocationReceipt,
  SealedInvocationRejection,
} from "../../internal/authorization/invocation-receipts.ts";
import { errorEnvelope, type ErrorEnvelopeV1 } from "./errors.ts";
import { InvocationIdV1, type JsonValueV1 } from "./primitives.ts";

/**
 * The four durable terminal states, unchanged from the engine.
 *
 * `status` — not the error code — is the authoritative discriminator for what
 * happened to the write. `completed` and `rejected` are final answers;
 * `failed` and `indeterminate` mean the caller should retry with the *same*
 * `invocationId`, which either replays the original outcome or resolves it.
 */
export const MUTATION_RECEIPT_STATUSES = Object.freeze(
  ["completed", "rejected", "failed", "indeterminate"] as const,
);
export type MutationReceiptStatusV1 = InvocationReceiptStatus;

/** The complete public receipt. Two members, both caller-meaningful. */
export const MutationReceiptV1 = Schema.Struct({
  invocationId: InvocationIdV1,
  status: Schema.Literals(MUTATION_RECEIPT_STATUSES).annotate({
    description:
      "Durable outcome. completed and rejected are final; failed and indeterminate should be retried with the same invocationId.",
  }),
}).annotate({
  identifier: "MutationReceiptV1",
  description:
    "Stable public receipt for one authoritative invocation. Retrying with the same invocationId replays exactly this outcome.",
});
export type MutationReceiptV1 = {
  readonly invocationId: string;
  readonly status: MutationReceiptStatusV1;
};

/**
 * Project the engine's public receipt onto the wire, dropping the durable
 * receipt generation. The generation is storage bookkeeping: a caller that
 * could see it might start branching on it, and then it could never change.
 */
export const mutationReceipt = (
  receipt: PublicInvocationReceipt,
): MutationReceiptV1 =>
  Object.freeze({
    invocationId: receipt.invocationId,
    status: receipt.status,
  });

/**
 * Map a sealed refusal onto the public error code.
 *
 * `unauthorized` collapses into `inaccessible` on purpose: a caller must not
 * be able to distinguish "you may not do this" from "this does not exist"
 * where the distinction itself would disclose the operation.
 */
const rejectionEnvelope = (
  rejection: SealedInvocationRejection,
): ErrorEnvelopeV1 => {
  switch (rejection.kind) {
    case "unauthorized":
      return errorEnvelope({
        code: "inaccessible",
        message: "The requested operation is not available at this path.",
        hint: "Re-run describe at this path to see what is currently available.",
      });
    case "invalid_request":
      return errorEnvelope({
        code: "invalid_input",
        message: "The operation refused the supplied arguments.",
        path: ["input"],
        hint: "Re-read the operation card's input schema and resend.",
      });
    case "request_rejected":
      return errorEnvelope({
        code: "operation_rejected",
        message: "The operation refused this request.",
      });
    case "operation_rejected":
      return errorEnvelope({
        code: "operation_rejected",
        message: rejection.message,
      });
  }
};

/**
 * The transport-neutral outcome of one `mutate`, reduced to what the wire
 * carries: either a receipt plus the operation's output, or a receipt (when
 * one exists) plus a recoverable error envelope.
 */
export type MutationOutcomeV1 =
  | {
    readonly ok: true;
    readonly receipt: MutationReceiptV1;
    readonly output: JsonValueV1;
  }
  | {
    readonly ok: false;
    readonly error: ErrorEnvelopeV1;
    readonly receipt?: MutationReceiptV1;
  };

/**
 * Project the engine's authoritative invocation result onto the public
 * outcome.
 *
 * Two of the engine's refusals carry no receipt because they had no effect,
 * and both mean the same thing to a caller: the operation moved underneath
 * a well-formed invocation, so re-discover it and mint a fresh
 * `invocationId`. `OperationChanged` is a stale pinned version;
 * `UpdateRequired` is a durable row from before the operation-scoped
 * correction, which is never re-executed and never silently cleared. Both are
 * sealed — neither names the deployed operation.
 */
export const mutationOutcome = (
  result: AuthoritativeInvocationResult,
): MutationOutcomeV1 => {
  switch (result._tag) {
    case "Completed":
      return Object.freeze({
        ok: true,
        receipt: mutationReceipt(result.receipt),
        output: (result.output ?? null) as JsonValueV1,
      });
    case "Rejected":
      return Object.freeze({
        ok: false,
        error: rejectionEnvelope(result.rejection),
        receipt: mutationReceipt(result.receipt),
      });
    case "Failed":
      return Object.freeze({
        ok: false,
        error: errorEnvelope({
          code: "operation_rejected",
          message: "The operation did not complete.",
          hint: "Retry with the same invocationId to recover the durable outcome.",
          retryable: true,
        }),
        receipt: mutationReceipt(result.receipt),
      });
    case "Indeterminate":
      return Object.freeze({
        ok: false,
        error: errorEnvelope({
          code: "operation_rejected",
          message: "The outcome of this invocation is not yet known.",
          hint: "Retry with the same invocationId; the durable receipt decides.",
          retryable: true,
        }),
        receipt: mutationReceipt(result.receipt),
      });
    case "Conflict":
      return Object.freeze({
        ok: false,
        error: errorEnvelope({
          code: "invocation_conflict",
          message:
            "This invocationId already belongs to a different invocation.",
          path: ["invocationId"],
          hint: "Mint a new invocationId, or resend the original arguments unchanged to replay.",
        }),
      });
    case "OperationChanged":
    case "UpdateRequired":
      return Object.freeze({
        ok: false,
        error: errorEnvelope({
          code: "operation_changed",
          message:
            "This operation has changed since the supplied version. Nothing was executed.",
          path: ["operation", "version"],
          hint: "Re-run describe for the operation, then resend with the current version and a new invocationId.",
        }),
      });
  }
};
