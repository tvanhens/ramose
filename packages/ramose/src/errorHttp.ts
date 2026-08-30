import { type DbError, InternalError, isDatabaseError } from "./db/Errors.ts";
import {
  publicErrorBody,
  publicResponseHeaders,
} from "./worker/public-observation.ts";

export interface ErrorHttp {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

const errorToHttpUnchecked = (err: DbError): ErrorHttp => {
  switch (err._tag) {
    case "TxRejected":
      return {
        status: 409,
        body: { error: "request rejected" },
      };
    case "Unavailable":
      return {
        status: 503,
        body: { error: "unavailable" },
        headers: { "retry-after": String(Math.ceil(err.retryAfterMs / 1000)) },
      };
    case "InvalidRequest":
      return { status: 400, body: { error: "invalid request" } };
    case "DatabaseNotFound":
      return { status: 404, body: { error: "not found" } };
    case "Unauthorized":
      return {
        status: err.status ?? (err.code === "policy" ? 403 : 401),
        body: { error: "unauthorized" },
      };
    case "QueryBudgetExceeded":
      return {
        status: 413,
        body: {
          error: "query budget exceeded",
          code: "query/budget-exceeded",
        },
      };
    case "InternalError":
      return { status: 500, body: { error: "internal error" } };
    case "NetworkError":
      return { status: 500, body: { error: "internal error" } };
    case "OperationRejected":
      return {
        status: 409,
        body: {
          error: err.message,
          tag: "OperationRejected",
          message: err.message,
          operation: err.operation,
          ...(err.step === undefined ? {} : { step: err.step }),
          ...(err.reason === undefined ? {} : { reason: err.reason }),
        },
      };
  }
};

/** Status + allowlisted JSON body/headers for a {@link DbError}. */
export const errorToHttp = (err: DbError): ErrorHttp => {
  const http = errorToHttpUnchecked(err);
  return {
    ...http,
    body: publicErrorBody(http.body),
    ...(http.headers === undefined
      ? {}
      : { headers: publicResponseHeaders(http.headers) }),
  };
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
    headers: {
      "content-type": "application/json",
      ...publicResponseHeaders(http.headers),
    },
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
