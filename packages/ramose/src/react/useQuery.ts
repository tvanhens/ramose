"use client";

/**
 * `useQuery` — one-shot `db.query(query)` as `Read` state.
 *
 * Two rules for callers:
 *
 * - The view is structural: `useQuery(db.asOf(t), q)` built inline re-runs
 *   per `t`, not per render. The query is structural too (canonical
 *   serialization of the lowered AST), the same key `useLiveQuery` uses. Put
 *   changing values in the query (`where({ issue: issueId })`). A
 *   render-fresh factory with the same literals does not re-run.
 * - The in-flight state is `isLoading: true` over the *previous* `data` (no
 *   flash to `undefined` on scrub); stale answers are dropped last-write-wins
 *   by issue order, not by resolution order.
 *
 * `initialData` hydrates this key so a server read can paint on the first
 * client render. `{ suspense: true }` throws until the first answer.
 */

import type { Schema, QueryError, QueryObject, ReadDb } from "../db/index.ts";
import { queryAstKey } from "../db/astKey.ts";
import {
  type Read,
  type ReadOptions,
  type SuspendedRead,
  readT,
} from "./read.ts";
import { viewDep, viewKeyOf } from "./seam.ts";
import { useOneShot } from "./useOneShot.ts";

export function useQuery<C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
  options: ReadOptions<Out> & { suspense: true },
): SuspendedRead<Out, QueryError<Out>>;
export function useQuery<C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
  options?: ReadOptions<Out>,
): Read<Out, QueryError<Out>>;
export function useQuery<C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
  options?: ReadOptions<Out>,
): Read<Out, QueryError<Out>> {
  const astKey = queryAstKey(query);
  return useOneShot(
    () => db.query(query),
    () => readT(db),
    [viewDep(db), astKey],
    {
      ...(options?.initialData !== undefined && { initialData: options.initialData }),
      ...(options?.initialT !== undefined && { initialT: options.initialT }),
      ...(options?.suspense !== undefined && { suspense: options.suspense }),
      suspendKey: `one\0${viewKeyOf(db)}\0${astKey}`,
    },
  );
}
