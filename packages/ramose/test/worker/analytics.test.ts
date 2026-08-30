import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { bindingOf, classifyDatasetError, fromBinding, httpPoint, routeOf } from "../../src/worker/analytics.ts";

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
    expect(routeOf("/op", "POST")).toBe("op");
    expect(routeOf("/query", "POST")).toBe("query");
    expect(routeOf("/pull", "POST")).toBe("pull");
    expect(routeOf("/live", "POST")).toBe("live");
    expect(routeOf("/info", "GET")).toBe("info");
    expect(routeOf("/admin/index", "POST")).toBe("admin");
    expect(routeOf("/admin/replica/reconnect", "POST")).toBe("admin");
    expect(routeOf("/entity/42", "GET")).toBe("entity");
    expect(routeOf("/entity/42", "POST")).toBe("other");
    expect(routeOf("/", "GET")).toBe("other");
  });
});

describe("Analytics decisions", () => {
  test("unbound: no-op, succeeds", async () => {
    const client = fromBinding(undefined);
    expect(client.bound).toBe(false);
    expect(await Effect.runPromise(client.writeDataPoint({ blobs: ["http"] }))).toBeUndefined();
  });

  test("delivery failures are classified as DatasetError values", () => {
    const cause = new Error("AE quota");
    const err = classifyDatasetError(cause);
    expect(err._tag).toBe("DatasetError");
    expect(err.message).toBe("AE quota");
    expect(err.cause).toBe(cause);
    expect(classifyDatasetError("dataset unavailable").message).toBe("dataset unavailable");
  });

  test("bindingOf reads env.ANALYTICS only when it looks like a dataset", () => {
    const bindingCandidate = { writeDataPoint: Array.prototype.push };
    expect(bindingOf({ ANALYTICS: bindingCandidate })).toBe(bindingCandidate);
    expect(bindingOf({})).toBeUndefined();
    expect(bindingOf(undefined)).toBeUndefined();
    expect(bindingOf({ ANALYTICS: {} })).toBeUndefined();
  });
});
