/**
 * Tagged failures for the peer Worker's request Effect.
 *
 * The HTTP boundary in index.ts runs one `Effect` per request; everything that
 * is not a 2xx is a `Data.TaggedError` in its error channel, mapped back to a
 * response with `Effect.catchTags`. The status codes and body fields here are
 * exactly the ones the Worker has always returned (the client parses
 * `error`/`code`, benches parse the `x-ramose-*` headers) — see `toHttp`:
 *
 *   NotFound            404  { error }
 *   BadRequest          400  { error, stack? }        stack (`trace`) only off-prod
 *   Unauthorized    401/403  { error, code?, attr? }   403 = known caller, policy refused
 *   UpstreamError       as-is  raw body + headers of a Transactor/Replica DO response
 *   QueryBudgetExceeded 413  { error, code, clause, cells, limit, spentBy? }
 *   Internal            500  { error, stack? }        stack (`trace`) only off-prod
 */

import { QueryBudgetError } from "../internal/core/index.ts";
import * as Data from "effect/Data";

export class NotFound extends Data.TaggedError("NotFound")<{ readonly message?: string }> {}
export class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string; readonly trace?: string }> {}
/** 401 by default; 403 when the caller is known but the policy refused (`code`/`attr`). */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message?: string;
  readonly status?: 401 | 403;
  readonly code?: string;
  readonly attr?: string;
}> {}
/** A Transactor/Replica DO answered with a non-2xx; passed through verbatim. */
export class UpstreamError extends Data.TaggedError("UpstreamError")<{ readonly status: number; readonly body: string; readonly headers?: Record<string, string> }> {}
export class QueryBudgetExceeded extends Data.TaggedError("QueryBudgetExceeded")<{ readonly message: string; readonly code: string; readonly clause: string; readonly cells: number; readonly limit: number; readonly spentBy?: "caller" | "policy" }> {}
export class Internal extends Data.TaggedError("Internal")<{ readonly message: string; readonly trace?: string }> {}
/** An operation was refused (dangling / foreign entity, body rejection). */
export class OperationRejected extends Data.TaggedError("OperationRejected")<{
  readonly message: string;
  readonly name: string;
  readonly step?: string;
  readonly reason?: string;
}> {}

export type RamoseError = NotFound | BadRequest | Unauthorized | UpstreamError | QueryBudgetExceeded | Internal | OperationRejected;

const TAGS = new Set(["NotFound", "BadRequest", "Unauthorized", "UpstreamError", "QueryBudgetExceeded", "Internal", "OperationRejected"]);

/** A tagged failure that was `throw`n inside an async route body. */
export const isRamoseError = (e: unknown): e is RamoseError => typeof e === "object" && e !== null && TAGS.has((e as { _tag?: string })._tag ?? "");

/** Message shapes that have always been the caller's fault (400), not ours (500). */
export const CLIENT_ERROR_RE = /unknown attribute|not bound|insufficient|parse|EDN|QueryError/i;

/** Classify anything thrown by a route body into a tagged failure (same 413/400/500 split as before). */
export function fromThrown(err: unknown, opts: { readonly stacks: boolean } = { stacks: false }): RamoseError {
  if (isRamoseError(err)) return err;
  if (err instanceof QueryBudgetError) {
    return new QueryBudgetExceeded({ message: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit, spentBy: err.spentBy });
  }
  const message = err instanceof Error ? err.message : String(err);
  const trace = opts.stacks && err instanceof Error ? err.stack : undefined;
  return CLIENT_ERROR_RE.test(message) ? new BadRequest({ message, trace }) : new Internal({ message, trace });
}

/** `message`/`stack` are own properties of `Error`, which `Data.TaggedError` extends: an unset
 *  `message` prop reads back as "" and an unset stack prop would read back as the JS stack (which
 *  must never reach a prod response). Hence the explicit fallback and the separate `trace` field. */
const text = (s: string | undefined, fallback: string): string => (s !== undefined && s.length > 0 ? s : fallback);

/** The machine tag out of an upstream error body, if it carried one. */
function codeOf(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { code?: unknown })?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpError {
  readonly status: number;
  /** JSON body (absent for a verbatim upstream pass-through). */
  readonly body?: Record<string, unknown>;
  /** Verbatim body text (upstream pass-through). */
  readonly raw?: string;
  readonly headers?: Record<string, string>;
}

/** Tagged failure → status + body fields. Pure; index.ts turns it into a `Response`. */
export function toHttp(err: RamoseError): HttpError {
  switch (err._tag) {
    case "NotFound":
      return { status: 404, body: { error: text(err.message, "not found") } };
    case "BadRequest":
      return { status: 400, body: { error: err.message, stack: err.trace } };
    case "Unauthorized":
      return {
        status: err.status ?? 401,
        body: { error: text(err.message, "unauthorized"), ...(err.code === undefined ? {} : { code: err.code }), ...(err.attr === undefined ? {} : { attr: err.attr }) },
      };
    case "UpstreamError":
      // an upstream refusal is re-stated, never passed through: its body may name rows this caller cannot read
      if (err.status === 401 || err.status === 403) {
        const code = codeOf(err.body);
        return { status: err.status, body: { error: "unauthorized", ...(code === undefined ? {} : { code }) }, headers: err.headers };
      }
      return { status: err.status, raw: err.body, headers: err.headers };
    case "QueryBudgetExceeded":
      return { status: 413, body: { error: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit, spentBy: err.spentBy ?? "caller" } };
    case "Internal":
      return { status: 500, body: { error: err.message, stack: err.trace } };
    case "OperationRejected":
      return {
        status: 409,
        body: {
          error: "OperationRejected",
          tag: "OperationRejected",
          message: err.message,
          name: err.name,
          ...(err.step === undefined ? {} : { step: err.step }),
          ...(err.reason === undefined ? {} : { reason: err.reason }),
        },
      };
  }
}
