import { afterEach, describe, expect, test } from "bun:test";
import type { Principal } from "../../src/internal/core/index.ts";
import { META_HEADERS, type Scheduler, type SessionDispatch, type SocketLike, openSession, planOf, watcherKeys } from "../../src/worker/session.ts";

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

/** A scheduler and clock the test drives by hand (pass `now` to the session so freshness follows the fake clock). */
function manualScheduler() {
  const state = { timers: [] as { fn: () => void; canceled: boolean }[], ms: [] as number[], cancels: 0, now: 10_000 };
  const schedule: Scheduler = (fn, ms) => {
    const timer = { fn, canceled: false };
    state.timers.push(timer);
    state.ms.push(ms);
    return () => {
      if (timer.canceled) return;
      timer.canceled = true;
      state.cancels++;
    };
  };
  const now = () => state.now;
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  /** move the clock past every session's freshness window */
  const advance = () => {
    state.now += Math.max(0, ...state.ms);
  };
  /** one interval elapses: advance the clock, fire every live timer, let the poll promises settle */
  const tick = async () => {
    advance();
    for (const t of state.timers) if (!t.canceled) t.fn();
    await settle();
  };
  /** fire one session's timer alone, without touching the clock */
  const fire = async (i: number) => {
    const t = state.timers[i];
    if (t && !t.canceled) t.fn();
    await settle();
  };
  return { schedule, tick, fire, advance, settle, state, now };
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
    const { schedule, tick, state, now } = manualScheduler();
    session(socket, { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => seen[i++] ?? 6, pollIntervalMs: 250 });
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
    const { schedule, tick, now } = manualScheduler();
    session(socket, { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => (answers[i++] ?? (() => 4))() });
    for (let n = 0; n < 3; n++) await tick();
    expect(socket.ticks()).toEqual([{ op: "t", t: 4 }]);
  });

  test("an in-flight poll suppresses overlapping ticks", async () => {
    const socket = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let polls = 0;
    let release!: (t: number) => void;
    const { schedule, tick, now } = manualScheduler();
    session(socket, {
      dispatch,
      schedule,
      now,
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
    const { schedule, tick, now } = manualScheduler();
    const s = session(socket, { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => 9 });
    await s.onMessage(JSON.stringify({ id: 1, op: "transact", tx: [] }));
    await tick();
    await tick();
    expect(socket.ticks()).toEqual([{ op: "t", t: 9 }]); // the ack's, not the poll's
  });
});

describe("per-session watchers over a shared basis reading", () => {
  // Regression for issue #28: one shared timer fanning out to every session's
  // socket runs in the first session's request context, and workerd forbids
  // touching another request's socket from there — every other session died on
  // the first fan-out. Each session must drive its own socket from its own
  // timer; what is shared is only the polled value.

  test("two sessions on one db keep receiving ticks across successive writes; one poll per interval per key", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let t = 1;
    let polls = 0;
    let cPolls = 0;
    const { schedule, tick, state, now } = manualScheduler();
    const opts = {
      dispatch,
      schedule,
      now,
      watchKey: "demo|enam",
      pollBasis: async () => {
        polls++;
        return t;
      },
    };
    const sa = session(a, opts);
    const sb = session(b, opts);
    // a different db|hint is a different reading with its own poller
    const sc = session(c, {
      ...opts,
      watchKey: "demo|wnam",
      pollBasis: async () => {
        cPolls++;
        return t;
      },
    });
    expect(state.timers.length).toBe(3); // one timer per session, each in its own request context
    expect(watcherKeys().sort()).toEqual(["demo|enam", "demo|wnam"]); // ...but one shared reading per key

    await tick(); // the first session on each key polls and seeds; b sees nothing known yet
    await tick(); // b seeds from the shared reading
    expect(polls).toBe(2); // one poll per interval for the key, not one per session
    expect(cPolls).toBe(2); // the other key polls for itself
    expect(a.ticks()).toEqual([]);
    expect(b.ticks()).toEqual([]);
    expect(c.ticks()).toEqual([]);

    t = 2; // a write moves the basis
    await tick();
    await tick(); // the non-polling session learns from the reading one interval later
    expect(a.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(c.ticks()).toEqual([{ op: "t", t: 2 }]);

    t = 3; // the second write still reaches everyone — the sessions must not have died on the first
    await tick();
    await tick();
    expect(a.ticks()).toEqual([{ op: "t", t: 2 }, { op: "t", t: 3 }]);
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }, { op: "t", t: 3 }]);
    expect(c.ticks()).toEqual([{ op: "t", t: 2 }, { op: "t", t: 3 }]);
    expect(polls).toBe(6);
    expect(cPolls).toBe(6);

    sa.close();
    expect(state.cancels).toBe(1); // its own timer, canceled at once
    expect(watcherKeys().sort()).toEqual(["demo|enam", "demo|wnam"]); // b still holds its reading
    sb.close();
    expect(state.cancels).toBe(2);
    expect(watcherKeys()).toEqual(["demo|wnam"]);
    sc.close();
    expect(state.cancels).toBe(3);
    expect(watcherKeys()).toEqual([]);
  });

  test("a session's timer only ever writes to its own socket", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let t = 1;
    const { schedule, fire, advance, now } = manualScheduler();
    const opts = { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => t };
    session(a, opts);
    session(b, opts);
    advance();
    await fire(0); // a polls and seeds the reading
    await fire(1); // b seeds from it
    t = 2;
    advance();
    await fire(0); // a's timer alone: only a's socket may be written
    expect(a.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(b.frames).toEqual([]);
    await fire(1); // b hears about it from its own timer
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(a.ticks()).toEqual([{ op: "t", t: 2 }]);
  });

  test("a poll slower than the interval may overlap; the late result never ticks wrong", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const { dispatch } = fakeDispatch();
    const { schedule, tick, settle, now } = manualScheduler();
    let polls = 0;
    const pending: ((t: number) => void)[] = [];
    const opts = {
      dispatch,
      schedule,
      now,
      watchKey: "demo|enam",
      pollBasis: () => {
        polls++;
        return new Promise<number>((resolve) => pending.push(resolve));
      },
    };
    session(a, opts);
    session(b, opts);

    let round = tick();
    pending.shift()!(1); // a's poll answers within the interval
    await round; // a seeds at 1
    round = tick();
    pending.shift()!(1);
    await round; // b seeds from the reading
    expect(polls).toBe(2);

    await tick(); // a polls; the answer does not come back this interval
    expect(polls).toBe(3);
    await tick(); // a is still in flight — its in-flight mark has aged out, so b polls too
    expect(polls).toBe(4); // the mark is time-bounded, not exclusive: an extra poll is allowed

    pending[1](3); // b's (fresher) poll answers first
    await settle();
    expect(b.ticks()).toEqual([{ op: "t", t: 3 }]);
    pending[0](2); // a's slow poll finally answers, with an older basis
    await settle();
    expect(a.ticks()).toEqual([{ op: "t", t: 3 }]); // the reading is monotone: never a backwards or wrong tick
  });

  test("the polling session closing does not strand the others", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let t = 1;
    const { schedule, tick, now } = manualScheduler();
    const opts = { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => t };
    const sa = session(a, opts);
    session(b, opts);
    await tick();
    await tick(); // both seeded; a has been doing the polling
    sa.close();
    t = 2;
    await tick(); // b takes over the poll on its own timer
    expect(b.ticks()).toEqual([{ op: "t", t: 2 }]);
    expect(a.ticks()).toEqual([]);
  });

  test("a late joiner is seeded from the warm reading; the next move ticks, the current value does not", async () => {
    const a = new FakeSocket();
    const { dispatch } = fakeDispatch();
    let t = 5;
    const { schedule, tick, now } = manualScheduler();
    const opts = { dispatch, schedule, now, watchKey: "demo|enam", pollBasis: async () => t };
    session(a, opts);
    await tick(); // the reading is warm at 5
    const c = new FakeSocket();
    const sc = session(c, opts);
    expect(sc.lastT).toBe(5); // seeded silently at subscribe
    t = 6;
    await tick();
    await tick();
    expect(c.ticks()).toEqual([{ op: "t", t: 6 }]);
  });

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
    expect(state.timers.length).toBe(0);
    expect(watcherKeys()).toEqual([]);
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
