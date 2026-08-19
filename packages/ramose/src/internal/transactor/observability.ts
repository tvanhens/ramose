/**
 * Write-path observability sink (Cloudflare Analytics Engine).
 *
 * Deliberately *not* an Effect: this is called from inside the group-commit
 * loop, once per batch, and must add O(1) work that can never fail a
 * transaction. `writeDataPoint` is fire-and-forget and wrapped in try/catch;
 * when no dataset is bound (Bun harness, local dev) every method is a no-op.
 *
 * ---------------------------------------------------------------------------
 * DATA POINT SCHEMA (one point per commit batch, one per indexer run)
 * ---------------------------------------------------------------------------
 *   indexes[0] = db          (sampling key — Analytics Engine allows exactly one)
 *   blob1      = stage       "batch" | "index"
 *   blob2      = db
 *   blob3      = colo        (from request.cf.colo when the DO has seen one, else "unknown")
 *
 *   stage = "batch":
 *     double1 = resolve_ms     ms resolving the whole batch (validate/tempids/uniques)
 *     double2 = commit_ms      ms inside the single storage write (group commit)
 *     double3 = batch_size     txs that committed in this batch
 *     double4 = queue_depth    pending txs when the batch was dequeued (incl. this batch)
 *     double5 = novelty_datoms un-indexed datoms held in memory after the commit
 *     double6 = tx_ok          txs acked
 *     double7 = tx_err         txs rejected while resolving this batch
 *     double8 = fence_ms       cost of one event-loop fence, measured once for this batch
 *                              (config.timingYields; 0 when off). With fences on, double1/2
 *                              are clock advance across a fence, so subtract this as the bias.
 *
 *   stage = "index" (same columns, indexer semantics):
 *     double1 = index_ms       wall time of the indexer run
 *     double2 = 0
 *     double3 = txs            log txs merged into the new root
 *     double4 = 0
 *     double5 = novelty_datoms novelty held *before* the merge/flush
 *     double6 = datoms         datoms merged
 *     double7 = 0
 *     (no double8 — index runs are not fenced)
 *
 * `loopMs` (dequeue → ack) is not a column: it is exposed in /info so
 * "other" = loopMs − resolve_ms − commit_ms can be computed per batch.
 */

/**
 * Minimal structural view of a Cloudflare Analytics Engine binding, so this
 * package does not need @cloudflare/workers-types at runtime. The real
 * `AnalyticsEngineDataset` is assignable to this.
 */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(dataPoint: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface BatchPoint {
  db: string;
  resolveMs: number;
  commitMs: number;
  batchSize: number;
  queueDepth: number;
  noveltyDatoms: number;
  txOk: number;
  txErr: number;
  /** cost of one event-loop fence for this batch (0 unless config.timingYields) */
  fenceMs?: number;
}

export interface IndexPoint {
  db: string;
  indexMs: number;
  txs: number;
  datoms: number;
  noveltyDatoms: number;
}

const UNKNOWN_COLO = "unknown";

export class TxMetrics {
  /** data points accepted by the binding */
  writes = 0;
  /** data points that threw (observability must never fail a tx) */
  errors = 0;
  /** best-effort colo, learned from any inbound Request the DO has seen */
  colo: string = UNKNOWN_COLO;

  constructor(private readonly dataset?: AnalyticsEngineDatasetLike) {}

  get enabled(): boolean {
    return this.dataset !== undefined;
  }

  /** Cheap: remember `request.cf.colo` when the DO is handed a Request. */
  observeColo(colo: string | undefined | null): void {
    if (colo && colo !== this.colo) this.colo = colo;
  }

  batch(p: BatchPoint): void {
    this.write("batch", p.db, [p.resolveMs, p.commitMs, p.batchSize, p.queueDepth, p.noveltyDatoms, p.txOk, p.txErr, p.fenceMs ?? 0]);
  }

  index(p: IndexPoint): void {
    this.write("index", p.db, [p.indexMs, 0, p.txs, 0, p.noveltyDatoms, p.datoms, 0]);
  }

  snapshot() {
    return { enabled: this.enabled, colo: this.colo, aeWrites: this.writes, aeErrors: this.errors };
  }

  private write(stage: string, db: string, doubles: number[]): void {
    const ds = this.dataset;
    if (!ds) return;
    try {
      ds.writeDataPoint({ indexes: [db], blobs: [stage, db, this.colo], doubles });
      this.writes++;
    } catch {
      // never let telemetry fail a transaction
      this.errors++;
    }
  }
}
