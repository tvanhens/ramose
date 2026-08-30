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
  TxError,
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
  type WireDatom,
  RateMeter,
  componentLogger,
  toWireDatom,
  VALUE_TYPE_IDENTS,
} from "../core/index.ts";
import type { CompositionIndex } from "../core/composition.ts";
import type { Principal } from "../../worker/auth.ts";
import {
  InvalidRequest,
  OperationRejected,
  TxRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import { R2NodeStore, readCurrentRoot, recordToRoots, rootsToRecord } from "../storage/index.ts";
import * as Effect from "effect/Effect";
import { BadRequest, NotFound, TransactorDeadError, Unavailable, errorResponse, toHttpError } from "./errors.ts";
import { type SocketLike, type TransactorHost } from "./host.ts";
import { Indexer } from "./indexer.ts";
import { TxMetrics } from "./observability.ts";
import {
  inertRuntimeBoundaries,
  type RuntimeBoundaries,
} from "../runtime-boundaries.ts";
import {
  allocationMappingsResolvable,
  authorizeCatalogOperation,
  authorizeCatalogOperationGrant,
  authorizeCatalogOperationReplay,
  catalogProvisioningAttributes,
  decideInvocationReceipt,
  deployedOperationVersion,
  executeCatalogOperation,
  invocationReceiptOutcome,
  isLegacyInvocationReceiptRow,
  OperationRuntimeFault,
  opaqueOperationDenial,
  parseEntityIdScope,
  parseInvocationAllocations,
  parseStoredInvocationReceipt,
  prepareInvocationReceipt,
  requireSuppliedOperationVersion,
  resolveOperationCatalog,
  resolveSealedTarget,
  transitionInvocationReceipt,
  type AuthoritativeInvocationResult,
  type AuthoritativeOperationInvocation,
  type CatalogOperationAdmission,
  type ClaimedInvocationReceipt,
  type InstalledCatalogDefinition,
  type InvocationReceiptEvent,
  type LegacyInvocationReceiptRow,
  type OperationRuntime,
  type PreparedInvocationReceipt,
  type SealedInvocationRejection,
  type StoredInvocationReceipt,
  type TerminalInvocationReceipt,
} from "../authorization/index.ts";
import type { EntityIdScope } from "../replication/entity-id.ts";
import type { ServerSealingKey } from "../replication/server-identity.ts";

export { TransactorDeadError };

/** Reshape Worker-verified caller metadata. Not an authorization decision. */
function asPrincipal(x: unknown): Principal | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (o.kind !== "user" || typeof o.class !== "string") return undefined;
  const claims =
    typeof o.claims === "object" && o.claims !== null
      ? (o.claims as Principal["claims"])
      : {};
  const classes = Array.isArray(o.classes)
    ? o.classes.filter((c): c is string => typeof c === "string")
    : undefined;
  return {
    kind: "user",
    class: o.class,
    claims,
    ...(typeof o.sub === "string" ? { sub: o.sub } : {}),
    ...(typeof o.eid === "number" ? { eid: o.eid } : {}),
    ...(classes !== undefined && classes.length > 0 ? { classes } : {}),
  };
}

export interface TxAck {
  t: number;
  txEid: number;
  tempids: Record<string, number>;
  /** facts that landed, already filtered for this principal */
  datoms: WireDatom[];
  clientTxId?: string;
}

export type OperationAck = AuthoritativeInvocationResult;

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
  principal?: Principal | undefined;
  /** opaque client id; a replay of a recent id returns the original ack */
  clientTxId?: string | undefined;
  /**
   * Peer-owned write (principal provisioning). Skips `checkTx` and the
   * pre-write provision hook — the ops *are* the provision.
   */
  system?: boolean | undefined;
  /** Native deployed invocation; mutually exclusive with raw `tx`. */
  operation?: AuthoritativeOperationInvocation | undefined;
  /**
   * The durable sealing root, resolved *before* this invocation is queued so
   * the serialized writer loop never waits on a Durable Object hop. Present
   * only for an invocation that carries a sealed target or binds an
   * allocation slot (#475).
   */
  sealing?: ServerSealingKey | undefined;
  resolve: (r: TxAck | OperationAck) => void;
  reject: (e: unknown) => void;
}

/** The root and scope one invocation's opaque handles are bound to (#475). */
type SealingContext = {
  readonly sealing: ServerSealingKey;
  readonly scope: EntityIdScope;
};

/** How many recent `clientTxId`s this instance remembers. FIFO once full. */
const RECENT_CLIENT_TX_LIMIT = 256;

/** Replay keys are per writer: a foreign principal must not see someone else's filtered ack. */
export function clientTxReplayKey(principal: Principal | undefined, id: string): string {
  if (!principal) return `\0:${id}`;
  const who = principal.sub ?? (principal.eid !== undefined ? `#${principal.eid}` : principal.class);
  return `${principal.kind}\0${who}\0${id}`;
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
  private deployedComposition:
    | { readonly unitHash: string; readonly index: CompositionIndex }
    | undefined;

  constructor(
    readonly host: TransactorHost,
    private readonly operationRuntime?: OperationRuntime,
    private readonly boundaries: RuntimeBoundaries = inertRuntimeBoundaries,
  ) {
    this.log = componentLogger("transactor", () => ({ db: safeName(host) }));
    this.metrics = new TxMetrics(host.analytics);
  }

  /** Bind this database's one deployed catalog before authoritative writes. */
  bindComposition(unitHash: string, index: CompositionIndex): void {
    const current = this.deployedComposition;
    if (current !== undefined) {
      if (current.unitHash !== unitHash) {
        throw new TxError(
          "cannot change deployed catalog composition",
          "tx/system",
        );
      }
      return;
    }
    this.deployedComposition = { unitHash, index };
    if (this.conn !== undefined) this.conn.bindComposition(index);
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
    sql.exec(`CREATE TABLE IF NOT EXISTS operation_receipts (
      principal_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt TEXT NOT NULL,
      PRIMARY KEY (principal_id, invocation_id)
    )`);
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
    this.conn = await Connection.restore(this.store, roots, logDatoms, nextEid, {
      now: () => this.host.now(),
      ...(this.deployedComposition === undefined
        ? {}
        : { composition: this.deployedComposition.index }),
    });
    if (this.deployedComposition !== undefined) {
      this.conn.bindComposition(this.deployedComposition.index);
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
    }, this.boundaries);
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

  private readInvocationReceipt(
    principalId: string,
    invocationId: string,
  ): StoredInvocationReceipt | LegacyInvocationReceiptRow | undefined {
    const row = this.host.sql.exec(
      `SELECT status, receipt FROM operation_receipts
       WHERE principal_id = ? AND invocation_id = ?`,
      principalId,
      invocationId,
    ).toArray()[0];
    if (row === undefined) return undefined;
    const receipt = parseStoredInvocationReceipt(JSON.parse(row.receipt as string));
    // A pre-correction row keeps its stored bytes untouched; only the current
    // generation is checked against the status column.
    if (isLegacyInvocationReceiptRow(receipt)) return receipt;
    if (row.status !== receipt.status) {
      throw new TypeError("durable invocation receipt status mismatch");
    }
    return receipt;
  }

  private insertInvocationReceipt(receipt: ClaimedInvocationReceipt): void {
    this.host.sql.exec(
      `INSERT INTO operation_receipts
       (principal_id, invocation_id, status, receipt) VALUES (?, ?, ?, ?)`,
      receipt.principalId,
      receipt.invocationId,
      receipt.status,
      JSON.stringify(receipt),
    );
  }

  private replaceInvocationReceipt(receipt: TerminalInvocationReceipt): void {
    this.host.sql.exec(
      `UPDATE operation_receipts SET status = ?, receipt = ?
       WHERE principal_id = ? AND invocation_id = ?`,
      receipt.status,
      JSON.stringify(receipt),
      receipt.principalId,
      receipt.invocationId,
    );
  }

  private claimInvocationReceipt(
    prepared: PreparedInvocationReceipt,
  ) {
    return this.host.transactionSync(() => {
      const stored = this.readInvocationReceipt(
        prepared.principalId,
        prepared.invocationId,
      );
      const decision = decideInvocationReceipt(stored, prepared);
      if (decision._tag === "Claim") {
        this.insertInvocationReceipt(decision.receipt);
      } else if (decision._tag === "Recover") {
        // A claim left by a discarded isolate is recovered only when its key
        // is retried, so cold-start work is independent of receipt history.
        this.replaceInvocationReceipt(decision.receipt);
      }
      return decision;
    });
  }

  /** Read-only first pass; missing invocations are admitted before insertion. */
  private inspectInvocationReceipt(
    prepared: PreparedInvocationReceipt,
  ) {
    const stored = this.readInvocationReceipt(
      prepared.principalId,
      prepared.invocationId,
    );
    return decideInvocationReceipt(stored, prepared);
  }

  /** Atomically seal only an already-existing abandoned claim. */
  private recoverInvocationReceipt(
    prepared: PreparedInvocationReceipt,
  ) {
    return this.host.transactionSync(() => {
      const stored = this.readInvocationReceipt(
        prepared.principalId,
        prepared.invocationId,
      );
      const decision = decideInvocationReceipt(stored, prepared);
      if (decision._tag === "Recover") {
        this.replaceInvocationReceipt(decision.receipt);
      }
      return decision;
    });
  }

  private assertClaimIdentity(
    stored: StoredInvocationReceipt | LegacyInvocationReceiptRow | undefined,
    claim: ClaimedInvocationReceipt,
  ): asserts stored is ClaimedInvocationReceipt {
    if (
      stored === undefined || isLegacyInvocationReceiptRow(stored) ||
      stored.status !== "claimed" || stored.version !== claim.version ||
      stored.principalId !== claim.principalId ||
      stored.invocationId !== claim.invocationId ||
      stored.scopeDigest !== claim.scopeDigest ||
      stored.operationVersion !== claim.operationVersion ||
      stored.invocationDigest !== claim.invocationDigest
    ) {
      throw new Error("durable invocation claim changed before completion");
    }
  }

  private finishInvocationReceipt(
    claim: ClaimedInvocationReceipt,
    event: InvocationReceiptEvent,
    insideTransaction = false,
  ): TerminalInvocationReceipt {
    const finish = () => {
      const stored = this.readInvocationReceipt(
        claim.principalId,
        claim.invocationId,
      );
      this.assertClaimIdentity(stored, claim);
      const terminal = transitionInvocationReceipt(stored, event);
      this.replaceInvocationReceipt(terminal);
      return terminal;
    };
    return insideTransaction ? finish() : this.host.transactionSync(finish);
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
    extras?: { readonly system?: boolean },
  ): Promise<TxAck> {
    if (this.dead !== undefined) return Promise.reject(new TransactorDeadError(this.dead));
    if (clientTxId !== undefined) {
      const key = clientTxReplayKey(principal, clientTxId);
      const hit = this.recentAcks.get(key);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise<TxAck>((resolve, reject) => {
      this.queue.push({
        tx,
        principal,
        clientTxId,
        system: extras?.system || undefined,
        resolve: resolve as (result: TxAck | OperationAck) => void,
        reject,
      });
      if (!this.committing) {
        this.committing = true;
        void this.commitLoop();
      }
    });
  }

  /**
   * Whether a durable receipt's stored mappings can still be opened by the
   * caller replaying it.
   *
   * The receipt identity covers the database and the verified claims but not
   * the public origin the request arrived on and not the server sealing key,
   * and a sealed handle is bound to both. After a key rotation — or through a
   * second origin serving the same database — a replay would otherwise return
   * handles the caller cannot resolve, and the client would durably persist
   * client ref mappings that are permanently unusable. That answer is the
   * typed, data-free update-required, not a denial: the receipt is genuine.
   */
  private replayableMappings(
    receipt: TerminalInvocationReceipt,
    context: SealingContext | undefined,
  ): boolean {
    if (receipt.status !== "completed" || receipt.allocations === undefined) {
      return true;
    }
    // A receipt with mappings was claimed under an invocation that bound slots,
    // and the binding is in the digest, so a matching replay bound them too.
    if (context === undefined) return false;
    return allocationMappingsResolvable(
      receipt.allocations,
      context.sealing.keyId,
      context.scope,
    );
  }

  /**
   * The root and scope this invocation's allocation mappings are sealed under.
   *
   * `invoke` established both before the invocation was ever queued, so a
   * missing one is an engine defect rather than a caller error — and it is
   * refused here, before the operation body runs, so the sealing step that
   * follows the staged commit cannot be the thing that fails.
   */
  private requireSealingContext(
    p: Pending,
    operation: AuthoritativeOperationInvocation,
  ): SealingContext {
    const scope = operation.entityIdScope;
    if (p.sealing === undefined || scope === undefined) {
      throw opaqueOperationDenial();
    }
    return { sealing: p.sealing, scope };
  }

  /**
   * Whether this invocation needs the durable sealing root at all: it names an
   * opaque target that has to be opened, or it binds allocation slots whose
   * eids have to be sealed into the receipt.
   */
  private needsSealingKey(
    invocation: AuthoritativeOperationInvocation,
  ): boolean {
    return invocation.sealedTarget !== undefined ||
      (invocation.allocations !== undefined && invocation.allocations.length > 0);
  }

  /**
   * Translate one opaque sealed target into the private eid the rest of the
   * pipeline already understands.
   *
   * Returns the invocation to run, or `undefined` when the handle's codec
   * version or key epoch is beyond this build — the caller turns that into the
   * typed, data-free `UpdateRequired` outcome. Every other failure is the
   * ordinary sealed denial, thrown here so it is indistinguishable from
   * not-found and from unauthorized.
   *
   * An invocation that supplies both a numeric/lookup target and a sealed one
   * is refused: two targets are two different invocations, and silently
   * preferring either would let a caller's durable queue and the authoritative
   * writer disagree about what was acted on.
   */
  private async resolveInvocationTarget(
    p: Pending,
    context: SealingContext | undefined,
  ): Promise<AuthoritativeOperationInvocation | undefined> {
    const invocation = p.operation!;
    if (invocation.sealedTarget === undefined) return invocation;
    if (invocation.target !== undefined) throw opaqueOperationDenial();
    if (context === undefined) throw opaqueOperationDenial();
    const resolution = await resolveSealedTarget(
      context.sealing,
      context.scope,
      invocation.sealedTarget,
    );
    if (resolution._tag === "UpdateRequired") return undefined;
    if (resolution._tag === "Denied") throw opaqueOperationDenial();
    return Object.freeze({ ...invocation, target: resolution.eid });
  }

  /** Submit one exact deployed-catalog invocation to the serialized writer. */
  async invoke(
    invocation: AuthoritativeOperationInvocation,
  ): Promise<OperationAck> {
    if (this.dead !== undefined) throw new TransactorDeadError(this.dead);
    const runtime = this.operationRuntime;
    if (runtime === undefined) throw opaqueOperationDenial();
    // Resolved here rather than inside the commit loop: it is a Durable Object
    // hop on a cold isolate, and the serialized writer must not wait on the
    // network between two batches. Only invocations that actually use opaque
    // handles pay for it; every other operation path is untouched.
    let sealing: ServerSealingKey | undefined;
    if (this.needsSealingKey(invocation)) {
      if (runtime.sealing === undefined || invocation.entityIdScope === undefined) {
        throw opaqueOperationDenial();
      }
      try {
        sealing = await runtime.sealing();
      } catch (cause) {
        // The root lives in another Durable Object, so a cold isolate has to
        // fetch it. A transient failure there is not an engine defect and not a
        // denial: nothing about this invocation is wrong and asking again is
        // the right answer. Answering an opaque 500 instead would be
        // indistinguishable, to a durable offline queue, from a permanent one —
        // and it would be invisible here, which is exactly what made an earlier
        // occurrence of this undiagnosable.
        const message = cause instanceof Error ? cause.message : String(cause);
        this.log.error("operation.sealing-root-unavailable", { error: message });
        throw new Unavailable({
          message: "the server sealing root is momentarily unavailable",
          retryAfterMs: 1_000,
        });
      }
    }
    return new Promise<OperationAck>((resolve, reject) => {
      this.queue.push({
        tx: [],
        operation: invocation,
        ...(sealing === undefined ? {} : { sealing }),
        resolve: resolve as (result: TxAck | OperationAck) => void,
        reject,
      });
      if (!this.committing) {
        this.committing = true;
        void this.commitLoop();
      }
    });
  }

  /**
   * Idempotently materialize only physical attribute schema for an already
   * authorized dynamic route. Runnable catalog authority remains in code.
   */
  async provisionCatalog(definition: InstalledCatalogDefinition): Promise<number> {
    await this.init();
    this.bindComposition(definition.unitHash, definition.composition);
    const attributes = catalogProvisioningAttributes(definition);
    let missing = false;
    for (const expected of attributes) {
      const existing = this.conn!.db().attr(expected[":db/ident"]);
      if (existing === undefined) {
        missing = true;
        continue;
      }
      const expectedValueType = VALUE_TYPE_IDENTS[expected[":db/valueType"]];
      const expectedUnique = expected[":db/unique"] === undefined
        ? undefined
        : expected[":db/unique"] === ":db.unique/identity"
          ? "identity"
          : "value";
      const expectedCardinality = expected[":db/cardinality"] ===
          ":db.cardinality/many"
        ? "many"
        : "one";
      if (
        existing.valueType !== expectedValueType ||
        existing.cardinality !== expectedCardinality ||
        existing.unique !== expectedUnique ||
        existing.index !== (expected[":db/index"] === true) ||
        existing.isComponent !== (expected[":db/isComponent"] === true) ||
        (existing.optional === true) !== (expected[":db/optional"] === true)
      ) {
        throw new TxError(
          `cannot provision incompatible deployed field ${expected[":db/ident"]}`,
          "tx/system",
        );
      }
    }
    if (!missing) return this.conn!.t;
    const ack = await this.transact(
      [...attributes] as TxData,
      undefined,
      undefined,
      { system: true },
    );
    return ack.t;
  }

  /** Principal-row provisioning is closed until verified JWT (#412). */
  async provision(principal?: Principal): Promise<{ eid: number | null; class: string }> {
    await this.init();
    if (!principal) return { eid: null, class: "" };
    return { eid: principal.eid ?? null, class: principal.class };
  }

  private rememberAck(id: string, ack: TxAck): void {
    this.recentAcks.set(id, ack);
    while (this.recentAcks.size > RECENT_CLIENT_TX_LIMIT) {
      const first = this.recentAcks.keys().next().value;
      if (first === undefined) break;
      this.recentAcks.delete(first);
    }
  }

  private invocationFailureEvent(
    error: unknown,
  ): InvocationReceiptEvent {
    let rejection: SealedInvocationRejection | undefined;
    if (error instanceof Unauthorized) {
      rejection = { kind: "unauthorized" };
    } else if (error instanceof InvalidRequest) {
      rejection = { kind: "invalid_request" };
    } else if (error instanceof OperationRejected) {
      rejection = {
        kind: "operation_rejected",
        message: error.message,
        operation: error.operation,
        ...(error.step === undefined ? {} : { step: error.step }),
        ...(error.reason === undefined ? {} : { reason: error.reason }),
      };
    } else if (error instanceof TxRejected || error instanceof TxError) {
      rejection = { kind: "request_rejected" };
    }
    return rejection === undefined
      ? { _tag: "Fail" }
      : { _tag: "Reject", rejection };
  }

  private takeBatch(): Pending[] {
    const max = this.host.config.maxBatch;
    // An operation carries a short-lived authorization lease through native
    // awaited work. Keep it in a one-entry durable batch so a pre-commit
    // expiry can discard this DO instance without rejecting unrelated writes.
    if (this.queue[0]?.operation !== undefined) return this.queue.splice(0, 1);
    const operationAt = this.queue.findIndex((pending) => pending.operation !== undefined);
    const available = operationAt < 0 ? this.queue.length : operationAt;
    const count = max > 0 ? Math.min(available, max) : available;
    return this.queue.splice(0, count);
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
        const acks: {
          p: Pending;
          ack: TxAck | OperationAck;
          assertFresh?: () => void;
          receiptCompletion?: {
            readonly claim: ClaimedInvocationReceipt;
            readonly event: InvocationReceiptEvent & {
              readonly _tag: "Complete";
            };
          };
        }[] = [];
        const batchAcks = new Map<string, TxAck>();
        const tResolve = performance.now();
        for (const p of batch) {
          if (p.operation !== undefined) {
            let claim: ClaimedInvocationReceipt | undefined;
            try {
              // The compatibility digest is operation-scoped, so the deployed
              // operation must be resolved before the receipt is prepared.
              // Resolution failures stay the ordinary sealed denial.
              if (this.operationRuntime === undefined) {
                throw opaqueOperationDenial();
              }
              const supplied = requireSuppliedOperationVersion(
                p.operation.operationVersion,
              );
              const resolved = await Effect.runPromise(
                resolveOperationCatalog(this.operationRuntime, p.operation),
              );
              this.bindComposition(
                resolved.deployed.definition.unitHash,
                resolved.deployed.definition.composition,
              );
              const operationVersion = deployedOperationVersion(
                resolved,
                p.operation.owner,
                p.operation.localName,
              );
              if (operationVersion === undefined) throw opaqueOperationDenial();
              // Every effect-free compatibility answer is disclosed only to a
              // caller who may still invoke the operation as it stands now.
              // Grant-only admission deliberately stops before the target and
              // input checks — those are exactly what a changed operation
              // moves — and its sealed denial wins over the answer (#419).
              const operationRuntime = this.operationRuntime;
              const resolveCompatibility = async (
                tag: "OperationChanged" | "UpdateRequired",
              ) => {
                // Grant-only admission never reads the target, so it is the
                // same answer before and after opaque-target resolution.
                await authorizeCatalogOperationGrant(
                  this.conn,
                  operationRuntime,
                  p.operation!,
                  resolved,
                );
                this.stats.rejected++;
                p.resolve({ _tag: tag });
              };
              // Opaque target translation, at the authoritative edge and
              // before the #487 primitive sees anything. Resolution is a
              // bounded decrypt that grants nothing: it only replaces the
              // caller's handle with the private eid, and every ordinary
              // visibility, type, and admission check below then runs against
              // that eid exactly as it would for a numeric target.
              // Resolved before the body runs, not after the commit: sealing an
              // allocated eid must not be able to fail between the staged
              // transaction and the durable batch write.
              const sealingContext = this.needsSealingKey(p.operation)
                ? this.requireSealingContext(p, p.operation)
                : undefined;
              // The Worker derived the scope under its own cached epoch, and
              // this isolate caches the root separately. If a replacement left
              // them disagreeing, every scope component — each a PRF of the
              // root — names something this key cannot reproduce: opening a
              // handle would fail as a denial rather than a quarantine, and
              // sealing one would commit a handle encrypted under one epoch and
              // bound to a scope derived under another, openable by neither
              // once they converge and already durable on the client. Ask again
              // instead; by then they agree, or the client learns to update.
              if (
                sealingContext !== undefined &&
                p.operation.entityIdKeyId !== sealingContext.sealing.keyId
              ) {
                await resolveCompatibility("UpdateRequired");
                continue;
              }
              const operation = await this.resolveInvocationTarget(
                p,
                sealingContext,
              );
              if (operation === undefined) {
                // The handle's own codec version or key epoch is beyond this
                // build. Data-free, and disclosed only to a caller who may
                // still invoke the operation as it stands now.
                await resolveCompatibility("UpdateRequired");
                continue;
              }
              // Prepared first so a malformed invocation id or an unverified
              // principal keeps its ordinary invalid-request answer.
              const prepared = await Effect.runPromise(
                prepareInvocationReceipt(operation, operationVersion),
              );
              // A pin the caller supplied and the deployment no longer has
              // decides before the durable row is read at all: an explicit
              // expectation is never satisfied by a receipt minted under a
              // different version.
              if (supplied !== undefined && supplied !== operationVersion) {
                await resolveCompatibility("OperationChanged");
                continue;
              }
              const inspected = this.inspectInvocationReceipt(prepared);
              if (
                inspected._tag === "OperationChanged" ||
                inspected._tag === "UpdateRequired"
              ) {
                await resolveCompatibility(inspected._tag);
                continue;
              }
              if (inspected._tag === "Conflict") {
                this.stats.rejected++;
                p.resolve({ _tag: "Conflict" });
                continue;
              }
              if (inspected._tag === "Recover") {
                const recovered = this.recoverInvocationReceipt(prepared);
                if (
                  recovered._tag === "OperationChanged" ||
                  recovered._tag === "UpdateRequired"
                ) {
                  await resolveCompatibility(recovered._tag);
                  continue;
                }
                if (recovered._tag === "Conflict") {
                  this.stats.rejected++;
                  p.resolve({ _tag: "Conflict" });
                  continue;
                }
                if (recovered._tag === "Replay" || recovered._tag === "Recover") {
                  if (!this.replayableMappings(recovered.receipt, sealingContext)) {
                    await resolveCompatibility("UpdateRequired");
                    continue;
                  }
                  p.resolve(invocationReceiptOutcome(recovered.receipt));
                  continue;
                }
                // A missing row cannot normally race inside one serialized DO,
                // but if storage changed, continue through fresh admission.
              }
              // An exact replay keeps PR #527's behavior byte for byte. The
              // fenced admission below is unchanged and still runs first.
              if (inspected._tag === "Replay") {
                if (!this.replayableMappings(inspected.receipt, sealingContext)) {
                  await resolveCompatibility("UpdateRequired");
                  continue;
                }
                if (inspected.receipt.status === "completed") {
                  await authorizeCatalogOperationReplay(
                    this.conn,
                    this.operationRuntime,
                    operation,
                    inspected.receipt.replayFence,
                    resolved,
                  );
                } else {
                  await authorizeCatalogOperation(
                    this.conn,
                    this.operationRuntime,
                    operation,
                    resolved,
                  );
                }
                p.resolve(invocationReceiptOutcome(inspected.receipt));
                continue;
              }

              const admission: CatalogOperationAdmission =
                await authorizeCatalogOperation(
                  this.conn,
                  this.operationRuntime,
                  operation,
                  resolved,
                );

              // Missing keys are admitted without writes. Only now, directly
              // before native execution, atomically recheck and insert.
              const decision = this.claimInvocationReceipt(prepared);
              if (
                decision._tag === "Conflict" ||
                decision._tag === "OperationChanged" ||
                decision._tag === "UpdateRequired"
              ) {
                this.stats.rejected++;
                p.resolve({ _tag: decision._tag });
                continue;
              }
              if (decision._tag === "Replay" || decision._tag === "Recover") {
                if (!this.replayableMappings(decision.receipt, sealingContext)) {
                  await resolveCompatibility("UpdateRequired");
                  continue;
                }
                if (decision.receipt.status === "completed") {
                  await authorizeCatalogOperationReplay(
                    this.conn,
                    this.operationRuntime,
                    operation,
                    decision.receipt.replayFence,
                    resolved,
                  );
                }
                p.resolve(invocationReceiptOutcome(decision.receipt));
                continue;
              }
              claim = decision.receipt;
              await this.boundaries.checkpoint("operation.claimed");
              const executed = await executeCatalogOperation(
                this.conn,
                this.operationRuntime,
                operation,
                resolved,
                admission,
                sealingContext?.sealing,
              );
              const rep = executed.report;
              // Already sealed, inside the pre-commit validator: nothing
              // between the staged transaction and this batch's durable write
              // can fail, and the durable row carries opaque handles only.
              // Sealing is deterministic in (root, scope, eid), so a replay
              // reproduces these bytes without re-executing.
              const event = {
                _tag: "Complete" as const,
                committedT: rep.t,
                output: executed.output,
                replayFence: executed.replayFence,
                ...(sealingContext === undefined ||
                    executed.allocations.length === 0
                  ? {}
                  : {
                    allocations: {
                      version: 1 as const,
                      keyId: sealingContext.sealing.keyId,
                      scope: { ...sealingContext.scope },
                      entries: executed.allocations,
                    },
                  }),
              };
              const terminal = transitionInvocationReceipt(claim, event);
              const txInstant = rep.txData[0]?.v as number;
              entries.push({ t: rep.t, txInstant, datoms: rep.txData });
              acks.push({
                p,
                ack: invocationReceiptOutcome(terminal),
                assertFresh: executed.assertFresh,
                receiptCompletion: { claim, event },
              });
            } catch (err) {
              if (err instanceof OperationRuntimeFault) {
                this.log.error("operation.failed", {
                  stage: err.stage,
                  error: err.detail instanceof Error
                    ? err.detail.message
                    : String(err.detail),
                });
              }
              if (claim !== undefined) {
                try {
                  const terminal = this.finishInvocationReceipt(
                    claim,
                    this.invocationFailureEvent(err),
                  );
                  this.stats.rejected++;
                  this.log.warn("operation.rejected", {
                    status: terminal.status,
                  });
                  p.resolve(invocationReceiptOutcome(terminal));
                } catch (storageError) {
                  this.die(
                    `receipt write failed: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
                    storageError,
                    [p],
                  );
                  return;
                }
              } else {
                const e = this.scrub(err, p);
                this.stats.rejected++;
                this.log.warn("tx.rejected", {
                  code: (e as { readonly code?: unknown })?.code,
                  error: e instanceof Error ? e.message : String(e),
                });
                p.reject(e);
              }
            }
            continue;
          }
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
            const ack: TxAck = {
              t: rep.t,
              txEid: rep.txEid,
              tempids: rep.tempids,
              datoms: await this.ackDatoms(rep.txData, p.principal),
              ...(p.clientTxId !== undefined ? { clientTxId: p.clientTxId } : {}),
            };
            const txInstant = rep.txData[0]?.v as number; // :db/txInstant is first
            entries.push({ t: rep.t, txInstant, datoms: rep.txData });
            if (p.clientTxId !== undefined) {
              batchAcks.set(clientTxReplayKey(p.principal, p.clientTxId), ack as TxAck);
            }
            acks.push({ p, ack });
          } catch (err) {
            if (err instanceof OperationRuntimeFault) {
              this.log.error("operation.failed", {
                stage: err.stage,
                error: err.detail instanceof Error ? err.detail.message : String(err.detail),
              });
            }
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
          await this.boundaries.checkpoint("transactor.commit");
          // Fresh clocks after the final async checkpoint and immediately
          // before the irreversible storage transaction. Operation batches
          // are isolated, so expiry can abort/rebuild without collateral loss.
          for (const pending of acks) pending.assertFresh?.();
          // ONE storage write for the whole batch (group commit).
          this.host.transactionSync(() => {
            this.boundaries.checkpointSync("transactor.commit.write");
            for (const e of entries) this.appendLogRow(e);
            this.setMeta("next_eid", this.conn.nextEntityId);
            for (const pending of acks) {
              if (pending.receiptCompletion !== undefined) {
                this.finishInvocationReceipt(
                  pending.receiptCompletion.claim,
                  pending.receiptCompletion.event,
                  true,
                );
              }
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
        for (const [id, ack] of batchAcks) this.rememberAck(id, ack);
        for (const a of acks) {
          try {
            // A post-commit expiry cannot undo an authorized atomic write, but
            // REV-5 still forbids emitting its result under an expired lease.
            a.assertFresh?.();
            a.p.resolve(a.ack);
          } catch (err) {
            this.stats.rejected++;
            a.p.reject(err);
          }
        }
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
  private async applyProvision(_p: Pending, _entries: LogEntry[]): Promise<void> {
    return;
  }

  /** Internal/admin transaction path. The public Worker never routes raw application writes here. */
  private async authorize(p: Pending): Promise<TxData> {
    return p.tx;
  }

  /** Internal transaction acks; public operation responses expose only declared output. */
  private async ackDatoms(datoms: Datom[], _principal?: Principal): Promise<WireDatom[]> {
    return datoms.map(toWireDatom);
  }

  private scrub(err: unknown, _p: Pending): unknown {
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

  /** Test-assembly inspection of the real durable receipt table. */
  operationReceiptCount(): number {
    const row = this.host.sql.exec(
      `SELECT COUNT(*) AS count FROM operation_receipts`,
    ).toArray()[0];
    return Number(row?.count ?? 0);
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
          Unauthorized: (e) => Effect.sync(() => errorResponse(e)),
          OperationRejected: (e) => Effect.sync(() => errorResponse(e)),
          TransactorDead: (e) => Effect.sync(() => errorResponse(e)),
          Unavailable: (e) => Effect.sync(() => errorResponse(e)),
          BadRequest: (e) => Effect.sync(() => errorResponse(e)),
          NotFound: (e) => Effect.sync(() => errorResponse(e)),
          Internal: (e) => Effect.sync(() => errorResponse(e)),
        }),
      ),
    );
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/invoke" && request.method === "POST") {
      const body = await request.json() as { invocation?: unknown };
      const raw = body?.invocation;
      const invocation = typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? {
          ...raw,
          ...(Object.hasOwn(raw, "target")
            ? { target: fromJson((raw as { readonly target?: unknown }).target) }
            : {}),
        } as AuthoritativeOperationInvocation
        : undefined;
      if (
        invocation === undefined || invocation.database !== safeName(this.host)
      ) {
        throw new BadRequest({ message: "invalid deployed operation invocation" });
      }
      // The channel is already authenticated, so this is defense in depth
      // rather than an authorization decision. It is not skippable, though: a
      // malformed scope read as "no scope" would make an opaque handle
      // silently unresolvable and a bound slot silently unsealable, and the
      // *decoded* values are the ones used, so the canonical slot order the
      // digest covers cannot depend on how the envelope was serialized (#475).
      const entityIdScope = parseEntityIdScope(invocation.entityIdScope);
      const allocations = parseInvocationAllocations(invocation.allocations);
      if (
        allocations === undefined ||
        (invocation.sealedTarget !== undefined &&
          (typeof invocation.sealedTarget !== "string" ||
            entityIdScope === undefined)) ||
        (allocations.length > 0 && entityIdScope === undefined)
      ) {
        throw new BadRequest({ message: "invalid deployed operation invocation" });
      }
      // The key id the scope was derived under is part of the same claim: a
      // scope without one cannot be checked for epoch agreement, so it is not
      // a usable scope.
      if (
        entityIdScope !== undefined &&
        (typeof invocation.entityIdKeyId !== "string" ||
          invocation.entityIdKeyId.length === 0)
      ) {
        throw new BadRequest({ message: "invalid deployed operation invocation" });
      }
      const resolved: AuthoritativeOperationInvocation = {
        ...invocation,
        ...(entityIdScope === undefined ? {} : { entityIdScope }),
        ...(allocations.length === 0 ? {} : { allocations }),
      };
      // Operation output was already materialized as exact JSON before the
      // commit. Native serialization preserves codec-owned object shapes;
      // the generic Ramose encoder would reinterpret `{ vt, v }` here.
      return new Response(JSON.stringify(await this.invoke(resolved)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/transact" && request.method === "POST") {
      const body = fromJson(await request.json()) as {
        tx?: TxData;
        principal?: unknown;
        clientTxId?: unknown;
      };
      if (!body || !Array.isArray(body.tx)) throw new BadRequest({ message: "body must be { tx: [...] }" });
      const clientTxId = typeof body.clientTxId === "string" && body.clientTxId.length > 0 ? body.clientTxId : undefined;
      const ack = await this.transact(body.tx, asPrincipal(body.principal), clientTxId);
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
