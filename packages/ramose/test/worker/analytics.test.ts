/**
 * Analytics Engine service (src/analytics.ts): the per-request http point's
 * column layout, the route labels, and the Effect client over a fake
 * `env.ANALYTICS` binding — including the unbound case, which must stay a
 * silent no-op so tests / miniflare / `bun alchemy dev` run without the
 * binding, and the throwing case, which must surface as a `DatasetError`
 * failure rather than a rejected request.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Analytics, type AnalyticsEngineDatasetLike, type DataPoint, bindingOf, fromBinding, httpPoint, routeOf } from "../../src/worker/analytics.ts";

function fakeDataset(onWrite?: () => void) {
  const points: DataPoint[] = [];
  const dataset: AnalyticsEngineDatasetLike = {
    writeDataPoint(p) {
      onWrite?.();
      points.push(p);
    },
  };
  return { dataset, points };
}

describe("http data point", () => {
  test("columns: index=db, blobs=[http, db, colo, route, status], doubles=[ms, 1, ok, err]", () => {
    expect(httpPoint({ db: "demo", colo: "IAD", route: "query", status: 200, ms: 7 })).toEqual({
      indexes: ["demo"],
      blobs: ["http", "demo", "IAD", "query", "200"],
      doubles: [7, 1, 1, 0],
    });
  });

  test("missing db/colo fall back to '-'; >=400 counts as err", () => {
    expect(httpPoint({ route: "other", status: 404, ms: 1 })).toEqual({
      indexes: ["-"],
      blobs: ["http", "-", "-", "other", "404"],
      doubles: [1, 1, 0, 1],
    });
    expect(httpPoint({ db: "demo", colo: "SJC", route: "transact", status: 500, ms: 12 }).doubles).toEqual([12, 1, 0, 1]);
    expect(httpPoint({ db: "demo", colo: "SJC", route: "query", status: 413, ms: 3 }).doubles).toEqual([3, 1, 0, 1]);
  });

  test("route labels", () => {
    expect(routeOf("/transact", "POST")).toBe("transact");
    expect(routeOf("/query", "POST")).toBe("query");
    expect(routeOf("/pull", "POST")).toBe("pull");
    expect(routeOf("/info", "GET")).toBe("info");
    expect(routeOf("/admin/index", "POST")).toBe("admin");
    expect(routeOf("/admin/replica/reconnect", "POST")).toBe("admin");
    expect(routeOf("/entity/42", "GET")).toBe("entity");
    expect(routeOf("/entity/42", "POST")).toBe("other");
    expect(routeOf("/", "GET")).toBe("other");
  });
});

describe("Analytics service", () => {
  test("writes through the binding when bound", async () => {
    const { dataset, points } = fakeDataset();
    const client = fromBinding(dataset);
    expect(client.bound).toBe(true);
    await Effect.runPromise(client.writeDataPoint(httpPoint({ db: "demo", colo: "IAD", route: "info", status: 200, ms: 2 })));
    expect(points.length).toBe(1);
    expect(points[0].blobs).toEqual(["http", "demo", "IAD", "info", "200"]);
  });

  test("unbound: no-op, succeeds", async () => {
    const client = fromBinding(undefined);
    expect(client.bound).toBe(false);
    expect(await Effect.runPromise(client.writeDataPoint({ blobs: ["http"] }))).toBeUndefined();
  });

  test("a throwing binding fails with DatasetError (never escapes as a defect)", async () => {
    const { dataset } = fakeDataset(() => {
      throw new Error("AE quota");
    });
    const exit = await Effect.runPromiseExit(fromBinding(dataset).writeDataPoint({ blobs: ["http"] }));
    expect(exit._tag).toBe("Failure");
    const err = await Effect.runPromise(Effect.flip(fromBinding(dataset).writeDataPoint({ blobs: ["http"] })));
    expect(err._tag).toBe("DatasetError");
    expect(err.message).toBe("AE quota");
  });

  test("provided as a service and yielded by a program (as the Worker does)", async () => {
    const { dataset, points } = fakeDataset();
    const program = Effect.gen(function* () {
      const ae = yield* Analytics;
      if (!ae.bound) return 0;
      yield* ae.writeDataPoint(httpPoint({ db: "demo", route: "health", status: 200, ms: 0 }));
      return 1;
    });
    expect(await Effect.runPromise(program.pipe(Effect.provideService(Analytics, fromBinding(dataset))))).toBe(1);
    expect(await Effect.runPromise(program.pipe(Effect.provideService(Analytics, fromBinding(undefined))))).toBe(0);
    expect(points.length).toBe(1);
  });

  test("bindingOf reads env.ANALYTICS only when it looks like a dataset", () => {
    const { dataset } = fakeDataset();
    expect(bindingOf({ ANALYTICS: dataset })).toBe(dataset);
    expect(bindingOf({})).toBeUndefined();
    expect(bindingOf(undefined)).toBeUndefined();
    expect(bindingOf({ ANALYTICS: {} })).toBeUndefined();
  });
});
