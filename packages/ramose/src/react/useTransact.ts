/**
 * `useTransact` — run an Effect from an event handler, and know whether it
 * is running and whether it failed.
 *
 * Deliberately not tied to the provider: it runs whatever Effect the caller
 * built (`run(moveIssue(db, id, status, rank))`), so it composes with a
 * module-singleton `Db` just as well as with `useDb`.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Transact {
  /**
   * Runs the effect; resolves to the outcome instead of throwing, so
   * handlers stay `void`-safe.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<Exit.Exit<A, E>>;
  /** In-flight count > 0. */
  readonly pending: boolean;
  /**
   * The last-settled failure's error (not the cause) — cleared when a run
   * settles successfully.
   */
  readonly error: unknown | undefined;
  readonly clearError: () => void;
}

/** The failure's error when there is one; the squashed cause (a defect) otherwise. */
const causeError = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) ? failure.value : Cause.squash(cause);
};

/**
 * One hook for running writes (any Effect with `R = never`, really) from
 * event handlers.
 *
 * - `run` resolves to the `Exit` — inspect it, or ignore it and read
 *   `error` / wire `onError` instead.
 * - `pending` counts concurrent runs: true while any run is in flight.
 * - `onError` fires per failure (the toast hook); `error` also lands on the
 *   return for inline rendering, and clears on the next successful run (or
 *   `clearError`).
 * - Concurrent runs settle independently and the last settler wins `error`:
 *   a failure that lands after a later-started success re-sets `error`.
 *   "Cleared on the next successful run" is about settle order, not start
 *   order.
 * - After unmount the effect still runs to completion, but no state is
 *   touched (guarded with a ref), so late settles never warn. `onError`
 *   still fires — the failure is real, and the toast host usually outlives
 *   the form that ran the write (toast after navigate-away is the point).
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

  // a ref so `run` stays referentially stable when the caller passes an
  // inline `onError` closure (the common spelling)
  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  const run = useCallback(
    async <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => {
      if (mounted.current) setInFlight((n) => n + 1);
      const exit = await Effect.runPromiseExit(effect);
      if (Exit.isFailure(exit)) {
        const failure = causeError(exit.cause);
        if (mounted.current) setError(failure);
        onErrorRef.current?.(failure);
      } else if (mounted.current) {
        setError(undefined);
      }
      if (mounted.current) setInFlight((n) => n - 1);
      return exit;
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
