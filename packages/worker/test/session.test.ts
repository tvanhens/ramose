import { afterEach, describe, expect, test } from "bun:test";
import { META_HEADERS, type Scheduler, type SessionDispatch, type SocketLike, openSession, planOf, watcherKeys } from "../src/session.ts";

/** A `WebSocket` stand-in: records what the session sent, replays what a client would do. */
class FakeSocket implements SocketLike {
  readonly frames: any[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.frames.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
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
  ticks() {
    return this.frames.filter((f) => f.op === "t");
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

/** A scheduler whose tick only fires when the test says so. */
function manualScheduler() {
  const state = { fns: [] as (() => void)[], ms: [] as number[], cancels: 0 };
  const schedule: Scheduler = (fn, ms) => {
    state.fns.push(fn);
    state.ms.push(ms);
    return () => {
      state.cancels++;
    };
  };
  /** fire every live interval and let the poll promise settle */
  const tick = async () => {
    for (const fn of state.fns) fn();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { schedule, tick, state };
}

let open: { close(): void }[] = [];
const session = (socket: FakeSocket, options: Parameters<typeof openSession>[1]) => {
  const s = openSession(socket, options);
  open.push(s);
  return s;
};

afterEach(() => {
  for (const s of open) s.close();
  open = [];
  expect(watcherKeys()).toEqual([]); // every test must leave the isolate's watcher map empty
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
  });

  test("entity/info → GET, asOf on the query string", () => {
    expect(planOf({ id: 4, op: "entity", eid: 42 })).toMatchObject({ rest: "/entity/42", method: "GET" });
    expect(planOf({ id: 4, op: "entity", eid: 42, asOf: 9 })).toMatchObject({ rest: "/entity/42?asOf=9" });
    expect(planOf({ id: 5, op: "info" })).toEqual({ id: 5, op: "info", rest: "/info", method: "GET", headers: {} }); // GET: no body
  });

  test("minT becomes x-ripple-min-t on reads; absent minT sets no header", () => {
    const q = planOf({ id: 1, op: "q", query: "[:find ?e]", minT: 12 }) as any;
    const pull = planOf({ id: 2, op: "pull", eid: 1, pattern: ["*"], minT: 0 }) as any;
    expect(q.headers["x-ripple-min-t"]).toBe("12");
    expect(pull.headers["x-ripple-min-t"]).toBe("0");
    expect((planOf({ id: 3, op: "q", query: "[:find ?e]" }) as any).headers["x-ripple-min-t"]).toBeUndefined();
    expect((planOf({ id: 4, op: "q", query: "[:find ?e]", minT: -1 }) as any).headers["x-ripple-min-t"]).toBeUndefined();
    expect((planOf({ id: 5, op: "q", query: "[:find ?e]", minT: "9" }) as any).headers["x-ripple-min-t"]).toBeUndefined();
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
    expect(calls[1].headers["x-ripple-min-t"]).toBe("4");
    expect(calls[0].headers["x-ripple-min-t"]).toBeUndefined();
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

  test("reply carries the status and the x-ripple-* headers; an upstream 413 does not close the socket", async () => {
    const socket = new FakeSocket();
    const budget = { error: "query aborted", code: "query/budget-exceeded", clause: "[?e :p/f ?f]", cells: 900, limit: 500 };
    const { dispatch } = fakeDispatch((c) =>
      c.rest === "/query"
        ? json(budget, 413, { "x-ripple-ms": "7" })
        : json({ t: 4, result: [] }, 200, { "x-ripple-ms": "3", "x-ripple-basis-t": "4", "x-ripple-basis-hit": "1", "x-ripple-colo": "IAD", "x-not-a-meta-header": "drop me" }),
    );
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "query-typo" }));
    await s.onMessage(JSON.stringify({ id: 2, op: "q", query: "[:find ?e]" }));
    await s.onMessage(JSON.stringify({ id: 3, op: "pull", eid: 1, pattern: ["*"] }));
    expect(socket.frames[0]).toEqual({ id: 1, status: 400, body: { error: "unknown op: query-typo" } });
    expect(socket.frames[1]).toMatchObject({ id: 2, status: 413, body: budget });
    expect(socket.frames[1].headers).toEqual({ "x-ripple-ms": "7" });
    expect(socket.frames[2]).toMatchObject({ id: 3, status: 200 });
    expect(socket.frames[2].headers).toEqual({ "x-ripple-ms": "3", "x-ripple-basis-t": "4", "x-ripple-basis-hit": "1", "x-ripple-colo": "IAD" });
    expect(META_HEADERS).toContain("x-ripple-basis-t");
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

describe("t frames", () => {
  test("ack.t: a write on this socket ticks after its reply, and only ever forwards", async () => {
    const socket = new FakeSocket();
    let t = 9;
    const { dispatch } = fakeDispatch(() => json({ t, txEid: 1, tempids: {}, datoms: [] }));
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    expect(socket.frames.map((f) => (f.op === "t" ? `t:${f.t}` : `reply:${f.id}`))).toEqual(["reply:1", "t:9"]);
    expect(s.lastT).toBe(9);
    await s.onMessage(JSON.stringify({ id: 2, op: "transact", tx: [] })); // same t: nothing new to say
    expect(socket.ticks().length).toBe(1);
    t = 10;
    await s.onMessage(JSON.stringify({ id: 3, op: "transact", tx: [] }));
    expect(socket.ticks()).toEqual([{ op: "t", t: 9 }, { op: "t", t: 10 }]);
    expect(s.lastT).toBe(10);
  });

  test("a failed write does not ack, and a read that answers with a t does not either", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch((c) => (c.rest === "/transact" ? json({ error: "conflict" }, 409) : json({ t: 5, result: [] })));
    const s = session(socket, { dispatch });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    await s.onMessage(JSON.stringify({ id: 2, op: "q", query: "[:find ?e]" }));
    expect(socket.ticks()).toEqual([]);
    expect(s.lastT).toBe(0);
  });

  test("polling /basis: the first poll only seeds, a move ticks once", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const seen = [5, 5, 6, 6];
    let i = 0;
    const { schedule, tick, state } = manualScheduler();
    session(socket, { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => seen[i++] ?? 6, pollIntervalMs: 250 });
    expect(state.ms).toEqual([250]);
    expect(watcherKeys()).toEqual(["demo|enam"]);
    for (let n = 0; n < 4; n++) await tick();
    expect(socket.ticks()).toEqual([{ op: "t", t: 6 }]);
  });

  test("a poll that throws is just no news; the watcher keeps going", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const answers: (() => number)[] = [
      () => 3,
      () => {
        throw new Error("replica down");
      },
      () => 4,
    ];
    let i = 0;
    const { schedule, tick } = manualScheduler();
    session(socket, { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => (answers[i++] ?? (() => 4))() });
    for (let n = 0; n < 3; n++) await tick();
    expect(socket.ticks()).toEqual([{ op: "t", t: 4 }]);
  });

  test("an in-flight poll suppresses overlapping ticks", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let polls = 0;
    let release!: (t: number) => void;
    const { schedule, tick } = manualScheduler();
    session(socket, {
      dispatch,
      schedule,
      watchKey: "demo|enam",
      pollBasis: () => {
        polls++;
        return new Promise<number>((r) => {
          release = r;
        });
      },
    });
    await tick();
    await tick();
    await tick();
    expect(polls).toBe(1);
    release(5);
    await Promise.resolve();
    await Promise.resolve();
    await tick();
    expect(polls).toBe(2);
  });

  test("a poll never re-sends a t the socket already learned from its own ack", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch(() => json({ t: 9 }));
    const { schedule, tick } = manualScheduler();
    const s = session(socket, { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => 9 });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    await tick();
    await tick();
    expect(socket.ticks()).toEqual([{ op: "t", t: 9 }]); // the ack's, not the poll's
  });
});

describe("the shared basis watcher", () => {
  test("sessions on one key share a poller; the last one out cancels it", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let t = 1;
    const { schedule, tick, state } = manualScheduler();
    const opts = { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => t };
    const sa = session(a, opts);
    const sb = session(b, opts);
    const sc = session(c, { ...opts, watchKey: "demo|wnam" });
    expect(state.fns.length).toBe(2); // one per key, not one per session
    expect(watcherKeys().sort()).toEqual(["demo|enam", "demo|wnam"]);

    await tick(); // seed at 1
    t = 2;
    await tick();
    expect(a.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(c.ticks()).toEqual([{ op: "t", t: 2 }]);

    sa.close();
    expect(state.cancels).toBe(0); // b still holds demo|enam
    expect(watcherKeys()).toContain("demo|enam");
    t = 3;
    await tick();
    expect(a.ticks().length).toBe(1); // closed: no further sends
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }, { op: "t", t: 3 }]);

    sb.close();
    expect(state.cancels).toBe(1);
    expect(watcherKeys()).toEqual(["demo|wnam"]);
    sc.close();
    expect(state.cancels).toBe(2);
    expect(watcherKeys()).toEqual([]);
  });

  test("a client-side close unsubscribes and resolves closed", async () => {
    const socket = new FakeSocket();
    const { dispatch, calls } = fakeDispatch();
    const { schedule, tick, state } = manualScheduler();
    const s = session(socket, { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => 7 });
    let done = false;
    void s.closed.then(() => {
      done = true;
    });
    socket.emit("close", { code: 1000 });
    await Promise.resolve();
    expect(done).toBe(true);
    expect(state.cancels).toBe(1);
    expect(watcherKeys()).toEqual([]);
    await tick();
    await s.onMessage(JSON.stringify({ id: 1, op: "info" })); // a frame racing the close is dropped
    expect(calls.length).toBe(0);
    expect(socket.frames).toEqual([]);
  });

  test("a socket error unsubscribes too, and close() is idempotent", () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const { schedule, state } = manualScheduler();
    const s = session(socket, { dispatch, schedule, watchKey: "demo|enam", pollBasis: async () => 7 });
    socket.emit("error", { message: "boom" });
    expect(state.cancels).toBe(1);
    s.close();
    s.close();
    expect(state.cancels).toBe(1);
    expect(socket.closed).toBe(false); // the socket was already gone; nothing to close
  });

  test("no watchKey/pollBasis means no poller at all", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const { schedule, state } = manualScheduler();
    session(socket, { dispatch, schedule });
    expect(state.fns.length).toBe(0);
    expect(watcherKeys()).toEqual([]);
  });
});
