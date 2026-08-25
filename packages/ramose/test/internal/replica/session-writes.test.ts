/**
 * Socket `{ op: "transact" }` is gated the same way as HTTPS `/transact`.
 * The Worker stamps `x-ramose-writes` on upgrade; QueryReplicaDO.sessionDispatch
 * enforces it — a live frame never goes through Worker `route()`.
 */
import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parsePolicy, type Principal, type RootRecord } from "../../../src/internal/core/index.ts";
import type { RamoseEnv } from "../../../src/internal/transactor/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";
import { sqliteLike } from "../transactor/harness.ts";
import { allowsRawTransact } from "../../../src/worker/auth.ts";
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
/** Open-mode service ingress — display class is a label, not a bypass key. */
const service: Principal = { kind: "service", class: "admin", claims: {}, db: "acme" };
/** User token whose class is literally `admin` — ordinary unless named `superuser`. */
const namedAdmin: Principal = {
  kind: "user",
  class: "admin",
  sub: "ops",
  claims: { sub: "ops" },
  db: "acme",
};
const owner: Principal = {
  kind: "user",
  class: "owner",
  sub: "ops",
  claims: { sub: "ops" },
  db: "acme",
};
const seed: Principal = { kind: "service", class: "$token", claims: {}, db: "acme" };

const SESSION_POLICY = JSON.stringify({
  version: 1,
  principal: ":user/sub",
  classes: ["member", "owner", "admin"],
  superuser: "owner",
});

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

async function bootReplica(
  envWrites?: string,
  extra: Record<string, string | undefined> = {},
): Promise<{
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
    RAMOSE_WRITES: envWrites,
    ...extra,
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
  const policy = parsePolicy(JSON.parse(SESSION_POLICY));
  const schemaTx = [{ ":db/ident": ":doc/title", ":db/valueType": ":db.type/string" }];

  test("operations denies an app-class caller; schema, superuser, $token, and writes: all pass", () => {
    expect(allowsRawTransact("operations", member, dataTx)).toBe(false);
    expect(allowsRawTransact("operations", namedAdmin, dataTx)).toBe(false);
    expect(allowsRawTransact("operations", namedAdmin, dataTx, policy)).toBe(false);
    expect(allowsRawTransact("operations", owner, dataTx, policy)).toBe(true);
    expect(allowsRawTransact("operations", seed, dataTx)).toBe(true);
    expect(allowsRawTransact("operations", service, dataTx)).toBe(true);
    expect(allowsRawTransact("all", member, dataTx)).toBe(true);
    expect(allowsRawTransact("operations", member, schemaTx)).toBe(true);
  });
});

describe("session { op: transact } is gated like HTTPS /transact", () => {
  test("app-class token under the default is 403 operations; Transactor is not called", async () => {
    const { replica, txBodies } = await bootReplica();
    const res = await replica.sessionDispatch("/transact", transactInit(dataTx), member, "operations");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("operations");
    expect(txBodies).toEqual([]);
  });

  test("unset session writes falls back to env and still denies a member", async () => {
    const { replica, txBodies } = await bootReplica();
    const res = await replica.sessionDispatch("/transact", transactInit(dataTx), member);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("operations");
    expect(txBodies).toEqual([]);
  });

  test("open-mode service, seed, and writes: all reach the Transactor", async () => {
    const { replica, txBodies } = await bootReplica();
    for (const [who, writes] of [
      [service, "operations"],
      [seed, "operations"],
      [member, "all"],
    ] as const) {
      const res = await replica.sessionDispatch("/transact", transactInit(dataTx), who, writes);
      expect(res.status).toBe(200);
    }
    expect(txBodies).toHaveLength(3);
  });

  test("a class literally named admin is not a bypass; the named superuser is", async () => {
    const { replica, txBodies } = await bootReplica(undefined, { RAMOSE_POLICY: SESSION_POLICY });
    const asAdmin = await replica.sessionDispatch("/transact", transactInit(dataTx), namedAdmin, "operations");
    expect(asAdmin.status).toBe(403);
    expect(((await asAdmin.json()) as { code?: string }).code).toBe("operations");
    const asOwner = await replica.sessionDispatch("/transact", transactInit(dataTx), owner, "operations");
    expect(asOwner.status).toBe(200);
    expect(txBodies).toHaveLength(1);
  });

  test("a live transact frame under operations is denied the same way", async () => {
    const { replica, txBodies } = await bootReplica();
    const socket = new FakeSocket();
    const session = openSession(socket, {
      listen: false,
      principal: member,
      seed: { lastT: 0, watermark: 10, writes: "operations" },
      dispatch: (rest, init, p) => replica.sessionDispatch(rest, init, p, "operations"),
    });
    await session.onMessage(JSON.stringify({ id: 1, op: "transact", tx: dataTx }));
    expect(socket.replies()).toEqual([
      { id: 1, status: 403, body: { error: "raw transact is disabled; use operations", code: "operations" } },
    ]);
    expect(txBodies).toEqual([]);
    session.close();
  });

  test("schema-only tx is exempt — member ensure reaches the Transactor", async () => {
    const { replica, txBodies } = await bootReplica();
    const schemaTx = [{ ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/optional": true }];
    const res = await replica.sessionDispatch("/transact", transactInit(schemaTx), member, "operations");
    expect(res.status).toBe(200);
    expect(txBodies).toHaveLength(1);
  });
});
