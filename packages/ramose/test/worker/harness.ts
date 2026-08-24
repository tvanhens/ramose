/**
 * The peer Worker, in process.
 *
 * `index.ts` re-exports the Durable Object classes, so it imports
 * `cloudflare:workers`; the module is virtualized here before the dynamic
 * import. The Transactor runs as the *real* DO shell over `bun:sqlite` (so the
 * internal-secret gate and the commit loop are the real ones); the QueryReplica
 * is stood in for, because it reaches the transactor over a WebSocket pair that
 * does not exist outside Workers — it serves the basis straight off the writer,
 * which makes reads see writes with no lag.
 */

import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import type { RamoseEnv, SqlLike } from "../../src/internal/transactor/index.ts";
import { internalGate } from "../../src/internal/transactor/index.ts";
import { makeBasis } from "../../src/internal/replica/basis.ts";
import { MemoryBucket } from "../../src/internal/storage/memory.ts";
import { sqliteLike } from "../internal/transactor/harness.ts";
import { clearAuthCache } from "../../src/worker/auth.ts";
import { clearBasisCache, clearSegmentSources } from "../../src/worker/peer.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: any,
      readonly env: any,
    ) {}
  },
}));

const { TransactorDO } = await import("../../src/internal/transactor/transactor-do.ts");
const { createServer, clearWritesWarning } = await import("../../src/worker/index.ts");
import type { AnyOperations } from "../../src/db/Operation.ts";

/** `DurableObjectState`, as much of it as the Transactor shell touches. */
function fakeState(db: Database) {
  const sql: SqlLike = sqliteLike(db);
  let alarmAt: number | null = null;
  return {
    storage: {
      sql,
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => alarmAt,
      setAlarm: async (t: number) => {
        alarmAt = t;
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    abort: () => {},
    id: { toString: () => "test" },
  };
}

export interface ServerOptions {
  /** every extra env var the peer reads (RAMOSE_POLICY, RAMOSE_TOKEN, …) */
  env?: Record<string, string | undefined>;
  operations?: AnyOperations;
  writes?: "all" | "operations";
}

export interface Peer {
  readonly env: RamoseEnv;
  /** One request against the peer, exactly as Cloudflare would deliver it. */
  fetch(path: string, init?: RequestInit & { token?: string; colo?: string }): Promise<Response>;
  /** `fetch`, with the JSON body parsed. */
  json<T = any>(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: T; res: Response }>;
  /** Transact straight through the writer, bypassing the Worker (test fixtures). */
  seed(tx: unknown[]): Promise<{ t: number; tempids: Record<string, number> }>;
  /** The Transactor DO shell, addressed directly (no internal-secret header unless you set one). */
  transactorFetch(path: string, init?: RequestInit): Promise<Response>;
  /** The QueryReplica stand-in, addressed directly. */
  replicaFetch(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

/** A peer serving exactly one database name. */
export function makePeer(dbName: string, options: ServerOptions = {}): Peer {
  clearAuthCache();
  clearBasisCache();
  clearSegmentSources();
  clearWritesWarning();

  const bucket = new MemoryBucket();
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA synchronous = OFF;");

  const env = { STORE: bucket, ...options.env } as unknown as RamoseEnv;

  let transactorDO: any;
  const transactor = () => {
    if (!transactorDO) {
      transactorDO = new (TransactorDO as any)(fakeState(sqlite), env);
      transactorDO.assign(dbName); // one peer, one database — the DO shell does this from `?db=`
    }
    return transactorDO;
  };

  (env as any).TRANSACTOR = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => ({ fetch: (url: string, init?: RequestInit) => transactor().fetch(new Request(url, init)) }),
  };

  /** The replica, standing in: the basis is read off the writer itself. */
  const replicaFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const gate = internalGate(env, request);
    if (gate) return gate;
    const core = transactor().transactor;
    await core.init();
    const path = new URL(url).pathname;
    const root = core.currentRootRecord;
    const entries = core.readLogEntries(root.t);
    if (path === "/basis") return Response.json(makeBasis(dbName, root, entries, "fake"));
    if (path === "/info") return Response.json({ db: dbName, t: core.t, root, novelty: entries.length, connected: true });
    if (path === "/admin/reconnect") return Response.json({ ok: true, t: core.t });
    return Response.json({ error: "not found" }, { status: 404 });
  };

  (env as any).REPLICA = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => ({ fetch: replicaFetch }),
  };

  const fetchPeer: Peer["fetch"] = (path, init = {}) => {
    const { token, colo, ...rest } = init as RequestInit & { token?: string; colo?: string };
    const headers = new Headers(rest.headers);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const request = new Request(`https://peer.test${path}`, { ...rest, headers });
    (request as any).cf = { colo: colo ?? "IAD", continent: "NA" };
    return createServer({
      operations: options.operations,
      writes: options.writes,
    }).fetch(request, env);
  };

  return {
    env,
    fetch: fetchPeer,
    async json(path, init) {
      const res = await fetchPeer(path, init);
      let body: any;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body, res };
    },
    async seed(tx) {
      const core = transactor().transactor;
      await core.init();
      const ack = await core.transact(tx as never, { kind: "service", class: "admin", claims: {}, db: dbName });
      clearBasisCache();
      return ack;
    },
    transactorFetch: (path, init) => transactor().fetch(new Request(`https://transactor${path}`, init)),
    replicaFetch: (path, init) => replicaFetch(`https://replica${path}`, init),
    close() {
      sqlite.close();
    },
  };
}

/** POST body helper. */
export const post = (body: unknown, token?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  ...(token === undefined ? {} : { token }),
});
