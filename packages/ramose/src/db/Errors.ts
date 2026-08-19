/**
 * Tagged failures for the Ramose database capabilities.
 *
 * These mirror, one-for-one, the error surface the peer Worker already
 * speaks over HTTP (packages/ramose/src/worker/errors.ts,
 * packages/ramose/src/internal/transactor/errors.ts, packages/ramose/src/internal/replica/errors.ts) so a
 * caller can `Effect.catchTag("TxRejected", …)` on exactly the condition the
 * database reported — no status-code sniffing.
 *
 * Wire shapes the classifier understands:
 *
 *   worker's own errors      { error, code?, clause?, cells?, limit?, stack? }   (no `tag`)
 *   DO errors passed through { error, tag, message, code?, retryAfterMs? }
 *
 * `NetworkError` is the only failure with no server side: the request never
 * produced a response (DNS, service binding down, aborted body).
 */

import * as Data from "effect/Data";

/** A transaction was rejected by validation / tempid / unique resolution (409). */
export class TxRejected extends Data.TaggedError("TxRejected")<{
  readonly message: string;
  readonly code: string;
}> {}

/** The transactor aborted and is rebuilding from durable state (503); retry after `retryAfterMs`. */
export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly message: string;
  readonly retryAfterMs: number;
}> {}

/** Malformed request — bad query, unknown attribute, unbound variable, invalid db name (400). */
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
}> {}

/** No such route / database (404). */
export class DatabaseNotFound extends Data.TaggedError("DatabaseNotFound")<{
  readonly message: string;
}> {}

/**
 * Missing, expired or wrong credential, or a policy denial (401 / 403).
 *
 * A policy denial carries `code` (e.g. `"policy"`) and the attribute ident it
 * tripped on (`attr: ":doc/owner"`) — never the value.
 */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message: string;
  readonly code?: string;
  readonly attr?: string;
}> {}

/**
 * The planner's intermediate relation would exceed the memory budget (413).
 * Retryable with a narrower query. Both the peer's own guard
 * (`QueryBudgetExceeded`) and the replica's (`QueryBudget`) land here.
 */
export class QueryBudgetExceeded extends Data.TaggedError(
  "QueryBudgetExceeded",
)<{
  readonly message: string;
  readonly code: string;
  readonly clause: string;
  readonly cells: number;
  readonly limit: number;
}> {}

/** Anything else the server reported (500). */
export class InternalError extends Data.TaggedError("InternalError")<{
  readonly message: string;
}> {}

/** The request never produced a response (transport, DNS, service binding, aborted body). */
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type DbError =
  | TxRejected
  | Unavailable
  | InvalidRequest
  | DatabaseNotFound
  | Unauthorized
  | QueryBudgetExceeded
  | InternalError
  | NetworkError;

const TAGS = new Set([
  "TxRejected",
  "Unavailable",
  "InvalidRequest",
  "DatabaseNotFound",
  "Unauthorized",
  "QueryBudgetExceeded",
  "InternalError",
  "NetworkError",
]);

export const isDatabaseError = (value: unknown): value is DbError =>
  typeof value === "object" &&
  value !== null &&
  TAGS.has((value as { _tag?: string })._tag ?? "");

/** Minimal read-only view of the response headers (`Headers`, or a plain map in tests). */
export interface HeaderLike {
  get(name: string): string | null;
}

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** An optional string field: absent stays absent, never `""`. */
const opt = (
  key: string,
  value: unknown,
): Record<string, string> =>
  typeof value === "string" && value.length > 0 ? { [key]: value } : {};

/**
 * Classify a non-2xx response into a tagged failure.
 *
 * The `tag` field (present only on errors the Transactor/QueryReplica DOs
 * produced and the peer passed through verbatim) wins over the status code,
 * because it is the stable discriminator; the peer's own errors carry no tag
 * and are classified by status.
 */
export const fromResponse = (
  status: number,
  body: unknown,
  headers?: HeaderLike,
): DbError => {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const message = str(b.error ?? b.message, `HTTP ${status}`);
  const budget = () =>
    new QueryBudgetExceeded({
      message,
      code: str(b.code, "query/budget-exceeded"),
      clause: str(b.clause, ""),
      cells: num(b.cells, 0),
      limit: num(b.limit, 0),
    });

  switch (b.tag) {
    case "TxRejected":
      return new TxRejected({ message, code: str(b.code, "tx/rejected") });
    case "TransactorDead": {
      const header = headers?.get("retry-after");
      const retryAfterMs = num(
        b.retryAfterMs,
        header === null || header === undefined ? 0 : Number(header) * 1000,
      );
      return new Unavailable({
        message,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
      });
    }
    case "QueryBudget":
      return budget();
    case "BadRequest":
      return new InvalidRequest({ message });
    case "NotFound":
      return new DatabaseNotFound({ message });
    case "Internal":
      return new InternalError({ message });
  }

  switch (status) {
    case 400:
      return new InvalidRequest({ message });
    case 401:
    case 403:
      // `{ error, code: "policy", attr: ":doc/owner" }` surfaces typed
      return new Unauthorized({ message, ...opt("code", b.code), ...opt("attr", b.attr) });
    case 404:
      // Application misses are JSON `{ error }`. Cloudflare's workers.dev
      // miss is an HTML "Page not found" — treat as Unavailable so callers
      // (and {@link send}'s retries) can wait it out under parallel CI.
      if (isCloudflarePlatform(message)) {
        return new Unavailable({
          message: "ramose: workers.dev edge returned HTML 404 (transient)",
          retryAfterMs: 200,
        });
      }
      return new DatabaseNotFound({ message });
    case 409:
      return new TxRejected({ message, code: str(b.code, "tx/rejected") });
    case 413:
      return budget();
    case 503:
      return new Unavailable({
        message,
        retryAfterMs: num(b.retryAfterMs, Number(headers?.get("retry-after") ?? 0) * 1000 || 0),
      });
    default:
      // 1042 / 1104 / "Worker not found" / "Handler does not export a fetch()
      // function." from a fresh workers.dev host or a Durable Object
      // namespace that has not finished converging on the new deploy yet.
      if (
        isCloudflarePlatform(message) ||
        /Worker not found|Handler does not export a fetch/i.test(message)
      ) {
        return new Unavailable({
          message: "ramose: Cloudflare edge returned a transient platform error",
          retryAfterMs: 200,
        });
      }
      return new InternalError({ message });
  }
};

const isCloudflarePlatform = (message: string): boolean =>
  /<!DOCTYPE html>|Page not found|There is nothing here yet|error code:\s*1\d{3}/i.test(
    message,
  );
