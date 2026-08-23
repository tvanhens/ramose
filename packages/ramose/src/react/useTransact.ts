"use client";

/**
 * `useTransact` — run a promise from an event handler, and know whether it
 * is running and whether it failed.
 *
 * Deliberately not tied to the provider: it runs whatever promise the caller
 * built (`run(moveIssue(db, id, status, rank))`), so it composes with a
 * module-singleton `Db` just as well as with `useDb`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Transact {
  /**
   * Runs the work; rejects with the tagged error, so handlers that `void`
   * the promise stay `void`-safe while `error` / `onError` still fire.
   */
  readonly run: <A>(work: Promise<A> | (() => Promise<A>)) => Promise<A>;
  /** In-flight count > 0. */
  readonly pending: boolean;
  /**
   * The last-settled failure — cleared when a run settles successfully.
   */
  readonly error: unknown | undefined;
  readonly clearError: () => void;
}

/**
 * One hook for running writes from event handlers.
 *
 * - `run` resolves or rejects with the work's value / tagged error.
 * - `pending` counts concurrent runs: true while any run is in flight.
 * - `onError` fires per failure (the toast hook); `error` also lands on the
 *   return for inline rendering, and clears on the next successful run (or
 *   `clearError`).
 * - Concurrent runs settle independently and the last settler wins `error`.
 * - After unmount the work still runs to completion, but no state is
 *   touched. `onError` still fires.
 */
export const useTransact = (options?: {
  onError?: (error: unknown) => void;
}): Transact => {
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<unknown | undefined>(undefined);

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
    async <A>(work: Promise<A> | (() => Promise<A>)): Promise<A> => {
      if (mounted.current) setInFlight((n) => n + 1);
      try {
        const value = await (typeof work === "function" ? work() : work);
        if (mounted.current) setError(undefined);
        return value;
      } catch (failure) {
        if (mounted.current) setError(failure);
        onErrorRef.current?.(failure);
        throw failure;
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
