/**
 * Tagged failures for the Ramose database capabilities — the one shared
 * error module. The peer Worker and the Transactor import the public
 * classes from here (`Unauthorized`, `OperationRejected`,
 * `QueryBudgetExceeded`, `TxRejected`) instead of declaring a second copy.
 * Worker-only HTTP tags (`NotFound`, `BadRequest`, `Internal`,
 * `UpstreamError`) and the transactor-internal `TransactorDead` stay at
 * those boundaries and map onto this union on the way out.
 *
 * App-path calls (`db.run`, `db.query`, `db.pull`) reject with the class
 * itself: `_tag` intact, `instanceof` works, `.name` / `.message` stable.
 * Match in `try/catch` with `instanceof` or `_tag`. `isDatabaseError` is
 * the type guard for the union. Effect matching (`catchTags`) is hatch-only
 * (`db.effect.*` / `ramose/effect`).
 *
 * ## `DbError` — nine request errors
 *
 * Members are named for the condition they report (`TxRejected`,
 * `Unavailable`, `Unauthorized`, `OperationRejected`, `InvalidRequest`,
 * `DatabaseNotFound`, `QueryBudgetExceeded`). `InternalError` and
 * `NetworkError` keep the `-Error` suffix because the bare words are too
 * generic. That is the convention; do not mix a third pattern into this
 * union.
 *
 * | tag                   | means                                      |
 * | --------------------- | ------------------------------------------ |
 * | `TxRejected`          | write refused by validation / unique / policy (409) |
 * | `Unavailable`         | writer restarting; retry after `retryAfterMs` (503) |
 * | `InvalidRequest`      | malformed request (400)                    |
 * | `DatabaseNotFound`    | no such route (404)                        |
 * | `Unauthorized`        | missing/wrong credential, or a policy denial (401 / 403) |
 * | `QueryBudgetExceeded` | planner memory budget (413)                |
 * | `InternalError`       | anything else the server reported (500)    |
 * | `NetworkError`        | the request never produced a response      |
 * | `OperationRejected`   | named operation refused (409)              |
 *
 * Not in this union: {@link NotOne} (`.oneOrFail()` cardinality),
 * {@link IncompatibleSchema} (`install()` refused a data-model split).
 * A runtime authorization denial is {@link Unauthorized}. A query that
 * cannot lower is {@link InvalidRequest}.
 *
 * Wire shapes the classifier understands:
 *
 *   worker's own errors      { error, code?, clause?, cells?, limit?, stack? }   (no `tag`)
 *   DO errors passed through { error, tag, message, code?, retryAfterMs? }
 *
 * `NetworkError` is the only failure with no server side: the request never
 * produced a response (DNS, service binding down, aborted body).
 * `TransactorDead` on the wire becomes {@link Unavailable} here.
 */

import * as Data from "effect/Data";
export {
  IncompatibleSchema,
  type IncompatibleKind,
  type InstallOptions,
  type SchemaChange,
} from "./SchemaErrors.ts";

/** A transaction was rejected by validation / tempid / unique / policy (409). */
export class TxRejected extends Data.TaggedError("TxRejected")<{
  readonly message: string;
  readonly code: string;
  /** Field ident a policy denial tripped on — never the value. */
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
  /** 403 when the caller is known but the policy refused; omit for 401. */
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

/** The request never produced a response (transport, DNS, service binding, aborted body). */
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
  /** The operation id (`user/create`). Not `Error.name` — that stays the tag. */
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
  /** Wire ids the client ships that the peer did not register. */
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
      // `{ error, code: "policy", attr: ":doc/owner" }` surfaces typed.
      // Keep `status` so `errorToHttp` can round-trip a 403 that is not
      // `code: "policy"` (an admin-only route, a known caller refused).
      return new Unauthorized({
        message,
        status,
        ...opt("code", b.code),
        ...opt("attr", b.attr),
      });
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
