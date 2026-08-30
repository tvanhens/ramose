import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export interface DataPoint {
  readonly indexes?: string[];
  readonly blobs?: string[];
  readonly doubles?: number[];
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: DataPoint): void;
}

export class DatasetError extends Data.TaggedError("DatasetError")<{ readonly message: string; readonly cause?: unknown }> {}

export const classifyDatasetError = (cause: unknown): DatasetError =>
  new DatasetError({ message: cause instanceof Error ? cause.message : String(cause), cause });

export interface AnalyticsClient {
  readonly bound: boolean;
  writeDataPoint(point: DataPoint): Effect.Effect<void, DatasetError>;
}

export class Analytics extends Context.Service<Analytics, AnalyticsClient>()("ramose/worker/Analytics") {}

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

export const bindingOf = (env: unknown): AnalyticsEngineDatasetLike | undefined => {
  const b = (env as { ANALYTICS?: AnalyticsEngineDatasetLike } | undefined)?.ANALYTICS;
  return typeof b?.writeDataPoint === "function" ? b : undefined;
};

export type Route = "transact" | "op" | "query" | "pull" | "entity" | "live" | "replicate" | "info" | "session" | "admin" | "health" | "other";

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

export function httpPoint(o: { db?: string; colo?: string; route: Route; status: number; ms: number }): DataPoint {
  const db = o.db && o.db.length > 0 ? o.db : "-";
  const ok = o.status < 400;
  return {
    indexes: [db],
    blobs: ["http", db, o.colo ?? "-", o.route, String(o.status)],
    doubles: [o.ms, 1, ok ? 1 : 0, ok ? 0 : 1],
  };
}
