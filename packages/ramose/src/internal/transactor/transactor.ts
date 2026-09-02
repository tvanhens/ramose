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
import * as Result from "effect/Result";
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
  decideEpoch,
  decideInvocationReceipt,
  deployedOperationInputWireShape,
  deployedOperationOutputWireShape,
  deployedOperationVersion,
  executeCatalogOperation,
  inputEntityRefHandles,
  invocationReceiptOutcome,
  isLegacyInvocationReceiptRow,
  OperationRuntimeFault,
  opaqueOperationDenial,
  outputEntityRefPaths,
  parseEntityIdScope,
  parseInvocationAllocations,
  parseStoredInvocationReceipt,
  prepareInvocationReceiptDirect,
  requireSuppliedOperationVersion,
  resolveDeployedCatalogDefinition,
  type ResolvedOperationCatalog,
  resolveSealedInputRefs,
  resolveSealedTarget,
  transitionInvocationReceipt,
  type AuthoritativeInvocationResult,
  type AuthoritativeOperationInvocation,
  type CatalogOperationAdmission,
  type ClaimedInvocationReceipt,
  type InstalledCatalogDefinition,
  type InvocationReceiptEvent,
  type InvocationReceiptOutcome,
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
  commitMs: number;
  resolveMs: number;
  loopMs: number;
  fenceMs: number;
}

interface Pending {
  tx: TxData;
  principal?: Principal | undefined;
  clientTxId?: string | undefined;
  system?: boolean | undefined;
  operation?: AuthoritativeOperationInvocation | undefined;
  sealing?: ServerSealingKey | undefined;
  resolve: (r: TxAck | OperationAck) => void;
  reject: (e: unknown) => void;
}

type SealingContext = {
  readonly sealing: ServerSealingKey;
  readonly scope: EntityIdScope;
};

type InputHandlePaths = ReturnType<typeof inputEntityRefHandles>;

const RECENT_CLIENT_TX_LIMIT = 256;

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

export const MAX_INVOKE_BATCH = 256;

export type InvokeOutcome = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

const LOG_ROWS_PER_INSERT = 32;
const logRowPlaceholders = (rows: number): string => Array.from({ length: rows }, () => "(?, ?, ?)").join(", ");

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
  private readonly recentAcks = new Map<string, TxAck>();
  readonly stats: TransactorStats = { txs: 0, batches: 0, maxBatch: 0, rejected: 0, indexRuns: 0, broadcasts: 0, commitMs: 0, resolveMs: 0, loopMs: 0, fenceMs: 0 };
  readonly txRate = new RateMeter(10_000);
  readonly batchSizes = new Histogram([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
  readonly commitLatency = new Histogram();
  readonly resolveLatency = new Histogram();
  readonly loopLatency = new Histogram();
  readonly fenceLatency = new Histogram();
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
      const roots = await emptyRoots(this.store);
      const fresh = rootsToRecord(roots, { log_watermark: 0, next_eid: FIRST_USER_EID, codec: gzipCodec.name });
      const boot = bootstrapDatoms();
      this.host.transactionSync(() => {
        this.appendLogRows([{ t: 1, txInstant: this.host.now(), datoms: boot }]);
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

  private getMeta<T>(k: string): T | undefined {
    const row = this.host.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? (JSON.parse(row.v as string) as T) : undefined;
  }
  private setMeta(k: string, v: unknown): void {
    this.host.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, JSON.stringify(v));
  }
  private appendLogRows(entries: readonly LogEntry[]): void {
    for (let from = 0; from < entries.length; from += LOG_ROWS_PER_INSERT) {
      const slice = entries.slice(from, from + LOG_ROWS_PER_INSERT);
      const bindings: unknown[] = [];
      for (const e of slice) {
        const body = encodeLogChunk([e]);
        bindings.push(
          e.t,
          e.txInstant,
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        );
      }
      this.host.sql.exec(
        `INSERT INTO log (t, tx_instant, datoms) VALUES ${logRowPlaceholders(slice.length)}`,
        ...bindings,
      );
    }
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

  private completeClaimedReceipt(receipt: TerminalInvocationReceipt): void {
    const updated = this.host.sql.exec(
      `UPDATE operation_receipts SET status = ?, receipt = ?
       WHERE principal_id = ? AND invocation_id = ? AND status = 'claimed'
       RETURNING invocation_id`,
      receipt.status,
      JSON.stringify(receipt),
      receipt.principalId,
      receipt.invocationId,
    ).toArray();
    if (updated.length !== 1) {
      throw new Error("durable invocation claim changed before completion");
    }
  }

  private claimInvocationReceipt(
    prepared: PreparedInvocationReceipt,
    inspected?: ReturnType<typeof decideInvocationReceipt>,
  ) {
    const apply = (decision: ReturnType<typeof decideInvocationReceipt>) => {
      if (decision._tag === "Claim") {
        this.insertInvocationReceipt(decision.receipt);
      } else if (decision._tag === "Recover") {
        this.replaceInvocationReceipt(decision.receipt);
      }
      return decision;
    };
    if (inspected !== undefined) return apply(inspected);
    return this.host.transactionSync(() =>
      apply(decideInvocationReceipt(
        this.readInvocationReceipt(prepared.principalId, prepared.invocationId),
        prepared,
      ))
    );
  }

  private inspectInvocationReceipt(
    prepared: PreparedInvocationReceipt,
  ) {
    const stored = this.readInvocationReceipt(
      prepared.principalId,
      prepared.invocationId,
    );
    return decideInvocationReceipt(stored, prepared);
  }

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

  private finishInvocationReceipt(
    claim: ClaimedInvocationReceipt,
    event: InvocationReceiptEvent,
    insideTransaction = false,
  ): TerminalInvocationReceipt {
    const finish = () => {
      const terminal = transitionInvocationReceipt(claim, event);
      this.completeClaimedReceipt(terminal);
      return terminal;
    };
    return insideTransaction ? finish() : this.host.transactionSync(finish);
  }
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
  earliestLogT(): number {
    const row = this.host.sql.exec(`SELECT MIN(t) AS t FROM log`).toArray()[0];
    return (row?.t as number | null) ?? 0;
  }
  pruneLog(throughT: number): number {
    const before = this.host.sql.exec(`SELECT COUNT(*) AS n FROM log WHERE t <= ?`, throughT).toArray()[0].n as number;
    this.host.sql.exec(`DELETE FROM log WHERE t <= ?`, throughT);
    return before;
  }

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
  adoptRoot(rec: RootRecord): void {
    this.rootRecord = rec;
    this.logWatermark = rec.log_watermark;
    this.setMeta("root", rec);
    this.txSinceIndex = Math.max(0, this.conn.t - rec.t);
    this.stats.indexRuns++;
    this.broadcast({ v: 1, kind: "root", root: rec });
  }

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

  private replayableMappings(
    receipt: TerminalInvocationReceipt,
    context: SealingContext | undefined,
  ): boolean {
    if (receipt.status !== "completed" || receipt.allocations === undefined) {
      return true;
    }
    if (context === undefined) return false;
    return allocationMappingsResolvable(receipt.allocations, {
      keyId: context.sealing.keyId,
      scope: context.scope,
    });
  }

  private decideInvocationEpoch(
    p: Pending,
    inputHandles: InputHandlePaths,
  ):
    | { readonly _tag: "Agreed"; readonly context: SealingContext | undefined }
    | { readonly _tag: "UpdateRequired" }
  {
    const operation = p.operation!;
    if (!this.usesOpaqueHandles(operation, inputHandles)) {
      return { _tag: "Agreed", context: undefined };
    }
    const scope = operation.entityIdScope;
    const keyId = operation.entityIdKeyId;
    if (p.sealing === undefined || scope === undefined || keyId === undefined) {
      throw opaqueOperationDenial();
    }
    const decision = decideEpoch({ keyId, scope }, p.sealing);
    if (decision._tag === "UpdateRequired") return decision;
    return {
      _tag: "Agreed",
      context: { sealing: decision.sealing, scope: decision.scope },
    };
  }

  private usesOpaqueHandles(
    invocation: AuthoritativeOperationInvocation,
    inputHandles: InputHandlePaths,
  ): boolean {
    return invocation.sealedTarget !== undefined ||
      (invocation.allocations !== undefined && invocation.allocations.length > 0) ||
      inputHandles.length > 0;
  }

  private needsSealingKey(
    invocation: AuthoritativeOperationInvocation,
  ): boolean {
    return invocation.sealedTarget !== undefined ||
      (invocation.allocations !== undefined && invocation.allocations.length > 0) ||
      invocation.entityIdScope !== undefined;
  }

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

  private async resolveInvocationInput(
    invocation: AuthoritativeOperationInvocation,
    context: SealingContext | undefined,
    inputHandles: InputHandlePaths,
  ): Promise<AuthoritativeOperationInvocation | undefined> {
    if (inputHandles.length === 0) return invocation;
    if (context === undefined) throw opaqueOperationDenial();
    const resolution = await resolveSealedInputRefs(
      context.sealing,
      context.scope,
      invocation.input,
      inputHandles,
    );
    if (resolution._tag === "UpdateRequired") return undefined;
    if (resolution._tag === "Denied") throw opaqueOperationDenial();
    return Object.freeze({ ...invocation, input: resolution.input });
  }

  async invoke(
    invocation: AuthoritativeOperationInvocation,
  ): Promise<OperationAck> {
    if (this.dead !== undefined) throw new TransactorDeadError(this.dead);
    const runtime = this.operationRuntime;
    if (runtime === undefined) throw opaqueOperationDenial();
    let sealing: ServerSealingKey | undefined;
    if (this.needsSealingKey(invocation)) {
      if (runtime.sealing === undefined || invocation.entityIdScope === undefined) {
        throw opaqueOperationDenial();
      }
      try {
        sealing = await runtime.sealing();
      } catch (cause) {
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
    const count = max > 0 ? Math.min(this.queue.length, max) : this.queue.length;
    return this.queue.splice(0, count);
  }

  private deferOverBudget(batch: Pending[], position: number, startedAt: number): void {
    const budget = this.host.config.batchBudgetMs;
    if (budget <= 0 || position === 0 || position >= batch.length) return;
    if (performance.now() - startedAt < budget) return;
    this.deferFrom(batch, position);
  }

  private deferFrom(batch: Pending[], from: number): void {
    this.queue.unshift(...batch.splice(from));
  }

  private async commitLoop(): Promise<void> {
    try {
      await this.init();
      const fences = this.host.config.timingYields;
      while (this.queue.length > 0 && this.dead === undefined) {
        await yieldToEventLoop();
        let fenceMs = 0;
        if (fences) {
          const tFence = performance.now();
          await yieldToEventLoop();
          fenceMs = performance.now() - tFence;
          this.stats.fenceMs += fenceMs;
          this.fenceLatency.observe(fenceMs);
        }
        const queueDepth = this.queue.length;
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
        const claimedInBatch = new Set<string>();
        const tResolve = performance.now();
        for (let position = 0; position < batch.length; position++) {
          this.deferOverBudget(batch, position, tResolve);
          if (position >= batch.length) break;
          const p = batch[position];
          if (p.operation !== undefined) {
            let claim: ClaimedInvocationReceipt | undefined;
            try {
              if (this.operationRuntime === undefined) {
                throw opaqueOperationDenial();
              }
              const supplied = requireSuppliedOperationVersion(
                p.operation.operationVersion,
              );
              const resolvedCatalog = resolveDeployedCatalogDefinition(
                this.operationRuntime.catalogs,
                {
                  database: p.operation.database,
                  catalogKey: p.operation.catalogKey,
                  unitHash: p.operation.unitHash,
                },
              );
              if (Result.isFailure(resolvedCatalog)) throw opaqueOperationDenial();
              const resolved: ResolvedOperationCatalog = Object.freeze({
                deployed: resolvedCatalog.success,
              });
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
              const inputWireShape = deployedOperationInputWireShape(
                resolved,
                p.operation.owner,
                p.operation.localName,
              );
              if (inputWireShape === undefined) throw opaqueOperationDenial();
              const inputHandles = inputEntityRefHandles(
                inputWireShape,
                p.operation.input,
              );
              const outputWireShape = deployedOperationOutputWireShape(
                resolved,
                p.operation.owner,
                p.operation.localName,
              );
              const outcomeOf = (
                receipt: TerminalInvocationReceipt,
              ): InvocationReceiptOutcome => {
                const outcome = invocationReceiptOutcome(receipt);
                if (
                  outcome._tag !== "Completed" || outputWireShape === undefined
                ) {
                  return outcome;
                }
                const outputRefPaths = outputEntityRefPaths(
                  outputWireShape,
                  outcome.output,
                );
                return outputRefPaths.length === 0
                  ? outcome
                  : { ...outcome, outputRefPaths };
              };
              const operationRuntime = this.operationRuntime;
              const resolveCompatibility = async (
                tag: "OperationChanged" | "UpdateRequired",
              ) => {
                await authorizeCatalogOperationGrant(
                  this.conn,
                  operationRuntime,
                  p.operation!,
                  resolved,
                );
                this.stats.rejected++;
                p.resolve({ _tag: tag });
              };
              if (supplied !== undefined && supplied !== operationVersion) {
                await resolveCompatibility("OperationChanged");
                continue;
              }
              const epoch = this.decideInvocationEpoch(p, inputHandles);
              if (epoch._tag === "UpdateRequired") {
                await resolveCompatibility("UpdateRequired");
                continue;
              }
              const sealingContext = epoch.context;
              const targeted = await this.resolveInvocationTarget(
                p,
                sealingContext,
              );
              if (targeted === undefined) {
                await resolveCompatibility("UpdateRequired");
                continue;
              }
              const operation = await this.resolveInvocationInput(
                targeted,
                sealingContext,
                inputHandles,
              );
              if (operation === undefined) {
                await resolveCompatibility("UpdateRequired");
                continue;
              }
              const prepared = await prepareInvocationReceiptDirect(
                operation,
                operationVersion,
              );
              const receiptKey = `${prepared.principalId}\0${prepared.invocationId}`;
              if (claimedInBatch.has(receiptKey)) {
                this.deferFrom(batch, position);
                break;
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
                  p.resolve(outcomeOf(recovered.receipt));
                  continue;
                }
              }
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
                p.resolve(outcomeOf(inspected.receipt));
                continue;
              }

              const admission: CatalogOperationAdmission =
                await authorizeCatalogOperation(
                  this.conn,
                  this.operationRuntime,
                  operation,
                  resolved,
                );

              const decision = this.claimInvocationReceipt(prepared, inspected);
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
                p.resolve(outcomeOf(decision.receipt));
                continue;
              }
              claim = decision.receipt;
              claimedInBatch.add(receiptKey);
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
                ack: outcomeOf(terminal),
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
            const txInstant = rep.txData[0]?.v as number;
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
        if (fences) await yieldToEventLoop();
        const resolveMs = performance.now() - tResolve;
        this.stats.resolveMs += resolveMs;
        if (entries.length === 0) continue;
        const tWrite = performance.now();
        try {
          await this.boundaries.checkpoint("transactor.commit");
          for (const pending of acks) pending.assertFresh?.();
          this.host.transactionSync(() => {
            this.boundaries.checkpointSync("transactor.commit.write");
            this.appendLogRows(entries);
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
          this.die(`log write failed: ${err instanceof Error ? err.message : String(err)}`, err, acks.map((a) => a.p));
          return;
        }
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
            a.assertFresh?.();
            a.p.resolve(a.ack);
          } catch (err) {
            this.stats.rejected++;
            a.p.reject(err);
          }
        }
        const loopMs = performance.now() - tLoop;
        this.stats.loopMs += loopMs;
        this.loopLatency.observe(loopMs);
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

  private async applyProvision(_p: Pending, _entries: LogEntry[]): Promise<void> {
    return;
  }

  private async authorize(p: Pending): Promise<TxData> {
    return p.tx;
  }

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

  private broadcast(frame: unknown): void {
    const msg = JSON.stringify(frame);
    this.stats.broadcasts++;
    for (const ws of this.host.sockets()) {
      try {
        ws.send(msg);
      } catch {
      }
    }
  }

  onSubscribe(ws: SocketLike, from: number): void {
    ws.send(JSON.stringify({ v: 1, kind: "hello", t: this.conn.t, root: this.rootRecord }));
    this.sendCatchUp(ws, Number.isFinite(from) ? from : 0);
    this.log.info("subscriber.connect", { from, t: this.conn.t, subscribers: this.host.sockets().length });
  }

  onSocketMessage(ws: SocketLike, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg?.kind === "resume" && typeof msg.from === "number") this.sendCatchUp(ws, msg.from);
    else if (msg?.kind === "ping") {
      ws.send(JSON.stringify({ v: 1, kind: "pong", t: this.conn.t, ...(msg.id === undefined ? {} : { id: msg.id }) }));
    } else if (msg?.kind === "write" && this.host.config.socketWrites && Array.isArray(msg.tx)) {
      const id = msg.id;
      const clientTxId = typeof msg.clientTxId === "string" && msg.clientTxId.length > 0 ? msg.clientTxId : undefined;
      void this.transact(msg.tx, undefined, clientTxId).then(
        (ack) => ws.send(JSON.stringify({ v: 1, kind: "ack", id, t: ack.t })),
        (cause) => ws.send(JSON.stringify({
          v: 1,
          kind: "error",
          id,
          message: cause instanceof Error ? cause.message : String(cause),
        })),
      );
    }
  }

  private sendCatchUp(ws: SocketLike, from: number): void {
    const t = this.conn.t;
    if (from >= t) return;
    const earliest = this.earliestLogT();
    if (earliest === 0 || earliest > from + 1) {
      ws.send(JSON.stringify({ v: 1, kind: "gap", from: Math.max(from, earliest - 1) }));
      this.log.warn("subscriber.gap", { from, earliestLogT: earliest, t });
      from = Math.max(from, earliest - 1);
    }
    for (const e of this.readLogEntries(from, t)) ws.send(JSON.stringify(txFrame(e)));
  }

  async onAlarm(): Promise<void> {
    await this.init();
    await this.indexer.onAlarm();
  }

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
      opts: { timingYields: this.host.config.timingYields, maxBatch: this.host.config.maxBatch, batchBudgetMs: this.host.config.batchBudgetMs },
      stats: this.stats,
      metrics: {
        txPerSec: round(this.txRate.rate(this.host.now())),
        batchSize: this.batchSizes.snapshot(),
        commitMs: this.commitLatency.snapshot(),
        avgBatch: this.stats.batches ? round(this.stats.txs / this.stats.batches) : 0,
        resolveMs: round(this.stats.resolveMs),
        loopMs: round(this.stats.loopMs),
        batchResolveMs: this.resolveLatency.snapshot(),
        batchCommitMs: this.commitLatency.snapshot(),
        batchLoopMs: this.loopLatency.snapshot(),
        fenceMs: this.fenceLatency.snapshot(),
        noveltyDatoms: this.conn.noveltyCount,
        queueDepth: this.queue.length,
        ...this.metrics.snapshot(),
      },
      store: this.store.stats,
      indexer: this.indexer.status(),
    };
  }

  operationReceiptCount(): number {
    const row = this.host.sql.exec(
      `SELECT COUNT(*) AS count FROM operation_receipts`,
    ).toArray()[0];
    return Number(row?.count ?? 0);
  }

  private parseInvocation(raw: unknown): AuthoritativeOperationInvocation {
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
    if (
      entityIdScope !== undefined &&
      (typeof invocation.entityIdKeyId !== "string" ||
        invocation.entityIdKeyId.length === 0)
    ) {
      throw new BadRequest({ message: "invalid deployed operation invocation" });
    }
    return {
      ...invocation,
      ...(entityIdScope === undefined ? {} : { entityIdScope }),
      ...(allocations.length === 0 ? {} : { allocations }),
    };
  }

  private async invokeOutcome(raw: unknown): Promise<InvokeOutcome> {
    try {
      return { status: 200, body: await this.invoke(this.parseInvocation(raw)) };
    } catch (cause) {
      const error = toHttpError(cause);
      const response = errorResponse(error);
      const retryAfter = response.headers.get("retry-after");
      return {
        status: response.status,
        body: await response.json(),
        ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
      };
    }
  }

  async handleRequest(request: Request): Promise<Response> {
    await this.init();
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
      const resolved = this.parseInvocation(body?.invocation);
      return new Response(JSON.stringify(await this.invoke(resolved)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/invoke-batch" && request.method === "POST") {
      const body = await request.json() as { invocations?: unknown };
      const raw = Array.isArray(body?.invocations) ? body.invocations : undefined;
      if (raw === undefined || raw.length === 0 || raw.length > MAX_INVOKE_BATCH) {
        throw new BadRequest({ message: "invalid deployed operation invocation batch" });
      }
      const results = await Promise.all(raw.map((entry) => this.invokeOutcome(entry)));
      return json({ results });
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
