"use client";

/**
 * `useLive` — a standing read as React state: `{ rows, error, ticks }`,
 * reset when the subscription identity changes.
 *
 * Two rules for consumers:
 *
 * - `useLive(db, query)` constructs `db.live(query)` inside the effect,
 *   keyed on the view, the lowered query AST, and params. Neither needs a
 *   provider. The hook owns that handle and closes it on cleanup. Two
 *   sites with the same lowered AST + params share one standing
 *   subscription (refcount; last unmount tears it down).
 * - The view is structural (`DbSeam.key`), the query is structural
 *   (canonical serialization of the lowered AST), params are structural
 *   (`paramsKey`). `useLive(db.asOf(t), q)` built inline re-subscribes per
 *   `t`, not per render — the same rule as `useQuery` / `usePull`. Build
 *   queries at module scope and bind changing values with `Ramose.params`;
 *   a params-only change re-runs without blanking `rows`.
 *
 * Subscription form (`useLive(sub)`) keys on handle **identity**. The hook
 * never `close()`s a handle it did not create — only `off()`.
 * `useLive(db.live(q))` built inline is a new subscription every render
 * and will re-subscribe forever — use the query form instead. A caller-
 * owned handle is never share-cached.
 */

import type {
  Schema,
  DbError,
  QueryError,
  QueryObject,
  ReadDb,
  Subscription,
} from "../db/index.ts";
import { liveSubscriptionKey, queryAstKey } from "../db/astKey.ts";
import type { ParamArgs } from "../db/Params.ts";
import { useEffect, useRef, useState } from "react";
import { retainLive } from "./liveCache.ts";
import { viewKeyOf } from "./seam.ts";

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

const DEV = process.env.NODE_ENV !== "production";

const CHURN_WARNING =
  "ramose/react: useLive subscription key changed between renders. " +
  "Queries are keyed structurally on the lowered AST — a value minted " +
  "each render (e.g. where({ at: new Date() })) tears the subscription " +
  "down. Hoist the query or keep bound values stable.";

/** Dev-only: warn once per hook site when the cache key churns. */
const useKeyChurnWarning = (key: string): void => {
  const prev = useRef<string | undefined>(undefined);
  const warned = useRef(false);
  if (DEV && prev.current !== undefined && prev.current !== key && !warned.current) {
    warned.current = true;
    console.warn(CHURN_WARNING);
  }
  prev.current = key;
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
  const owned = query !== undefined;
  const viewKey = owned ? viewKeyOf(source as ReadDb) : "";
  const astKey = owned ? queryAstKey(query) : "";
  const cacheKey = owned
    ? liveSubscriptionKey(viewKey, query, params)
    : "";
  useKeyChurnWarning(owned ? cacheKey : "");

  return useLiveSubscription(
    () =>
      owned
        ? {
            sub: retainLive(cacheKey, () =>
              params === undefined
                ? (source as ReadDb).live(query)
                : (source as ReadDb).live(
                    query as QueryObject<unknown, Record<string, unknown>>,
                    params as Record<string, unknown>,
                  ),
            ),
            owned: true,
          }
        : {
            sub: source as Subscription<unknown, unknown>,
            owned: false,
          },
    owned ? [cacheKey] : [source],
    owned ? [viewKey, astKey] : [source],
  );
}

export { CHURN_WARNING };
