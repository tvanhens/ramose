/**
 * QueryReplica Durable Object (M5) — N per database, sharded by region/tenant.
 *
 * - Holds a WebSocket to the Transactor (resume-from-watermark on reconnect,
 *   gap detection via `t` continuity, catch-up from the transactor's /log or
 *   from R2 `log/` chunks). A read with `x-ramose-min-t` also pulls `/log`
 *   when the subscription is open but behind the fence.
 * - Keeps novelty since the current root sorted in memory and spilled to
 *   SQLite (survives eviction/restart without a full resync).
 * - Caches hot segments in SQLite (`segcache`) in front of R2.
 * - Serves `GET /basis` → { t, root, novelty } to Workers, and executes
 *   reads itself (`POST /query`: datalog / pull / entity) — the Worker's
 *   read path forwards here instead of running datalog in the Worker.
 * - Drops novelty ≤ new root on root flip.
 *
 * Workers never talk to the Transactor for reads (invariant §1.5).
 */

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_QUERY_MAX_CELLS,
  type LogEntry,
  type QueryStats,
  type RootRecord,
  type WireDatom,
  type WireFrame,
  componentLogger,
  decodeLogChunk,
  encodeLogChunk,
  entryFromFrame,
  fromJson,
  gzipCodec,
  query as runQuery,
  pull as runPull,
  toJson,
  toWireDatom,
} from "../core/index.ts";
import { type R2Like, R2NodeStore, dbPrefix, prefixedBucket, readCurrentRoot, readLogSince, type ByteTier } from "../storage/index.ts";
import { type RamoseEnv, envInt, internalGate, internalHeaders } from "../transactor/index.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Principal } from "../../worker/auth.ts";
import { Unauthorized } from "../../db/Errors.ts";
import { type Session, type SessionState, type SocketLike, openSession, parsePrincipalHeader, PRINCIPAL_HEADER, TEST_SESSION_TOKEN_HEADER, WRITES_HEADER } from "../../worker/session.ts";
import { fromEnv as jwtVerifierFromEnv } from "../../worker/jwt.ts";
import { type WritesMode, parseWritesHeader } from "../../writes.ts";
import { decideSessionTx, type SessionLog, type SessionLogEntry, type SessionTxDecision } from "../../worker/session-sync.ts";
import { type Basis, dbFromBasis, makeBasis } from "./basis.ts";
import { replicaErrorResponse, toReplicaError } from "./errors.ts";
import { checkpoint, handleIsolateTestAdmin, resetTestHooks, testHooksEnabled } from "../test-hooks.ts";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), { status, headers: { "content-type": "application/json", ...extra } });

const DEPLOYMENT_HEADER = "x-ramose-deployment";
const LIVE_DEPLOYMENT_INTERVAL_MS = 2_000;
const LIVE_DEPLOYMENT_TIMEOUT_MS = 2_000;
const LIVE_UPSTREAM_WATCH_INTERVAL_MS = 1_000;
const LIVE_UPSTREAM_STALE_MS = 3_500;
const LIVE_UPSTREAM_CATCHUP_TIMEOUT_MS = 2_000;

const withAbortTimeout = async <A>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<A>,
): Promise<A> => {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

type BasisWatchAttachment = {
  readonly kind: "basis-watch";
  readonly expectedDeployment: string;
  readonly healthUrl: string;
};

/** Client read fence (`x-ramose-min-t` or `?minT=`). */
function requestedMinT(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** SQLite-backed byte tier for segment bodies (bounded by row count, LRU-ish by insertion). */
class SqliteTier implements ByteTier {
  constructor(private readonly sql: SqlStorage, private readonly maxRows = 2000) {
    sql.exec(`CREATE TABLE IF NOT EXISTS segcache (k TEXT PRIMARY KEY, body BLOB NOT NULL, ts INTEGER NOT NULL)`);
  }
  get(key: string): Uint8Array | undefined {
    const row = this.sql.exec(`SELECT body FROM segcache WHERE k = ?`, key).toArray()[0];
    return row ? new Uint8Array(row.body as ArrayBuffer) : undefined;
  }
  put(key: string, body: Uint8Array): void {
    this.sql.exec(`INSERT OR REPLACE INTO segcache (k, body, ts) VALUES (?, ?, ?)`, key, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), Date.now());
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM segcache`).toArray()[0].n as number;
    if (n > this.maxRows) {
      this.sql.exec(`DELETE FROM segcache WHERE k IN (SELECT k FROM segcache ORDER BY ts ASC LIMIT ?)`, Math.ceil(this.maxRows / 10));
    }
  }
}

export class QueryReplicaDO extends DurableObject<RamoseEnv> {
  private readonly sql: SqlStorage;
  private ready: Promise<void> | undefined;
  private store!: R2NodeStore;
  private dbName: string | undefined;
  private root: RootRecord | undefined;
  private entries: LogEntry[] = []; // novelty since root, ascending t
  private ws: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private syncing: Promise<void> | undefined;
  /** In-order apply of upstream frames; `sync` drains this before serving a basis. */
  private applyChain: Promise<void> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = 0;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastUpstreamAt = 0;
  readonly stats = { frames: 0, gaps: 0, reconnects: 0, rootFlips: 0, basisServed: 0, queries: 0, budgetAborts: 0 };
  private readonly log = componentLogger("replica");
  /** Live session protocol objects (rebuilt from hibernation attachments). */
  private readonly live = new Map<WebSocket, Session>();

  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
    resetTestHooks();
    this.sql = ctx.storage.sql;
  }

  // ---------------------------------------------------------------------------
  // Boot / persistence
  // ---------------------------------------------------------------------------

  private init(): Promise<void> {
    if (!this.ready) this.ready = this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS novelty (t INTEGER PRIMARY KEY, tx_instant INTEGER NOT NULL, datoms BLOB NOT NULL)`);
    this.dbName = this.getMeta<string>("db");
    if (this.dbName) this.bindStore(this.dbName);
    this.root = this.getMeta<RootRecord>("root");
    if (this.root) {
      const rows = this.sql.exec(`SELECT t, tx_instant, datoms FROM novelty WHERE t > ? ORDER BY t`, this.root.t).toArray();
      this.entries = rows.map((r) => decodeLogChunk(new Uint8Array(r.datoms as ArrayBuffer))[0]);
    }
  }

  /** Per-database view of the bucket (all keys under db/<name>/). */
  private bucket!: R2Like;
  private bindStore(db: string): void {
    this.bucket = prefixedBucket(this.env.STORE, dbPrefix(db));
    this.store = new R2NodeStore(this.bucket, { codec: gzipCodec, maxNodes: 4096, tier: new SqliteTier(this.sql) });
  }

  private getMeta<T>(k: string): T | undefined {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? (JSON.parse(row.v as string) as T) : undefined;
  }
  private setMeta(k: string, v: unknown): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, JSON.stringify(v));
  }

  get basisT(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].t : (this.root?.t ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Novelty protocol
  // ---------------------------------------------------------------------------

  private appendEntry(e: LogEntry): void {
    this.entries.push(e);
    const body = encodeLogChunk([e]);
    this.sql.exec(`INSERT OR REPLACE INTO novelty (t, tx_instant, datoms) VALUES (?, ?, ?)`, e.t, e.txInstant, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }

  /**
   * Apply one dense log frame, then walk every attached session. The follow
   * cursor is `basisT` after this returns — it does not move on a poll.
   */
  private async applyDatoms(e: LogEntry): Promise<void> {
    await checkpoint("replica.apply");
    this.appendEntry(e);
    await checkpoint("session.notify");
    await this.notifySessions(e);
  }

  private adoptRoot(rec: RootRecord): void {
    if (this.root && rec.t <= this.root.t) return;
    const beforeT = this.basisT;
    this.root = rec;
    this.setMeta("root", rec);
    // drop novelty absorbed by the new root
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.t > rec.t);
    this.sql.exec(`DELETE FROM novelty WHERE t <= ?`, rec.t);
    this.stats.rootFlips++;
    this.log.info("replica.root", { db: this.dbName, rootT: rec.t, noveltyBefore: before, noveltyAfter: this.entries.length });
    if (this.basisT !== beforeT) this.notifyBasisWatches(this.basisT);
  }

  private async handleFrame(frame: WireFrame): Promise<void> {
    this.stats.frames++;
    switch (frame.kind) {
      case "hello": {
        const rec = frame.root as RootRecord;
        if (!this.root || rec.t > this.root.t) this.adoptRoot(rec);
        if (frame.t > this.basisT + 0) {
          // transactor is ahead; it will send catch-up frames (or a gap frame) right after hello
        }
        break;
      }
      case "root":
        this.adoptRoot(frame.root as RootRecord);
        break;
      case "gap":
        this.stats.gaps++;
        this.log.warn("replica.gap", { db: this.dbName, from: frame.from, basisT: this.basisT });
        await withAbortTimeout(
          LIVE_UPSTREAM_CATCHUP_TIMEOUT_MS,
          async (signal) => {
            await this.catchUpFromR2(frame.from);
            if (signal.aborted) throw new Error("upstream catch-up timed out");
          },
        );
        break;
      case "tx": {
        const e = entryFromFrame(frame);
        const expected = this.basisT + 1;
        if (e.t < expected) return; // duplicate / already applied
        if (e.t > expected) {
          // gap: fill from the transactor's log (or R2), then apply this frame
          this.stats.gaps++;
          this.log.warn("replica.gap", { db: this.dbName, expected, got: e.t });
          await withAbortTimeout(
            LIVE_UPSTREAM_CATCHUP_TIMEOUT_MS,
            (signal) => this.fillGap(this.basisT, e.t - 1, signal),
          );
          if (e.t !== this.basisT + 1) return; // still inconsistent; a resume will fix it
        }
        if (!this.root || e.t > this.root.t) await this.applyDatoms(e);
        break;
      }
    }
  }

  /** Fetch (from, to] from the transactor's HTTP /log, falling back to R2 chunks. */
  private async fillGap(from: number, to: number, signal?: AbortSignal): Promise<void> {
    if (!this.dbName) return;
    try {
      const stub = this.env.TRANSACTOR.get(this.env.TRANSACTOR.idFromName(this.dbName));
      const res = await stub.fetch(`https://transactor/log?from=${from}&to=${to}&db=${encodeURIComponent(this.dbName)}`, {
        headers: internalHeaders(this.env),
        ...(signal === undefined ? {} : { signal }),
      });
      if (res.ok) {
        const body = (await res.json()) as { earliestLogT: number; entries: any[] };
        if (body.earliestLogT !== 0 && body.earliestLogT <= from + 1) {
          for (const f of body.entries) {
            if (signal?.aborted) throw new Error("upstream catch-up timed out");
            const e = entryFromFrame(f);
            if (e.t === this.basisT + 1) await this.applyDatoms(e);
          }
          return;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      this.log.warn("replica.log.fetch.failed", { db: this.dbName, error: String(err), from, to });
    }
    if (signal?.aborted) throw new Error("upstream catch-up timed out");
    await this.catchUpFromR2(from, to);
    if (signal?.aborted) throw new Error("upstream catch-up timed out");
  }

  /** Read log/ chunks from R2 for t in (from, to] and apply in order. */
  private async catchUpFromR2(from: number, to = Number.MAX_SAFE_INTEGER): Promise<void> {
    if (!this.root) {
      const rec = await readCurrentRoot(this.bucket);
      if (rec) this.adoptRoot(rec);
    }
    const entries = await readLogSince(this.bucket, Math.max(from, this.basisT), to, gzipCodec);
    for (const e of entries) if (e.t === this.basisT + 1) await this.applyDatoms(e);
  }

  /** Establish (or re-establish) the WS subscription to the Transactor. */
  private async ensureConnected(): Promise<void> {
    if (this.ws && (this.ws.readyState === 1 /* OPEN */ || this.ws.readyState === 0)) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectUpstream().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connectUpstream(): Promise<void> {
    if (!this.dbName) throw new Error("replica has no db assigned");
    if (!this.root) {
      const rec = await readCurrentRoot(this.bucket);
      if (rec) this.adoptRoot(rec);
    }
    const stub = this.env.TRANSACTOR.get(this.env.TRANSACTOR.idFromName(this.dbName));
    const res = await stub.fetch(`https://transactor/subscribe?from=${this.basisT}&db=${encodeURIComponent(this.dbName)}`, { headers: { Upgrade: "websocket", ...internalHeaders(this.env) } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`transactor did not upgrade (status ${res.status})`);
    ws.accept();
    this.ws = ws;
    this.stats.reconnects++;
    this.reconnectDelayMs = 0;
    this.lastUpstreamAt = Date.now();
    this.log.info("replica.connect", { db: this.dbName, from: this.basisT, reconnects: this.stats.reconnects, novelty: this.entries.length });
    ws.addEventListener("message", (ev) => this.enqueueFrame(ev));
    const drop = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.closeBasisWatches("upstream disconnected");
      // Listening sessions never call `sync()`. Retry with backoff until the
      // socket is back or every attached session is gone.
      this.scheduleReconnect();
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
    if (this.listening()) this.armWatch();
    // give the hello + catch-up a moment so the first basis is fresh
    await new Promise((r) => setTimeout(r, 20));
    await this.drainFrames();
  }

  private listening(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  /** Retry `ensureConnected` with backoff while live sessions are attached. */
  private scheduleReconnect(): void {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) return;
    if (this.connecting || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const run = this.ensureConnected()
        .then(() => {
          this.reconnectDelayMs = 0;
          if (this.listening()) this.armWatch();
        })
        .catch((err) => {
          this.log.warn("replica.reconnect.failed", { db: this.dbName, error: String(err), basisT: this.basisT, delayMs: this.reconnectDelayMs });
          this.reconnectDelayMs = this.reconnectDelayMs === 0 ? 250 : Math.min(8_000, this.reconnectDelayMs * 2);
          if (this.listening()) this.scheduleReconnect();
        });
      this.ctx.waitUntil?.(run);
    }, delay);
  }

  /**
   * Ping the transactor while sessions are attached. A pong carries `t` and
   * runs `catchUpTo` so an open-but-silent novelty socket still wakes live
   * subscribers. No pong for a few ticks → drop and reconnect.
   */
  private armWatch(): void {
    if (this.watchTimer !== undefined) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.tickWatch().finally(() => {
        if (this.listening()) this.armWatch();
      });
    }, LIVE_UPSTREAM_WATCH_INTERVAL_MS);
  }

  private async tickWatch(): Promise<void> {
    if (!this.listening()) return;
    if (!this.ws || this.ws.readyState !== 1) {
      this.closeBasisWatches("upstream unavailable");
      this.scheduleReconnect();
      return;
    }
    if (this.lastUpstreamAt !== 0 && Date.now() - this.lastUpstreamAt > LIVE_UPSTREAM_STALE_MS) {
      this.log.warn("replica.upstream.stale", { db: this.dbName, basisT: this.basisT, silentMs: Date.now() - this.lastUpstreamAt });
      this.closeBasisWatches("upstream stale");
      try {
        this.ws.close(1000, "stale");
      } catch {
        /* already gone */
      }
      this.ws = undefined;
      this.scheduleReconnect();
      return;
    }
    try {
      this.ws.send(JSON.stringify({ kind: "ping" }));
    } catch {
      this.closeBasisWatches("upstream ping failed");
      this.ws = undefined;
      this.scheduleReconnect();
    }
  }

  /**
   * Run `work` after every previously queued apply, without letting a
   * rejection become the permanent `applyChain` value (later frames would
   * skip their callbacks). The returned promise still rejects so a fenced
   * read can fail the request.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.applyChain.then(work);
    this.applyChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private enqueueFrame(ev: MessageEvent): void {
    void this.onUpstreamData(String(ev.data));
  }

  /** Transactor novelty frames, or a `pong` that fences catch-up for live sessions. */
  private async onUpstreamData(data: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch (err) {
      console.error("replica: bad frame", err);
      this.closeBasisWatches("invalid upstream frame");
      return;
    }
    this.lastUpstreamAt = Date.now();
    if (raw !== null && typeof raw === "object" && (raw as { kind?: unknown }).kind === "pong") {
      const t = (raw as { t?: unknown }).t;
      if (typeof t === "number") {
        try {
          await withAbortTimeout(
            LIVE_UPSTREAM_CATCHUP_TIMEOUT_MS,
            (signal) => this.catchUpTo(t, signal),
          );
        } catch (err) {
          this.log.warn("replica.watch.catchup.failed", { db: this.dbName, error: String(err), basisT: this.basisT, targetT: t });
          this.closeBasisWatches("upstream catch-up failed");
        }
      }
      return;
    }
    await this.enqueue(async () => {
      try {
        await this.handleFrame(raw as WireFrame);
      } catch (err) {
        console.error("replica: bad frame", err);
        this.closeBasisWatches("upstream apply failed");
      }
    });
  }

  /** Wait for the apply-chain tail captured now — do not chase later frames. */
  private async drainFrames(): Promise<void> {
    await this.applyChain;
  }

  /**
   * Pull `(basisT, minT]` from the transactor SQL log when the WS
   * subscription is open-but-stale (broadcasts dropped under load).
   * Enqueued on `applyChain` so a live frame cannot double-apply the same t.
   * Fenced HTTP reads and upstream `pong` (live-session watch) both call this.
   */
  private async catchUpTo(minT: number | undefined, signal?: AbortSignal): Promise<void> {
    if (minT === undefined || this.basisT >= minT) return;
    const target = minT;
    await this.enqueue(async () => {
      if (signal?.aborted) throw new Error("upstream catch-up timed out");
      if (this.basisT >= target) return;
      await this.fillGap(this.basisT, target, signal);
    });
  }

  /** Make sure we are connected and caught up (bounded wait). */
  private async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        await this.ensureConnected();
        await this.drainFrames();
      } catch (err) {
        // transactor unreachable: serve from R2 (root + log chunks) — stale but consistent
        this.log.warn("replica.connect.failed", { db: this.dbName, error: String(err), basisT: this.basisT });
        await this.catchUpFromR2(this.basisT).catch(() => undefined);
        if (this.listening()) this.scheduleReconnect();
      }
    })().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  // ---------------------------------------------------------------------------
  // Session follow (apply-then-push)
  // ---------------------------------------------------------------------------

  private sessionLog(): SessionLog {
    return {
      t: this.basisT,
      rootT: this.root?.t ?? 0,
      entries: this.entries.map((e) => ({ t: e.t, datoms: e.datoms.map(toWireDatom) })),
    };
  }

  private async sieve(entry: SessionLogEntry, p?: Principal): Promise<SessionTxDecision> {
    if (!this.root || !this.dbName) return { kind: "skip" };
    const basis = makeBasis(this.dbName, this.root, this.entries);
    const raw = await dbFromBasis(this.store, basis);
    return decideSessionTx({
      datoms: [],
      ...(p !== undefined ? { principal: p } : {}),
      ruleDbAfter: raw,
      ruleDbBefore: raw,
    });
  }

  private async snapshotView(_p?: Principal): Promise<{ t: number; datoms: WireDatom[] }> {
    return { t: this.basisT, datoms: [] };
  }

  private async provisionPrincipal(p: Principal): Promise<Principal> {
    if (this.dbName === undefined) return p;
    const dbName = this.dbName;
    try {
      const stub = this.env.TRANSACTOR.get(this.env.TRANSACTOR.idFromName(dbName));
      const res = await stub.fetch(`https://transactor/provision?db=${encodeURIComponent(dbName)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalHeaders(this.env) },
        body: JSON.stringify({ principal: p }),
      });
      if (!res.ok) return p;
      const body = (await res.json()) as { eid?: unknown };
      if (typeof body.eid !== "number") return p;
      return { ...p, eid: body.eid };
    } catch {
      return p;
    }
  }

  /** Test-session authentication still uses the deployed peer's real JWT verifier. */
  private async authenticateTestSession(token: string): Promise<Principal> {
    if (!testHooksEnabled(this.env)) throw new Unauthorized({});
    try {
      const verified = await Effect.runPromise(
        jwtVerifierFromEnv(this.env).verify(Redacted.make(token)),
      );
      return verified.principal;
    } catch {
      throw new Unauthorized({});
    }
  }

  private createSession(ws: WebSocket, seed: SessionState): Session {
    return openSession(ws as unknown as SocketLike, {
      listen: false,
      seed,
      ...(seed.principal !== undefined && { principal: seed.principal }),
      dispatch: (rest, init, p) => this.sessionDispatch(rest, init, p, seed.writes),
      authenticate: (token) => this.authenticateTestSession(token),
      provision: (p) => this.provisionPrincipal(p),
      describe: async (p) => ({ eid: p.eid ?? null, class: p.class }),
      readLog: async () => {
        await this.sync();
        return this.sessionLog();
      },
      filterEntry: (entry, p) => this.sieve(entry, p),
      snapshot: (p) => this.snapshotView(p),
    });
  }

  private sessionOf(ws: WebSocket): Session {
    const hit = this.live.get(ws);
    if (hit) return hit;
    const raw = typeof ws.deserializeAttachment === "function" ? ws.deserializeAttachment() : undefined;
    const seed = (raw ?? { lastT: 0, watermark: 0 }) as SessionState;
    const s = this.createSession(ws, seed);
    this.live.set(ws, s);
    return s;
  }

  private persist(ws: WebSocket, s: Session): void {
    try {
      ws.serializeAttachment?.(s.state());
    } catch {
      /* attachment is optional outside workerd */
    }
  }

  private basisWatchOf(ws: WebSocket): BasisWatchAttachment | undefined {
    try {
      const raw = ws.deserializeAttachment?.() as Partial<BasisWatchAttachment> | undefined;
      if (
        raw?.kind === "basis-watch" &&
        typeof raw.expectedDeployment === "string" &&
        raw.expectedDeployment.length > 0 &&
        typeof raw.healthUrl === "string"
      ) {
        return raw as BasisWatchAttachment;
      }
    } catch {
      /* malformed attachments are ordinary sessions and fail closed there */
    }
    return undefined;
  }

  private basisWatches(): readonly [WebSocket, BasisWatchAttachment][] {
    const watches: [WebSocket, BasisWatchAttachment][] = [];
    for (const ws of this.ctx.getWebSockets() as WebSocket[]) {
      const attachment = this.basisWatchOf(ws);
      if (attachment !== undefined) watches.push([ws, attachment]);
    }
    return watches;
  }

  private async armDeploymentWatch(): Promise<void> {
    const next = Date.now() + LIVE_DEPLOYMENT_INTERVAL_MS;
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null || armed > next) await this.ctx.storage.setAlarm(next);
  }

  private notifyBasisWatches(t: number): void {
    if (this.dbName === undefined || this.root === undefined) {
      this.closeBasisWatches("basis unavailable");
      return;
    }
    const basis = makeBasis(
      this.dbName,
      this.root,
      this.entries,
      this.ctx.id.toString().slice(0, 8),
    );
    const body = JSON.stringify({ kind: "basis", t, basis });
    for (const [ws] of this.basisWatches()) {
      try {
        ws.send(body);
      } catch {
        try {
          ws.close(1011, "basis notification failed");
        } catch {
          /* already gone */
        }
      }
    }
  }

  private closeBasisWatches(reason: string): void {
    for (const [ws] of this.basisWatches()) {
      try {
        ws.close(1011, reason);
      } catch {
        /* already gone */
      }
    }
  }

  private async notifySessions(e: LogEntry): Promise<void> {
    const entry: SessionLogEntry = { t: e.t, datoms: e.datoms.map(toWireDatom) };
    const rootT = this.root?.t ?? 0;
    this.notifyBasisWatches(e.t);
    const sockets = this.ctx.getWebSockets() as WebSocket[];
    for (const ws of sockets) {
      if (this.basisWatchOf(ws) !== undefined) continue;
      const s = this.sessionOf(ws);
      try {
        await s.applyEntry(entry, rootT);
        this.persist(ws, s);
      } catch {
        this.live.delete(ws);
        try {
          ws.close(1011, "session filter failed");
        } catch {
          /* already gone */
        }
      }
    }
  }

  private async sessionDispatch(
    rest: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    principal?: Principal,
    writes?: WritesMode,
  ): Promise<Response> {
    await this.sync();
    await this.catchUpTo(requestedMinT(init.headers["x-ramose-min-t"]));
    if (!this.root) return json({ error: "database has no root yet" }, 503);
    if (rest === "/op" && init.method === "POST") {
      return json({ error: "operations must be POSTed to /db/:name/op" }, 400);
    }
    if (rest === "/transact" && init.method === "POST") {
      return json({ error: "unauthorized" }, 401);
    }
    if (rest === "/info" && init.method === "GET") {
      return json({ error: "unauthorized" }, 401);
    }
    if (rest === "/query" && init.method === "POST") {
      return json({ error: "unauthorized" }, 401);
    }
    if (rest === "/pull" && init.method === "POST") {
      return json({ error: "unauthorized" }, 401);
    }
    if (/^\/entity\/(\d+)$/.exec(rest.split("?")[0] ?? "") && init.method === "GET") {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ error: "not found" }, 404);
  }

  private async upgradeSession(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    await this.sync();
    let raw = parsePrincipalHeader(request.headers.get(PRINCIPAL_HEADER));
    const testToken = request.headers.get(TEST_SESSION_TOKEN_HEADER);
    if (testToken !== null) {
      try {
        raw = await this.authenticateTestSession(testToken);
      } catch {
        return json({ error: "unauthorized" }, 401);
      }
    }
    const principal = raw !== undefined ? await this.provisionPrincipal(raw) : undefined;
    const writes = parseWritesHeader(request.headers.get(WRITES_HEADER));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    this.armWatch();
    const seed: SessionState = {
      ...(principal !== undefined ? { principal } : {}),
      ...(writes !== undefined ? { writes } : {}),
      lastT: 0,
      watermark: 0,
    };
    const session = this.createSession(server, seed);
    this.live.set(server, session);
    this.persist(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async upgradeBasisWatch(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    const expectedDeployment = request.headers.get("x-ramose-live-deployment") ?? "";
    const healthUrl = request.headers.get("x-ramose-live-health") ?? "";
    let health: URL;
    try {
      health = new URL(healthUrl);
    } catch {
      return json({ error: "invalid deployment watch" }, 400);
    }
    if (
      expectedDeployment.length === 0 ||
      (health.protocol !== "https:" && health.protocol !== "http:") ||
      health.pathname !== "/health" ||
      health.username !== "" ||
      health.password !== ""
    ) {
      return json({ error: "invalid deployment watch" }, 400);
    }
    await this.sync();
    if (this.ws?.readyState !== 1) {
      return json({ error: "replica upstream unavailable" }, 503);
    }
    if (this.dbName === undefined || this.root === undefined) {
      return json({ error: "database has no root yet" }, 503);
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment?.({
      kind: "basis-watch",
      expectedDeployment,
      healthUrl: health.href,
    } satisfies BasisWatchAttachment);
    const basis = makeBasis(
      this.dbName,
      this.root,
      this.entries,
      this.ctx.id.toString().slice(0, 8),
    );
    server.send(JSON.stringify({ kind: "ready", t: basis.t, basis }));
    this.armWatch();
    await this.armDeploymentWatch();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.init();
    if (this.basisWatchOf(ws) !== undefined) return;
    const s = this.sessionOf(ws);
    await s.onMessage(message);
    this.persist(ws, s);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (this.basisWatchOf(ws) !== undefined) {
      try {
        ws.close(code, "bye");
      } catch {
        /* already gone */
      }
      return;
    }
    const s = this.live.get(ws);
    s?.close();
    this.live.delete(ws);
    try {
      ws.close(code, "bye");
    } catch {
      /* already gone */
    }
  }

  /**
   * Deployment probes run as separate Durable Object alarm invocations, so a
   * long-lived Worker response never accumulates one subrequest per lease.
   * Any failed or mismatched probe closes the internal watch and therefore
   * fails the live response closed before its next five-second lease.
   */
  override async alarm(): Promise<void> {
    await this.init();
    const watches = this.basisWatches();
    if (watches.length === 0) return;
    if (
      this.ws?.readyState !== 1 ||
      this.lastUpstreamAt === 0 ||
      Date.now() - this.lastUpstreamAt > LIVE_UPSTREAM_STALE_MS
    ) {
      this.closeBasisWatches("upstream freshness lost");
      return;
    }
    const byHealthUrl = new Map<string, [WebSocket, BasisWatchAttachment][]>();
    for (const item of watches) {
      const group = byHealthUrl.get(item[1].healthUrl);
      if (group === undefined) byHealthUrl.set(item[1].healthUrl, [item]);
      else group.push(item);
    }
    await Promise.all([...byHealthUrl].map(async ([healthUrl, group]) => {
      let currentDeployment: string | undefined;
      try {
        // One bounded probe per distinct public route fences every subscriber
        // on that route without charging the long-lived Worker invocation.
        currentDeployment = await withAbortTimeout(
          LIVE_DEPLOYMENT_TIMEOUT_MS,
          async (signal) => {
            const health = new URL(healthUrl);
            health.searchParams.set("live-renew", crypto.randomUUID());
            const response = await fetch(health, {
              method: "GET",
              headers: { "cache-control": "no-cache" },
              redirect: "error",
              signal,
            });
            const value = response.headers.get(DEPLOYMENT_HEADER);
            return response.ok && value !== null && value.length > 0 ? value : undefined;
          },
        );
      } catch {
        /* an ambiguous deployment probe fails this route's watches closed */
      }
      for (const [ws, watch] of group) {
        if (currentDeployment === watch.expectedDeployment) continue;
        try {
          ws.close(1000, "deployment changed");
        } catch {
          /* already gone */
        }
      }
    }));
    if (this.basisWatches().length > 0) await this.armDeploymentWatch();
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    // reachable only from the peer Worker
    const gate = internalGate(this.env, request);
    if (gate) return gate;
    await this.init();
    const url = new URL(request.url);
    const dbParam = url.searchParams.get("db");
    if (dbParam && dbParam !== this.dbName) {
      if (this.dbName !== undefined) return json({ error: `replica already bound to database ${this.dbName}` }, 409);
      this.dbName = dbParam;
      this.setMeta("db", dbParam);
      this.bindStore(dbParam);
    }
    if (!this.dbName) return json({ error: "missing ?db=" }, 400);
    if (url.pathname === "/session") return this.upgradeSession(request);
    if (url.pathname === "/watch") return this.upgradeBasisWatch(request);
    // Route dispatch as an Effect program: the routes stay plain async/await,
    // failures are classified into tagged errors (errors.ts) and mapped back to
    // exactly the statuses/bodies this endpoint returned before.
    return Effect.runPromise(
      Effect.tryPromise({ try: () => this.route(request, url, this.dbName as string), catch: toReplicaError }).pipe(
        Effect.catchTags({
          QueryBudget: (e) =>
            Effect.sync(() => {
              this.stats.budgetAborts++;
              this.log.warn("query.budget-exceeded", { db: this.dbName, clause: e.clause, cells: e.cells, limit: e.limit, spentBy: e.spentBy ?? "caller" });
              return replicaErrorResponse(e);
            }),
          BadRequest: (e) => Effect.sync(() => replicaErrorResponse(e)),
          Internal: (e) => Effect.sync(() => replicaErrorResponse(e)),
        }),
      ),
    );
  }

  private async route(request: Request, url: URL, dbName: string): Promise<Response> {
    switch (url.pathname) {
      case "/basis": {
        await this.sync();
        await this.catchUpTo(requestedMinT(url.searchParams.get("minT") ?? request.headers.get("x-ramose-min-t")));
        if (!this.root) return json({ error: "database has no root yet" }, 503);
        this.stats.basisServed++;
        if (this.stats.basisServed % 100 === 1) this.log.debug("replica.basis", { db: this.dbName, t: this.basisT, rootT: this.root.t, novelty: this.entries.length, served: this.stats.basisServed });
        const basis: Basis = makeBasis(dbName, this.root, this.entries, this.ctx.id.toString().slice(0, 8));
        return json(basis);
      }
      case "/query": {
        // Internal replica read. External one-shot query/pull/entity go through
        // executeAuthorizedRequest on the Worker (#423). This path is not that
        // authorization boundary.
        await this.sync();
        await this.catchUpTo(requestedMinT(url.searchParams.get("minT") ?? request.headers.get("x-ramose-min-t")));
        if (!this.root) return json({ error: "database has no root yet" }, 503);
        const body = fromJson(await request.json()) as {
          query?: unknown;
          inputs?: unknown[];
          asOf?: number;
          history?: boolean;
          explain?: boolean;
          pull?: { eid: number | string | [string, unknown]; pattern: unknown };
          entity?: number;
        };
        if (!body || (!body.query && !body.pull && typeof body.entity !== "number")) return json({ error: "body must be { query, inputs? } | { pull } | { entity }" }, 400);
        const basis = makeBasis(dbName, this.root, this.entries);
        const before = { ...this.store.stats };
        const db = await dbFromBasis(this.store, basis, {
          ...(typeof body.asOf === "number" && { asOf: body.asOf }),
          history: !!body.history,
        });
        this.stats.queries++;
        const hdrs = () => ({
          "x-ramose-basis-t": String(basis.t),
          "x-ramose-r2-gets": String(this.store.stats.r2Gets - before.r2Gets),
          "x-ramose-cache-hits": String(this.store.stats.cacheHits + this.store.stats.tierHits + this.store.stats.memHits - before.cacheHits - before.tierHits - before.memHits),
        });
        if (typeof body.entity === "number") return json({ t: basis.t, entity: await db.entity(body.entity) }, 200, hdrs());
        if (body.pull) {
          const eid = typeof body.pull.eid === "number" ? body.pull.eid : await db.entid(body.pull.eid as any);
          if (eid === undefined) return json({ t: basis.t, result: null }, 200, hdrs());
          return json({ t: basis.t, result: await runPull(db, eid, body.pull.pattern as any) }, 200, hdrs());
        }
        const stats: QueryStats = { clauses: [] };
        const result = await runQuery(db, body.query as any, body.inputs ?? [], { stats, maxCells: envInt(this.env.RAMOSE_QUERY_MAX_CELLS, DEFAULT_QUERY_MAX_CELLS) });
        if (this.stats.queries % 100 === 1) this.log.debug("replica.query", { db: this.dbName, t: basis.t, rows: Array.isArray(result) ? result.length : 1, novelty: this.entries.length, peakCells: stats.budget?.peakCells });
        return json({ t: basis.t, root: basis.root.t, result, ...(body.explain ? { explain: stats.clauses, budget: stats.budget } : {}) }, 200, hdrs());
      }
      case "/info":
        return json({ db: this.dbName, t: this.basisT, root: this.root, novelty: this.entries.length, connected: this.ws?.readyState === 1, stats: this.stats, store: this.store.stats });
      case "/admin/test/sessions": {
        if (!testHooksEnabled(this.env)) return json({ error: "not found" }, 404);
        const sessions = (this.ctx.getWebSockets() as WebSocket[])
          .filter((ws) => this.basisWatchOf(ws) === undefined)
          .map((ws) => this.sessionOf(ws).state());
        return json({ ok: true, sessions });
      }
      case "/admin/test/checkpoint":
      case "/admin/test/abort": {
        const testAdmin = await handleIsolateTestAdmin(request, url.pathname, (reason) =>
          this.ctx.abort(reason),
        );
        if (testAdmin !== undefined) return testAdmin;
        return json({ error: "not found" }, 404);
      }
      case "/admin/reconnect": {
        this.closeBasisWatches("upstream reconnecting");
        try {
          this.ws?.close(1000, "reconnect");
        } catch {}
        this.ws = undefined;
        await this.sync();
        return json({ ok: true, t: this.basisT });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }
}
