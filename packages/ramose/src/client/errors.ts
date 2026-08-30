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
