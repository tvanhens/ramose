"use client";

/**
 * `useTransact` — pending / error helper for a promise from an event
 * handler. Not the write API: that is `db.run`. Typical call is
 * `run(moveIssue(db, id, status, rank))`.
 *
 * Deliberately not tied to the provider: it runs whatever promise the caller
 * built, so it composes with a module-singleton `Db` just as well as with
 * `useDb`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What `run` resolves — always, so `void run(...)` is safe. */
export type RunResult<A, E = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

export interface Transact<E = unknown> {
  /**
   * Runs the work. Always resolves — failure lands on `error` / `onError`
   * and on the rejected half of the result, so `void run(...)` is safe.
   */
  readonly run: <A>(
    work: Promise<A> | (() => Promise<A>),
  ) => Promise<RunResult<A, E>>;
  /** In-flight count > 0. */
  readonly pending: boolean;
  /**
   * The last-settled failure — cleared when a run settles successfully.
   */
  readonly error: E | undefined;
  readonly clearError: () => void;
}

/**
 * Run a promise from an event handler and expose pending / error.
 * The write itself is `db.run` (or any other promise).
 *
 * - `run` always resolves: `{ ok: true, value }` or `{ ok: false, error }`.
 * - `pending` counts concurrent runs: true while any run is in flight.
 * - `onError` fires per failure (the toast hook); `error` also lands on the
 *   return for inline rendering, and clears on the next successful run (or
 *   `clearError`).
 * - Concurrent runs settle independently and the last settler wins `error`.
 * - After unmount the work still runs to completion, but no state is
 *   touched. `onError` still fires.
 */
export const useTransact = <E = unknown>(options?: {
  onError?: (error: E) => void;
}): Transact<E> => {
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<E | undefined>(undefined);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  const run = useCallback(
    async <A>(
      work: Promise<A> | (() => Promise<A>),
    ): Promise<RunResult<A, E>> => {
      if (mounted.current) setInFlight((n) => n + 1);
      try {
        const value = await (typeof work === "function" ? work() : work);
        if (mounted.current) setError(undefined);
        return { ok: true, value };
      } catch (failure) {
        const err = failure as E;
        if (mounted.current) setError(err);
        onErrorRef.current?.(err);
        return { ok: false, error: err };
      } finally {
        if (mounted.current) setInFlight((n) => n - 1);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(undefined), []);

  const pending = inFlight > 0;
  return useMemo(
    () => ({ run, pending, error, clearError }),
    [run, pending, error, clearError],
  );
};
