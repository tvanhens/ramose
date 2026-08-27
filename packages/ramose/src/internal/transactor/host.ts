/**
 * The runtime seam of the Transactor.
 *
 * `Transactor` (transactor.ts) contains the whole write path — validation,
 * tempid/unique resolution, monotonic `t`, group commit, novelty broadcast,
 * root ownership — and touches the outside world only through this
 * interface. The Durable Object shell (transactor-do.ts) implements it over
 * `ctx.storage.sql` / WebSockets / alarms; the Bun test + bench harness
 * implements it over `bun:sqlite` and fake sockets, so the write pipeline is
 * exercised (with fault injection) without Cloudflare.
 */

import type { R2Like } from "../storage/index.ts";
import type { AnalyticsEngineDatasetLike } from "./observability.ts";

export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
}

/** DO `SqlStorage`-shaped synchronous SQL. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

/** A novelty subscriber (WebSocket or in-process). */
export interface SocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

export interface TransactorConfig {
  /** indexer: run when this many txs accumulated since the last root */
  indexTxThreshold: number;
  /** indexer: or when the oldest un-indexed tx is this old */
  indexIntervalMs: number;
  /** indexer: bound per run (DO CPU/memory limits) */
  indexMaxTxsPerRun: number;
  /** keep this many txs in the SQLite log after indexing (WS catch-up window) */
  logKeepTxs: number;
  gcEveryNIndexes: number;
  retainRoots: number;
  /** cap on txs coalesced into one storage write (0 = unbounded) */
  maxBatch: number;
  /**
   * Diagnostics only (default false): insert `await`-fences around the resolve
   * and commit sections of the group-commit loop so a runtime whose clock only
   * advances across I/O (Cloudflare Workers) produces non-zero resolve/commit
   * timings, plus one calibration fence per batch measuring the fence's own
   * cost (`stats.fenceMs`). Off = the loop runs with no extra awaits.
   */
  timingYields: boolean;
}

export const DEFAULT_CONFIG: TransactorConfig = {
  indexTxThreshold: 500,
  indexIntervalMs: 5_000,
  indexMaxTxsPerRun: 5_000,
  logKeepTxs: 20_000,
  gcEveryNIndexes: 50,
  retainRoots: 20,
  maxBatch: 0,
  timingYields: false,
};

export interface TransactorHost {
  /** Logical database name (R2 keys live under `db/<name>/`). */
  readonly dbName: string;
  /** Durable, single-writer SQL log + metadata (DO SQLite). */
  readonly sql: SqlLike;
  /** Run `fn` atomically against `sql` (all-or-nothing). */
  transactionSync<T>(fn: () => T): T;
  /** Segment / log / root object store. */
  readonly bucket: R2Like;
  /** Currently connected novelty subscribers. */
  sockets(): SocketLike[];
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  /**
   * Fatal: in-memory and durable state may have diverged (e.g. the log write
   * failed after `t` was assigned). The host must discard this instance so
   * the next request boots a fresh one from durable state.
   */
  abort(reason: string): void;
  now(): number;
  readonly config: TransactorConfig;
  /**
   * Optional Analytics Engine dataset for write-path metrics (one data point
   * per commit batch / indexer run). Absent = metrics disabled (no-op sink).
   */
  readonly analytics?: AnalyticsEngineDatasetLike;
}
