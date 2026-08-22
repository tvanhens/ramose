import { afterEach, describe, expect, test } from "bun:test";
import { Connection } from "../../src/internal/core/conn.ts";
import { filterDb, fromWireDatom, toWireDatom, type Principal, type WireDatom } from "../../src/internal/core/index.ts";
import { PolicyAst as A, parsePolicy } from "../../src/internal/core/policy/index.ts";
import { META_HEADERS, PRINCIPAL_HEADER, type SessionDispatch, type SocketLike, openSession, parsePrincipalHeader, planOf, pushApplied } from "../../src/worker/session.ts";
import { currentViewDatoms, decideSessionTx, type SessionLog, type SessionLogEntry, type SessionTxDecision } from "../../src/worker/session-sync.ts";

/** A `WebSocket` stand-in: records what the session sent, replays what a client would do. */
class FakeSocket implements SocketLike {
  readonly frames: any[] = [];
  closed = false;
  closeCode: number | undefined;
  /** simulate a runtime that refuses the write (a gone socket, a foreign IoContext) */
  failSends = false;
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    if (this.failSends) throw new Error("Cannot perform I/O on behalf of a different request.");
    this.frames.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  addEventListener(type: "message" | "close" | "error", cb: (ev: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  /** what a client sends over the wire */
  message(frame: unknown): void {
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  txs() {
    return this.frames.filter((f) => f.op === "tx");
  }
  resyncs() {
    return this.frames.filter((f) => f.op === "resync");
  }
  replies() {
    return this.frames.filter((f) => f.op === undefined);
  }
}

interface Call {
  rest: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Records every dispatched sub-request; answers with whatever `reply` returns. */
function fakeDispatch(reply: (call: Call) => Response = () => json({ ok: true })): { dispatch: SessionDispatch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    dispatch: async (rest, init) => {
      const call: Call = { rest, method: init.method, headers: init.headers, body: init.body };
      calls.push(call);
      return reply(call);
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const wire = (t: number): [number, number, number, string, number, 0 | 1] => [1, 2, 3, "x", t, 1];

let open: { close(): void }[] = [];
const session = (socket: FakeSocket, options: Parameters<typeof openSession>[1]) => {
  const s = openSession(socket, options);
  open.push(s);
  return s;
};

afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

describe("planOf: frame → sub-request", () => {
  test("q → POST /query carrying query/inputs/asOf/history/explain", () => {
    const p = planOf({ id: 1, op: "q", query: "[:find ?e :where [?e :name]]", inputs: [7], asOf: 3, history: true, explain: true }) as any;
    expect(p.error).toBeUndefined();
    expect([p.rest, p.method]).toEqual(["/query", "POST"]);
    expect(p.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(p.body)).toEqual({ query: "[:find ?e :where [?e :name]]", inputs: [7], asOf: 3, history: true, explain: true });
  });

  test("pull → POST /pull; transact → POST /transact { tx }", () => {
    const pull = planOf({ id: 2, op: "pull", eid: [":person/email", "a@b.c"], pattern: ["*"], asOf: 4 }) as any;
    expect([pull.rest, pull.method]).toEqual(["/pull", "POST"]);
    expect(JSON.parse(pull.body)).toEqual({ eid: [":person/email", "a@b.c"], pattern: ["*"], asOf: 4 });
    const tx = planOf({ id: 3, op: "transact", tx: [{ ":db/id": -1 }] }) as any;
    expect([tx.rest, tx.method]).toEqual(["/transact", "POST"]);
    expect(JSON.parse(tx.body)).toEqual({ tx: [{ ":db/id": -1 }] });
    const replay = planOf({ id: 4, op: "transact", tx: [{ ":db/id": -1 }], clientTxId: "c1" }) as any;
    const operation = planOf({
      id: 5,
      op: "operation",
      name: "issue/move",
      entity: 1001,
      input: { status: "done" },
      clientOpId: "op-1",
    }) as any;
    expect([operation.rest, operation.method]).toEqual(["/op", "POST"]);
    expect(JSON.parse(operation.body)).toEqual({
      name: "issue/move",
      entity: 1001,
      input: { status: "done" },
      clientOpId: "op-1",
    });
    expect(JSON.parse(replay.body)).toEqual({ tx: [{ ":db/id": -1 }], clientTxId: "c1" });
  });

  test("entity/info → GET, asOf on the query string", () => {
    expect(planOf({ id: 4, op: "entity", eid: 42 })).toMatchObject({ rest: "/entity/42", method: "GET" });
    expect(planOf({ id: 4, op: "entity", eid: 42, asOf: 9 })).toMatchObject({ rest: "/entity/42?asOf=9" });
    expect(planOf({ id: 5, op: "info" })).toEqual({ id: 5, op: "info", rest: "/info", method: "GET", headers: {} }); // GET: no body
  });

  test("minT becomes x-ramose-min-t on reads; absent minT sets no header", () => {
    const q = planOf({ id: 1, op: "q", query: "[:find ?e]", minT: 12 }) as any;
    const pull = planOf({ id: 2, op: "pull", eid: 1, pattern: ["*"], minT: 0 }) as any;
    expect(q.headers["x-ramose-min-t"]).toBe("12");
    expect(pull.headers["x-ramose-min-t"]).toBe("0");
    expect((planOf({ id: 3, op: "q", query: "[:find ?e]" }) as any).headers["x-ramose-min-t"]).toBeUndefined();
    expect((planOf({ id: 4, op: "q", query: "[:find ?e]", minT: -1 }) as any).headers["x-ramose-min-t"]).toBeUndefined();
    expect((planOf({ id: 5, op: "q", query: "[:find ?e]", minT: "9" }) as any).headers["x-ramose-min-t"]).toBeUndefined();
  });

  test("malformed frames are plan errors, keeping the id when there is one", () => {
    expect(planOf({ op: "info" })).toEqual({ id: undefined, error: "frame.id must be a number" });
    expect(planOf([1, 2])).toMatchObject({ id: undefined });
    expect(planOf({ id: 1, op: "nope" })).toEqual({ id: 1, error: "unknown op: nope" });
    expect(planOf({ id: 1, op: "transact" })).toMatchObject({ id: 1 });
    expect(planOf({ id: 1, op: "q" })).toMatchObject({ id: 1, error: "q frame needs query" });
    expect(planOf({ id: 1, op: "pull", eid: 1 })).toMatchObject({ id: 1, error: "pull frame needs pattern" });
    expect(planOf({ id: 1, op: "entity", eid: "x" })).toMatchObject({ id: 1 });
  });
});

describe("parsePrincipalHeader", () => {
  test("the worker hands the replica a JSON principal; junk is ignored", () => {
    const ada: Principal = { kind: "user", class: "member", sub: "ada", claims: { sub: "ada" }, db: "acme" };
    expect(PRINCIPAL_HEADER).toBe("x-ramose-principal");
    expect(parsePrincipalHeader(JSON.stringify(ada))).toEqual(ada);
    expect(parsePrincipalHeader(null)).toBeUndefined();
    expect(parsePrincipalHeader("")).toBeUndefined();
    expect(parsePrincipalHeader("{")).toBeUndefined();
    expect(parsePrincipalHeader(JSON.stringify({ class: "member" }))).toBeUndefined();
  });
});

describe("frame dispatch", () => {
  test("every op reaches its route and comes back as one reply with the same id", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch(() => json({ t: 4, result: [] }));
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "q", query: "[:find ?e]", inputs: [] }));
    await s.onMessage(JSON.stringify({ id: 2, op: "pull", eid: 7, pattern: ["*"], minT: 4 }));
    await s.onMessage(JSON.stringify({ id: 3, op: "entity", eid: 7 }));
    await s.onMessage(JSON.stringify({ id: 4, op: "info" }));
    expect(calls.map((c) => `${c.method} ${c.rest}`)).toEqual(["POST /query", "POST /pull", "GET /entity/7", "GET /info"]);
    expect(calls[1].headers["x-ramose-min-t"]).toBe("4");
    expect(calls[0].headers["x-ramose-min-t"]).toBeUndefined();
    expect(socket.frames.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    expect(socket.frames[0]).toMatchObject({ id: 1, status: 200, body: { t: 4, result: [] } });
  });

  test("the socket's own message events drive dispatch (frames are not serialized)", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch();
    session(socket, { dispatch });
    socket.message({ id: 1, op: "info" });
    socket.message({ id: 2, op: "info" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(2);
    expect(socket.frames.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  test("reply carries the status and the x-ramose-* headers; an upstream 413 does not close the socket", async () => {
    const socket = new FakeSocket();
    const budget = { error: "query aborted", code: "query/budget-exceeded", clause: "[?e :p/f ?f]", cells: 900, limit: 500 };
    const { dispatch } = fakeDispatch((c) =>
      c.rest === "/query"
        ? json(budget, 413, { "x-ramose-ms": "7" })
        : json({ t: 4, result: [] }, 200, { "x-ramose-ms": "3", "x-ramose-basis-t": "4", "x-ramose-basis-hit": "1", "x-ramose-colo": "IAD", "x-not-a-meta-header": "drop me" }),
    );
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "query-typo" }));
    await s.onMessage(JSON.stringify({ id: 2, op: "q", query: "[:find ?e]" }));
    await s.onMessage(JSON.stringify({ id: 3, op: "pull", eid: 1, pattern: ["*"] }));
    expect(socket.frames[0]).toEqual({ id: 1, status: 400, body: { error: "unknown op: query-typo" } });
    expect(socket.frames[1]).toMatchObject({ id: 2, status: 413, body: budget });
    expect(socket.frames[1].headers).toEqual({ "x-ramose-ms": "7" });
    expect(socket.frames[2]).toMatchObject({ id: 3, status: 200 });
    expect(socket.frames[2].headers).toEqual({ "x-ramose-ms": "3", "x-ramose-basis-t": "4", "x-ramose-basis-hit": "1", "x-ramose-colo": "IAD" });
    expect(META_HEADERS).toContain("x-ramose-basis-t");
    expect(socket.closed).toBe(false);
  });

  test("a non-JSON frame, a non-object frame and a thrown dispatch all answer without closing", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch((c) => {
      if (c.rest === "/info") throw new Error("replica unavailable");
      return new Response("not json at all", { status: 502 });
    });
    const s = session(socket, { dispatch });
    await s.onMessage("}{ not json");
    await s.onMessage(JSON.stringify(["array", "frame"]));
    await s.onMessage(JSON.stringify({ id: 8, op: "info" }));
    await s.onMessage(JSON.stringify({ id: 9, op: "q", query: "[:find ?e]" }));
    expect(socket.frames[0]).toEqual({ id: 0, status: 400, body: { error: "frame must be JSON" } });
    expect(socket.frames[1]).toMatchObject({ id: 0, status: 400 });
    expect(socket.frames[2]).toEqual({ id: 8, status: 500, body: { error: "replica unavailable" } });
    expect(socket.frames[3]).toEqual({ id: 9, status: 502, body: "not json at all" }); // upstream pass-through, verbatim
    expect(socket.closed).toBe(false);
  });
});

describe("follow cursor", () => {
  test("HTTP ack does not move the follow cursor; applyEntry does", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch(() => json({ t: 9, txEid: 1, tempids: {}, datoms: [] }));
    const s = session(socket, {
      dispatch,
      filterEntry: async (e) => ({ kind: "tx", datoms: e.datoms }),
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    expect(socket.frames.map((f) => (f.op === undefined ? `reply:${f.id}` : f.op))).toEqual(["reply:1"]);
    expect(s.lastT).toBe(0);
    expect(s.watermark).toBe(0);
    await s.applyEntry({ t: 9, datoms: [wire(9)] }, 1);
    // from 0 < rootT 1 is a dump — one `{ op: resync, t }`
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 9 }]);
    expect(s.lastT).toBe(9);
    expect(s.watermark).toBe(9);
  });

  test("unsynced apply behind rootT is resync; the next catalog apply is tx", async () => {
    // The #28 e2e sockets never send {op:sync}. The first replica apply
    // therefore hits from < rootT and dumps — it does not walk the schema
    // entry as {op:tx}. After the dump, a catalog attr install still walks
    // as {op:tx} (no leftover {op:t}).
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      snapshot: async () => ({ t: 9, datoms: [wire(9)] }),
      filterEntry: async (e) => ({ kind: "tx", datoms: e.datoms }),
    });
    await s.applyEntry({ t: 9, datoms: [wire(9)] }, 1);
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 9, datoms: [wire(9)] }]);
    expect(socket.txs()).toEqual([]);
    expect(socket.frames.some((f) => f.op === "t")).toBe(false);
    await s.applyEntry({ t: 10, datoms: [wire(10)] }, 9);
    expect(socket.txs()).toEqual([{ op: "tx", t: 10, datoms: [wire(10)] }]);
    expect(s.lastT).toBe(10);
    expect(s.watermark).toBe(10);
  });

  test("a failed write does not ack, and a read that answers with a t does not either", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch((c) => (c.rest === "/transact" ? json({ error: "conflict" }, 409) : json({ t: 5, result: [] })));
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    await s.onMessage(JSON.stringify({ id: 2, op: "q", query: "[:find ?e]" }));
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.lastT).toBe(0);
  });
});

describe("socket lifetime", () => {
  test("a send that throws closes the socket instead of zombieing the session", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch();
    const s = session(socket, { dispatch });
    let done = false;
    void s.closed.then(() => {
      done = true;
    });
    socket.failSends = true;
    await s.onMessage(JSON.stringify({ id: 1, op: "info" })); // the reply send throws
    expect(calls.length).toBe(1);
    expect(socket.closed).toBe(true); // closed, so the client can reconnect
    expect(socket.closeCode).toBe(1011);
    await Promise.resolve();
    expect(done).toBe(true);
    await s.onMessage(JSON.stringify({ id: 2, op: "info" })); // dead: frames are dropped
    expect(calls.length).toBe(1);
  });

  test("a client-side close resolves closed and drops racing frames", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch();
    const s = session(socket, { dispatch });
    let done = false;
    void s.closed.then(() => {
      done = true;
    });
    socket.emit("close", { code: 1000 });
    await Promise.resolve();
    expect(done).toBe(true);
    await s.onMessage(JSON.stringify({ id: 1, op: "info" })); // a frame racing the close is dropped
    expect(calls.length).toBe(0);
    expect(socket.frames).toEqual([]);
  });

  test("a socket error dies too, and close() is idempotent", () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, { dispatch });
    socket.emit("error", { message: "boom" });
    s.close();
    s.close();
    expect(socket.closed).toBe(false); // the socket was already gone; nothing to close
  });
});

describe("the auth frame", () => {
  const who = (sub: string, exp?: number): Principal => ({ kind: "user", class: "member", sub, claims: { sub, ...(exp === undefined ? {} : { exp }) }, db: "demo" });

  /** Dispatch that records the principal each frame was planned under. */
  const seen = (): { dispatch: SessionDispatch; subs: (string | undefined)[]; release: () => void } => {
    const subs: (string | undefined)[] = [];
    let gate: Promise<void> | undefined;
    let open!: () => void;
    return {
      subs,
      release: () => open(),
      dispatch: async (_rest, _init, p) => {
        subs.push(p?.sub);
        if (gate === undefined) {
          gate = new Promise<void>((r) => {
            open = r;
          });
          await gate;
        }
        return json({ ok: true });
      },
    };
  };

  test("a swap acks and only later frames use the new principal; in-flight ones finish under the old", async () => {
    const socket = new FakeSocket();
    const { dispatch, subs, release } = seen();
    const s = session(socket, { dispatch, principal: who("ada"), authenticate: async () => who("bob") });
    const inflight = s.onMessage(JSON.stringify({ id: 1, op: "info" })); // parked in dispatch
    await s.onMessage(JSON.stringify({ id: 2, op: "auth", token: "next" }));
    expect(socket.replies()).toEqual([{ id: 2, ok: true }]);
    await s.onMessage(JSON.stringify({ id: 3, op: "info" }));
    release();
    await inflight;
    expect(subs).toEqual(["ada", "bob"]);
  });

  test("a refused swap keeps the old principal and answers with the refusal's status and code", async () => {
    const socket = new FakeSocket();
    const { dispatch, subs, release } = seen();
    const s = session(socket, {
      dispatch,
      principal: who("ada"),
      authenticate: () => Promise.reject(Object.assign(new Error("token is not valid for this database"), { status: 401, code: "policy" })),
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "auth", token: "forged" }));
    expect(socket.replies()).toEqual([{ id: 1, status: 401, body: { error: "token is not valid for this database", code: "policy" } }]);
    const inflight = s.onMessage(JSON.stringify({ id: 2, op: "info" }));
    release();
    await inflight;
    expect(subs).toEqual(["ada"]);
  });

  test("with a describe seam the ack names the swapped principal", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      principal: who("ada"),
      authenticate: async () => who("bob"),
      describe: async (p) => ({ eid: p.sub === "bob" ? 42 : null, class: p.class }),
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "auth", token: "next" }));
    expect(socket.replies()).toEqual([{ id: 1, ok: true, principal: { eid: 42, class: "member" } }]);
  });

  test("the ack says { eid: null } when the principal's row does not exist, and when describe fails", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let describes = 0;
    const s = session(socket, {
      dispatch,
      principal: who("ada"),
      authenticate: async () => who("bob"),
      describe: async () => {
        if (++describes === 1) return { eid: null, class: "member" };
        throw new Error("replica unavailable");
      },
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "auth", token: "next" }));
    // a transient describe error must not fail the swap: ack, just without an entity
    await s.onMessage(JSON.stringify({ id: 2, op: "auth", token: "next" }));
    expect(socket.replies()).toEqual([
      { id: 1, ok: true, principal: { eid: null, class: "member" } },
      { id: 2, ok: true, principal: { eid: null, class: "member" } },
    ]);
  });

  test("a session with no authenticate cannot re-authenticate", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 4, op: "auth", token: "x" }));
    expect(socket.replies()).toEqual([{ id: 4, status: 400, body: { error: "this session cannot re-authenticate" } }]);
  });

  test("past exp every frame is denied and the socket closes", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch();
    const s = session(socket, { dispatch, principal: who("ada", Math.floor(Date.now() / 1000) - 1) });
    await s.onMessage(JSON.stringify({ id: 1, op: "info" }));
    expect(calls).toEqual([]);
    expect(socket.replies()).toEqual([{ id: 1, status: 401, body: { error: "token expired" } }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.closed).toBe(true);
  });
});

describe("apply-then-push", () => {
  const filterOf = (decide: (t: number) => SessionTxDecision) => async (entry: { t: number }) => decide(entry.t);
  const attached = (filter: (t: number) => SessionTxDecision, extra: Partial<Parameters<typeof openSession>[1]> = {}) => {
    const socket = new FakeSocket();
    const { dispatch } = extra.dispatch ? { dispatch: extra.dispatch } : fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 10 },
      filterEntry: filterOf(filter),
      ...extra,
    });
    return { socket, s };
  };

  // Protocol walk on Session.applyEntry. The replica pin that would fail if
  // notifySessions were a no-op lives in test/internal/replica/session-follow.test.ts.
  test("two sessions on one replica receive both non-conflicting txs without a poll timer; later writer included", async () => {
    const a = attached((t) => ({ kind: "tx", datoms: [wire(t)] }));
    const b = attached((t) => ({ kind: "tx", datoms: [wire(t)] }));
    await pushApplied([a.s, b.s], { t: 11, datoms: [wire(11)] }, 10);
    await pushApplied([a.s, b.s], { t: 12, datoms: [wire(12)] }, 10);
    expect(a.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(b.socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(a.s.watermark).toBe(12);
    expect(b.s.watermark).toBe(12);
    expect(a.s.lastT).toBe(12);
    expect(b.s.lastT).toBe(12);
  });

  test("overlapping applyEntry still delivers t and t+1 — from is the walked cursor at run, not enqueue", async () => {
    const { socket, s } = attached((t) => ({ kind: "tx", datoms: [wire(t)] }));
    // Capturing watermark at enqueue made both jobs start from 10; the
    // second walk then saw 12 > 10+1 and tore — t+1 never left.
    await Promise.all([
      s.applyEntry({ t: 11, datoms: [wire(11)] }, 10),
      s.applyEntry({ t: 12, datoms: [wire(12)] }, 10),
    ]);
    expect(socket.resyncs()).toEqual([]);
    expect(socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(s.watermark).toBe(12);
  });

  test("applyEntry twice before the first consider resolves still delivers both txs", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 10 },
      filterEntry: async (entry) => {
        entered += 1;
        if (entered === 1) await hold;
        return { kind: "tx", datoms: [wire(entry.t)] };
      },
    });
    const first = s.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    const second = s.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    for (let i = 0; i < 20 && entered === 0; i++) await Promise.resolve();
    expect(entered).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(socket.resyncs()).toEqual([]);
    expect(socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(s.watermark).toBe(12);
  });

  test("cursor / basisT cannot get ahead of an unapplied frame", async () => {
    const { socket, s } = attached((t) => ({ kind: "tx", datoms: [wire(t)] }));
    expect(s.watermark).toBe(10);
    await s.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    expect(s.watermark).toBe(10);
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    await s.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    await s.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    expect(socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(s.watermark).toBe(12);
  });

  test("fully-filtered tx is silence (no t leak); later visible tx still arrives", async () => {
    const { socket, s } = attached((t) => (t === 11 ? { kind: "skip" } : { kind: "tx", datoms: [wire(t)] }));
    await s.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.lastT).toBe(0);
    expect(s.watermark).toBe(11);
    await s.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    expect(socket.txs()).toEqual([{ op: "tx", t: 12, datoms: [wire(12)] }]);
    expect(s.watermark).toBe(12);
  });

  test("grant/revoke still resync", async () => {
    const { socket, s } = attached(() => ({ kind: "resync" }), {
      snapshot: async () => ({ t: 11, datoms: [wire(1), wire(2)] }),
    });
    await s.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 11, datoms: [wire(1), wire(2)] }]);
    expect(socket.txs()).toEqual([]);
    expect(s.watermark).toBe(11);
  });

  test("connect still snapshot-then-tail (from < rootT or first attach)", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const log: SessionLog = {
      t: 8,
      rootT: 4,
      entries: [
        { t: 5, datoms: [wire(5)] },
        { t: 6, datoms: [wire(6)] },
        { t: 7, datoms: [wire(7)] },
        { t: 8, datoms: [wire(8)] },
      ],
    };
    const late = session(socket, {
      dispatch,
      readLog: async () => log,
      filterEntry: filterOf(() => ({ kind: "tx", datoms: [wire(1)] })),
      snapshot: async () => ({ t: 8, datoms: [wire(1)] }),
    });
    await late.onMessage(JSON.stringify({ id: 2, op: "sync", from: 2 }));
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 8, datoms: [wire(1)] }]);
    expect(socket.txs()).toEqual([]);
    await late.applyEntry({ t: 9, datoms: [wire(9)] }, 4);
    expect(socket.txs().map((f) => f.t)).toEqual([9]);
  });
});

describe("filtered log walk", () => {
  const filterOf = (decide: (t: number) => SessionTxDecision) => async (entry: { t: number }) => decide(entry.t);

  test("a fully-filtered tx does not appear on that socket (no t, no datoms)", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: filterOf(() => ({ kind: "skip" })),
    });
    expect(s.lastT).toBe(0);
    expect(s.watermark).toBe(5);
    await s.applyEntry({ t: 6, datoms: [wire(6)] }, 1);
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.lastT).toBe(0); // skip must not leak t
    expect(s.watermark).toBe(6);
  });

  test("a revoke-of-P produces resync, not silence", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: filterOf((t) => (t === 6 ? { kind: "resync" } : { kind: "skip" })),
    });
    await s.applyEntry({ t: 6, datoms: [wire(6)] }, 1);
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 6 }]);
    expect(socket.txs()).toEqual([]);
  });

  test("a same-tx grant yields resync, not a one-datom apply", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: filterOf(() => ({ kind: "resync" })),
      snapshot: async () => ({ t: 6, datoms: [wire(1), wire(2)] }),
    });
    await s.applyEntry({ t: 6, datoms: [wire(6)] }, 1);
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 6, datoms: [wire(1), wire(2)] }]);
    expect(socket.txs()).toEqual([]);
  });

  test("a visible tx is one { op: tx, t, datoms } frame", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const kept = [wire(6)];
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: filterOf(() => ({ kind: "tx", datoms: kept })),
    });
    await s.applyEntry({ t: 6, datoms: [wire(6), wire(6)] }, 1);
    expect(socket.txs()).toEqual([{ op: "tx", t: 6, datoms: kept }]);
    expect(socket.frames.filter((f) => f.op === "t")).toEqual([]);
    expect(s.lastT).toBe(6);
  });

  test("catch-up from skips empties; from < root.t is resync", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const log: SessionLog = {
      t: 8,
      rootT: 4,
      entries: [
        { t: 5, datoms: [wire(5)] },
        { t: 6, datoms: [wire(6)] },
        { t: 7, datoms: [wire(7)] },
        { t: 8, datoms: [wire(8)] },
      ],
    };
    const s = session(socket, {
      dispatch,
      readLog: async () => log,
      filterEntry: filterOf((t) => (t === 6 || t === 8 ? { kind: "tx", datoms: [wire(t)] } : { kind: "skip" })),
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "sync", from: 4 }));
    expect(socket.txs().map((f) => f.t)).toEqual([6, 8]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.watermark).toBe(8);
    expect(socket.replies()).toEqual([{ id: 1, status: 200, body: { t: 8, from: 4 } }]);

    const late = new FakeSocket();
    const sl = session(late, {
      dispatch,
      readLog: async () => log,
      filterEntry: filterOf(() => ({ kind: "tx", datoms: [wire(1)] })),
      snapshot: async () => ({ t: 8, datoms: [wire(1)] }),
    });
    await sl.onMessage(JSON.stringify({ id: 2, op: "sync", from: 2 })); // 2 < rootT 4
    expect(late.resyncs()).toEqual([{ op: "resync", t: 8, datoms: [wire(1)] }]);
    expect(late.txs()).toEqual([]);
  });

  test("kind: tx without datoms never sends the replica entry", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const leak: WireDatom = [1, 2, 3, "UNFILTERED-LEAK", 6, 1];
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: async () => ({ kind: "tx" }) as SessionTxDecision,
    });
    await s.applyEntry({ t: 6, datoms: [leak] }, 1).catch(() => undefined);
    expect(JSON.stringify(socket.frames)).not.toContain("UNFILTERED-LEAK");
    expect(socket.txs()).toEqual([]);
    expect(s.lastT).toBe(0);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
  });

  test("a filter throw is not silence: the socket closes, lastT does not jump", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 5 },
      filterEntry: async () => {
        throw new Error("sieve exploded");
      },
    });
    await s.applyEntry({ t: 6, datoms: [wire(6)] }, 1).catch(() => undefined);
    expect(socket.txs()).toEqual([]);
    expect(s.lastT).toBe(0);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1011);
  });

  test("apply of t+2 while t+1 is unapplied does not stamp the tip", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const phone = [wire(11)];
    const browser = [wire(12)];
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 10 },
      filterEntry: filterOf((t) => ({ kind: "tx", datoms: t === 11 ? phone : browser })),
    });
    expect(s.watermark).toBe(10);
    await s.applyEntry({ t: 12, datoms: browser }, 10);
    expect(s.watermark).toBe(10); // must not jump to 12
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    await s.applyEntry({ t: 11, datoms: phone }, 10);
    await s.applyEntry({ t: 12, datoms: browser }, 10);
    expect(socket.txs().map((f) => f.t)).toEqual([11, 12]);
    expect(s.watermark).toBe(12);
  });

  test("torn catch-up with a snapshot dumps instead of claiming log.t", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const dump = [wire(11), wire(12)];
    const s = session(socket, {
      dispatch,
      readLog: async () => ({ t: 12, rootT: 10, entries: [{ t: 12, datoms: [wire(12)] }] }),
      filterEntry: filterOf(() => ({ kind: "tx", datoms: [wire(12)] })),
      snapshot: async () => ({ t: 12, datoms: dump }),
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "sync", from: 10 }));
    expect(socket.resyncs()).toEqual([{ op: "resync", t: 12, datoms: dump }]);
    expect(s.watermark).toBe(12);
    expect(socket.txs()).toEqual([]);
  });

  test("a newly attached session does not inherit another session's cursor", async () => {
    const a = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const opts = {
      dispatch,
      filterEntry: filterOf((t: number) => ({ kind: "tx" as const, datoms: [wire(t)] })),
    };
    const sa = session(a, { ...opts, seed: { lastT: 0, watermark: 10 } });
    await sa.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    await sa.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    expect(sa.watermark).toBe(12);
    expect(a.txs().map((f) => f.t)).toEqual([11, 12]);

    const b = new FakeSocket();
    const sb = session(b, opts);
    expect(sb.watermark).toBe(0); // must not seed-jump to the other socket's t
    expect(sb.lastT).toBe(0);
    expect(b.frames).toEqual([]);
  });

  test("sieved skip is not a hole: cursor advances, later visible tx arrives", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      seed: { lastT: 0, watermark: 10 },
      filterEntry: filterOf((t) => (t === 11 ? { kind: "skip" } : { kind: "tx", datoms: [wire(t)] })),
    });
    await s.applyEntry({ t: 11, datoms: [wire(11)] }, 10);
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.lastT).toBe(0);
    expect(s.watermark).toBe(11);
    await s.applyEntry({ t: 12, datoms: [wire(12)] }, 10);
    expect(socket.txs()).toEqual([{ op: "tx", t: 12, datoms: [wire(12)] }]);
    expect(s.watermark).toBe(12);
  });

  test("sync answers 500 when the sieve throws (not a successful empty catch-up)", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      readLog: async () => ({
        t: 6,
        rootT: 1,
        entries: [
          { t: 5, datoms: [wire(5)] },
          { t: 6, datoms: [wire(6)] },
        ],
      }),
      filterEntry: async () => {
        throw new Error("sieve exploded");
      },
    });
    await s.onMessage(JSON.stringify({ id: 1, op: "sync", from: 4 }));
    expect(socket.replies()).toEqual([{ id: 1, status: 500, body: { error: "sieve exploded" } }]);
    expect(socket.txs()).toEqual([]);
    expect(socket.closed).toBe(true);
  });
});

describe("decideSessionTx: post-commit rule view", () => {
  const SCHEMA = [
    { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
    { ":db/ident": ":org/members", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
    { ":db/ident": ":project/org", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  ];
  const inOrg = A.ref(":doc/project", A.ref(":project/org", A.eq(":org/members", A.principal)));
  const POLICY = parsePolicy({
    version: 1,
    principal: ":user/sub",
    classes: ["member", "admin"],
    attrs: {},
    ns: {
      doc: { read: [A.allow(A.or(A.eq(":doc/owner", A.principal), inOrg))] },
      project: { read: [A.allow(A.ref(":project/org", A.eq(":org/members", A.principal)))] },
      org: { read: [A.allow(A.eq(":org/members", A.principal))] },
      user: { read: [A.allow(A.eq(":user/sub", A.claim("sub")))] },
    },
    preset: { ":doc/owner": A.principal },
  });
  const user = (sub: string, eid: number): Principal => ({
    kind: "user",
    class: "member",
    sub,
    eid,
    claims: { sub },
    db: "acme",
  });

  async function world() {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact(SCHEMA);
    const rep = await conn.transact([
      { ":db/id": "ada", ":user/sub": "user_ada" },
      { ":db/id": "bea", ":user/sub": "user_bea" },
      { ":db/id": "cal", ":user/sub": "user_cal" },
      { ":db/id": "org", ":org/members": ["ada", "bea"] },
      { ":db/id": "proj", ":project/org": "org" },
      { ":db/id": "doc", ":doc/title": "Roadmap", ":doc/owner": "ada", ":doc/project": "proj" },
      { ":db/id": "other", ":org/members": ["cal"] },
    ]);
    return {
      conn,
      ids: rep.tempids,
      policy: POLICY,
      ada: user("user_ada", rep.tempids.ada),
      bea: user("user_bea", rep.tempids.bea),
      cal: user("user_cal", rep.tempids.cal),
    };
  }

  test("no policy: a catalog attr install is tx, not skip", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    const before = conn.db();
    const rep = await conn.transact([
      { ":db/ident": ":two/b", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
    ]);
    const decision = await decideSessionTx({
      datoms: rep.txData,
      ruleDbAfter: conn.db(),
      ruleDbBefore: before,
    });
    expect(decision.kind).toBe("tx");
    if (decision.kind !== "tx") throw new Error("expected tx");
    expect(decision.datoms.length).toBeGreaterThan(0);
  });

  test("a fully-filtered other-org write is skip (no t leak)", async () => {
    const { conn, ids, policy, ada } = await world();
    const before = conn.db();
    const rep = await conn.transact([{ ":db/id": "secret", ":doc/title": "Cal only", ":doc/owner": ids.cal, ":doc/project": ids.other }]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("skip");
  });

  test("a revoke-of-P is resync, not silence", async () => {
    const { conn, ids, policy, ada } = await world();
    const before = conn.db();
    const rep = await conn.transact([
      [":db/retract", ids.doc, ":doc/owner", ids.ada],
      [":db/retract", ids.proj, ":project/org", ids.org],
    ]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("resync");
  });

  test("a same-tx grant of membership is resync, not a one-datom apply", async () => {
    const { conn, ids, policy, cal } = await world();
    const before = conn.db();
    const rep = await conn.transact([[":db/add", ids.org, ":org/members", ids.cal]]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: cal, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("resync");
  });

  test("a visible add is filtered against the post-commit ruleDb", async () => {
    const { conn, ids, policy, ada } = await world();
    const before = conn.db();
    const rep = await conn.transact([[":db/add", ids.doc, ":doc/title", "Roadmap v2"]]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("tx");
    if (decision.kind !== "tx") throw new Error("expected tx");
    expect(decision.datoms.length).toBeGreaterThan(0);
    expect(decision.datoms.every((d) => d[4] === rep.t)).toBe(true);
  });

  test("a peer-visible create is tx, not resync", async () => {
    const { conn, ids, policy, ada, bea } = await world();
    const before = conn.db();
    const rep = await conn.transact([{ ":db/id": "q3", ":doc/title": "Q3", ":doc/owner": ids.ada, ":doc/project": ids.proj }]);
    const after = conn.db();
    const adaDecision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: after, ruleDbBefore: before });
    const beaDecision = await decideSessionTx({ datoms: rep.txData, policy, principal: bea, ruleDbAfter: after, ruleDbBefore: before });
    expect(adaDecision.kind).toBe("tx");
    expect(beaDecision.kind).toBe("tx");
    if (adaDecision.kind !== "tx" || beaDecision.kind !== "tx") throw new Error("expected tx");
    expect(adaDecision.datoms.length).toBeGreaterThan(0);
    expect(beaDecision.datoms.length).toBeGreaterThan(0);
  });
});

describe("sieve security: openSession + decideSessionTx", () => {
  const SCHEMA = [
    { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
    { ":db/ident": ":org/members", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
    { ":db/ident": ":project/org", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
    { ":db/ident": ":doc/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  ];
  const inOrg = A.ref(":doc/project", A.ref(":project/org", A.eq(":org/members", A.principal)));
  const POLICY = parsePolicy({
    version: 1,
    principal: ":user/sub",
    classes: ["member", "admin"],
    attrs: { ":doc/audit": { read: [A.allow(A.class("admin"))] } },
    ns: {
      doc: { read: [A.allow(A.or(A.eq(":doc/owner", A.principal), inOrg))] },
      project: { read: [A.allow(A.ref(":project/org", A.eq(":org/members", A.principal)))] },
      org: { read: [A.allow(A.eq(":org/members", A.principal))] },
      user: { read: [A.allow(A.eq(":user/sub", A.claim("sub")))] },
    },
    preset: { ":doc/owner": A.principal },
  });
  const user = (sub: string, eid: number): Principal => ({
    kind: "user",
    class: "member",
    sub,
    eid,
    claims: { sub },
    db: "acme",
  });
  const values = (datoms: readonly WireDatom[]) => datoms.map((d) => d[3]);

  async function world() {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact(SCHEMA);
    const rep = await conn.transact([
      { ":db/id": "ada", ":user/sub": "user_ada" },
      { ":db/id": "bea", ":user/sub": "user_bea" },
      { ":db/id": "cal", ":user/sub": "user_cal" },
      { ":db/id": "org", ":org/members": ["ada", "bea"] },
      { ":db/id": "proj", ":project/org": "org" },
      { ":db/id": "doc", ":doc/title": "Roadmap", ":doc/owner": "ada", ":doc/project": "proj", ":doc/audit": "AUDIT-SEED" },
      { ":db/id": "other", ":org/members": ["cal"] },
    ]);
    return {
      conn,
      ids: rep.tempids,
      policy: POLICY,
      seedT: conn.t,
      ada: user("user_ada", rep.tempids.ada),
      bea: user("user_bea", rep.tempids.bea),
      cal: user("user_cal", rep.tempids.cal),
    };
  }

  function sieveOf(conn: Connection, policy: typeof POLICY) {
    return async (entry: { t: number; datoms: WireDatom[] }, principal?: Principal) =>
      decideSessionTx({
        datoms: entry.datoms.map(fromWireDatom),
        policy,
        principal,
        ruleDbAfter: conn.db().asOf(entry.t),
        ruleDbBefore: conn.db().asOf(Math.max(0, entry.t - 1)),
      });
  }

  function snapshotOf(conn: Connection, policy: typeof POLICY) {
    return async (principal?: Principal) => {
      const db = conn.db();
      const view = principal ? filterDb(db, db, policy, principal) : db;
      return { t: db.basisT, datoms: await currentViewDatoms(view) };
    };
  }

  test("other-org write is silence on the socket (no t, no tx); lastT stays, watermark advances", async () => {
    const { conn, ids, policy, seedT, ada } = await world();
    const entries: SessionLogEntry[] = [];
    let log: SessionLog = { t: seedT, rootT: 1, entries };
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      principal: ada,
      readLog: async () => log,
      filterEntry: sieveOf(conn, policy),
      seed: { lastT: seedT, watermark: 0 },
    });
    expect(s.lastT).toBe(seedT);
    const rep = await conn.transact([{ ":db/id": "secret", ":doc/title": "Cal only", ":doc/owner": ids.cal, ":doc/project": ids.other }]);
    entries.push({ t: rep.t, datoms: rep.txData.map(toWireDatom) });
    log = { t: conn.t, rootT: 1, entries: [...entries] };
    await s.onMessage(JSON.stringify({ id: 1, op: "sync", from: seedT }));
    expect(socket.txs()).toEqual([]);
    expect(socket.resyncs()).toEqual([]);
    expect(s.lastT).toBe(seedT);
    expect(s.watermark).toBe(rep.t);
  });

  test("revoke-of-P is resync; snapshot does not contain now-unreadable facts", async () => {
    const { conn, ids, policy, seedT, bea } = await world();
    const entries: SessionLogEntry[] = [];
    let log: SessionLog = { t: seedT, rootT: 1, entries };
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const s = session(socket, {
      dispatch,
      principal: bea,
      readLog: async () => log,
      filterEntry: sieveOf(conn, policy),
      snapshot: snapshotOf(conn, policy),
    });
    const rep = await conn.transact([[":db/retract", ids.org, ":org/members", ids.bea]]);
    entries.push({ t: rep.t, datoms: rep.txData.map(toWireDatom) });
    log = { t: conn.t, rootT: 1, entries: [...entries] };
    await s.onMessage(JSON.stringify({ id: 1, op: "sync", from: seedT }));
    expect(socket.resyncs()).toHaveLength(1);
    expect(socket.txs()).toEqual([]);
    const snap = values(socket.resyncs()[0].datoms ?? []);
    expect(snap).not.toContain("Roadmap");
    expect(snap).not.toContain("AUDIT-SEED");
    expect(JSON.stringify(socket.frames)).not.toContain("AUDIT-SEED");
  });

  test("empty-looking membership retract is resync, not skip", async () => {
    const { conn, ids, policy, ada } = await world();
    const before = conn.db();
    const rep = await conn.transact([[":db/retract", ids.org, ":org/members", ids.ada]]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("resync");
  });

  test("grant of membership is resync; peer-visible create is tx", async () => {
    const { conn, ids, policy, seedT, ada, bea, cal } = await world();
    const entries: SessionLogEntry[] = [];
    let log: SessionLog = { t: seedT, rootT: 1, entries };
    const grantSock = new FakeSocket();
    const createAda = new FakeSocket();
    const createBea = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const opts = { dispatch, readLog: async () => log, filterEntry: sieveOf(conn, policy) };
    const grantS = session(grantSock, { ...opts, principal: cal });
    const adaS = session(createAda, { ...opts, principal: ada });
    const beaS = session(createBea, { ...opts, principal: bea });
    const grant = await conn.transact([[":db/add", ids.org, ":org/members", ids.cal]]);
    entries.push({ t: grant.t, datoms: grant.txData.map(toWireDatom) });
    log = { t: conn.t, rootT: 1, entries: [...entries] };
    await grantS.onMessage(JSON.stringify({ id: 1, op: "sync", from: seedT }));
    expect(grantSock.resyncs()).toHaveLength(1);
    expect(grantSock.txs()).toEqual([]);

    const created = await conn.transact([{ ":db/id": "q3", ":doc/title": "Q3", ":doc/owner": ids.ada, ":doc/project": ids.proj, ":doc/audit": "LEAK-AUDIT" }]);
    entries.push({ t: created.t, datoms: created.txData.map(toWireDatom) });
    log = { t: conn.t, rootT: 1, entries: [...entries] };
    await adaS.onMessage(JSON.stringify({ id: 2, op: "sync", from: seedT }));
    await beaS.onMessage(JSON.stringify({ id: 3, op: "sync", from: seedT }));
    expect(createAda.resyncs()).toEqual([]);
    expect(createBea.resyncs()).toEqual([]);
    const adaCreate = createAda.txs().find((f) => f.t === created.t);
    const beaCreate = createBea.txs().find((f) => f.t === created.t);
    expect(adaCreate).toBeDefined();
    expect(beaCreate).toBeDefined();
    expect(values(adaCreate!.datoms)).toContain("Q3");
    expect(values(adaCreate!.datoms)).not.toContain("LEAK-AUDIT");
    expect(values(beaCreate!.datoms)).toContain("Q3");
    expect(values(beaCreate!.datoms)).not.toContain("LEAK-AUDIT");
  });

  test("catch-up skips filtered rows, resyncs from < root.t, and a grant in the gap is resync", async () => {
    const { conn, ids, policy, seedT, ada, cal } = await world();
    const hidden = await conn.transact([{ ":db/id": "secret", ":doc/title": "Cal only", ":doc/owner": ids.cal, ":doc/project": ids.other }]);
    const title = await conn.transact([[":db/add", ids.doc, ":doc/title", "Roadmap v2"]]);
    const grant = await conn.transact([[":db/add", ids.org, ":org/members", ids.cal]]);
    const created = await conn.transact([{ ":db/id": "q3", ":doc/title": "Q3", ":doc/owner": ids.ada, ":doc/project": ids.proj }]);
    const all: SessionLogEntry[] = [
      { t: hidden.t, datoms: hidden.txData.map(toWireDatom) },
      { t: title.t, datoms: title.txData.map(toWireDatom) },
      { t: grant.t, datoms: grant.txData.map(toWireDatom) },
      { t: created.t, datoms: created.txData.map(toWireDatom) },
    ];
    const adaLog: SessionLog = { t: conn.t, rootT: seedT, entries: all };
    const calLog: SessionLog = { t: conn.t, rootT: seedT, entries: all };
    const { dispatch } = fakeDispatch();

    const adaSock = new FakeSocket();
    const adaS = session(adaSock, { dispatch, principal: ada, readLog: async () => adaLog, filterEntry: sieveOf(conn, policy) });
    await adaS.onMessage(JSON.stringify({ id: 1, op: "sync", from: seedT }));
    expect(adaSock.txs().map((f) => f.t)).toEqual([title.t, grant.t, created.t]);
    expect(adaSock.resyncs()).toEqual([]);
    expect(JSON.stringify(adaSock.frames)).not.toContain("Cal only");

    const calSock = new FakeSocket();
    const calS = session(calSock, {
      dispatch,
      principal: cal,
      readLog: async () => calLog,
      filterEntry: sieveOf(conn, policy),
      snapshot: snapshotOf(conn, policy),
    });
    await calS.onMessage(JSON.stringify({ id: 2, op: "sync", from: seedT }));
    expect(calSock.resyncs()).toHaveLength(1);
    expect(calSock.txs().every((f) => f.t < grant.t)).toBe(true);
    expect(values(calSock.resyncs()[0].datoms ?? [])).toContain("Roadmap v2");

    const late = new FakeSocket();
    const lateS = session(late, {
      dispatch,
      principal: ada,
      readLog: async () => adaLog,
      filterEntry: sieveOf(conn, policy),
      snapshot: snapshotOf(conn, policy),
    });
    await lateS.onMessage(JSON.stringify({ id: 3, op: "sync", from: 1 }));
    expect(late.resyncs()).toHaveLength(1);
    expect(late.txs()).toEqual([]);
    expect(values(late.resyncs()[0].datoms ?? [])).not.toContain("AUDIT-SEED");
  });

  test("writer HTTP ack and later { op: tx } for the same t are the same filtered list", async () => {
    const { conn, ids, policy, seedT, ada } = await world();
    let ack: { t: number; txEid: number; tempids: Record<string, never>; datoms: WireDatom[] } | undefined;
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch(() => json(ack));
    const s = session(socket, {
      dispatch,
      principal: ada,
      seed: { lastT: 0, watermark: seedT },
      filterEntry: sieveOf(conn, policy),
    });
    const before = conn.db();
    const rep = await conn.transact([{ ":db/id": "q3", ":doc/title": "Q3", ":doc/owner": ids.ada, ":doc/project": ids.proj, ":doc/audit": "LEAK-AUDIT" }]);
    const decision = await decideSessionTx({ datoms: rep.txData, policy, principal: ada, ruleDbAfter: conn.db(), ruleDbBefore: before });
    expect(decision.kind).toBe("tx");
    if (decision.kind !== "tx") throw new Error("expected tx");
    ack = { t: rep.t, txEid: 1, tempids: {}, datoms: decision.datoms };
    const unfiltered = rep.txData.map(toWireDatom);
    expect(values(unfiltered)).toContain("LEAK-AUDIT");
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    const reply = socket.replies().find((f) => f.id === 1);
    expect(reply.body.datoms).toEqual(ack.datoms);
    expect(socket.txs()).toEqual([]); // ack paints; it does not push or move the cursor
    expect(s.watermark).toBe(seedT);
    await s.applyEntry({ t: rep.t, datoms: unfiltered }, 1);
    expect(socket.txs()).toHaveLength(1);
    expect(socket.txs()[0]).toEqual({ op: "tx", t: rep.t, datoms: ack.datoms });
    expect(values(ack.datoms)).toContain("Q3");
    expect(values(ack.datoms)).not.toContain("LEAK-AUDIT");
  });

  test("writer { op: tx } echo carries this session's clientTxId; another session's apply does not", async () => {
    const { conn, ids, policy, seedT, ada } = await world();
    let ack:
      | { t: number; txEid: number; tempids: Record<string, never>; datoms: WireDatom[]; clientTxId: string }
      | undefined;
    const writerSock = new FakeSocket();
    const otherSock = new FakeSocket();
    const { dispatch } = fakeDispatch(() => json(ack));
    const writer = session(writerSock, {
      dispatch,
      principal: ada,
      seed: { lastT: 0, watermark: seedT },
      filterEntry: sieveOf(conn, policy),
    });
    const other = session(otherSock, {
      dispatch,
      principal: ada,
      seed: { lastT: 0, watermark: seedT },
      filterEntry: sieveOf(conn, policy),
    });
    const before = conn.db();
    const rep = await conn.transact([
      { ":db/id": "q3", ":doc/title": "Q3", ":doc/owner": ids.ada, ":doc/project": ids.proj, ":doc/audit": "LEAK-AUDIT" },
    ]);
    const decision = await decideSessionTx({
      datoms: rep.txData,
      policy,
      principal: ada,
      ruleDbAfter: conn.db(),
      ruleDbBefore: before,
    });
    expect(decision.kind).toBe("tx");
    if (decision.kind !== "tx") throw new Error("expected tx");
    ack = { t: rep.t, txEid: 1, tempids: {}, datoms: decision.datoms, clientTxId: "c-writer" };
    const unfiltered = rep.txData.map(toWireDatom);
    await writer.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [], clientTxId: "c-writer" }));
    expect(writerSock.txs()).toEqual([]);
    expect(writer.watermark).toBe(seedT);
    await writer.applyEntry({ t: rep.t, datoms: unfiltered }, 1);
    await other.applyEntry({ t: rep.t, datoms: unfiltered }, 1);
    expect(writerSock.txs()).toHaveLength(1);
    expect(writerSock.txs()[0]).toEqual({
      op: "tx",
      t: rep.t,
      datoms: ack.datoms,
      clientTxId: "c-writer",
    });
    expect(otherSock.txs()).toHaveLength(1);
    expect(otherSock.txs()[0]).toEqual({ op: "tx", t: rep.t, datoms: ack.datoms });
    expect(otherSock.txs()[0].clientTxId).toBeUndefined();
  });
});
