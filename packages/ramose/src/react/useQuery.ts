"use client";

/**
 * `useQuery` — one-shot `db.query(query)` as React state.
 *
 * Two rules for callers:
 *
 * - The view is structural: `useQuery(db.asOf(t), q)` built inline re-runs
 *   per `t`, not per render. Put changing values in the query
 *   (`where({ issue: issueId })`). The leftover bindings argument is
 *   still accepted. `query` is compared by identity here — hoist a
 *   stable value, or accept a re-run when the object is new.
 * - The in-flight state is `loading: true` over the *previous* `data` (no
 *   flash to `undefined` on scrub); stale answers are dropped last-write-wins
 *   by issue order, not by resolution order.
 */

import type { Schema, DbError, QueryError, QueryObject, ReadDb } from "../db/index.ts";
import { paramsKey, type ParamArgs } from "../db/Params.ts";
import { useEffect, useRef, useState } from "react";
import { viewDep } from "./seam.ts";

/** What a one-shot read looks like as React state. */
export interface Async<A, E = DbError> {
  /** The last completed run's rows — kept while the next run is in flight. */
  readonly data: A | undefined;
  /** The last completed run's failure. Cleared when a new run starts. */
  readonly error: E | undefined;
  /** `true` from mount / input change until that run settles. */
  readonly loading: boolean;
}

export const useQuery = <C extends Schema.Any, R, P = never, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, P, Out>,
  ...params: ParamArgs<P>
): Async<Out, QueryError<Out, P>> => {
  const bindings = params[0];
  const [state, set] = useState<Async<Out, QueryError<Out, P>>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  /** Monotonic run counter, shared across effect runs: the LWW sequence. */
  const runs = useRef({ issued: 0, applied: 0 });

  useEffect(() => {
    const seq = ++runs.current.issued;
    let disposed = false;
    /** Land this run's outcome unless a later-issued run already landed. */
    const land = (
      next: (prev: Async<Out, QueryError<Out, P>>) => Async<Out, QueryError<Out, P>>,
    ): void => {
      if (disposed || seq < runs.current.applied) return;
      runs.current.applied = seq;
      set(next);
    };

    set((prev) =>
      prev.loading && prev.error === undefined
        ? prev
        : { data: prev.data, error: undefined, loading: true },
    );

    void db
      .query(query, ...(params as ParamArgs<P>))
      .then((rows) => {
        land(() => ({ data: rows as Out, error: undefined, loading: false }));
      })
      .catch((error: QueryError<Out, P>) => {
        if (disposed) return;
        land((prev) => ({ data: prev.data, error, loading: false }));
      });

    return () => {
      disposed = true;
    };
    // the view is a structural dependency; `db` itself may be a fresh object
    // every render (`db.asOf(t)` is pure and unmemoised by design). Params
    // are structural too — `{ issueId }` inline is fine.
  }, [viewDep(db), query, paramsKey(bindings)]);

  return state;
};
