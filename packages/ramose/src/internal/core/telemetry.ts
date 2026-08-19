/**
 * Structured logs / metrics for every Ramose component.
 *
 * One JSON object per line on the default sink (`console.log`), which is what
 * Workers/DO observability ingests, so `wrangler tail`, Logpush or the local
 * `alchemy dev` console all show queryable events. Nothing here is a
 * dashboard: it is the minimum needed to see tx/s, batch sizes, index run
 * durations, novelty sizes and query aborts.
 *
 *   { ts, level, component, event, db?, ...fields }
 *
 * `setTelemetrySink` swaps the sink (tests capture events; a Worker can fan
 * out to Analytics Engine); `setTelemetryLevel` filters. Both are process-wide
 * by design — one isolate, one stream.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Component = "transactor" | "indexer" | "replica" | "peer" | "core";

export interface TelemetryEvent {
  ts: number;
  level: LogLevel;
  component: Component;
  event: string;
  db?: string;
  [field: string]: unknown;
}

export type TelemetrySink = (e: TelemetryEvent) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let sink: TelemetrySink = (e) => console.log(JSON.stringify(e));
let minLevel: LogLevel = "info";
let now: () => number = () => Date.now();

export function setTelemetrySink(s: TelemetrySink | undefined): void {
  sink = s ?? ((e) => console.log(JSON.stringify(e)));
}
export function setTelemetryLevel(level: LogLevel): void {
  minLevel = level;
}
export function setTelemetryClock(clock: () => number): void {
  now = clock;
}
export function telemetryLevel(): LogLevel {
  return minLevel;
}

/** Emit one event (dropped if below the configured level). */
export function logEvent(component: Component, event: string, fields: Record<string, unknown> = {}, level: LogLevel = "info"): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  try {
    sink({ ts: now(), level, component, event, ...fields });
  } catch {
    // telemetry must never take the data path down
  }
}

/** Convenience: a component-bound logger with an optional fixed `db` field. */
export function componentLogger(component: Component, base: Record<string, unknown> | (() => Record<string, unknown>) = {}) {
  const b = () => (typeof base === "function" ? base() : base);
  return {
    debug: (event: string, fields: Record<string, unknown> = {}) => logEvent(component, event, { ...b(), ...fields }, "debug"),
    info: (event: string, fields: Record<string, unknown> = {}) => logEvent(component, event, { ...b(), ...fields }, "info"),
    warn: (event: string, fields: Record<string, unknown> = {}) => logEvent(component, event, { ...b(), ...fields }, "warn"),
    error: (event: string, fields: Record<string, unknown> = {}) => logEvent(component, event, { ...b(), ...fields }, "error"),
  };
}
export type Logger = ReturnType<typeof componentLogger>;

/**
 * Small fixed-bucket histogram for latencies / batch sizes: cheap to update,
 * summarised into p50/p95/p99/max for `/info` snapshots.
 */
export class Histogram {
  private readonly buckets: number[];
  private readonly counts: number[];
  count = 0;
  sum = 0;
  max = 0;
  constructor(buckets: number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length + 1).fill(0);
  }
  observe(x: number): void {
    this.count++;
    this.sum += x;
    if (x > this.max) this.max = x;
    let i = 0;
    while (i < this.buckets.length && x > this.buckets[i]) i++;
    this.counts[i]++;
  }
  /** Upper bound of the bucket holding the p-th percentile (Infinity for the overflow bucket). */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= target) return i < this.buckets.length ? this.buckets[i] : Infinity;
    }
    return Infinity;
  }
  snapshot() {
    return { count: this.count, mean: this.count ? this.sum / this.count : 0, p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99), max: this.max };
  }
}

/** Events-per-second meter over a sliding window (for tx/s, queries/s in /info). */
export class RateMeter {
  private readonly at: number[] = [];
  private readonly n: number[] = [];
  private head = 0;
  total = 0;
  constructor(readonly windowMs = 10_000) {}
  private prune(t: number): void {
    while (this.head < this.at.length && this.at[this.head] < t - this.windowMs) this.head++;
    if (this.head > 1024 && this.head > this.at.length / 2) {
      this.at.splice(0, this.head);
      this.n.splice(0, this.head);
      this.head = 0;
    }
  }
  mark(n = 1, at: number = now()): void {
    this.at.push(at);
    this.n.push(n);
    this.total += n;
    this.prune(at);
  }
  /** events per second over the window ending at `at` */
  rate(at: number = now()): number {
    this.prune(at);
    let sum = 0;
    for (let i = this.head; i < this.n.length; i++) sum += this.n[i];
    return (sum / this.windowMs) * 1000;
  }
}
