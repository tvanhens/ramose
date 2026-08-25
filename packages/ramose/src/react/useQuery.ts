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
 */

import type { Schema, QueryError, QueryObject, ReadDb } from "../db/index.ts";
import { queryAstKey } from "../db/astKey.ts";
import { type Read, readT } from "./read.ts";
import { viewDep } from "./seam.ts";
import { useOneShot } from "./useOneShot.ts";

export const useQuery = <C extends Schema.Any, R, Out = readonly R[]>(
  db: ReadDb<C>,
  query: QueryObject<R, Out>,
): Read<Out, QueryError<Out>> => {
  const astKey = queryAstKey(query);
  return useOneShot(
    () => db.query(query),
    () => readT(db),
    [viewDep(db), astKey],
  );
};
