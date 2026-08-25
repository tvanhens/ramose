"use client";

/**
 * Shared one-shot engine for `useQuery` / `usePull`: last-write-wins by
 * issue order, previous `data` kept while the next run is in flight,
 * `refetch()` / `retry()` re-issue the same run.
 *
 * `initialData` hydrates the first paint for this structural key and
 * skips the automatic first fetch (the rows already came from the
 * server). `refetch()` / a later key still run. `{ suspense: true }`
 * throws until the first settlement; hydrated rows do not suspend.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  asError,
  asLoading,
  asSuccess,
  hydrateRead,
  type Read,
  type ReadOptions,
  type ReadState,
} from "./read.ts";
import { ensureOneShot, evictSuspend, peekSuspend } from "./suspend.ts";

export const useOneShot = <A, E>(
  run: () => Promise<A>,
  basis: () => number | undefined,
  deps: readonly unknown[],
  options?: ReadOptions<A> & { readonly suspendKey?: string },
): Read<A, E> => {
  const suspendKey = options?.suspendKey;
  const [nudge, setNudge] = useState(0);
  const [state, set] = useState<ReadState<A, E>>(() => {
    const hydrated = hydrateRead<A, E>(options);
    if (hydrated.data !== undefined) return hydrated;
    if (options?.suspense === true && suspendKey !== undefined) {
      const slot = peekSuspend<A, E>(suspendKey);
      if (slot?.data !== undefined) {
        evictSuspend(suspendKey);
        return asSuccess(slot.data, slot.t ?? options.initialT);
      }
    }
    return hydrated;
  });
  /** Monotonic run counter, shared across effect runs: the LWW sequence. */
  const runs = useRef({ issued: 0, applied: 0 });
  /**
   * Structural key whose rows already arrived (`initialData` or a
   * just-resolved suspense slot). The effect skips that key — including
   * StrictMode's remount — until `refetch()` or a later key without rows.
   */
  const hydratedKey = useRef<string | undefined>(
    state.data !== undefined && state.status === "success"
      ? (suspendKey ?? "hydrated")
      : undefined,
  );

  const seen = useRef(deps);
  const seedRef = useRef(options?.initialData);
  const identityChanged =
    seen.current.length !== deps.length ||
    seen.current.some((key, i) => key !== deps[i]);
  const seedChanged = !Object.is(seedRef.current, options?.initialData);
  if (identityChanged) {
    seen.current = deps;
    seedRef.current = options?.initialData;
    if (seedChanged && options?.initialData !== undefined) {
      hydratedKey.current = suspendKey ?? "hydrated";
      set(hydrateRead<A, E>(options));
    } else {
      // Same `initialData` reference (or none) is for the previous key —
      // a later key still runs. Keep previous `data` while that run loads.
      hydratedKey.current = undefined;
      set((prev) => asLoading(prev));
    }
  }

  const refetch = useCallback(() => {
    if (suspendKey !== undefined) evictSuspend(suspendKey);
    hydratedKey.current = undefined;
    setNudge((n) => n + 1);
  }, [suspendKey]);

  useEffect(() => {
    if (
      hydratedKey.current !== undefined &&
      hydratedKey.current === (suspendKey ?? "hydrated")
    ) {
      return;
    }
    const seq = ++runs.current.issued;
    let disposed = false;
    const land = (
      next: (prev: ReadState<A, E>) => ReadState<A, E>,
    ): void => {
      if (disposed || seq < runs.current.applied) return;
      runs.current.applied = seq;
      set(next);
    };

    set((prev) =>
      prev.isLoading && prev.error === undefined ? prev : asLoading(prev),
    );

    void run()
      .then((data) => {
        land(() => asSuccess(data, basis()));
      })
      .catch((error: E) => {
        land((prev) => asError(prev, error));
      });

    return () => {
      disposed = true;
    };
    // run / basis close over the same values as deps; nudge is refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nudge]);

  let shown =
    identityChanged && seedChanged && options?.initialData !== undefined
      ? hydrateRead<A, E>(options)
      : identityChanged
        ? asLoading(state)
        : state;
  if (
    options?.suspense === true &&
    suspendKey !== undefined &&
    shown.data === undefined &&
    shown.error === undefined
  ) {
    const slot = ensureOneShot<A, E>(suspendKey, run, basis);
    if (slot.error !== undefined) throw slot.error;
    if (slot.data === undefined) throw slot.promise;
    shown = asSuccess(slot.data, slot.t ?? options.initialT);
    hydratedKey.current = suspendKey;
    evictSuspend(suspendKey);
    if (state.data !== slot.data) set(shown);
  }

  return { ...shown, refetch, retry: refetch };
};
