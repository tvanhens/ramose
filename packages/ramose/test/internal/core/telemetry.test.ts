import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Histogram, RateMeter, type TelemetryEvent, componentLogger, logEvent, setTelemetryClock, setTelemetryLevel, setTelemetrySink } from "../../../src/internal/core/telemetry.ts";

const resetTelemetry = () => {
  setTelemetrySink(undefined);
  setTelemetryLevel("info");
  setTelemetryClock(() => Date.now());
};
beforeEach(resetTelemetry);
afterEach(resetTelemetry);

describe("telemetry", () => {
  test("events are structured, level-filtered, and never throw", () => {
    const got: TelemetryEvent[] = [];
    setTelemetrySink((e) => got.push(e));
    setTelemetryClock(() => 123);
    const log = componentLogger("transactor", { db: "x" });
    log.debug("tx.commit", { batch: 3 }); // below default level
    log.info("boot", { t: 1 });
    log.warn("tx.rejected", { code: "tx/invalid" });
    expect(got).toEqual([
      { ts: 123, level: "info", component: "transactor", event: "boot", db: "x", t: 1 },
      { ts: 123, level: "warn", component: "transactor", event: "tx.rejected", db: "x", code: "tx/invalid" },
    ]);
    setTelemetryLevel("debug");
    log.debug("tx.commit", { batch: 3 });
    expect(got.at(-1)!.event).toBe("tx.commit");
    // a throwing sink does not propagate
    setTelemetrySink(() => {
      throw new Error("sink down");
    });
    expect(() => logEvent("peer", "query", { ms: 1 })).not.toThrow();
  });

  test("histogram percentiles and rate meter", () => {
    const h = new Histogram([1, 10, 100]);
    for (const x of [0.5, 0.5, 5, 50, 500]) h.observe(x);
    const s = h.snapshot();
    expect(s.count).toBe(5);
    expect(s.p50).toBe(10);
    expect(s.p99).toBe(Infinity);
    expect(s.max).toBe(500);
    const r = new RateMeter(1000);
    for (let t = 0; t < 1000; t += 100) r.mark(10, t);
    expect(r.rate(999)).toBeCloseTo(100, 0);
    expect(r.rate(1900)).toBeCloseTo(10, 0); // only the mark at t=900 remains in the window
    expect(r.rate(5000)).toBe(0);
    expect(r.total).toBe(100);
  });
});
