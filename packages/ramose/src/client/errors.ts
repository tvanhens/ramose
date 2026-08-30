import * as Data from "effect/Data";

/**
 * `createClient` was handed configuration it cannot bind: a server URL that is
 * not one plain origin, an empty or path-shaped root route, or a value that is
 * not an installed catalog definition.
 *
 * Raised synchronously from `createClient`, because none of these can become
 * valid later.
 */
export class ClientConfigurationError extends Data.TaggedError(
  "ClientConfigurationError",
)<{ readonly message: string }> {}

/**
 * The client is terminal. A terminal client never repopulates storage, so the
 * application constructs a new one.
 *
 * - `closed` — `close()` released it.
 * - `cleared` — `clearLocalData()` deleted the scope it was bound to.
 * - `fenced` — destructive local maintenance (another client's clear, or a
 *   database eviction) closed this client's session out from under it.
 */
export class ClientClosedError extends Data.TaggedError("ClientClosedError")<{
  readonly operation: string;
  readonly reason: "closed" | "cleared" | "fenced";
}> {}

/** Why `clearLocalData()` deleted nothing. */
export type ClientLocalDataFailure =
  | "no-confirmed-scope"
  | "storage";

/**
 * `clearLocalData()` failed. The clear is atomic: on failure the scope's
 * durable state is exactly what it was, and the call may be retried.
 */
export class ClientLocalDataError extends Data.TaggedError(
  "ClientLocalDataError",
)<{
  readonly reason: ClientLocalDataFailure;
  readonly cause?: unknown;
}> {}

/** Why a graph path does not name a database this client may read. */
export type GraphPathFailure =
  | "unavailable"
  | "ambiguous"
  | "unauthorized"
  | "update-required"
  | "closed"
  | "query";

/**
 * A graph path could not be resolved to one database.
 *
 * Surfaced as the `error` of every descendant query snapshot, and never as an
 * absence of rows: a path that does not resolve has no rows to be absent.
 */
export class GraphPathError extends Data.TaggedError("GraphPathError")<{
  readonly reason: GraphPathFailure;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Why an invocation could not be addressed to one stable database. */
export type GraphReceiverFailure =
  | "unresolved"
  | "ambiguous"
  | "unauthorized"
  | "update-required"
  | "closed";

/**
 * An invocation's receiver did not resolve to one stable database identity, so
 * nothing was queued.
 *
 * The pre-queue gate: no durable invocation or outbox entry is ever created
 * from mutable path text or from a guessed receiver, so this failure leaves no
 * durable trace to undo.
 */
export class GraphReceiverError extends Data.TaggedError("GraphReceiverError")<{
  readonly reason: GraphReceiverFailure;
  readonly message: string;
  readonly cause?: unknown;
}> {}
