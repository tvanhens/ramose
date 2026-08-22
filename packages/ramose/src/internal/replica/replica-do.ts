/**
 * QueryReplica Durable Object (M5) — N per database, sharded by region/tenant.
 *
 * - Holds a WebSocket to the Transactor (resume-from-watermark on reconnect,
 *   gap detection via `t` continuity, catch-up from the transactor's /log or
 *   from R2 `log/` chunks).
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
  type Principal,
  type QueryStats,
  anonymousPrincipal,
  componentLogger,
  type LogEntry,
  type RootRecord,
  type WireDatom,
  type WireFrame,
  decodeLogChunk,
  encodeLogChunk,
  entryFromFrame,
  fromJson,
  fromWireDatom,
  gzipCodec,
  query as runQuery,
  pull as runPull,
  toJson,
  toWireDatom,
} from "../core/index.ts";
import { type R2Like, R2NodeStore, dbPrefix, prefixedBucket, readCurrentRoot, readLogSince, type ByteTier } from "../storage/index.ts";
import { type RamoseEnv, envInt, internalGate, internalHeaders } from "../transactor/index.ts";
import * as Effect from "effect/Effect";
import { authState, describePrincipal, principalForToken, rememberProvisioned, shouldProvision, viewDb, withEid } from "../../worker/auth.ts";
import { type Session, type SessionState, type SocketLike, openSession, parsePrincipalHeader, PRINCIPAL_HEADER } from "../../worker/session.ts";
import { currentViewDatoms, decideSessionTx, type SessionLog, type SessionLogEntry, type SessionTxDecision } from "../../worker/session-sync.ts";
import { type Basis, dbFromBasis, makeBasis } from "./basis.ts";
import { replicaErrorResponse, toReplicaError } from "./errors.ts";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJson(body)), { status, headers: { "content-type": "application/json", ...extra } });

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
  readonly stats = { frames: 0, gaps: 0, reconnects: 0, rootFlips: 0, basisServed: 0, queries: 0, budgetAborts: 0 };
  private readonly log = componentLogger("replica");
  /** Live session protocol objects (rebuilt from hibernation attachments). */
  private readonly live = new Map<WebSocket, Session>();

  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
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
    this.appendEntry(e);
    await this.notifySessions(e);
  }

  private adoptRoot(rec: RootRecord): void {
    if (this.root && rec.t <= this.root.t) return;
    this.root = rec;
    this.setMeta("root", rec);
    // drop novelty absorbed by the new root
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.t > rec.t);
    this.sql.exec(`DELETE FROM novelty WHERE t <= ?`, rec.t);
    this.stats.rootFlips++;
    this.log.info("replica.root", { db: this.dbName, rootT: rec.t, noveltyBefore: before, noveltyAfter: this.entries.length });
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
        await this.catchUpFromR2(frame.from);
        break;
      case "tx": {
        const e = entryFromFrame(frame);
        const expected = this.basisT + 1;
        if (e.t < expected) return; // duplicate / already applied
        if (e.t > expected) {
          // gap: fill from the transactor's log (or R2), then apply this frame
          this.stats.gaps++;
          this.log.warn("replica.gap", { db: this.dbName, expected, got: e.t });
          await this.fillGap(this.basisT, e.t - 1);
          if (e.t !== this.basisT + 1) return; // still inconsistent; a resume will fix it
        }
        if (!this.root || e.t > this.root.t) await this.applyDatoms(e);
        break;
      }
    }
  }

  /** Fetch (from, to] from the transactor's HTTP /log, falling back to R2 chunks. */
  private async fillGap(from: number, to: number): Promise<void> {
    if (!this.dbName) return;
    const stub = this.env.TRANSACTOR.get(this.env.TRANSACTOR.idFromName(this.dbName));
    const res = await stub.fetch(`https://transactor/log?from=${from}&to=${to}&db=${encodeURIComponent(this.dbName)}`, { headers: internalHeaders(this.env) });
    if (res.ok) {
      const body = (await res.json()) as { earliestLogT: number; entries: any[] };
      if (body.earliestLogT !== 0 && body.earliestLogT <= from + 1) {
        for (const f of body.entries) {
          const e = entryFromFrame(f);
          if (e.t === this.basisT + 1) await this.applyDatoms(e);
        }
        return;
      }
    }
    await this.catchUpFromR2(from, to);
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
    this.log.info("replica.connect", { db: this.dbName, from: this.basisT, reconnects: this.stats.reconnects, novelty: this.entries.length });
    let chain: Promise<void> = Promise.resolve();
    ws.addEventListener("message", (ev) => {
      // frames are applied strictly in order
      chain = chain.then(async () => {
        try {
          const frame = JSON.parse(String(ev.data)) as WireFrame;
          await this.handleFrame(frame);
        } catch (err) {
          console.error("replica: bad frame", err);
        }
      });
    });
    const drop = () => {
      if (this.ws === ws) this.ws = undefined;
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
    // give the hello + catch-up a moment so the first basis is fresh
    await new Promise((r) => setTimeout(r, 20));
    await chain;
  }

  /** Make sure we are connected and caught up (bounded wait). */
  private async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        await this.ensureConnected();
      } catch (err) {
        // transactor unreachable: serve from R2 (root + log chunks) — stale but consistent
        this.log.warn("replica.connect.failed", { db: this.dbName, error: String(err), basisT: this.basisT });
        await this.catchUpFromR2(this.basisT).catch(() => undefined);
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
    const after = raw.asOf(entry.t);
    const before = raw.asOf(Math.max(0, entry.t - 1));
    const st = authState(this.env);
    let who = p;
    if (st.policy && who) who = await withEid(st.policy, who, after);
    return decideSessionTx({
      datoms: entry.datoms.map(fromWireDatom),
      policy: st.policy,
      principal: who,
      ruleDbAfter: after,
      ruleDbBefore: before,
    });
  }

  private async snapshotView(p?: Principal): Promise<{ t: number; datoms: WireDatom[] }> {
    if (!this.root || !this.dbName) return { t: 0, datoms: [] };
    const basis = makeBasis(this.dbName, this.root, this.entries);
    const who = p ?? anonymousPrincipal(this.dbName);
    const dbv = await viewDb(this.env, who, this.store, basis);
    return { t: basis.t, datoms: await currentViewDatoms(dbv) };
  }

  /** Upsert the caller's row on the writer and attach the eid. */
  private async provisionPrincipal(p: Principal): Promise<Principal> {
    if (!shouldProvision(p) || this.dbName === undefined) return p;
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
      return rememberProvisioned(p, body.eid);
    } catch {
      return p;
    }
  }

  private createSession(ws: WebSocket, seed: SessionState): Session {
    const dbName = this.dbName as string;
    return openSession(ws as unknown as SocketLike, {
      listen: false,
      seed,
      principal: seed.principal,
      dispatch: (rest, init, p) => this.sessionDispatch(rest, init, p),
      authenticate: (token) => principalForToken(this.env, token.length === 0 ? undefined : token, dbName),
      provision: (p) => this.provisionPrincipal(p),
      describe: async (p) => {
        if (p.eid !== undefined) return { eid: p.eid, class: p.class };
        await this.sync();
        if (!this.root) return { eid: null, class: p.class };
        return describePrincipal(this.env, p, this.store, makeBasis(dbName, this.root, this.entries));
      },
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

  private async notifySessions(e: LogEntry): Promise<void> {
    const entry: SessionLogEntry = { t: e.t, datoms: e.datoms.map(toWireDatom) };
    const rootT = this.root?.t ?? 0;
    const sockets = this.ctx.getWebSockets() as WebSocket[];
    for (const ws of sockets) {
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
  ): Promise<Response> {
    await this.sync();
    const dbName = this.dbName as string;
    if (!this.root) return json({ error: "database has no root yet" }, 503);
    if (rest === "/op" && init.method === "POST") {
      return json({ error: "operations must be POSTed to /db/:name/op" }, 400);
    }
    if (rest === "/transact" && init.method === "POST") {
      let tx: unknown = [];
      let clientTxId: string | undefined;
      if (init.body) {
        const raw = JSON.parse(init.body) as { tx?: unknown; clientTxId?: unknown };
        tx = raw.tx;
        if (typeof raw.clientTxId === "string" && raw.clientTxId.length > 0) clientTxId = raw.clientTxId;
      }
      const stub = this.env.TRANSACTOR.get(this.env.TRANSACTOR.idFromName(dbName));
      return stub.fetch(`https://transactor/transact?db=${encodeURIComponent(dbName)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalHeaders(this.env) },
        body: JSON.stringify({ tx, principal, ...(clientTxId !== undefined ? { clientTxId } : {}) }),
      });
    }
    const basis = makeBasis(dbName, this.root, this.entries);
    const who = principal ?? anonymousPrincipal(dbName);
    const hdrs = { "x-ramose-basis-t": String(basis.t) };
    if (rest === "/info" && init.method === "GET") {
      const described = await describePrincipal(this.env, who, this.store, basis);
      return json({ db: dbName, t: basis.t, principal: described }, 200, hdrs);
    }
    if (rest === "/query" && init.method === "POST") {
      const body = fromJson(init.body ? JSON.parse(init.body) : {}) as {
        query?: unknown;
        inputs?: unknown[];
        asOf?: number;
        history?: boolean;
        explain?: boolean;
      };
      if (!body?.query) return json({ error: "body must be { query, inputs? }" }, 400);
      const dbv = await viewDb(this.env, who, this.store, basis, { asOf: typeof body.asOf === "number" ? body.asOf : undefined, history: !!body.history });
      const stats: QueryStats = { clauses: [] };
      const result = await runQuery(dbv, body.query as never, body.inputs ?? [], { stats, maxCells: envInt(this.env.RAMOSE_QUERY_MAX_CELLS, DEFAULT_QUERY_MAX_CELLS) });
      return json({ t: basis.t, root: basis.root.t, result, ...(body.explain ? { explain: stats.clauses, budget: stats.budget } : {}) }, 200, hdrs);
    }
    if (rest === "/pull" && init.method === "POST") {
      const body = fromJson(init.body ? JSON.parse(init.body) : {}) as {
        eid?: number | string | [string, unknown];
        pattern?: unknown;
        asOf?: number;
        history?: boolean;
      };
      const dbv = await viewDb(this.env, who, this.store, basis, { asOf: typeof body.asOf === "number" ? body.asOf : undefined, history: !!body.history });
      if (body.eid === undefined || body.pattern === undefined) return json({ error: "body must be { eid, pattern }" }, 400);
      const eid = typeof body.eid === "number" ? body.eid : await dbv.entid(body.eid as never);
      if (eid === undefined) return json({ t: basis.t, result: null }, 200, hdrs);
      return json({ t: basis.t, result: await runPull(dbv, eid, body.pattern as never) }, 200, hdrs);
    }
    const em = /^\/entity\/(\d+)$/.exec(rest.split("?")[0] ?? "");
    if (em && init.method === "GET") {
      const asOfRaw = new URL(`https://replica${rest}`).searchParams.get("asOf");
      const asOf = asOfRaw !== null ? Number(asOfRaw) : undefined;
      const dbv = await viewDb(this.env, who, this.store, basis, { asOf: Number.isFinite(asOf as number) ? asOf : undefined });
      return json({ t: basis.t, entity: await dbv.entity(Number(em[1])) }, 200, hdrs);
    }
    return json({ error: "not found" }, 404);
  }

  private async upgradeSession(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    await this.sync();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const raw = parsePrincipalHeader(request.headers.get(PRINCIPAL_HEADER));
    const principal = raw !== undefined ? await this.provisionPrincipal(raw) : undefined;
    const seed: SessionState = { ...(principal !== undefined ? { principal } : {}), lastT: 0, watermark: 0 };
    const session = this.createSession(server, seed);
    this.live.set(server, session);
    this.persist(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.init();
    const s = this.sessionOf(ws);
    await s.onMessage(message);
    this.persist(ws, s);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const s = this.live.get(ws);
    s?.close();
    this.live.delete(ws);
    try {
      ws.close(code, "bye");
    } catch {
      /* already gone */
    }
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
        if (!this.root) return json({ error: "database has no root yet" }, 503);
        this.stats.basisServed++;
        if (this.stats.basisServed % 100 === 1) this.log.debug("replica.basis", { db: this.dbName, t: this.basisT, rootT: this.root.t, novelty: this.entries.length, served: this.stats.basisServed });
        const basis: Basis = makeBasis(dbName, this.root, this.entries, this.ctx.id.toString().slice(0, 8));
        return json(basis);
      }
      case "/query": {
        // Executes the read on the replica (SPEC §8): plain datalog, pull, or a whole-entity read.
        // The Worker forwards its public /query /pull /entity bodies here; the JSON shape it returns
        // is exactly what the Worker used to build itself.
        await this.sync();
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
        const db = await dbFromBasis(this.store, basis, { asOf: typeof body.asOf === "number" ? body.asOf : undefined, history: !!body.history });
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
      case "/admin/reconnect": {
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
