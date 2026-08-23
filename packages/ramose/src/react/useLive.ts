"use client";

/**
 * `useLive` — a standing read as React state: `{ rows, error, ticks }`,
 * reset when the subscription identity changes.
 *
 * Two rules for consumers:
 *
 * - `useLive(db, query)` constructs `db.live(query)` inside the effect,
 *   keyed on the view, `query`, and params. Neither needs a provider. The
 *   hook owns that handle and closes it on cleanup.
 * - The view is structural, the query is identity, params are structural:
 *   `useLive(db.asOf(t), q)` built inline re-subscribes per `t`, not per
 *   render — the same rule as `useQuery` / `usePull` — while `query` must
 *   be a stable object (build it at module scope). Bind changing values
 *   with `Ramose.params` as the third argument; a params-only change
 *   re-runs without blanking `rows`.
 *
 * Subscription form (`useLive(sub)`) keys on handle **identity**. The hook
 * never `close()`s a handle it did not create — only `off()`.
 * `useLive(db.live(q))` built inline is a new subscription every render
 * and will re-subscribe forever — use the query form instead.
 */

import type {
  Schema,
  DbError,
  QueryError,
  QueryObject,
  ReadDb,
  Subscription,
} from "../db/index.ts";
import { paramsKey } from "../db/Params.ts";
import type { ParamArgs } from "../db/Params.ts";
import { useEffect, useRef, useState } from "react";
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

type Acquire<A, E> = () => {
  readonly sub: Subscription<A, E>;
  readonly owned: boolean;
};

/**
 * Drive a {@link Subscription} as `Live` state. `acquire` runs inside the
 * effect; the hook closes only handles it created. `resetKeys` blanks `rows`
 * when the subscription identity actually changes (not on a params-only
 * re-run, and not on a render-fresh handle).
 */
export const useLiveSubscription = <A, E>(
  acquire: Acquire<A, E>,
  deps: readonly unknown[],
  resetKeys: readonly unknown[],
): Live<A, E> => {
  const [state, setState] = useState<Live<A, E>>(INITIAL as Live<A, E>);
  const seen = useRef(resetKeys);
  const identityChanged =
    seen.current.length !== resetKeys.length ||
    seen.current.some((key, i) => key !== resetKeys[i]);
  if (identityChanged) {
    seen.current = resetKeys;
    setState(INITIAL as Live<A, E>);
  }

  useEffect(() => {
    const { sub, owned } = acquire();
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
      if (owned) sub.close();
    };
    // acquire closes over the same values as deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
};

/** Query form: `db.live(query, params)`, constructed inside the effect. */
export function useLive<C extends Schema.Any, R, P = never, Out = readonly R[]>(
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
  return useLiveSubscription(
    () =>
      query === undefined
        ? {
            sub: source as Subscription<unknown, unknown>,
            owned: false,
          }
        : {
            sub:
              params === undefined
                ? (source as ReadDb).live(query as QueryObject<unknown>)
                : (source as ReadDb).live(
                    query as QueryObject<unknown, Record<string, unknown>>,
                    params as Record<string, unknown>,
                  ),
            owned: true,
          },
    [sourceDep, query, pKey],
    query === undefined ? [source] : [sourceDep, query],
  );
}
