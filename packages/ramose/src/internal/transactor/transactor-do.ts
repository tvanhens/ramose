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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  compositionFromUnit,
  deployedOperationKey,
  OperationId,
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  resolveDeployedCatalog,
  type AuthenticatedCaller,
  type DeployedCatalogs,
  type InstalledCatalogUnitV2,
} from "../authorization/index.ts";
import { fromJson, toJson } from "../core/index.ts";
import { restoreEngineTypeAssertions } from "../core/tx-provenance.ts";
import { dbPrefix, prefixedBucket } from "../storage/index.ts";
import { type RamoseEnv, envInt } from "./env.ts";
import { DEFAULT_CONFIG, type SocketLike, type TransactorConfig, type TransactorHost } from "./host.ts";
import { internalGate } from "./internal.ts";
import { asPrincipal, Transactor, type TxAck } from "./transactor.ts";
import { handleIsolateTestAdmin, resetTestHooks } from "../test-hooks.ts";
import { prepareAuthorizedOperation } from "../authorization/operation-execution.ts";
import { Unauthorized } from "../../db/Errors.ts";
import { errorResponse, toDbError } from "../../errorHttp.ts";

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

  constructor(
    ctx: DurableObjectState,
    env: RamoseEnv,
    private readonly catalogs?: DeployedCatalogs,
  ) {
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

  transact(
    db: string,
    tx: unknown[],
    unit: InstalledCatalogUnitV2,
  ): Promise<TxAck> {
    this.assign(db);
    const composition = Result.getOrThrow(compositionFromUnit(unit));
    this.core.bindComposition(unit.unitHash, composition);
    restoreEngineTypeAssertions(tx);
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
    if (url.pathname === "/operation" && request.method === "POST") {
      try {
        const body = fromJson(await request.json()) as Record<string, unknown>;
        const principal = asPrincipal(body.principal);
        if (this.catalogs === undefined || principal === undefined) throw new Unauthorized({});
        const catalogKey = Schema.decodeUnknownSync(CatalogId)(body.catalogKey);
        const unitHash = Schema.decodeUnknownSync(CatalogUnitHash)(body.unitHash);
        const operation = Schema.decodeUnknownSync(OperationId)(body.operation);
        const deployedResult = resolveDeployedCatalog(this.catalogs, {
          database: DatabaseId.make(this.dbName),
          catalogKey,
          unitHash,
        });
        if (Result.isFailure(deployedResult)) throw new Unauthorized({});
        const deployed = deployedResult.success;
        const definition = deployed.operations.get(deployedOperationKey(operation));
        if (definition === undefined) throw new Unauthorized({});
        this.core.bindComposition(deployed.unitHash, deployed.composition);
        const caller = body.caller as AuthenticatedCaller;
        const ack = await this.core.transactOperation((currentDb, now) =>
          prepareAuthorizedOperation({
            deployed,
            definition,
            caller,
            principal,
            dbName: this.dbName!,
            currentDb,
            target: body.target,
            input: body.input,
            now,
            env: this.env,
          })
        );
        return new Response(JSON.stringify(toJson({ t: ack.t, result: ack.output })), {
          headers: { "content-type": "application/json" },
        });
      } catch (cause) {
        return errorResponse(toDbError(cause));
      }
    }
    const testAdmin = await handleIsolateTestAdmin(request, url.pathname, (reason) => this.ctx.abort(reason));
    if (testAdmin !== undefined) return testAdmin;
    return this.core.handleRequest(request);
  }
}
