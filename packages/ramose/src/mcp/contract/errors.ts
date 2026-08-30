/**
 * The one shared structured error envelope (#485).
 *
 * ## Which failures land here
 *
 * This envelope is for *recoverable* failures — validation, discovery,
 * catalog, query, budget, policy, and conflict outcomes. They are returned as
 * **completed** MCP tool results with `isError: true` and a schema-valid
 * `structuredContent`, because the agent that made the call is exactly the
 * party that can recover from them, and it can only do that if the failure
 * arrives as data it can read.
 *
 * Three other classes deliberately do *not* use this envelope:
 *
 * - Malformed JSON-RPC/MCP envelopes, required-header mismatches,
 *   unsupported methods or protocol versions, and unknown tool names are
 *   **protocol errors**. The request never became a Ramose request.
 * - Missing or invalid credentials and coarse-scope failures are **HTTP
 *   authorization challenges** (401/403), so a client can renew and retry.
 * - Anything that would disclose the existence of something the caller may
 *   not see collapses into `inaccessible`, which is deliberately identical
 *   for hidden, missing, and unauthorized targets (#419).
 *
 * ## Sealing
 *
 * `message` and `hint` are caller-facing prose. They are held to the same
 * rule as every other public value: no database ids, catalog keys, hashes,
 * transaction ids, storage locators, internal function names, or engine
 * symbols. `serialization.ts` enforces this mechanically over whole results.
 */

import * as Schema from "effect/Schema";
import {
  MAX_ERROR_HINT_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_PATH_SEGMENTS,
  MAX_PUBLIC_NAME_LENGTH,
} from "./bounds.ts";

/**
 * The initial public error codes. This list is closed for v1: a client may
 * switch on it exhaustively. Adding a code is a new contract version, because
 * an exhaustive client would otherwise silently mis-handle the new one.
 */
export const ERROR_CODES = Object.freeze([
  /** The query document is not a well-formed, in-budget, in-language query. */
  "invalid_query",
  /** No such entity, trait, field, operation, or function is addressable here. */
  "unknown_definition",
  /** Tool arguments failed the published input schema or a bound. */
  "invalid_input",
  /** Hidden, missing, or unauthorized — deliberately indistinguishable. */
  "inaccessible",
  /** An explicitly pinned catalogToken no longer describes this catalog. */
  "catalog_changed",
  /** The pinned operation version is not the deployed one. No effect occurred. */
  "operation_changed",
  /** The query would exceed a declared budget. Nothing was truncated. */
  "query_budget_exceeded",
  /** The operation itself refused: a precondition or policy said no. */
  "operation_rejected",
  /** This invocationId already belongs to a different invocation. */
  "invocation_conflict",
] as const);
export type ErrorCodeV1 = (typeof ERROR_CODES)[number];

/**
 * Whether attempting this intent again can succeed.
 *
 * `true` means the same intent is still reachable: the caller follows `hint`
 * — refreshes a stale token, re-discovers an operation version, narrows a
 * page — and tries again. `false` means no attempt can succeed until the
 * application state, the caller's authorization, or the request's meaning
 * changes.
 *
 * It is a recovery hint, never authority: a `true` never implies permission,
 * and a producer may override the default for a genuinely transient refusal.
 */
export const ERROR_CODE_RETRYABLE: Readonly<Record<ErrorCodeV1, boolean>> =
  Object.freeze({
    invalid_query: false,
    unknown_definition: false,
    invalid_input: false,
    inaccessible: false,
    catalog_changed: true,
    operation_changed: true,
    query_budget_exceeded: true,
    operation_rejected: false,
    invocation_conflict: false,
  });

/**
 * Where in the caller's own arguments the failure is. Segments are the
 * request's public property names and array indices — a JSON-pointer-like
 * path into the tool arguments the caller sent, never into engine state.
 * `[]` means the request as a whole.
 */
export const ErrorPathV1 = Schema.Array(
  Schema.Union([
    Schema.String.check(Schema.isMaxLength(MAX_PUBLIC_NAME_LENGTH)),
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ]),
).check(Schema.isMaxLength(MAX_ERROR_PATH_SEGMENTS)).annotate({
  identifier: "ErrorPathV1",
  description:
    "Path into the caller's own tool arguments: property names and array indices. [] refers to the request as a whole.",
});
export type ErrorPathV1 = readonly (string | number)[];

/**
 * The single structured failure shape every kernel tool, Resource, and
 * generated alias shares.
 */
export const ErrorEnvelopeV1 = Schema.Struct({
  code: Schema.Literals(ERROR_CODES).annotate({
    description:
      "Closed set of public failure codes. Switch on this, not on message text.",
  }),
  path: ErrorPathV1,
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ERROR_MESSAGE_LENGTH),
  ).annotate({
    description:
      "Human-readable statement of what failed. Sealed: never names internal identifiers.",
  }),
  hint: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ERROR_HINT_LENGTH),
    ),
  ).annotate({
    description:
      "Optional concrete next step, for example refresh the catalog token or narrow the page.",
  }),
  retryable: Schema.Boolean.annotate({
    description:
      "True when the same intent can succeed on a later attempt, usually after following hint. A hint, never authority.",
  }),
}).annotate({
  identifier: "ErrorEnvelopeV1",
  description:
    "Structured, recoverable failure. Delivered as a completed tool result with isError true.",
});
export type ErrorEnvelopeV1 = {
  readonly code: ErrorCodeV1;
  readonly path: ErrorPathV1;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
};

/**
 * Build an error envelope. `retryable` defaults to the code's entry in
 * {@link ERROR_CODE_RETRYABLE}; pass it explicitly only to describe a
 * genuinely transient instance of an otherwise terminal code.
 */
export const errorEnvelope = (input: {
  readonly code: ErrorCodeV1;
  readonly message: string;
  readonly path?: ErrorPathV1 | undefined;
  readonly hint?: string | undefined;
  readonly retryable?: boolean | undefined;
}): ErrorEnvelopeV1 =>
  Object.freeze({
    code: input.code,
    path: Object.freeze([...(input.path ?? [])]),
    message: input.message,
    ...(input.hint === undefined ? {} : { hint: input.hint }),
    retryable: input.retryable ?? ERROR_CODE_RETRYABLE[input.code],
  });
