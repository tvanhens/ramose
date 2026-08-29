/**
 * Workers Analytics Engine, as an Effect service.
 *
 * `alchemy.run.ts` binds the `ripple_tx` dataset to the Worker under the env
 * name `ANALYTICS` (binding type `analytics_engine`) — physical dataset name
 * pinned so existing telemetry keeps flowing; the product is Ramose — so both
 * this Worker and
 * the two Durable Object classes it exports see `env.ANALYTICS`. The service
 * has the same shape as Alchemy's `Cloudflare.AnalyticsEngine.WriteDataset`
 * client (`writeDataPoint(dp) => Effect<void, DatasetError>`) and is a no-op
 * when the binding is missing, so `bun test`, miniflare and `bun alchemy dev`
 * without the binding still run.
 *
 * `writeDataPoint` is sync and non-blocking on Workers (the point is flushed
 * with the response), so no `ctx.waitUntil` is needed.
 *
 * ---- http point schema (one per request; see `httpPoint`) ----
 *   index1 = db ("-" when the request never resolved a database)
 *   blob1  = "http" (point kind), blob2 = db, blob3 = colo (request.cf.colo),
 *   blob4  = route (transact|op|query|pull|entity|live|replicate|info|session|admin|health|other),
 *   blob5  = status
 *   double1 = duration_ms, double2 = count (1), double3 = ok (1|0), double4 = err (1|0)
 */

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export interface DataPoint {
  readonly indexes?: string[];
  readonly blobs?: string[];
  readonly doubles?: number[];
}

/** Runtime shape of an `analytics_engine` binding (structurally the same as
 *  `RamoseEnv["ANALYTICS"]`; kept local so this module needs no workers-types). */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: DataPoint): void;
}

export class DatasetError extends Data.TaggedError("DatasetError")<{ readonly message: string; readonly cause?: unknown }> {}

/** Classify a thrown Analytics Engine delivery failure without depending on a binding. */
export const classifyDatasetError = (cause: unknown): DatasetError =>
  new DatasetError({ message: cause instanceof Error ? cause.message : String(cause), cause });

export interface AnalyticsClient {
  /** false when the Worker runs without an `ANALYTICS` binding (writes are dropped). */
  readonly bound: boolean;
  writeDataPoint(point: DataPoint): Effect.Effect<void, DatasetError>;
}

export class Analytics extends Context.Service<Analytics, AnalyticsClient>()("ramose/worker/Analytics") {}

/** Client over an `analytics_engine` binding; a no-op client when it is unbound. */
export const fromBinding = (binding: AnalyticsEngineDatasetLike | undefined): AnalyticsClient => ({
  bound: binding !== undefined && binding !== null,
  writeDataPoint: (point) =>
    binding
      ? Effect.try({
          try: () => binding.writeDataPoint(point),
          catch: classifyDatasetError,
        })
      : Effect.void,
});

/** The `ANALYTICS` binding, if `alchemy.run.ts` bound one (RamoseEnv gains `ANALYTICS?` separately). */
export const bindingOf = (env: unknown): AnalyticsEngineDatasetLike | undefined => {
  const b = (env as { ANALYTICS?: AnalyticsEngineDatasetLike } | undefined)?.ANALYTICS;
  return typeof b?.writeDataPoint === "function" ? b : undefined;
};

export type Route = "transact" | "op" | "query" | "pull" | "entity" | "live" | "replicate" | "info" | "session" | "admin" | "health" | "other";

/** Route label for a `/db/:name/<rest>` suffix (or a non-db path). */
export function routeOf(rest: string, method: string): Route {
  if (rest === "/transact") return "transact";
  if (rest === "/op") return "op";
  if (rest === "/query") return "query";
  if (rest === "/pull") return "pull";
  if (rest === "/live") return "live";
  if (rest === "/replicate") return "replicate";
  if (rest === "/info") return "info";
  if (rest === "/session") return "session";
  if (rest.startsWith("/admin/")) return "admin";
  if (/^\/entity\/\d+$/.test(rest) && method === "GET") return "entity";
  return "other";
}

/** One point per HTTP request (columns documented at the top of this file). */
export function httpPoint(o: { db?: string; colo?: string; route: Route; status: number; ms: number }): DataPoint {
  const db = o.db && o.db.length > 0 ? o.db : "-";
  const ok = o.status < 400;
  return {
    indexes: [db],
    blobs: ["http", db, o.colo ?? "-", o.route, String(o.status)],
    doubles: [o.ms, 1, ok ? 1 : 0, ok ? 0 : 1],
  };
}
