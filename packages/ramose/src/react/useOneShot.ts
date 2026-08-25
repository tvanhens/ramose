"use client";

/**
 * Shared one-shot engine for `useQuery` / `usePull`: last-write-wins by
 * issue order, previous `data` kept while the next run is in flight,
 * `refetch()` re-issues the same run.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  READ_INITIAL,
  asError,
  asLoading,
  asSuccess,
  type Read,
  type ReadState,
} from "./read.ts";

export const useOneShot = <A, E>(
  run: () => Promise<A>,
  basis: () => number | undefined,
  deps: readonly unknown[],
): Read<A, E> => {
  const [nudge, setNudge] = useState(0);
  const refetch = useCallback(() => setNudge((n) => n + 1), []);
  const [state, set] = useState<ReadState<A, E>>(
    READ_INITIAL as ReadState<A, E>,
  );
  /** Monotonic run counter, shared across effect runs: the LWW sequence. */
  const runs = useRef({ issued: 0, applied: 0 });

  useEffect(() => {
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

  return { ...state, refetch };
};
