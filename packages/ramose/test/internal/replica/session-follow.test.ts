/**
 * Architectural pin for #121: after `applyDatoms`, QueryReplicaDO walks every
 * attached session. A pair of `openSession` + `pushApplied` is not this path —
 * that would still pass if `notifySessions` were a no-op.
 *
 * Direct `applyDatoms` / `handleFrame` control — local Alchemy mode cannot
 * schedule this deterministically. `mock.module("cloudflare:workers")` is
 * only here to import the DO class. Public multi-client live is
 * `test/local/multi-client.ts`.
 *
 * Stands up the real DO over bun:sqlite, the same way the Transactor DO
 * is driven.
 */
import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { datom, txFrame, ValueTag, type LogEntry, type RootRecord } from "../../../src/internal/core/index.ts";
import type { RamoseEnv } from "../../../src/internal/transactor/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";
import { sqliteLike } from "../transactor/harness.ts";
import { openSession, type Session, type SocketLike } from "../../../src/worker/session.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: any,
      readonly env: any,
    ) {}
  },
}));

const { QueryReplicaDO } = await import("../../../src/internal/replica/replica-do.ts");

class FakeSocket implements SocketLike {
  readonly frames: any[] = [];
  closed = false;
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.frames.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(): void {}
  txs() {
    return this.frames.filter((f) => f.op === "tx");
  }
  resyncs() {
    return this.frames.filter((f) => f.op === "resync");
  }
}

const hash = { hash: "0".repeat(64), kind: 0 as const, count: 0 };
const rootAt = (t: number): RootRecord => ({
  v: 1,
  t,
  eavt: hash,
  aevt: hash,
  avet: hash,
  vaet: hash,
  log_watermark: t,
  next_eid: 100,
  codec: "gzip",
  created_at: 0,
});

const entry = (t: number): LogEntry => ({
  t,
  txInstant: t,
  datoms: [datom(1, 2, ValueTag.Str, `v${t}`, t, true)],
});

/** The private apply/walk surface the transactor `tx` path uses after density checks. */
type ReplicaWalk = {
  readonly basisT: number;
  fetch(request: Request): Promise<Response>;
  applyDatoms(e: LogEntry): Promise<void>;
  handleFrame(frame: unknown): Promise<void>;
  adoptRoot(rec: RootRecord): void;
  live: Map<FakeSocket, Session>;
};

function replicaCtx() {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF;");
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    state: {
      storage: {
        sql: sqliteLike(db),
        transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      },
      getWebSockets: () => sockets,
      acceptWebSocket: (ws: FakeSocket) => {
        sockets.push(ws);
      },
      abort: () => {},
      id: { toString: () => "replica-test" },
    },
  };
}

function envOf(): RamoseEnv {
  return {
    STORE: new MemoryBucket(),
    TRANSACTOR: {
      idFromName: () => ({ toString: () => "tx" }),
      get: () => ({
        fetch: async (url: string) => {
          if (String(url).includes("/log")) return Response.json({ earliestLogT: 0, entries: [] });
          return new Response("unavailable", { status: 503 });
        },
      }),
    },
  } as unknown as RamoseEnv;
}

async function bootReplica(watermark = 10): Promise<{
  replica: ReplicaWalk;
  attach: () => { socket: FakeSocket; session: Session };
}> {
  const { sockets, state } = replicaCtx();
  const replica = new QueryReplicaDO(state as never, envOf()) as unknown as ReplicaWalk;
  const ready = await replica.fetch(new Request("https://replica/info?db=acme"));
  expect(ready.status).toBe(200);
  replica.adoptRoot(rootAt(watermark));
  const dispatch = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  return {
    replica,
    attach: () => {
      const socket = new FakeSocket();
      state.acceptWebSocket(socket);
      const session = openSession(socket, {
        listen: false,
        dispatch,
        seed: { lastT: 0, watermark },
        filterEntry: async (e) => ({ kind: "tx", datoms: e.datoms }),
      });
      replica.live.set(socket, session);
      expect(sockets).toContain(socket);
      return { socket, session };
    },
  };
}

describe("QueryReplicaDO apply-then-notify", () => {
  test("two attached sessions both receive t and t+1 after applyDatoms; no poll timer", async () => {
    const { replica, attach } = await bootReplica(10);
    const a = attach();
    const b = attach();
    await replica.applyDatoms(entry(11));
    await replica.applyDatoms(entry(12));
    expect(replica.basisT).toBe(12);
    expect(a.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(b.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(a.session.watermark).toBe(12);
    expect(b.session.watermark).toBe(12);
    expect(a.socket.resyncs()).toEqual([]);
    expect(b.socket.resyncs()).toEqual([]);
  });

  test("overlapping applyDatoms still walks t and t+1 on both sockets; no torn dump", async () => {
    const { replica, attach } = await bootReplica(10);
    const a = attach();
    const b = attach();
    // Group-commit / fillGap / two handleFrames can overlap notifySessions.
    // Each applyEntry must not snapshot watermark at enqueue.
    await Promise.all([replica.applyDatoms(entry(11)), replica.applyDatoms(entry(12))]);
    expect(replica.basisT).toBe(12);
    expect(a.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(b.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(a.socket.resyncs()).toEqual([]);
    expect(b.socket.resyncs()).toEqual([]);
    expect(a.session.watermark).toBe(12);
    expect(b.session.watermark).toBe(12);
  });

  test("GET /basis with minT fills from the transactor log when the subscription is stale", async () => {
    const pending = [entry(11), entry(12)];
    const env = {
      STORE: new MemoryBucket(),
      TRANSACTOR: {
        idFromName: () => ({ toString: () => "tx" }),
        get: () => ({
          fetch: async (url: string) => {
            const href = String(url);
            if (href.includes("/log")) {
              const u = new URL(href);
              const from = Number(u.searchParams.get("from") ?? "0");
              const to = Number(u.searchParams.get("to") ?? String(Number.MAX_SAFE_INTEGER));
              const entries = pending.filter((e) => e.t > from && e.t <= to).map((e) => txFrame(e));
              return Response.json({ earliestLogT: 11, entries, t: 12 });
            }
            return new Response("unavailable", { status: 503 });
          },
        }),
      },
    } as unknown as RamoseEnv;
    const { state } = replicaCtx();
    const replica = new QueryReplicaDO(state as never, env) as unknown as ReplicaWalk;
    expect((await replica.fetch(new Request("https://replica/info?db=acme"))).status).toBe(200);
    replica.adoptRoot(rootAt(10));
    expect(replica.basisT).toBe(10);
    const stale = await replica.fetch(new Request("https://replica/basis?db=acme"));
    expect(stale.status).toBe(200);
    expect(((await stale.json()) as { t: number }).t).toBe(10);
    const fresh = await replica.fetch(
      new Request("https://replica/basis?db=acme", { headers: { "x-ramose-min-t": "12" } }),
    );
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { t: number }).t).toBe(12);
    expect(replica.basisT).toBe(12);
  });

  test("a failed minT catch-up does not prevent a later fenced read from applying", async () => {
    let failLog = true;
    const env = {
      STORE: new MemoryBucket(),
      TRANSACTOR: {
        idFromName: () => ({ toString: () => "tx" }),
        get: () => ({
          fetch: async (url: string) => {
            const href = String(url);
            if (href.includes("/log")) {
              if (failLog) throw new Error("log down");
              return Response.json({
                earliestLogT: 11,
                entries: [txFrame(entry(11))],
                t: 11,
              });
            }
            return new Response("unavailable", { status: 503 });
          },
        }),
      },
    } as unknown as RamoseEnv;
    const { state } = replicaCtx();
    const replica = new QueryReplicaDO(state as never, env) as unknown as ReplicaWalk;
    expect((await replica.fetch(new Request("https://replica/info?db=acme"))).status).toBe(200);
    replica.adoptRoot(rootAt(10));
    const failed = await replica.fetch(
      new Request("https://replica/basis?db=acme", { headers: { "x-ramose-min-t": "11" } }),
    );
    expect(failed.status).toBe(500);
    expect(replica.basisT).toBe(10);
    failLog = false;
    const recovered = await replica.fetch(
      new Request("https://replica/basis?db=acme", { headers: { "x-ramose-min-t": "11" } }),
    );
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { t: number }).t).toBe(11);
    expect(replica.basisT).toBe(11);
  });

  test("handleFrame of t+2 while t+1 is unapplied does not stamp the tip or dump", async () => {
    const { replica, attach } = await bootReplica(10);
    const a = attach();
    const b = attach();
    expect(replica.basisT).toBe(10);
    await replica.handleFrame(txFrame(entry(12)));
    expect(replica.basisT).toBe(10);
    expect(a.session.watermark).toBe(10);
    expect(b.session.watermark).toBe(10);
    expect(a.socket.txs()).toEqual([]);
    expect(b.socket.txs()).toEqual([]);
    expect(a.socket.resyncs()).toEqual([]);
    expect(b.socket.resyncs()).toEqual([]);
  });
});
