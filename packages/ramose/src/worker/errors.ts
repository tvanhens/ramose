/**
 * Tagged failures for the peer Worker's request Effect.
 *
 * Rich causes stay available to internal logging. `toHttp` is the only
 * public restatement and deliberately exposes the small, stable vocabulary
 * selected by `public-observation.ts`.
 */

import {
  OperationRejected,
  QueryBudgetExceeded,
  Unauthorized,
} from "../db/Errors.ts";
import {
  QueryBudgetError,
  QueryError,
  QueryParseError,
} from "../internal/core/index.ts";
import * as Data from "effect/Data";

export { OperationRejected, QueryBudgetExceeded, Unauthorized };

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message?: string;
}> {}
export class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string;
  readonly trace?: string | undefined;
}> {}
/** A Transactor/Replica failure whose detail is internal only. */
export class UpstreamError extends Data.TaggedError("UpstreamError")<{
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}> {}
export class Internal extends Data.TaggedError("Internal")<{
  readonly message: string;
  readonly trace?: string | undefined;
}> {}

export type RamoseError =
  | NotFound
  | BadRequest
  | Unauthorized
  | UpstreamError
  | QueryBudgetExceeded
  | Internal
  | OperationRejected;

const TAGS = new Set([
  "NotFound",
  "BadRequest",
  "Unauthorized",
  "UpstreamError",
  "QueryBudgetExceeded",
  "Internal",
  "OperationRejected",
]);

/** A tagged failure that was `throw`n inside an async route body. */
export const isRamoseError = (error: unknown): error is RamoseError =>
  typeof error === "object" &&
  error !== null &&
  TAGS.has((error as { readonly _tag?: string })._tag ?? "");

/** Classify route failures without inferring public status from private text. */
export function fromThrown(
  error: unknown,
  options: { readonly stacks: boolean } = { stacks: false },
): RamoseError {
  if (isRamoseError(error)) return error;
  if (error instanceof QueryBudgetError) {
    return new QueryBudgetExceeded({
      message: error.message,
      code: error.code,
      clause: error.clause,
      cells: error.cells,
      limit: error.limit,
      spentBy: error.spentBy,
    });
  }
  if (error instanceof QueryParseError || error instanceof QueryError) {
    return new BadRequest({
      message: error.message,
      trace: options.stacks ? error.stack : undefined,
    });
  }
  return new Internal({
    message: error instanceof Error ? error.message : String(error),
    trace: options.stacks && error instanceof Error ? error.stack : undefined,
  });
}

export interface HttpError {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string> | undefined;
}

/** Tagged failure -> the complete public status/body vocabulary. */
export function toHttp(error: RamoseError): HttpError {
  switch (error._tag) {
    case "NotFound":
      return { status: 404, body: { error: "not found" } };
    case "BadRequest":
      return { status: 400, body: { error: "invalid request" } };
    case "Unauthorized":
      return {
        status: error.status ?? 401,
        body: { error: "unauthorized" },
      };
    case "UpstreamError":
      if (error.status === 401 || error.status === 403) {
        return { status: error.status, body: { error: "unauthorized" } };
      }
      if (error.status === 400) {
        return { status: 400, body: { error: "invalid request" } };
      }
      if (error.status === 409) {
        return { status: 409, body: { error: "request rejected" } };
      }
      if (error.status === 429 || error.status === 503) {
        return {
          status: error.status,
          body: { error: "unavailable" },
          headers: error.headers,
        };
      }
      return { status: 500, body: { error: "internal error" } };
    case "QueryBudgetExceeded":
      return {
        status: 413,
        body: {
          error: "query budget exceeded",
          code: "query/budget-exceeded",
        },
      };
    case "Internal":
      return { status: 500, body: { error: "internal error" } };
    case "OperationRejected":
      return {
        status: 409,
        body: {
          error: error.message,
          tag: "OperationRejected",
          message: error.message,
          operation: error.operation,
          ...(error.step === undefined ? {} : { step: error.step }),
          ...(error.reason === undefined ? {} : { reason: error.reason }),
        },
      };
  }
}
