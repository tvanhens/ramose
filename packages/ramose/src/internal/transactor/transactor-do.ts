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
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CatalogId,
  DatabaseId,
  compositionFromUnit,
  deriveResolvedDatabaseRoute,
  resolveBoundCatalogDefinition,
  type DatabaseCatalogBindings,
  type DatabaseRouteDerivation,
  type DeployedCatalogDefinitions,
  type InstalledCatalogUnitV2,
} from "../authorization/index.ts";
import { toJson } from "../core/index.ts";
import { restoreEngineTypeAssertions } from "../core/tx-provenance.ts";
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

class TransactorDOBase extends DurableObject<RamoseEnv> {
  private readonly core: Transactor;
  private readonly databaseCatalogBindings: DatabaseCatalogBindings | undefined;
  private dbName: string | undefined;

  constructor(
    ctx: DurableObjectState,
    env: RamoseEnv,
    operationCatalogs?: DeployedCatalogDefinitions,
    databaseCatalogBindings?: DatabaseCatalogBindings,
  ) {
    super(ctx, env);
    resetTestHooks();
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const row = ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = 'db'`).toArray()[0];
    if (row) this.dbName = JSON.parse(row.v as string) as string;
    this.databaseCatalogBindings = databaseCatalogBindings;
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
    this.core = new Transactor(
      host,
      operationCatalogs === undefined
        ? undefined
        : {
          catalogs: operationCatalogs,
          ...(databaseCatalogBindings === undefined
            ? {}
            : { bindings: databaseCatalogBindings }),
          environment: env,
          now: () => host.now(),
        },
    );
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
    if (url.pathname === "/provision-catalog" && request.method === "POST") {
      if (this.databaseCatalogBindings === undefined) {
        return new Response(JSON.stringify({ error: "catalog provisioning unavailable" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const body = await request.json() as { readonly derivation?: unknown };
        const raw = body?.derivation;
        if (
          typeof raw !== "object" || raw === null || Array.isArray(raw) ||
          typeof (raw as { readonly rootDatabase?: unknown }).rootDatabase !== "string" ||
          !Array.isArray((raw as { readonly graphs?: unknown }).graphs)
        ) {
          throw new Error("invalid database route derivation");
        }
        const graphs = (raw as { readonly graphs: readonly unknown[] }).graphs.map(
          (entry) => {
            if (
              typeof entry !== "object" || entry === null || Array.isArray(entry) ||
              !Number.isSafeInteger((entry as { readonly graphEntity?: unknown }).graphEntity) ||
              typeof (entry as { readonly catalogKey?: unknown }).catalogKey !== "string"
            ) {
              throw new Error("invalid dynamic Graph binding");
            }
            return Object.freeze({
              graphEntity: (entry as { readonly graphEntity: number }).graphEntity,
              catalogKey: CatalogId.make(
                (entry as { readonly catalogKey: string }).catalogKey,
              ),
            });
          },
        );
        const derivation: DatabaseRouteDerivation = Object.freeze({
          rootDatabase: DatabaseId.make(
            (raw as { readonly rootDatabase: string }).rootDatabase,
          ),
          graphs: Object.freeze(graphs),
        });
        const route = await Effect.runPromise(deriveResolvedDatabaseRoute(
          this.databaseCatalogBindings,
          derivation,
        ));
        if (route.database !== DatabaseId.make(this.dbName)) {
          throw new Error("database route derivation does not match this transactor");
        }
        const deployed = Result.getOrThrow(resolveBoundCatalogDefinition(
          this.databaseCatalogBindings,
          route,
        ));
        const t = await this.core.provisionCatalog(deployed.definition);
        return new Response(JSON.stringify({ t }), {
          headers: { "content-type": "application/json" },
        });
      } catch (cause) {
        return new Response(JSON.stringify({
          error: cause instanceof Error ? cause.message : "catalog provisioning failed",
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    const testAdmin = await handleIsolateTestAdmin(request, url.pathname, (reason) => this.ctx.abort(reason));
    if (testAdmin !== undefined) return testAdmin;
    return this.core.handleRequest(request);
  }
}

/** Build the deployed Transactor class from the same immutable registry as the Worker. */
export const createTransactorDO = (
  operationCatalogs: DeployedCatalogDefinitions,
  databaseCatalogBindings?: DatabaseCatalogBindings,
): (new (
  ctx: DurableObjectState,
  env: RamoseEnv,
) => DurableObject<RamoseEnv>) => class TransactorDO extends TransactorDOBase {
  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env, operationCatalogs, databaseCatalogBindings);
  }
};

/** Default fail-closed class for peers with no runnable catalog definitions. */
export class TransactorDO extends TransactorDOBase {
  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
  }
}
