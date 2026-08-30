/** Typed failures the public client surface raises. */

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
  /**
   * No server/principal scope this client can name has ever been confirmed by
   * an authenticated response — so there is nothing it is entitled to delete,
   * and a guessed scope must never stand in for one.
   */
  | "no-confirmed-scope"
  /** Storage refused or failed the deletion; the prior state is intact. */
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
  /**
   * The path names no entity this client may read.
   *
   * Deliberately one answer for two causes: an entity that does not exist and
   * an entity the read policy hides are indistinguishable here, and must stay
   * that way — a distinguishable "hidden" would be a disclosure.
   */
  | "unavailable"
  /**
   * The path matches more than one entity. Never resolved by picking one: an
   * arbitrary selection would silently address the wrong database, and a
   * mutation queued against it would be unrecoverable.
   */
  | "ambiguous"
  /** An ancestor's authorization was revoked, or its principal was replaced. */
  | "unauthorized"
  /** This build cannot read an ancestor's current authorized view. */
  | "update-required"
  /** An ancestor was closed, so nothing maintains the path any more. */
  | "closed"
  /** The canonical resolution query could not run against the parent. */
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
  /** The path has not resolved, and terminated rather than resolving. */
  | "unresolved"
  /** The path matches more than one entity, so there is no one receiver. */
  | "ambiguous"
  /**
   * The credential no longer opens this database, or its principal was
   * replaced. A session keeps its prior identity while it fences the rows, so
   * this is checked before that identity may address durable work.
   */
  | "unauthorized"
  /** This build cannot read this database's authorized view, or replay against it. */
  | "update-required"
  /** The database was closed before its receiver was known. */
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
