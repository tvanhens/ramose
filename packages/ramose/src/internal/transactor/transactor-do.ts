import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CatalogId,
  DatabaseId,
  deriveResolvedDatabaseRoute,
  resolveBoundCatalogDefinition,
  type DatabaseCatalogBindings,
  type DatabaseRouteDerivation,
  type DeployedCatalogDefinitions,
} from "../authorization/index.ts";
import { toJson } from "../core/index.ts";
import { serverSealingKey } from "../replication/identity-root.ts";
import { dbPrefix, prefixedBucket } from "../storage/index.ts";
import { type RamoseEnv, envInt } from "./env.ts";
import { DEFAULT_CONFIG, type SocketLike, type TransactorConfig, type TransactorHost } from "./host.ts";
import { internalGate } from "./internal.ts";
import { Transactor, type TxAck } from "./transactor.ts";
import type { RuntimeBoundaries } from "../runtime-boundaries.ts";

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

export interface TransactorTesting {
  readonly boundariesOf: (database: () => string) => RuntimeBoundaries;
  readonly enabled: (env: RamoseEnv) => boolean;
  readonly reset: () => void;
  readonly handleAdmin: (
    request: Request,
    path: string,
    database: string,
    abort: (reason: string) => void,
    inspect: {
      readonly operationReceiptCount: () => number;
      readonly dropStoredSettlement: (
        principalId: string,
        invocationId: string,
      ) => boolean;
      readonly storedSettlements: (
        principalId: string,
      ) => readonly { settled: number; committedT: number; invocationId: string }[];
    },
  ) => Promise<Response | undefined>;
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
    private readonly testing?: TransactorTesting,
  ) {
    super(ctx, env);
    if (testing?.enabled(env) === true) testing.reset();
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
          sealing: () => serverSealingKey(env),
        },
      testing?.boundariesOf(() => host.dbName),
    );
  }

  private assign(db: string): void {
    if (this.dbName === db) return;
    if (this.dbName !== undefined) throw new Error(`transactor already bound to database ${this.dbName}`);
    this.dbName = db;
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('db', ?)`, JSON.stringify(db));
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
    const dbName = this.dbName;
    await this.core.init();
    const testingEnabled = this.testing?.enabled(this.env) === true;
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
      if (!testingEnabled) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(toJson({ ok: true, t: this.core.t })), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/settled" && request.method === "POST") {
      const body = await request.json() as {
        readonly principalId?: unknown;
        readonly basisT?: unknown;
      };
      if (
        typeof body.principalId !== "string" || body.principalId.length === 0 ||
        !Number.isSafeInteger(body.basisT) || (body.basisT as number) < 0
      ) {
        return new Response(
          JSON.stringify({ error: "settled needs principalId and basisT" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          settled: this.core.settledThrough(
            body.principalId,
            body.basisT as number,
          ),
        }),
        { headers: { "content-type": "application/json" } },
      );
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
    if (testingEnabled) {
      const testAdmin = await this.testing.handleAdmin(
        request,
        url.pathname,
        dbName,
        (reason) => this.ctx.abort(reason),
        {
          operationReceiptCount: () => this.core.operationReceiptCount(),
          dropStoredSettlement: (principalId, invocationId) =>
            this.core.dropStoredSettlement(principalId, invocationId),
          storedSettlements: (principalId) => this.core.storedSettlements(principalId),
        },
      );
      if (testAdmin !== undefined) return testAdmin;
    }
    if (
      !testingEnabled &&
      (
        url.pathname === "/transact" ||
        url.pathname === "/provision" ||
        url.pathname.startsWith("/admin/")
      )
    ) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return this.core.handleRequest(request);
  }
}

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

export const createTestingTransactorDO = (
  testing: TransactorTesting,
  operationCatalogs?: DeployedCatalogDefinitions,
  databaseCatalogBindings?: DatabaseCatalogBindings,
): (new (
  ctx: DurableObjectState,
  env: RamoseEnv,
) => DurableObject<RamoseEnv>) => class TransactorDO extends TransactorDOBase {
  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env, operationCatalogs, databaseCatalogBindings, testing);
  }
};

export class TransactorDO extends TransactorDOBase {
  constructor(ctx: DurableObjectState, env: RamoseEnv) {
    super(ctx, env);
  }
}
