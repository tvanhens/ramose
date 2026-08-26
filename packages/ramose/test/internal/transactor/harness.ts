/**
 * Transactor unit harness: `bun:sqlite` stands in for DO SQLite, an
 * in-memory map for R2, plain objects for WebSockets.
 *
 * Kept for storage-failure injection, rollback, and restart simulation —
 * workerd cannot schedule those deterministically. Public commit behavior
 * runs against the Alchemy local stack.
 */
import { Database } from "bun:sqlite";
import { type R2Like, dbPrefix, prefixedBucket } from "../../../src/internal/storage/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";
export { MemoryBucket };
import { type CompiledPolicy, type TelemetryEvent, setTelemetryLevel, setTelemetrySink } from "../../../src/internal/core/index.ts";
import { type AnalyticsEngineDatasetLike, DEFAULT_CONFIG, type SocketLike, type SqlLike, type TransactorConfig, type TransactorHost, Transactor } from "../../../src/internal/transactor/index.ts";

/** Captured structured events (all levels) instead of console noise. */
export const events: TelemetryEvent[] = [];
/** Re-armed per Harness: telemetry is process-wide, and another test file may have reset it. */
export function captureTelemetry(): void {
  setTelemetrySink((e) => {
    events.push(e);
    if (events.length > 50_000) events.splice(0, 25_000);
  });
  setTelemetryLevel("debug");
}
captureTelemetry();
export const eventsOf = (event: string) => events.filter((e) => e.event === event);

/** Fake subscriber socket collecting frames. */
export class FakeSocket implements SocketLike {
  readonly frames: any[] = [];
  closed = false;
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.frames.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  ofKind(kind: string) {
    return this.frames.filter((f) => f.kind === kind);
  }
}

/** bun:sqlite as DO-style SqlLike. */
export function sqliteLike(db: Database): SqlLike {
  const cache = new Map<string, ReturnType<Database["query"]>>();
  return {
    exec(query: string, ...bindings: unknown[]) {
      let stmt = cache.get(query);
      if (!stmt) cache.set(query, (stmt = db.query(query)));
      // DO SqlStorage accepts ArrayBuffer blobs; bun:sqlite wants TypedArrays
      const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
      const rows = stmt.all(...(args as any[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

export interface HarnessOptions {
  /** logical database name */
  dbName?: string;
  /** sqlite file path (default: in-memory) */
  file?: string;
  config?: Partial<TransactorConfig>;
  /** fault injection: throw inside the N-th (1-based) transactionSync */
  failWriteAt?: number;
  now?: () => number;
  /** fake Analytics Engine dataset (see FakeAnalytics) */
  analytics?: AnalyticsEngineDatasetLike;
  /** deployed policy: the commit loop then checks every non-admin tx */
  policy?: CompiledPolicy;
}

/** Collects Analytics Engine data points; `fail` makes writeDataPoint throw. */
export class FakeAnalytics implements AnalyticsEngineDatasetLike {
  readonly points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  constructor(public fail = false) {}
  writeDataPoint(dp: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void {
    if (this.fail) throw new Error("analytics unavailable");
    this.points.push(dp);
  }
  ofStage(stage: string) {
    return this.points.filter((p) => p.blobs?.[0] === stage);
  }
}

export class Harness implements TransactorHost {
  readonly dbName: string;
  readonly db: Database;
  readonly sql: SqlLike;
  /** the shared bucket (all databases) */
  readonly raw: MemoryBucket;
  /** this database's view of it (db/<name>/…), as the DO shell hands it to the Transactor */
  readonly bucket: R2Like;
  readonly config: TransactorConfig;
  readonly analytics?: AnalyticsEngineDatasetLike;
  readonly policy?: CompiledPolicy;
  readonly subscribers = new Set<FakeSocket>();
  alarm: number | null = null;
  aborted: string | undefined;
  writes = 0;
  private failAt: number | undefined;
  private clock: () => number;
  transactor: Transactor;

  constructor(opts: HarnessOptions = {}, bucket?: MemoryBucket) {
    captureTelemetry();
    this.dbName = opts.dbName ?? "test";
    this.db = new Database(opts.file ?? ":memory:");
    // file-backed: WAL + fsync on every commit (so group commit pays for real durability)
    this.db.exec(opts.file ? "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;" : "PRAGMA synchronous = OFF;");
    this.sql = sqliteLike(this.db);
    this.raw = bucket ?? new MemoryBucket();
    this.bucket = prefixedBucket(this.raw, dbPrefix(this.dbName));
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    if (opts.analytics !== undefined) this.analytics = opts.analytics;
    if (opts.policy !== undefined) this.policy = opts.policy;
    this.failAt = opts.failWriteAt;
    this.clock = opts.now ?? (() => Date.now());
    this.transactor = new Transactor(this);
  }

  transactionSync<T>(fn: () => T): T {
    this.writes++;
    if (this.failAt !== undefined && this.writes === this.failAt) {
      // simulate a storage failure *before* anything lands (all-or-nothing)
      throw new Error("injected storage failure");
    }
    return this.db.transaction(fn)();
  }
  sockets(): SocketLike[] {
    return [...this.subscribers];
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
  abort(reason: string) {
    this.aborted = reason;
  }
  now() {
    return this.clock();
  }

  /** Subscribe a fake socket (hello + catch-up from `from`). */
  subscribe(from = 0): FakeSocket {
    const s = new FakeSocket();
    this.subscribers.add(s);
    this.transactor.onSubscribe(s, from);
    return s;
  }

  /** Simulate the DO being evicted/restarted: a fresh Transactor over the same durable state. */
  restart(opts: Omit<HarnessOptions, "file"> = {}): Harness {
    const h = new Harness({ ...opts, dbName: this.dbName, config: opts.config ?? this.config }, this.raw);
    // share the SQLite database (same durable state) — reuse the same handle
    (h as any).db = this.db;
    (h as any).sql = this.sql;
    (h as any).transactor = new Transactor(h);
    return h;
  }

  /** Fire the pending alarm, if any. */
  async fireAlarm(): Promise<boolean> {
    if (this.alarm === null) return false;
    this.alarm = null;
    await this.transactor.onAlarm();
    return true;
  }

  /** All log ts in order. */
  logTs(): number[] {
    return this.sql.exec(`SELECT t FROM log ORDER BY t`).toArray().map((r) => r.t as number);
  }
}

export const attribute = (ident: string, type: string, extra: Record<string, unknown> = {}) => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ...(extra[":db/cardinality"] === ":db.cardinality/many" ? {} : { ":db/optional": true }),
  ...extra,
});
