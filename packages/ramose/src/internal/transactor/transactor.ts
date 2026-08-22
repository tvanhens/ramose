/**
 * Transactor — the single writer of one logical Ramose database.
 *
 * Runtime-agnostic (see host.ts): the Durable Object shell and the Bun test
 * harness both drive this class.
 *
 *   validate against schema → resolve tempids / uniques (reads via its own
 *   segment source + own novelty) → assign monotonic `t` → GROUP COMMIT to
 *   the SQL log → ack → broadcast novelty frames → (alarm) incremental index.
 *
 * Group commit: every transaction that arrives while a storage write is in
 * flight (or while the current batch is being resolved) is coalesced into the
 * next single SQL write. `t` is assigned in arrival order and persisted in
 * the same order, so the durable log never has gaps or duplicates: a batch
 * either lands entirely or not at all, and if it does not land the instance
 * is aborted and rebuilt from durable state (in-memory `t` is discarded).
 *
 * HTTP surface (the DO shell forwards `fetch` here; `/subscribe` upgrades are
 * done by the shell, which then calls `onSubscribe`):
 *   POST /transact   { tx: TxData, clientTxId? }   → { t, txEid, tempids, datoms: WireDatom[], clientTxId? }
 *   POST /provision  { principal }                 → { eid, class }  (peer-owned upsert)
 *   GET  /info                        → { t, root, novelty, logWatermark, ... }
 *   GET  /log?from=&to=               → { entries: NoveltyFrameV1[] }
 *   POST /admin/index                 → run the indexer now
 *   POST /admin/gc                    → run GC now
 */

import {
  Connection,
  type Datom,
  type LogEntry,
  type NoveltyFrameV1,
  type RootRecord,
  type Roots,
  type TxData,
  bootstrapDatoms,
  decodeLogChunk,
  emptyRoots,
  encodeLogChunk,
  fromJson,
  gzipCodec,
  toJson,
  txFrame,
  FIRST_USER_EID,
  Histogram,
  type Logger,
  type Principal,
  type WireDatom,
  RateMeter,
  TxError,
  checkTx,
  componentLogger,
  filterDb,
  isAdmin,
  provisionTx,
  resolveProvisionedEid,
  shouldProvision,
  toWireDatom,
} from "../core/index.ts";
import { FilteredDb } from "../core/policy/filter.ts";
import { R2NodeStore, readCurrentRoot, recordToRoots, rootsToRecord } from "../storage/index.ts";
import * as Effect from "effect/Effect";
import { BadRequest, NotFound, TransactorDeadError, TxRejected, errorResponse, toHttpError } from "./errors.ts";
import { type SocketLike, type TransactorHost } from "./host.ts";
import { asPrincipal } from "./policy.ts";
import { Indexer } from "./indexer.ts";
import { TxMetrics } from "./observability.ts";

export { TransactorDeadError };

export interface TxAck {
  t: number;
  txEid: number;
  tempids: Record<string, number>;
  /** facts that landed, already filtered for this principal */
  datoms: WireDatom[];
  clientTxId?: string;
  /** Encoded operation output; present when this ack is an operation replay. */
  output?: unknown;
}

export interface TransactorStats {
  txs: number;
  batches: number;
  maxBatch: number;
  rejected: number;
  indexRuns: number;
  broadcasts: number;
  /** ms spent inside the storage write (group commit) */
  commitMs: number;
  /** ms spent resolving txs in memory (validate/tempids/uniques) */
  resolveMs: number;
  /** ms of wall clock per batch from dequeue to ack ("other" = loopMs - resolveMs - commitMs) */
  loopMs: number;
  /**
   * ms measured by the per-batch calibration fence (config.timingYields only;
   * 0 when off). Each timed section is closed by one such fence, so the fence's
   * own latency is the bias of resolveMs/commitMs: corrected ≈ x - fenceMs/batches.
   */
  fenceMs: number;
}

interface Pending {
  tx: TxData;
  /** verified by the Worker; trusted metadata (the DO is only reachable behind the internal secret) */
  principal?: Principal;
  /** opaque client id; a replay of a recent id returns the original ack */
  clientTxId?: string;
  /** Encoded operation output to persist with the ack (effects must not re-run). */
  opOutput?: unknown;
  /**
   * Peer-owned write (principal provisioning). Skips `checkTx` and the
   * pre-write provision hook — the ops *are* the provision.
   */
  system?: boolean;
  resolve: (r: TxAck) => void;
  reject: (e: unknown) => void;
}

interface StoredOpAck {
  readonly k: string;
  readonly ack: TxAck;
}

/** How many recent `clientTxId`s this instance remembers. FIFO once full. */
const RECENT_CLIENT_TX_LIMIT = 256;

/** Replay keys are per writer: a foreign principal must not see someone else's filtered ack. */
export function clientTxReplayKey(principal: Principal | undefined, id: string): string {
  if (!principal) return `\0:${id}`;
  const who = principal.sub ?? (principal.eid !== undefined ? `#${principal.eid}` : principal.class);
  return `${principal.db}\0${principal.kind}\0${who}\0${id}`;
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const round = (x: number) => Math.round(x * 100) / 100;
const safeName = (host: TransactorHost): string | undefined => {
  try {
    return host.dbName;
  } catch {
    return undefined;
  }
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), { status, headers: { "content-type": "application/json", ...headers } });

export class Transactor {
  private ready: Promise<void> | undefined;
  private conn!: Connection;
  private store!: R2NodeStore;
  private rootRecord!: RootRecord;
  private logWatermark = 0;
  private queue: Pending[] = [];
  private committing = false;
  private indexer!: Indexer;
  private txSinceIndex = 0;
  private dead: string | undefined;
  /** recent `clientTxReplayKey(principal, clientTxId)` → original ack; replay must not assign a second `t` */
  private readonly recentAcks = new Map<string, TxAck>();
  /** persisted operation acks (includes `output`); loaded from `meta.op_acks` */
  private readonly recentOpAcks = new Map<string, TxAck>();
  readonly stats: TransactorStats = { txs: 0, batches: 0, maxBatch: 0, rejected: 0, indexRuns: 0, broadcasts: 0, commitMs: 0, resolveMs: 0, loopMs: 0, fenceMs: 0 };
  /** metrics: tx/s over the last 10 s, batch-size and commit-latency distributions */
  readonly txRate = new RateMeter(10_000);
  readonly batchSizes = new Histogram([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
  readonly commitLatency = new Histogram();
  /** per-batch resolve time and dequeue→ack wall time (commit time is `commitLatency`) */
  readonly resolveLatency = new Histogram();
  readonly loopLatency = new Histogram();
  /** cost of one event-loop fence, measured once per batch when config.timingYields is on */
  readonly fenceLatency = new Histogram();
  /** Analytics Engine sink (no-op when the host has no dataset bound) */
  readonly metrics: TxMetrics;
  private readonly log: Logger;

  constructor(readonly host: TransactorHost) {
    this.log = componentLogger("transactor", () => ({ db: safeName(host) }));
    this.metrics = new TxMetrics(host.analytics);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /** Idempotent: load durable state (or bootstrap a fresh database). */
  init(): Promise<void> {
    if (!this.ready) this.ready = this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    const sql = this.host.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS log (t INTEGER PRIMARY KEY, tx_instant INTEGER NOT NULL, datoms BLOB NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.store = new R2NodeStore(this.host.bucket, { codec: gzipCodec, maxNodes: 4096 });

    let rec = this.getMeta<RootRecord>("root") ?? (await readCurrentRoot(this.host.bucket));
    if (!rec) {
      // Fresh database: empty trees + bootstrap tx at t = 1 in the log.
      const roots = await emptyRoots(this.store);
      const fresh = rootsToRecord(roots, { log_watermark: 0, next_eid: FIRST_USER_EID, codec: gzipCodec.name });
      const boot = bootstrapDatoms();
      this.host.transactionSync(() => {
        this.appendLogRow({ t: 1, txInstant: this.host.now(), datoms: boot });
        this.setMeta("root", fresh);
        this.setMeta("next_eid", FIRST_USER_EID);
      });
      rec = fresh;
    }
    this.rootRecord = rec;
    this.logWatermark = rec.log_watermark;
    const roots: Roots = recordToRoots(rec);
    const nextEid = this.getMeta<number>("next_eid") ?? rec.next_eid;
    const logDatoms = this.readLogDatoms(roots.t);
    this.conn = await Connection.restore(this.store, roots, logDatoms, nextEid, { now: () => this.host.now() });
    for (const row of this.getMeta<StoredOpAck[]>("op_acks") ?? []) {
      this.recentOpAcks.set(row.k, row.ack);
      this.recentAcks.set(row.k, row.ack);
    }
    // txs already in the log but not yet indexed count toward the next index run
    this.txSinceIndex = Math.max(0, this.conn.t - roots.t);
    const c = this.host.config;
    this.indexer = new Indexer(this, {
      intervalMs: c.indexIntervalMs,
      txThreshold: c.indexTxThreshold,
      maxTxsPerRun: c.indexMaxTxsPerRun,
      logKeepTxs: c.logKeepTxs,
      gcEveryN: c.gcEveryNIndexes,
      retainRoots: c.retainRoots,
    });
    if (this.conn.t > roots.t) await this.indexer.schedule();
    this.log.info("boot", { t: this.conn.t, rootT: roots.t, novelty: this.conn.noveltyCount, nextEid: this.conn.nextEntityId, fresh: !this.getMeta("root") });
  }

  // ---------------------------------------------------------------------------
  // SQL helpers
  // ---------------------------------------------------------------------------

  private getMeta<T>(k: string): T | undefined {
    const row = this.host.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? (JSON.parse(row.v as string) as T) : undefined;
  }
  private setMeta(k: string, v: unknown): void {
    this.host.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, JSON.stringify(v));
  }
  private appendLogRow(e: LogEntry): void {
    const body = encodeLogChunk([e]);
    // DO SqlStorage binds ArrayBuffer; bun:sqlite binds Uint8Array. A fresh ArrayBuffer works for both.
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    this.host.sql.exec(`INSERT INTO log (t, tx_instant, datoms) VALUES (?, ?, ?)`, e.t, e.txInstant, buf);
  }
  /** Log entries with from < t <= to (ascending). */
  readLogEntries(from: number, to = Number.MAX_SAFE_INTEGER, limit = 100_000): LogEntry[] {
    const rows = this.host.sql.exec(`SELECT t, tx_instant, datoms FROM log WHERE t > ? AND t <= ? ORDER BY t LIMIT ?`, from, to, limit).toArray();
    const out: LogEntry[] = [];
    for (const r of rows) {
      const raw = r.datoms as ArrayBuffer | Uint8Array;
      const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const [entry] = decodeLogChunk(buf);
      out.push(entry);
    }
    return out;
  }
  private readLogDatoms(afterT: number): Datom[] {
    const out: Datom[] = [];
    for (const e of this.readLogEntries(afterT)) for (const d of e.datoms) out.push(d);
    return out;
  }
  /** Lowest t still present in the SQL log (0 if empty). */
  earliestLogT(): number {
    const row = this.host.sql.exec(`SELECT MIN(t) AS t FROM log`).toArray()[0];
    return (row?.t as number | null) ?? 0;
  }
  pruneLog(throughT: number): number {
    const before = this.host.sql.exec(`SELECT COUNT(*) AS n FROM log WHERE t <= ?`, throughT).toArray()[0].n as number;
    this.host.sql.exec(`DELETE FROM log WHERE t <= ?`, throughT);
    return before;
  }

  // ---------------------------------------------------------------------------
  // Accessors (indexer, shell, tests)
  // ---------------------------------------------------------------------------

  get connection(): Connection {
    return this.conn;
  }
  get nodeStore(): R2NodeStore {
    return this.store;
  }
  get bucket() {
    return this.host.bucket;
  }
  get currentRootRecord(): RootRecord {
    return this.rootRecord;
  }
  get watermark(): number {
    return this.logWatermark;
  }
  get t(): number {
    return this.conn.t;
  }
  get txsSinceIndex(): number {
    return this.txSinceIndex;
  }
  get isDead(): boolean {
    return this.dead !== undefined;
  }
  /** Called by the indexer after publishing a new root. */
  adoptRoot(rec: RootRecord): void {
    this.rootRecord = rec;
    this.logWatermark = rec.log_watermark;
    this.setMeta("root", rec);
    this.txSinceIndex = Math.max(0, this.conn.t - rec.t);
    this.stats.indexRuns++;
    this.broadcast({ v: 1, kind: "root", root: rec });
  }

  // ---------------------------------------------------------------------------
  // Group commit
  // ---------------------------------------------------------------------------

  /** Submit a transaction. Resolves once it is durably committed. */
  transact(
    tx: TxData,
    principal?: Principal,
    clientTxId?: string,
    extras?: { readonly opOutput?: unknown; readonly system?: boolean },
  ): Promise<TxAck> {
    if (this.dead !== undefined) return Promise.reject(new TransactorDeadError(this.dead));
    if (clientTxId !== undefined) {
      const key = clientTxReplayKey(principal, clientTxId);
      const hit = this.recentOpAcks.get(key) ?? this.recentAcks.get(key);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise<TxAck>((resolve, reject) => {
      this.queue.push({
        tx,
        principal,
        clientTxId,
        opOutput: extras?.opOutput,
        system: extras?.system || undefined,
        resolve,
        reject,
      });
      if (!this.committing) {
        this.committing = true;
        void this.commitLoop();
      }
    });
  }

  /**
   * Upsert the caller's principal row (and role fact) and return the resolved
   * eid. Idempotent. Anonymous / service principals stay `{ eid: null }`.
   */
  async provision(principal?: Principal): Promise<{ eid: number | null; class: string }> {
    await this.init();
    if (!principal) return { eid: null, class: "anonymous" };
    const policy = this.host.policy;
    if (!policy || !shouldProvision(principal)) return { eid: principal.eid ?? null, class: principal.class };
    const ops = await provisionTx(policy, principal, this.conn.db());
    if (ops !== undefined) await this.transact(ops, principal, undefined, { system: true });
    const eid = await resolveProvisionedEid(policy, principal, this.conn.db());
    return { eid: eid ?? null, class: principal.class };
  }

  private rememberAck(id: string, ack: TxAck, persist: boolean): void {
    this.recentAcks.set(id, ack);
    while (this.recentAcks.size > RECENT_CLIENT_TX_LIMIT) {
      const first = this.recentAcks.keys().next().value;
      if (first === undefined) break;
      this.recentAcks.delete(first);
    }
    if (persist) {
      this.recentOpAcks.set(id, ack);
      const list = [...this.recentOpAcks.entries()].map(([k, a]) => ({ k, ack: a }));
      const trimmed = list.length > RECENT_CLIENT_TX_LIMIT ? list.slice(-RECENT_CLIENT_TX_LIMIT) : list;
      if (trimmed.length < list.length) {
        this.recentOpAcks.clear();
        for (const row of trimmed) this.recentOpAcks.set(row.k, row.ack);
      }
      this.setMeta("op_acks", trimmed);
    }
  }

  lookupOpAck(principal: Principal | undefined, clientOpId: string): TxAck | undefined {
    const key = clientTxReplayKey(principal, clientOpId);
    return this.recentOpAcks.get(key) ?? this.recentAcks.get(key);
  }

  private takeBatch(): Pending[] {
    const max = this.host.config.maxBatch;
    if (max > 0 && this.queue.length > max) return this.queue.splice(0, max);
    const b = this.queue;
    this.queue = [];
    return b;
  }

  private async commitLoop(): Promise<void> {
    try {
      await this.init();
      const fences = this.host.config.timingYields;
      while (this.queue.length > 0 && this.dead === undefined) {
        // Open the batching window: yield to the event loop once so requests
        // that are already in flight (separate events in a Durable Object)
        // land in the queue and share the coming storage write.
        await yieldToEventLoop();
        // Diagnostics (config.timingYields): one calibration fence per batch.
        // On Cloudflare the clock does not advance inside a synchronous turn,
        // so every timing below is really "clock advance across a fence"; this
        // measures what one fence costs on its own, i.e. the bias of the rest.
        let fenceMs = 0;
        if (fences) {
          const tFence = performance.now();
          await yieldToEventLoop();
          fenceMs = performance.now() - tFence;
          this.stats.fenceMs += fenceMs;
          this.fenceLatency.observe(fenceMs);
        }
        // Everything queued while the previous batch was in flight forms the next batch.
        const queueDepth = this.queue.length; // pending txs at dequeue (includes this batch)
        const tLoop = performance.now();
        const batch = this.takeBatch();
        const entries: LogEntry[] = [];
        const acks: { p: Pending; ack: TxAck }[] = [];
        const batchAcks = new Map<string, TxAck>();
        const tResolve = performance.now();
        for (const p of batch) {
          if (p.clientTxId !== undefined) {
            const key = clientTxReplayKey(p.principal, p.clientTxId);
            const hit = this.recentAcks.get(key) ?? batchAcks.get(key);
            if (hit) {
              p.resolve(hit);
              continue;
            }
          }
          try {
            if (!p.system) await this.applyProvision(p, entries);
            const tx = await this.authorize(p);
            const rep = await this.conn.transact(tx);
            const txInstant = rep.txData[0]?.v as number; // :db/txInstant is first
            entries.push({ t: rep.t, txInstant, datoms: rep.txData });
            const ack: TxAck = {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: await this.ackDatoms(rep.txData, p.principal),
              ...(p.clientTxId !== undefined ? { clientTxId: p.clientTxId } : {}),
              ...(p.opOutput !== undefined ? { output: p.opOutput } : {}),
            };
            if (p.clientTxId !== undefined) batchAcks.set(clientTxReplayKey(p.principal, p.clientTxId), ack);
            acks.push({ p, ack });
          } catch (err) {
            const e = this.scrub(err, p);
            this.stats.rejected++;
            this.log.warn("tx.rejected", { code: (e as any)?.code, error: e instanceof Error ? e.message : String(e) });
            p.reject(e);
          }
        }
        // fence after the resolve section so the clock advances past it (diagnostics only)
        if (fences) await yieldToEventLoop();
        const resolveMs = performance.now() - tResolve;
        this.stats.resolveMs += resolveMs;
        if (entries.length === 0) continue;
        const tWrite = performance.now();
        try {
          // ONE storage write for the whole batch (group commit).
          this.host.transactionSync(() => {
            for (const e of entries) this.appendLogRow(e);
            this.setMeta("next_eid", this.conn.nextEntityId);
            const persist = [...batchAcks].filter(([, a]) => a.output !== undefined);
            if (persist.length > 0) {
              for (const [id, ack] of persist) this.recentOpAcks.set(id, ack);
              this.setMeta(
                "op_acks",
                [...this.recentOpAcks.entries()]
                  .map(([k, a]) => ({ k, ack: a }))
                  .slice(-RECENT_CLIENT_TX_LIMIT),
              );
            }
          });
        } catch (err) {
          // Memory and durable state diverged (t was assigned, nothing landed):
          // fail this batch and everything behind it, then discard the instance.
          this.die(`log write failed: ${err instanceof Error ? err.message : String(err)}`, err, acks.map((a) => a.p));
          return;
        }
        // fence after the storage write, before the acks: persist-before-ack is
        // unaffected (the write already returned) (diagnostics only)
        if (fences) await yieldToEventLoop();
        const writeMs = performance.now() - tWrite;
        this.stats.commitMs += writeMs;
        this.stats.txs += entries.length;
        this.stats.batches++;
        if (entries.length > this.stats.maxBatch) this.stats.maxBatch = entries.length;
        this.txSinceIndex += entries.length;
        this.txRate.mark(entries.length, this.host.now());
        this.batchSizes.observe(entries.length);
        this.commitLatency.observe(writeMs);
        this.resolveLatency.observe(resolveMs);
        this.log.debug("tx.commit", { t: this.conn.t, batch: entries.length, datoms: entries.reduce((n, e) => n + e.datoms.length, 0), writeMs: round(writeMs), queued: this.queue.length, txsSinceIndex: this.txSinceIndex });
        for (const [id, ack] of batchAcks) this.rememberAck(id, ack, ack.output !== undefined);
        for (const a of acks) a.p.resolve(a.ack);
        // dequeue → ack wall clock; "other" = loopMs - resolveMs - commitMs
        const loopMs = performance.now() - tLoop;
        this.stats.loopMs += loopMs;
        this.loopLatency.observe(loopMs);
        // ONE Analytics Engine data point per batch, after the acks and outside every timed region.
        this.metrics.batch({
          db: safeName(this.host) ?? "unknown",
          resolveMs,
          commitMs: writeMs,
          batchSize: entries.length,
          queueDepth,
          noveltyDatoms: this.conn.noveltyCount,
          fenceMs,
          txOk: entries.length,
          txErr: batch.length - entries.length,
        });
        for (const e of entries) this.broadcast(txFrame(e));
        await this.indexer.maybeSchedule();
      }
    } catch (err) {
      this.die(`commit loop failed: ${err instanceof Error ? err.message : String(err)}`, err, []);
    } finally {
      this.committing = false;
      if (this.queue.length > 0 && this.dead === undefined) {
        this.committing = true;
        void this.commitLoop();
      }
    }
  }

  /**
   * Peer-owned upsert of the caller's row, committed on this writer *before*
   * the client tx is authorized. Same group-commit batch; earlier `t`.
   */
  private async applyProvision(p: Pending, entries: LogEntry[]): Promise<void> {
    const policy = this.host.policy;
    const who = p.principal;
    if (!policy || !who || !shouldProvision(who)) return;
    const ops = await provisionTx(policy, who, this.conn.db());
    if (ops !== undefined) {
      const rep = await this.conn.transact(ops);
      entries.push({ t: rep.t, txInstant: rep.txData[0]?.v as number, datoms: rep.txData });
    }
    const eid = await resolveProvisionedEid(policy, who, this.conn.db());
    if (eid !== undefined) p.principal = { ...who, eid };
  }

  /** The authoritative write check: runs against `this.conn.db()` and returns the ops to transact, preset injections included. */
  private async authorize(p: Pending): Promise<TxData> {
    const policy = this.host.policy;
    if (!policy) return p.tx;
    if (p.system) return p.tx;
    if (!p.principal) throw new TxRejected({ message: "no principal", code: "policy" });
    if (isAdmin(p.principal)) return p.tx;
    const db = this.conn.db();
    // the Worker usually resolved it already; when its pre-check was skipped, do it here
    let who = p.principal;
    if (who.eid === undefined && who.sub !== undefined) {
      const eid = await db.entid([policy.principal, who.sub] as never);
      if (eid !== undefined) who = { ...who, eid };
    }
    const res = await checkTx(p.tx, db, policy, who);
    if (!res.ok) throw new TxRejected({ message: `${res.op} denied on ${res.attr}`, code: res.code, attr: res.attr });
    return res.ops as TxData;
  }

  /** Ack facts the writer may read, judged against the post-commit unfiltered db. */
  private async ackDatoms(datoms: Datom[], principal?: Principal): Promise<WireDatom[]> {
    const policy = this.host.policy;
    if (!policy || !principal || isAdmin(principal)) return datoms.map(toWireDatom);
    const db = this.conn.db();
    let who = principal;
    if (who.eid === undefined && who.sub !== undefined) {
      const eid = await db.entid([policy.principal, who.sub] as never);
      if (eid !== undefined) who = { ...who, eid };
    }
    const view = filterDb(db, db, policy, who);
    if (!(view instanceof FilteredDb)) return datoms.map(toWireDatom);
    const kept: WireDatom[] = [];
    for (const d of datoms) if (await view.visible(d)) kept.push(toWireDatom(d));
    return kept;
  }

  /** A unique conflict names the entity and value it collided with — a read leak under a policy. */
  private scrub(err: unknown, p: Pending): unknown {
    if (!this.host.policy || !p.principal || isAdmin(p.principal)) return err;
    if (err instanceof TxError && err.code === "tx/unique-conflict") return new TxRejected({ message: "unique conflict", code: err.code });
    return err;
  }

  private die(reason: string, cause: unknown, inflight: Pending[]): void {
    if (this.dead !== undefined) return;
    this.dead = reason;
    this.log.error("tx.aborted", { reason, inflight: inflight.length, queued: this.queue.length, t: this.conn?.t });
    const err = cause instanceof Error ? cause : new TransactorDeadError(reason);
    for (const p of inflight) p.reject(err);
    for (const p of this.queue) p.reject(new TransactorDeadError(reason));
    this.queue = [];
    this.host.abort(reason);
  }

  // ---------------------------------------------------------------------------
  // Novelty subscribers
  // ---------------------------------------------------------------------------

  private broadcast(frame: unknown): void {
    const msg = JSON.stringify(frame);
    this.stats.broadcasts++;
    for (const ws of this.host.sockets()) {
      try {
        ws.send(msg);
      } catch {
        // closed socket; the host cleans up
      }
    }
  }

  /** New subscriber: hello + catch-up from `from` (exclusive). */
  onSubscribe(ws: SocketLike, from: number): void {
    ws.send(JSON.stringify({ v: 1, kind: "hello", t: this.conn.t, root: this.rootRecord }));
    this.sendCatchUp(ws, Number.isFinite(from) ? from : 0);
    this.log.info("subscriber.connect", { from, t: this.conn.t, subscribers: this.host.sockets().length });
  }

  /** Subscriber control message (resume / ping). */
  onSocketMessage(ws: SocketLike, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg?.kind === "resume" && typeof msg.from === "number") this.sendCatchUp(ws, msg.from);
    else if (msg?.kind === "ping") ws.send(JSON.stringify({ v: 1, kind: "pong", t: this.conn.t }));
  }

  private sendCatchUp(ws: SocketLike, from: number): void {
    const t = this.conn.t;
    if (from >= t) return;
    const earliest = this.earliestLogT();
    if (earliest === 0 || earliest > from + 1) {
      // The SQL log no longer holds (from, earliest): subscriber must read log/ chunks from R2.
      ws.send(JSON.stringify({ v: 1, kind: "gap", from: Math.max(from, earliest - 1) }));
      this.log.warn("subscriber.gap", { from, earliestLogT: earliest, t });
      from = Math.max(from, earliest - 1);
    }
    for (const e of this.readLogEntries(from, t)) ws.send(JSON.stringify(txFrame(e)));
  }

  // ---------------------------------------------------------------------------
  // Alarm → indexer
  // ---------------------------------------------------------------------------

  async onAlarm(): Promise<void> {
    await this.init();
    await this.indexer.onAlarm();
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  info() {
    return {
      t: this.conn.t,
      root: this.rootRecord,
      novelty: this.conn.noveltyCount,
      txsSinceIndex: this.txSinceIndex,
      logWatermark: this.logWatermark,
      earliestLogT: this.earliestLogT(),
      nextEid: this.conn.nextEntityId,
      subscribers: this.host.sockets().length,
      opts: { timingYields: this.host.config.timingYields, maxBatch: this.host.config.maxBatch },
      stats: this.stats,
      metrics: {
        txPerSec: round(this.txRate.rate(this.host.now())),
        batchSize: this.batchSizes.snapshot(),
        commitMs: this.commitLatency.snapshot(),
        avgBatch: this.stats.batches ? round(this.stats.txs / this.stats.batches) : 0,
        // cumulative counters (same numbers as stats.*, kept here for one-stop reading)
        resolveMs: round(this.stats.resolveMs),
        loopMs: round(this.stats.loopMs),
        // per-batch distributions: "other" per batch = batchLoopMs - batchResolveMs - batchCommitMs
        batchResolveMs: this.resolveLatency.snapshot(),
        batchCommitMs: this.commitLatency.snapshot(),
        batchLoopMs: this.loopLatency.snapshot(),
        // fence cost per batch (config.timingYields; all zero when off) — the bias to subtract
        fenceMs: this.fenceLatency.snapshot(),
        noveltyDatoms: this.conn.noveltyCount,
        queueDepth: this.queue.length,
        ...this.metrics.snapshot(),
      },
      store: this.store.stats,
      indexer: this.indexer.status(),
    };
  }

  /**
   * Route dispatch as an Effect program: every route runs inside
   * `Effect.tryPromise`, whatever it throws is classified into a tagged error
   * (errors.ts) and `Effect.catchTags` maps each tag to the same status/body
   * the pre-Effect handler produced. Only the boundary is effectful — the
   * resolve/commit loop above stays plain async/await.
   *
   * The WebSocket `/subscribe` upgrade never reaches here (the DO shell owns it).
   */
  async handleRequest(request: Request): Promise<Response> {
    await this.init();
    // Worker→DO subrequests have no `request.cf`; the Worker forwards its own colo as a header.
    this.metrics.observeColo((request as { cf?: { colo?: string } }).cf?.colo ?? request.headers.get("x-ramose-colo") ?? undefined);
    const url = new URL(request.url);
    return Effect.runPromise(
      Effect.tryPromise({ try: () => this.route(request, url), catch: toHttpError }).pipe(
        Effect.catchTags({
          TxRejected: (e) => Effect.sync(() => errorResponse(e)),
          TransactorDead: (e) => Effect.sync(() => errorResponse(e)),
          BadRequest: (e) => Effect.sync(() => errorResponse(e)),
          NotFound: (e) => Effect.sync(() => errorResponse(e)),
          Internal: (e) => Effect.sync(() => errorResponse(e)),
        }),
      ),
    );
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/op-ack" && request.method === "POST") {
      const body = fromJson(await request.json()) as {
        clientOpId?: unknown;
        principal?: unknown;
        ack?: TxAck;
      };
      if (typeof body.clientOpId !== "string" || body.clientOpId.length === 0) {
        throw new BadRequest({ message: "body must be { clientOpId }" });
      }
      const principal = asPrincipal(body.principal);
      if (body.ack !== undefined && body.ack !== null) {
        const key = clientTxReplayKey(principal, body.clientOpId);
        this.rememberAck(key, { ...body.ack, clientTxId: body.clientOpId }, true);
        return json({ ack: body.ack });
      }
      return json({ ack: this.lookupOpAck(principal, body.clientOpId) ?? null });
    }
    if (path === "/transact" && request.method === "POST") {
      const body = fromJson(await request.json()) as {
        tx?: TxData;
        principal?: unknown;
        clientTxId?: unknown;
        opOutput?: unknown;
      };
      if (!body || !Array.isArray(body.tx)) throw new BadRequest({ message: "body must be { tx: [...] }" });
      const clientTxId = typeof body.clientTxId === "string" && body.clientTxId.length > 0 ? body.clientTxId : undefined;
      const ack = await this.transact(body.tx, asPrincipal(body.principal), clientTxId, {
        opOutput: body.opOutput,
      });
      return json(ack);
    }
    if (path === "/provision" && request.method === "POST") {
      const body = fromJson(await request.json()) as { principal?: unknown };
      return json(await this.provision(asPrincipal(body?.principal)));
    }
    if (path === "/info") return json(this.info());
    if (path === "/log") {
      const from = Number(url.searchParams.get("from") ?? "0");
      const to = Number(url.searchParams.get("to") ?? String(Number.MAX_SAFE_INTEGER));
      const entries = this.readLogEntries(from, to, 10_000);
      const frames: NoveltyFrameV1[] = entries.map(txFrame);
      return json({ from, to, earliestLogT: this.earliestLogT(), t: this.conn.t, entries: frames });
    }
    if (path === "/admin/index" && request.method === "POST") return json(await this.indexer.runNow());
    if (path === "/admin/gc" && request.method === "POST") return json(await this.indexer.gcNow());
    throw new NotFound({ message: "not found" });
  }
}
