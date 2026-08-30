import * as Data from "effect/Data";

/** A transaction was rejected by validation / tempid / unique / policy (409). */
export class TxRejected extends Data.TaggedError("TxRejected")<{
  readonly message: string;
  readonly code: string;
  readonly attr?: string;
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
  readonly message?: string;
  readonly status?: 401 | 403;
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
  readonly spentBy?: "caller";
}> {}

/** Anything else the server reported (500). */
export class InternalError extends Data.TaggedError("InternalError")<{
  readonly message: string;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `.oneOrFail()` promised exactly one row and the peer answered zero or two
 * (it is asked for `:limit 2`, so "two" means at least two). Client-side —
 * the query succeeded; the cardinality did not. Not a {@link DbError}: a
 * plain `.where` / `.limit` query cannot produce it.
 *
 * `found` is `0` or `2`. There is no "3": the wire never sees past the
 * second row.
 */
export class NotOne extends Data.TaggedError("NotOne")<{
  readonly message: string;
  readonly found: 0 | 2;
}> {}

/**
 * An operation was refused before or during execution (dangling / foreign
 * entity, a body-thrown rejection). Schema failures stay {@link InvalidRequest};
 * policy denials stay {@link TxRejected} / {@link Unauthorized}. Terminal —
 * never silently retried, because effect steps may not be free to repeat.
 */
export class OperationRejected extends Data.TaggedError("OperationRejected")<{
  readonly message: string;
  readonly operation: string;
  readonly step?: string;
  readonly reason?: string;
}> {}

/**
 * The peer's registered operations do not cover the ids the client ships.
 * Deploy / connect time — not a {@link DbError}. A missing id used to
 * surface later as `unknown operation` on `db.run`.
 */
export class OperationsCoverageError extends Data.TaggedError(
  "OperationsCoverageError",
)<{
  readonly message: string;
  readonly missing: readonly string[];
}> {}

export type DbError =
  | TxRejected
  | Unavailable
  | InvalidRequest
  | DatabaseNotFound
  | Unauthorized
  | QueryBudgetExceeded
  | InternalError
  | NetworkError
  | OperationRejected;

const TAGS = new Set([
  "TxRejected",
  "Unavailable",
  "InvalidRequest",
  "DatabaseNotFound",
  "Unauthorized",
  "QueryBudgetExceeded",
  "InternalError",
  "NetworkError",
  "OperationRejected",
]);

export const isDatabaseError = (value: unknown): value is DbError =>
  typeof value === "object" &&
  value !== null &&
  TAGS.has((value as { _tag?: string })._tag ?? "");

export interface HeaderLike {
  get(name: string): string | null;
}

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const opt = (
  key: string,
  value: unknown,
): Record<string, string> =>
  typeof value === "string" && value.length > 0 ? { [key]: value } : {};

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
      ...(b.spentBy === "caller" ? { spentBy: "caller" as const } : {}),
    });

  switch (b.tag) {
    case "OperationRejected":
      return new OperationRejected({
        message: str(b.message ?? b.error, `HTTP ${status}`),
        operation: str(b.operation ?? b.name, ""),
        ...opt("step", b.step),
        ...opt("reason", b.reason),
      });
    case "TxRejected":
      return new TxRejected({
        message,
        code: str(b.code, "tx/rejected"),
        ...opt("attr", b.attr),
      });
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
      return new Unauthorized({
        message,
        status,
        ...opt("code", b.code),
        ...opt("attr", b.attr),
      });
    case 404:
      if (isCloudflarePlatform(message)) {
        return new Unavailable({
          message: "ramose: workers.dev edge returned HTML 404 (transient)",
          retryAfterMs: 200,
        });
      }
      return new DatabaseNotFound({ message });
    case 409:
      if (b.tag === "OperationRejected" || b.error === "OperationRejected") {
        return new OperationRejected({
          message: str(b.message ?? b.error, `HTTP ${status}`),
          operation: str(b.operation ?? b.name, ""),
          ...opt("step", b.step),
          ...opt("reason", b.reason),
        });
      }
      return new TxRejected({
        message,
        code: str(b.code, "tx/rejected"),
        ...opt("attr", b.attr),
      });
    case 413:
      return budget();
    case 503:
      return new Unavailable({
        message,
        retryAfterMs: num(b.retryAfterMs, Number(headers?.get("retry-after") ?? 0) * 1000 || 0),
      });
    default:
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
