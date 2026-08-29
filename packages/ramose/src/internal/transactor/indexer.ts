/**
 * Alarm-driven incremental indexer (M4) running inside the Transactor DO.
 *
 * Trigger: log ≥ txThreshold transactions since the last root, or age ≥ intervalMs.
 * Each run merges a *bounded* slice of the log (≤ maxTxsPerRun txs) into new
 * segment trees with structural sharing (only touched paths are rewritten),
 * flushes that slice to `log/<t0>-<t1>` in R2, publishes `roots/<t>` then flips
 * `root/current`, notifies subscribers, prunes the SQLite log, and every N runs
 * marks-and-sweeps GC against the retained roots.
 *
 * Seam for the future: `mergeSlice` is the only CPU-heavy step; it can be
 * moved to a Workflow / Container by handing it (roots, log range) and
 * receiving new roots back — nothing else here needs to change.
 */

import { type LogEntry, type RootRecord, componentLogger, gzipCodec, txFrame } from "../core/index.ts";
import { gcSweep, publishRoot, putLogChunk, retainNewest, rootsToRecord } from "../storage/index.ts";
import {
  inertRuntimeBoundaries,
  type RuntimeBoundaries,
} from "../runtime-boundaries.ts";
import type { Transactor } from "./transactor.ts";

export interface IndexerOptions {
  intervalMs: number;
  txThreshold: number;
  maxTxsPerRun: number;
  logKeepTxs: number;
  gcEveryN: number;
  retainRoots: number;
}

export interface IndexRunResult {
  ran: boolean;
  fromT: number;
  toT: number;
  txs: number;
  datoms: number;
  ms: number;
  r2Puts: number;
  remainingTxs: number;
  root?: RootRecord;
}

export class Indexer {
  private running = false;
  private runs = 0;
  private lastRun: IndexRunResult | undefined;
  private lastGc: unknown;
  private readonly log = componentLogger("indexer");

  constructor(
    private readonly t: Transactor,
    readonly opts: IndexerOptions,
    private readonly boundaries: RuntimeBoundaries = inertRuntimeBoundaries,
  ) {}
  private get db(): string | undefined {
    try {
      return this.t.host.dbName;
    } catch {
      return undefined;
    }
  }

  status() {
    return { running: this.running, runs: this.runs, lastRun: this.lastRun, lastGc: this.lastGc, opts: this.opts };
  }

  /** Called after each commit batch: run soon if the log is large, else make sure an alarm exists. */
  async maybeSchedule(): Promise<void> {
    if (this.t.txsSinceIndex >= this.opts.txThreshold) {
      await this.t.host.setAlarm(this.t.host.now()); // as soon as possible
    } else await this.schedule();
  }

  /** Ensure a periodic alarm is set. */
  async schedule(): Promise<void> {
    const existing = await this.t.host.getAlarm();
    if (existing === null) await this.t.host.setAlarm(this.t.host.now() + this.opts.intervalMs);
  }

  async onAlarm(): Promise<void> {
    const res = await this.runOnce();
    if (res.remainingTxs > 0) await this.t.host.setAlarm(this.t.host.now() + 50);
    // else: next commit re-arms the alarm via maybeSchedule()
  }

  async runNow(): Promise<IndexRunResult> {
    return this.runOnce();
  }

  private async runOnce(): Promise<IndexRunResult> {
    const conn = this.t.connection;
    const fromT = conn.currentRoots.t;
    if (this.running) return { ran: false, fromT, toT: fromT, txs: 0, datoms: 0, ms: 0, r2Puts: 0, remainingTxs: conn.t - fromT };
    if (conn.t <= fromT) return { ran: false, fromT, toT: fromT, txs: 0, datoms: 0, ms: 0, r2Puts: 0, remainingTxs: 0 };
    this.running = true;
    const started = this.t.host.now();
    const putsBefore = this.t.nodeStore.stats.r2Puts;
    const noveltyBefore = conn.noveltyCount; // O(1) counter, read before the merge/flush
    try {
      await this.boundaries.checkpoint("indexer.run");
      // 1. Bounded slice of the log.
      const toT = Math.min(conn.t, fromT + this.opts.maxTxsPerRun);
      const entries: LogEntry[] = this.t.readLogEntries(fromT, toT);
      const datoms = entries.reduce((n, e) => n + e.datoms.length, 0);

      // 2. Flush the slice to R2 first (replicas can always catch up from log/ chunks).
      if (entries.length) await putLogChunk(this.t.bucket, entries, gzipCodec);

      // 3. Merge into new trees (structural sharing) — the movable CPU-heavy step.
      const roots = await conn.index(toT);

      // 4. Publish roots/<t> then flip root/current; then tell subscribers.
      const rec = rootsToRecord(roots, {
        log_watermark: entries.length ? entries[entries.length - 1].t : this.t.watermark,
        next_eid: conn.nextEntityId,
        codec: gzipCodec.name,
      });
      await publishRoot(this.t.bucket, rec);
      this.t.adoptRoot(rec);

      // 5. Prune the SQLite log (keep a tail for WebSocket catch-up).
      this.t.pruneLog(toT - this.opts.logKeepTxs);

      this.runs++;
      const res: IndexRunResult = {
        ran: true,
        fromT,
        toT,
        txs: entries.length,
        datoms,
        ms: this.t.host.now() - started,
        r2Puts: this.t.nodeStore.stats.r2Puts - putsBefore,
        remainingTxs: conn.t - toT,
        root: rec,
      };
      this.lastRun = res;
      // one Analytics Engine data point per indexer run (see observability.ts schema)
      this.t.metrics.index({ db: this.db ?? "unknown", indexMs: res.ms, txs: res.txs, datoms: res.datoms, noveltyDatoms: noveltyBefore });
      this.log.info("index.run", { db: this.db, fromT, toT, txs: entries.length, datoms, ms: res.ms, r2Puts: res.r2Puts, remainingTxs: res.remainingTxs, noveltyAfter: conn.noveltyCount });

      // 6. Occasionally GC.
      if (this.opts.gcEveryN > 0 && this.runs % this.opts.gcEveryN === 0) {
        try {
          this.lastGc = await this.gcNow();
        } catch (err) {
          this.lastGc = { error: String(err) };
          this.log.error("index.gc.error", { db: this.db, error: String(err) });
        }
      }
      return res;
    } catch (err) {
      this.log.error("index.error", { db: this.db, fromT, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      this.running = false;
    }
  }

  async gcNow() {
    const t0 = this.t.host.now();
    const res = await gcSweep(this.t.bucket, this.t.nodeStore, this.t.currentRootRecord.t, retainNewest(this.opts.retainRoots), { deleteRoots: true });
    this.lastGc = res;
    this.log.info("index.gc", { db: this.db, ...res, ms: this.t.host.now() - t0 });
    return res;
  }
}

export { txFrame };
