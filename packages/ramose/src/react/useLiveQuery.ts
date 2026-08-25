"use client";

/**
 * `useLiveQuery` — a live query as React `Read` state: `{ data, error,
 * status, isLoading, t, refetch, retry }`, reset when the subscription
 * identity changes. `{ initialData, initialT }` hydrates that identity;
 * `{ suspense: true }` throws until it has a value.
 *
 * Two rules for consumers:
 *
 * - `useLiveQuery(db, query)` constructs a shared raw live read inside the
 *   effect, keyed on the view and the lowered query AST. Neither needs a
 *   provider. Two sites with the same AST share one raw subscription
 *   (refcount; last unmount tears it down); each hook applies its own
 *   `finalize` (take-unwrap / page-wrap) on read, so `one()` and `.limit(1)`
 *   share the wire result without swapping shapes.
 * - The view is structural (`DbSeam.key`), the query is structural
 *   (canonical serialization of the lowered AST). `useLiveQuery(db.asOf(t),
 *   q)` built inline re-subscribes per `t`, not per render — the same rule
 *   as `useQuery` / `useLivePull`. Put changing values in the query
 *   (`where({ issue: issueId })`). Same literals → same key, even when the
 *   object is new every render. Changing an inline literal changes the AST
 *   key and resubscribes — that is the point.
 *
 * Subscription form (`useLiveQuery(sub)`) keys on handle **identity**. The
 * hook never `close()`s a handle it did not create — only `off()`.
 * `useLiveQuery(db.live(q))` built inline is a new subscription every
 * render and will re-subscribe forever — use the query form instead. A
 * caller-owned handle is never share-cached.
 */

import type {
  ConnectionStatus,
  Schema,
  QueryError,
  QueryObject,
  ReadDb,
  Subscription,
} from "../db/index.ts";
import {
  assertLoweringPurity,
  liveSubscriptionKey,
  queryStructureKey,
} from "../db/astKey.ts";
import { lowerQueryObject } from "../db/query/index.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { retainLive } from "./liveCache.ts";
import {
  asError,
  asLoading,
  asSuccess,
  hydrateRead,
  readT,
  type Read,
  type ReadOptions,
  type ReadState,
  type SuspendedRead,
} from "./read.ts";
import { seamOf, viewKeyOf } from "./seam.ts";
import { ensureLive, evictSuspend, peekSuspend } from "./suspend.ts";

type Acquire<A, E> = () => {
  readonly sub: Subscription<A, E>;
  readonly owned: boolean;
};

interface LiveSeam {
  readonly generation: () => number;
  readonly status: () => ConnectionStatus;
  readonly onWake: (cb: () => void) => (() => void) | undefined;
}

interface LiveOptions<A, E = unknown> extends ReadOptions<A> {
  readonly basis?: () => number | undefined;
  readonly refetch?: () => Promise<A>;
  readonly seam?: LiveSeam;
  /** Structural key for `{ suspense: true }` — view + AST, or handle identity. */
  readonly suspendKey?: string;
}

/**
 * Drive a {@link Subscription} as `Read` state. `acquire` runs inside the
 * effect; the hook closes only handles it created. `resetKeys` blanks `data`
 * when the subscription identity actually changes (not on a render-fresh
 * handle).
 */
const firstPaint = <A, E>(
  options: LiveOptions<A, E> | undefined,
  suspendKey: string | undefined,
): ReadState<A, E> => {
  const hydrated = hydrateRead<A, E>(options);
  if (hydrated.data !== undefined) return hydrated;
  if (options?.suspense !== true || suspendKey === undefined) return hydrated;
  const slot = peekSuspend<A, E>(suspendKey);
  if (slot?.data === undefined) return hydrated;
  evictSuspend(suspendKey);
  return asSuccess(slot.data, options.initialT ?? options.basis?.());
};

export const useLiveSubscription = <A, E>(
  acquire: Acquire<A, E>,
  deps: readonly unknown[],
  resetKeys: readonly unknown[],
  options?: LiveOptions<A, E>,
): Read<A, E> => {
  const suspendKey = options?.suspendKey;
  const [state, setState] = useState<ReadState<A, E>>(() =>
    firstPaint(options, suspendKey),
  );
  const seen = useRef(resetKeys);
  const identityChanged =
    seen.current.length !== resetKeys.length ||
    seen.current.some((key, i) => key !== resetKeys[i]);
  if (identityChanged) {
    seen.current = resetKeys;
    setState(firstPaint(options, suspendKey));
  }

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const refetchRuns = useRef({ issued: 0, applied: 0 });
  const [nudge, setNudge] = useState(0);

  const [epoch, setEpoch] = useState(0);

  const refetch = useCallback(() => {
    const opts = optionsRef.current;
    if (opts?.refetch !== undefined) {
      const seq = ++refetchRuns.current.issued;
      setState((prev) => asLoading(prev));
      void opts
        .refetch()
        .then((data) => {
          if (seq < refetchRuns.current.applied) return;
          refetchRuns.current.applied = seq;
          setState(asSuccess(data, opts.basis?.()));
        })
        .catch((error: E) => {
          if (seq < refetchRuns.current.applied) return;
          refetchRuns.current.applied = seq;
          setState((prev) => asError(prev, error));
        });
      return;
    }
    setNudge((n) => n + 1);
  }, []);

  const retry = useCallback(() => {
    const key = optionsRef.current?.suspendKey;
    if (key !== undefined) evictSuspend(key);
    setState((prev) => asLoading(prev));
    setEpoch((n) => n + 1);
  }, []);
  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    const { sub, owned } = acquire();
    let cancelled = false;
    const off = sub.subscribe(
      (data) => {
        if (cancelled) return;
        const t = optionsRef.current?.basis?.();
        setState((prev) =>
          prev.data === data &&
          prev.t === t &&
          prev.error === undefined &&
          !prev.isLoading
            ? prev
            : asSuccess(data, t),
        );
      },
      (error) => {
        if (cancelled) return;
        setState((prev) =>
          prev.error === error && !prev.isLoading
            ? prev
            : asError(prev, error),
        );
      },
    );
    return () => {
      cancelled = true;
      off();
      if (owned) sub.close();
    };
    // acquire closes over the same values as deps; nudge remounts a
    // caller-owned handle on refetch(); epoch remounts on retry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nudge, epoch]);

  const error = state.error;
  useEffect(() => {
    if (error === undefined) return;
    const seam = optionsRef.current?.seam;
    if (seam === undefined) return;
    const genAtError = seam.generation();
    const off = seam.onWake(() => {
      if (seam.generation() > genAtError && seam.status() === "live") {
        retryRef.current();
      }
    });
    return () => {
      off?.();
    };
  }, [error]);

  let shown = identityChanged ? firstPaint(options, suspendKey) : state;
  if (
    options?.suspense === true &&
    suspendKey !== undefined &&
    shown.data === undefined &&
    shown.error === undefined
  ) {
    const slot = ensureLive(suspendKey, acquire);
    if (slot.error !== undefined) throw slot.error;
    if (slot.data === undefined) throw slot.promise;
    shown = asSuccess(slot.data, options.initialT ?? options.basis?.());
    evictSuspend(suspendKey);
    if (state.data !== slot.data) setState(shown);
  }

  return { ...shown, refetch, retry };
};

// Bundlers replace the dotted `process.env.NODE_ENV` via define even
// inside this try (`?.` is not substituted). The declare is for tsc;
// a missing runtime `process` (unbundled ESM / Deno) throws here and
// the catch keeps DEV true.
declare const process: { readonly env: { readonly NODE_ENV?: string } };
let DEV = true;
try {
  DEV = process.env.NODE_ENV !== "production";
} catch {
  // no `process`, no substitution — stay in dev mode
}

const CHURN_WARNING =
  "ramose/react: useLiveQuery subscription key changed between renders. " +
  "Queries are keyed structurally on the lowered AST — a value minted " +
  "each render (e.g. where({ at: new Date() })) tears the subscription " +
  "down. Hoist the query or keep bound values stable.";

/**
 * Consecutive query-half key changes before the dev warning fires.
 * One legitimate navigation (`issueId` A → B) is silent; a `Date.now()`
 * footgun changes every render and trips this. A same-key follow-up
 * (the hook blanking `data` via setState) does not reset the streak;
 * two quiet same-key renders do — that is a settled navigation.
 */
const CHURN_STREAK = 3;
const CHURN_SETTLE = 2;

/**
 * Dev-only: warn once per hook site when the **query-half** (AST key)
 * churns for {@link CHURN_STREAK} consecutive changes. A view (`asOf(t)`)
 * change is the documented path and stays silent. A single A → B change
 * does not warn.
 */
const useKeyChurnWarning = (key: string): void => {
  const prev = useRef<string | undefined>(undefined);
  const streak = useRef(0);
  const settled = useRef(0);
  const warned = useRef(false);
  if (!DEV) {
    prev.current = key;
    return;
  }
  if (prev.current === undefined) {
    prev.current = key;
    return;
  }
  if (prev.current !== key) {
    streak.current += 1;
    settled.current = 0;
    if (streak.current >= CHURN_STREAK && !warned.current) {
      warned.current = true;
      console.warn(CHURN_WARNING);
    }
  } else {
    settled.current += 1;
    if (settled.current >= CHURN_SETTLE) streak.current = 0;
  }
  prev.current = key;
};

const isSubscription = (
  value: unknown,
): value is Subscription<unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Subscription<unknown, unknown>).subscribe === "function" &&
  typeof (value as Subscription<unknown, unknown>).close === "function";

const subKeys = new WeakMap<object, string>();
let nextSubKey = 1;
const subscriptionKey = (sub: object): string => {
  const held = subKeys.get(sub);
  if (held !== undefined) return held;
  const key = `sub:${nextSubKey++}`;
  subKeys.set(sub, key);
  return key;
};

/** Query form: `db.live(query)`, constructed inside the effect. */
export function useLiveQuery<C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
  options: ReadOptions<Out> & { suspense: true },
): SuspendedRead<Out, QueryError<Out>>;
export function useLiveQuery<C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
  options?: ReadOptions<Out>,
): Read<Out, QueryError<Out>>;
/** Subscription form: a handle built elsewhere; re-subscribes when its identity changes. */
export function useLiveQuery<A, E>(
  sub: Subscription<A, E>,
  options: ReadOptions<A> & { suspense: true },
): SuspendedRead<A, E>;
export function useLiveQuery<A, E>(
  sub: Subscription<A, E>,
  options?: ReadOptions<A>,
): Read<A, E>;
export function useLiveQuery(
  source: ReadDb | Subscription<unknown, unknown>,
  queryOrOptions?: QueryObject<unknown, unknown> | ReadOptions<unknown>,
  options?: ReadOptions<unknown>,
): Read<unknown, unknown> {
  const owned = !isSubscription(source);
  const query = owned
    ? (queryOrOptions as QueryObject<unknown, unknown>)
    : undefined;
  const opts = owned ? options : (queryOrOptions as ReadOptions<unknown> | undefined);
  const viewKey = owned ? viewKeyOf(source as ReadDb) : "";
  const structureKey = owned ? queryStructureKey(query!) : "";
  const cacheKey = owned ? liveSubscriptionKey(viewKey, query!) : "";
  const suspendKey = owned ? cacheKey : subscriptionKey(source);
  useKeyChurnWarning(owned ? structureKey : "");

  const db = owned ? (source as ReadDb) : undefined;
  const queryRef = useRef(query);
  queryRef.current = query;
  const dbRef = useRef(db);
  dbRef.current = db;

  return useLiveSubscription(
    () => {
      if (!owned) {
        return {
          sub: source as Subscription<unknown, unknown>,
          owned: false,
        };
      }
      if (DEV) assertLoweringPurity(query!);
      const seam = seamOf(source as ReadDb);
      // `finalize` is only correct on the raw wire result. A hand-rolled
      // ReadDb without `liveRaw` already emits shaped rows from `live()`.
      if (seam?.liveRaw !== undefined) {
        let finalize: ((result: unknown) => unknown) | undefined;
        try {
          finalize = lowerQueryObject(query!).finalize;
        } catch {
          // liveRaw will surface the same lowering failure
        }
        return {
          sub: retainLive(cacheKey, () => seam.liveRaw!(query!), finalize),
          owned: true,
        };
      }
      return {
        sub: retainLive(cacheKey, () => (source as ReadDb).live(query!)),
        owned: true,
      };
    },
    owned ? [cacheKey] : [source],
    owned ? [viewKey, structureKey] : [source],
    {
      initialData: opts?.initialData,
      initialT: opts?.initialT,
      suspense: opts?.suspense,
      suspendKey,
      basis: () => readT(dbRef.current),
      refetch:
        owned
          ? () => (dbRef.current as ReadDb).query(queryRef.current!)
          : undefined,
      seam:
        owned
          ? {
              generation: () => seamOf(dbRef.current!)?.generation() ?? 0,
              status: () => seamOf(dbRef.current!)?.status() ?? "offline",
              onWake: (cb) => seamOf(dbRef.current!)?.onWake(cb),
            }
          : undefined,
    },
  );
}
