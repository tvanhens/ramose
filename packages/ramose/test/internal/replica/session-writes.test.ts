/**
 * Socket `{ op: "transact" }` is gated the same way as HTTPS `/transact`.
 * Until authorized application access lands, both surfaces fail closed.
 */
import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RootRecord } from "../../../src/internal/core/index.ts";
import type { RamoseEnv } from "../../../src/internal/transactor/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";
import { sqliteLike } from "../transactor/harness.ts";
import { allowsRawTransact, type Principal } from "../../../src/worker/auth.ts";
import { openSession, type SocketLike } from "../../../src/worker/session.ts";
import type { WritesMode } from "../../../src/writes.ts";

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
  replies() {
    return this.frames.filter((f) => f.op === undefined);
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

const member: Principal = {
  kind: "user",
  class: "member",
  sub: "ada",
  claims: { sub: "ada" },
  db: "acme",
};

const dataTx = [{ ":doc/title": "raw via socket" }];

type ReplicaDispatch = {
  fetch(request: Request): Promise<Response>;
  adoptRoot(rec: RootRecord): void;
  sessionDispatch(
    rest: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    principal?: Principal,
    writes?: WritesMode,
  ): Promise<Response>;
};

async function bootReplica(): Promise<{
  replica: ReplicaDispatch;
  txBodies: string[];
}> {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF;");
  const sockets: FakeSocket[] = [];
  const txBodies: string[] = [];
  const state = {
    storage: {
      sql: sqliteLike(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeSocket) => {
      sockets.push(ws);
    },
    abort: () => {},
    id: { toString: () => "replica-writes-test" },
  };
  const env = {
    STORE: new MemoryBucket(),
    TRANSACTOR: {
      idFromName: () => ({ toString: () => "tx" }),
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          const href = String(url);
          if (href.includes("/log")) return Response.json({ earliestLogT: 0, entries: [] });
          if (href.includes("/subscribe")) return new Response("no", { status: 426 });
          if (href.includes("/transact")) {
            txBodies.push(typeof init?.body === "string" ? init.body : "");
            return Response.json({ t: 1 });
          }
          return new Response("unavailable", { status: 503 });
        },
      }),
    },
  } as unknown as RamoseEnv;
  const replica = new QueryReplicaDO(state as never, env) as unknown as ReplicaDispatch;
  const ready = await replica.fetch(new Request("https://replica/info?db=acme"));
  expect(ready.status).toBe(200);
  replica.adoptRoot(rootAt(10));
  return { replica, txBodies };
}

const transactInit = (tx: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tx }),
});

describe("allowsRawTransact", () => {
  test("every caller is denied until authorized application access lands", () => {
    expect(allowsRawTransact("operations", member, dataTx)).toBe(false);
    expect(allowsRawTransact("all", member, dataTx)).toBe(false);
    expect(
      allowsRawTransact("operations", member, [
        { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string" },
      ]),
    ).toBe(false);
  });
});

describe("session { op: transact } is fail-closed", () => {
  test("session HTTP transact is 401 and the Transactor is not called", async () => {
    const { replica, txBodies } = await bootReplica();
    const res = await replica.sessionDispatch("/transact", transactInit(dataTx), member, "operations");
    expect(res.status).toBe(401);
    expect(txBodies).toEqual([]);
  });

  test("a live transact frame is 401 the same way", async () => {
    const { replica, txBodies } = await bootReplica();
    const socket = new FakeSocket();
    const session = openSession(socket, {
      listen: false,
      principal: member,
      seed: { lastT: 0, watermark: 10, writes: "operations" },
      dispatch: (rest, init, p) => replica.sessionDispatch(rest, init, p, "operations"),
    });
    await session.onMessage(JSON.stringify({ id: 1, op: "transact", tx: dataTx }));
    expect(socket.replies()).toEqual([{ id: 1, status: 401, body: { error: "unauthorized" } }]);
    expect(txBodies).toEqual([]);
    session.close();
  });
});
