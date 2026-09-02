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
  private armedAt: number | null | undefined;
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

  async maybeSchedule(): Promise<void> {
    if (this.t.txsSinceIndex >= this.opts.txThreshold) {
      const now = this.t.host.now();
      if (this.armedAt === undefined || this.armedAt === null || this.armedAt > now) await this.arm(now);
    } else await this.schedule();
  }

  async schedule(): Promise<void> {
    if (this.armedAt === undefined) this.armedAt = await this.t.host.getAlarm();
    if (this.armedAt === null) await this.arm(this.t.host.now() + this.opts.intervalMs);
  }

  private async arm(time: number): Promise<void> {
    await this.t.host.setAlarm(time);
    this.armedAt = time;
  }

  async onAlarm(): Promise<void> {
    this.armedAt = null;
    const res = await this.runOnce();
    if (res.remainingTxs > 0) await this.arm(this.t.host.now() + 50);
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
    const noveltyBefore = conn.noveltyCount;
    try {
      await this.boundaries.checkpoint("indexer.run");
      const toT = Math.min(conn.t, fromT + this.opts.maxTxsPerRun);
      const entries: LogEntry[] = this.t.readLogEntries(fromT, toT);
      const datoms = entries.reduce((n, e) => n + e.datoms.length, 0);

      if (entries.length) await putLogChunk(this.t.bucket, entries, gzipCodec);

      const roots = await conn.index(toT);

      const rec = rootsToRecord(roots, {
        log_watermark: entries.length ? entries[entries.length - 1].t : this.t.watermark,
        next_eid: conn.nextEntityId,
        codec: gzipCodec.name,
      });
      await publishRoot(this.t.bucket, rec);
      this.t.adoptRoot(rec);

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
      this.t.metrics.index({ db: this.db ?? "unknown", indexMs: res.ms, txs: res.txs, datoms: res.datoms, noveltyDatoms: noveltyBefore });
      this.log.info("index.run", { db: this.db, fromT, toT, txs: entries.length, datoms, ms: res.ms, r2Puts: res.r2Puts, remainingTxs: res.remainingTxs, noveltyAfter: conn.noveltyCount });

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
