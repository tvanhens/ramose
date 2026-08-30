import { describe, expect, test } from "bun:test";
import { Store, sameResult } from "../../src/client/subscription.ts";
import { aggregateSyncStatus, syncState } from "../../src/client/sync.ts";

describe("Store", () => {
  test("notifies only when the published identity changed", () => {
    const value = { rows: [1] };
    const store = new Store<{ rows: number[] }>(value);
    let notified = 0;
    const stop = store.subscribe(() => {
      notified++;
    });

    expect(store.publish(value)).toBe(false);
    expect(notified).toBe(0);

    const next = { rows: [1] };
    expect(store.publish(next)).toBe(true);
    expect(notified).toBe(1);
    expect(store.getSnapshot()).toBe(next);

    stop();
    stop();
    store.publish({ rows: [2] });
    expect(notified).toBe(1);
  });

  test("exposes bound subscribe/getSnapshot and survives a throwing listener", () => {
    const store = new Store(0);
    const { subscribe, getSnapshot } = store.subscription;
    let seen = 0;
    subscribe(() => {
      throw new Error("render failed");
    });
    subscribe(() => {
      seen++;
    });

    store.publish(1);
    expect(seen).toBe(1);
    expect(getSnapshot()).toBe(1);
    expect(store.size).toBe(2);
  });
});

describe("sameResult", () => {
  test("compares everything a query can return", () => {
    expect(sameResult([{ id: 1, title: "a" }], [{ id: 1, title: "a" }])).toBe(true);
    expect(sameResult([{ id: 1, title: "a" }], [{ id: 1, title: "b" }])).toBe(false);
    expect(sameResult({ a: undefined }, {})).toBe(false);
    expect(sameResult([1, 2], [1, 2, 3])).toBe(false);
    expect(sameResult(new Date(5), new Date(5))).toBe(true);
    expect(sameResult(new Date(5), new Date(6))).toBe(false);
    expect(sameResult(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameResult(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameResult(new Uint8Array([1]), [1])).toBe(false);
    expect(sameResult(null, undefined)).toBe(false);
    expect(sameResult(Number.NaN, Number.NaN)).toBe(true);
    expect(sameResult({ nested: [{ x: null }] }, { nested: [{ x: null }] })).toBe(true);
  });
});

describe("sync state", () => {
  test("is one frozen singleton per status", () => {
    expect(syncState("live")).toBe(syncState("live"));
    expect(Object.isFrozen(syncState("live"))).toBe(true);
    expect(syncState("live")).not.toBe(syncState("stale"));
  });

  test("aggregates a client to its least synchronized database", () => {
    expect(aggregateSyncStatus([])).toBe("idle");
    expect(aggregateSyncStatus(["idle"])).toBe("idle");
    expect(aggregateSyncStatus(["live", "live"])).toBe("live");
    expect(aggregateSyncStatus(["live", "stale"])).toBe("stale");
    expect(aggregateSyncStatus(["stale", "connecting"])).toBe("connecting");
    expect(aggregateSyncStatus(["live", "offline"])).toBe("offline");
    expect(aggregateSyncStatus(["offline", "update-required"])).toBe("update-required");
    expect(aggregateSyncStatus(["update-required", "authentication-required"]))
      .toBe("update-required");

    expect(aggregateSyncStatus(["closed", "live"])).toBe("closed");
    expect(aggregateSyncStatus(["closed", "update-required"])).toBe("closed");
  });
});
