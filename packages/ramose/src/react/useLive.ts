"use client";

/**
 * `useLive` — a standing read as React state: `{ rows, error, ticks }`,
 * reset when the inputs change.
 *
 * Two rules for consumers:
 *
 * - `useLive(db, query)` subscribes to `db.live(query)` on the view's
 *   structural key and `query`. Neither needs a provider.
 * - The view is structural, the query is identity, params are structural:
 *   `useLive(db.asOf(t), q)` built inline re-subscribes per `t`, not per
 *   render — the same rule as `useQuery` / `usePull` — while `query` must
 *   be a stable object (build it at module scope). Bind changing values
 *   with `Ramose.params` as the third argument; a params-only change
 *   re-runs without blanking `rows`.
 *
 * Subscription form (`useLive(sub)`) keys on handle **identity**. Hoist the
 * handle (`const sub = db.live(q)` / `immediate(…)` outside render, or a
 * `useMemo`). `useLive(db.live(q))` built inline is a new subscription every
 * render and will re-subscribe forever — use the query form instead.
 */

import type {
  Catalog,
  DbError,
  QueryError,
  QueryObject,
  ReadDb,
  Subscription,
} from "../db/index.ts";
import { paramsKey } from "../db/Params.ts";
import type { ParamArgs } from "../db/Params.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { viewDep } from "./seam.ts";

/** What a standing read looks like from a component. */
export interface Live<A, E = DbError> {
  /** The last emission; `undefined` until the first (and again right after the inputs change). */
  readonly rows: A | undefined;
  /**
   * Terminal failure of the subscription. Transient errors never land here —
   * `live` retries them in place — and completion (a pinned `asOf` /
   * `history` view emitted its one pass) is not an error: `rows` stays.
   */
  readonly error: E | undefined;
  /** Emissions after the first — how many times the basis moved under this subscription. */
  readonly ticks: number;
}

const INITIAL: Live<never, never> = {
  rows: undefined,
  error: undefined,
  ticks: 0,
};

/** Query form: `db.live(query, params)`, memoised on the view, `query`, and params. */
export function useLive<C extends Catalog.Any, R, P = never, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, P, Out>,
  ...params: ParamArgs<P>
): Live<Out, QueryError<Out, P>>;
/** Subscription form: a handle built elsewhere; re-subscribes when its identity changes. */
export function useLive<A, E>(sub: Subscription<A, E>): Live<A, E>;
export function useLive(
  source: ReadDb | Subscription<unknown, unknown>,
  query?: QueryObject<unknown, unknown, unknown>,
  params?: unknown,
): Live<unknown, unknown> {
  const sourceDep =
    query === undefined ? source : viewDep(source as ReadDb);
  const pKey = query === undefined ? "" : paramsKey(params);
  const sub = useMemo(
    () =>
      query === undefined
        ? (source as Subscription<unknown, unknown>)
        : params === undefined
          ? (source as ReadDb).live(query as QueryObject<unknown>)
          : (source as ReadDb).live(
              query as QueryObject<unknown, Record<string, unknown>>,
              params as Record<string, unknown>,
            ),
    [sourceDep, query, pKey],
  );

  const [state, setState] = useState<Live<unknown, unknown>>(INITIAL);
  const queryRef = useRef(query);

  useEffect(() => {
    const queryChanged = query !== queryRef.current;
    queryRef.current = query;
    // Query form: a new query object blanks rows. Subscription form keys
    // on handle identity — do not reset+replay here or a fresh handle
    // built inline (`immediate(…)` / `db.live(q)`) loops setState forever.
    if (query !== undefined && queryChanged) {
      setState(INITIAL);
    }
    let emissions = 0;
    let cancelled = false;
    const off = sub.subscribe(
      (rows) => {
        if (cancelled) return;
        const ticks = emissions;
        emissions += 1;
        setState((prev) =>
          prev.rows === rows && prev.ticks === ticks && prev.error === undefined
            ? prev
            : { rows, error: undefined, ticks },
        );
      },
      (error) => {
        if (cancelled) return;
        setState((prev) => (prev.error === error ? prev : { ...prev, error }));
      },
    );
    return () => {
      cancelled = true;
      off();
      sub.close();
    };
  }, [sub]);

  return state;
}
