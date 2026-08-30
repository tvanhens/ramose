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
  writes = 0;
  errors = 0;
  colo: string = UNKNOWN_COLO;

  constructor(private readonly dataset?: AnalyticsEngineDatasetLike) {}

  get enabled(): boolean {
    return this.dataset !== undefined;
  }

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
      this.errors++;
    }
  }
}
