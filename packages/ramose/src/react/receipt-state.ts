import type { ReceiptState } from "../client/receipt.ts";

/**
 * One invocation's current state, as a component reads it — including the
 * renders before that component has invoked anything.
 *
 * Every member other than `idle` is the client's own `ReceiptState`, passed
 * through unchanged: React adds no second mutation state machine.
 *
 * - `idle` — there is no invocation to report. A component that renders before
 *   its user acts holds no receipt, and this is what it reads. It is distinct
 *   from `pending`, which says a real invocation exists and has not reached the
 *   outbox yet, so a form can tell "not submitted" from "submitting" without
 *   tracking a second flag beside the receipt.
 * - `pending` — invoked, not yet durable. Nothing survives a reload yet.
 * - `queued` — durably in the outbox. It will be submitted, this session or a
 *   later one, and the optimistic value is already in the local view.
 * - `committed` — the authoritative server accepted it.
 * - `rejected` — the authoritative server refused it, with the server's own
 *   classification on `error.code`.
 * - `failed` — it never reached the outbox, so nothing durable exists and
 *   nothing will be retried.
 */
export type ReceiptView = ReceiptState | { readonly status: "idle" };

export const IDLE: ReceiptView = Object.freeze({ status: "idle" as const });
