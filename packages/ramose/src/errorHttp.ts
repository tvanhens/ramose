/**
 * Map a public {@link DbError} to HTTP status + JSON body.
 *
 * For app Workers / routes that proxy Ramose — one call instead of a
 * 9-arm `catchTags`. Does not live on `ramose/db`, so the browser graph
 * stays free of an HTTP helper. Import from `ramose` or `ramose/worker`.
 *
 * The peer Worker's own `toHttp` stays in `worker/errors.ts`: it maps
 * worker-only tags (`UpstreamError`, `Internal` with a stack, …) and
 * keeps the historical body fields. This helper is the app-path contract.
 */

import { type DbError, InternalError, isDatabaseError } from "./db/Errors.ts";

export interface ErrorHttp {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

const messageOf = (err: { readonly message?: string; readonly _tag: string }): string =>
  typeof err.message === "string" && err.message.length > 0 ? err.message : err._tag;

/** Status + JSON body for a {@link DbError}. Total over the union. */
export const errorToHttp = (err: DbError): ErrorHttp => {
  switch (err._tag) {
    case "TxRejected":
      return {
        status: 409,
        body: {
          error: err.message,
          tag: "TxRejected",
          code: err.code,
          ...(err.attr === undefined ? {} : { attr: err.attr }),
        },
      };
    case "Unavailable":
      return {
        status: 503,
        body: { error: err.message, tag: "Unavailable", retryAfterMs: err.retryAfterMs },
        headers: { "retry-after": String(Math.ceil(err.retryAfterMs / 1000)) },
      };
    case "InvalidRequest":
      return { status: 400, body: { error: err.message, tag: "InvalidRequest" } };
    case "DatabaseNotFound":
      return { status: 404, body: { error: err.message, tag: "DatabaseNotFound" } };
    case "Unauthorized":
      return {
        status: err.status ?? (err.code === "policy" ? 403 : 401),
        body: {
          error: messageOf(err),
          tag: "Unauthorized",
          ...(err.code === undefined ? {} : { code: err.code }),
          ...(err.attr === undefined ? {} : { attr: err.attr }),
        },
      };
    case "QueryBudgetExceeded":
      return {
        status: 413,
        body: {
          error: err.message,
          tag: "QueryBudgetExceeded",
          code: err.code,
          clause: err.clause,
          cells: err.cells,
          limit: err.limit,
          spentBy: err.spentBy ?? "caller",
        },
      };
    case "InternalError":
      return { status: 500, body: { error: err.message, tag: "InternalError" } };
    case "NetworkError":
      return { status: 502, body: { error: err.message, tag: "NetworkError" } };
    case "OperationRejected":
      return {
        status: 409,
        body: {
          error: err.message,
          tag: "OperationRejected",
          operation: err.operation,
          ...(err.step === undefined ? {} : { step: err.step }),
          ...(err.reason === undefined ? {} : { reason: err.reason }),
        },
      };
  }
};

/** HTTP status for a {@link DbError}. */
export const statusOf = (err: DbError): number => errorToHttp(err).status;

/**
 * A `Response` for a {@link DbError}. Use {@link errorToHttp} when the
 * framework wants status + body rather than a Fetch `Response`.
 */
export const errorResponse = (err: DbError): Response => {
  const http = errorToHttp(err);
  return new Response(JSON.stringify(http.body), {
    status: http.status,
    headers: { "content-type": "application/json", ...http.headers },
  });
};

/**
 * Classify `unknown` as a {@link DbError} when it is one; otherwise wrap
 * as {@link InternalError}. Useful at a Worker boundary that `catch`es
 * anything.
 *
 * Worker-only tags (`NotFound`, `BadRequest`, `Internal`, `UpstreamError`)
 * are not {@link DbError}s and become `InternalError` (500) here. For the
 * peer Worker's own request Effect, use `fromThrown` + `toHttp` instead —
 * this helper does not know about those tags.
 */
export const toDbError = (err: unknown): DbError => {
  if (isDatabaseError(err)) return err;
  return new InternalError({
    message: err instanceof Error ? err.message : String(err),
  });
};
