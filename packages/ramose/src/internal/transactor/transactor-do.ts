/**
 * Transactor Durable Object — exactly one per logical database.
 *
 * Thin shell: adapts the DO runtime (SQLite storage, hibernating WebSockets,
 * alarms, R2 binding) to `TransactorHost` and forwards everything to the
 * runtime-agnostic `Transactor` (transactor.ts). All logic lives there and is
 * tested under Bun; this file only maps APIs.
 *
 *   GET /subscribe?from=<t>  (WebSocket upgrade) → hello / tx / root / gap frames
 *   everything else → Transactor.handleRequest
 */

import { DurableObject } from "cloudflare:workers";
import { toJson } from "../core/index.ts";
import { dbPrefix, prefixedBucket } from "../storage/index.ts";
import { type RamoseEnv, envInt } from "./env.ts";
import { DEFAULT_CONFIG, type SocketLike, type TransactorConfig, type TransactorHost } from "./host.ts";
import { internalGate } from "./internal.ts";
import { Transactor, type TxAck } from "./transactor.ts";
import { handleIsolateTestAdmin, resetTestHooks } from "../test-hooks.ts";

export type { TxAck };

export function configFromEnv(env: RamoseEnv): TransactorConfig {
  return {
    ...DEFAULT_CONFIG,
    indexIntervalMs: envInt(env.RAMOSE_INDEX_INTERVAL_MS, DEFAULT_CONFIG.indexIntervalMs),
    indexTxThreshold: envInt(env.RAMOSE_INDEX_TX_THRESHOLD, DEFAULT_CONFIG.indexTxThreshold),
    indexMaxTxsPerRun: envInt(env.RAMOSE_INDEX_MAX_TXS_PER_RUN, DEFAULT_CONFIG.indexMaxTxsPerRun),
    logKeepTxs: envInt(env.RAMOSE_LOG_KEEP_TXS, DEFAULT_CONFIG.logKeepTxs),
    gcEveryNIndexes: envInt(env.RAMOSE_GC_EVERY_N_INDEXES, DEFAULT_CONFIG.gcEveryNIndexes),
    retainRoots: envInt(env.RAMOSE_RETAIN_ROOTS, DEFAULT_CONFIG.retainRoots),
    maxBatch: envInt(env.RAMOSE_MAX_BATCH, DEFAULT_CONFIG.maxBatch),
    timingYields: env.RAMOSE_TIMING_YIELDS === "1",
  };
}

export class TransactorDO extends DurableObject<RamoseEnv> {
  private readonly core: Transactor;
  private dbName: string | undefined;

  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
    resetTestHooks();
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const row = ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = 'db'`).toArray()[0];
    if (row) this.dbName = JSON.parse(row.v as string) as string;
    const self = this;
    const host: TransactorHost = {
      get dbName() {
        if (!self.dbName) throw new Error("transactor has no database assigned (pass ?db=<name>)");
        return self.dbName;
      },
      sql: ctx.storage.sql,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
      get bucket() {
        return prefixedBucket(env.STORE, dbPrefix(host.dbName));
      },
      sockets: () => ctx.getWebSockets() as unknown as SocketLike[],
      getAlarm: () => ctx.storage.getAlarm(),
      setAlarm: (time) => ctx.storage.setAlarm(time),
      abort: (reason) => ctx.abort(reason),
      now: () => Date.now(),
      config: configFromEnv(env),
      // bound in alchemy.run.ts as ANALYTICS; undefined = metrics disabled
      ...(env.ANALYTICS !== undefined && { analytics: env.ANALYTICS }),
    };
    this.core = new Transactor(host);
  }

  /** In-process access for other code running in the same isolate (tests, worker). */
  get transactor(): Transactor {
    return this.core;
  }

  /** Bind this object to a database name (idempotent; persisted). */
  assign(db: string): void {
    if (this.dbName === db) return;
    if (this.dbName !== undefined) throw new Error(`transactor already bound to database ${this.dbName}`);
    this.dbName = db;
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('db', ?)`, JSON.stringify(db));
  }

  transact(db: string, tx: unknown[]): Promise<TxAck> {
    this.assign(db);
    return this.core.init().then(() => this.core.transact(tx));
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.init();
    this.core.onSocketMessage(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "bye");
    } catch {}
  }

  override async alarm(): Promise<void> {
    await this.core.onAlarm();
  }

  override async fetch(request: Request): Promise<Response> {
    // reachable only from the peer Worker (and the replicas), /subscribe included
    const gate = internalGate(this.env, request);
    if (gate) return gate;
    const url = new URL(request.url);
    const db = url.searchParams.get("db");
    if (db) {
      try {
        this.assign(db);
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 409, headers: { "content-type": "application/json" } });
      }
    }
    if (!this.dbName) return new Response(JSON.stringify({ error: "missing ?db=" }), { status: 400, headers: { "content-type": "application/json" } });
    await this.core.init();
    if (url.pathname === "/subscribe") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const from = Number(url.searchParams.get("from") ?? "0");
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      this.core.onSubscribe(server, from);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify(toJson({ ok: true, t: this.core.t })), { headers: { "content-type": "application/json" } });
    }
    const testAdmin = await handleIsolateTestAdmin(request, url.pathname, (reason) => this.ctx.abort(reason));
    if (testAdmin !== undefined) return testAdmin;
    return this.core.handleRequest(request);
  }
}
