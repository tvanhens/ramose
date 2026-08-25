/**
 * `Read` — the one result every `ramose/react` read hook returns.
 *
 * Live and one-shot, query and pull: `data` (never `rows`), a plain tagged
 * `error`, `status` / `isLoading`, the basis `t` the rows were read at,
 * `refetch()`, and `retry()`. No Effect types.
 */

import type { Schema, DbError, ReadDb } from "../db/index.ts";
import { seamOf } from "./seam.ts";

export type ReadStatus = "loading" | "success" | "error";

/** What a read looks like as React state. Shared by every read hook. */
export interface Read<A, E = DbError> {
  /**
   * The last successful value. `undefined` until the first success — and
   * again right after a live hook's inputs change — unless `initialData`
   * hydrated this key. One-shot hooks keep the previous value while a
   * later run is in flight (no flash on scrub). A pull of a missing
   * record is `null`, not `undefined`.
   */
  readonly data: A | undefined;
  /**
   * Terminal failure. Transient live errors are retried in place and never
   * land here. Cleared when a new run or subscription starts.
   */
  readonly error: E | undefined;
  readonly status: ReadStatus;
  /** `true` from mount / input change / `refetch()` until that run settles. */
  readonly isLoading: boolean;
  /**
   * The basis the current `data` was read at. Pinned `asOf(t)` views answer
   * `t`. A live view reads `session.t`. `undefined` until a value is known.
   */
  readonly t: number | undefined;
  /** Re-run the one-shot, or re-read once on a live hook. Stable identity. */
  readonly refetch: () => void;
  /**
   * Re-subscribe (live) or re-run (one-shot). Recovers a terminal live
   * error without unmounting. Stable identity. One-shot `retry` is
   * `refetch`.
   */
  readonly retry: () => void;
}

/**
 * Options shared by every read hook. `initialData` hydrates the first
 * paint (a server `db.query` / `db.pull` handed across the RSC boundary).
 * It is applied once per structural key — the same view + lowered AST
 * (or subject) the hook already keys the subscription / one-shot on.
 * `{ suspense: true }` throws until that key has a value, then `data` is
 * defined. The two compose: hydrated rows do not suspend.
 */
export interface ReadOptions<A = unknown> {
  readonly initialData?: A;
  /** Basis those rows were read at, when the server also knows `t`. */
  readonly initialT?: number;
  readonly suspense?: boolean;
}

/** {@link Read} after `{ suspense: true }` — `data` is defined. */
export type SuspendedRead<A, E = DbError> = Read<A, E> & { readonly data: A };

/** Slice of {@link Read} stored in hook state — `refetch` / `retry` attach on return. */
export type ReadState<A, E> = Omit<Read<A, E>, "refetch" | "retry">;

export const READ_INITIAL: ReadState<never, never> = {
  data: undefined,
  error: undefined,
  status: "loading",
  isLoading: true,
  t: undefined,
};

export const asLoading = <A, E>(prev: ReadState<A, E>): ReadState<A, E> => ({
  data: prev.data,
  error: undefined,
  status: "loading",
  isLoading: true,
  t: prev.t,
});

export const asSuccess = <A, E>(
  data: A,
  t: number | undefined,
): ReadState<A, E> => ({
  data,
  error: undefined,
  status: "success",
  isLoading: false,
  t,
});

export const asError = <A, E>(
  prev: ReadState<A, E>,
  error: E,
): ReadState<A, E> => ({
  data: prev.data,
  error,
  status: "error",
  isLoading: false,
  t: prev.t,
});

/** First-paint state: hydrated rows, or the empty loading shell. */
export const hydrateRead = <A, E>(
  options?: ReadOptions<A>,
): ReadState<A, E> =>
  options !== undefined && options.initialData !== undefined
    ? asSuccess(options.initialData, options.initialT)
    : (READ_INITIAL as ReadState<A, E>);

/**
 * The basis a view reads at, without `GET /info`: pinned `asOf(t)`, else
 * `session.t` once the session has seen a frame. `0` is "not yet".
 */
export const readT = <C extends Schema.Any>(
  db: ReadDb<C> | undefined,
): number | undefined => {
  if (db === undefined) return undefined;
  const seam = seamOf(db);
  if (seam === undefined) return undefined;
  if (seam.asOf !== undefined) return seam.asOf;
  const t = seam.t();
  return t !== undefined && t > 0 ? t : undefined;
};
