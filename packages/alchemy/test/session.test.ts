/**
 * The session socket as a transport: the frames a client's requests become, the
 * replies they turn back into, and what happens when the socket goes away.
 *
 * The fake here is the socket-shaped twin of the `recorder` fetch in
 * `client.test.ts` — it records the frames it was sent and answers each one
 * with a canned reply frame. Nothing else about the clients changes, which is
 * the point: the same `Client.make` / `SchemaFx` surface is exercised, only the
 * `fetch` seam is different.
 */

import { describe, expect, test } from "bun:test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "../src/Client.ts";
import type { FetchLike } from "../src/Client.ts";
import { openSession, type WebSocketLike } from "../src/Session.ts";
import { isEid, Session as SchemaFxSession } from "../src/schema/index.ts";

import { Movies, User } from "./schema/fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(eff.pipe(Effect.provide(RuntimeContext.phantom)));

const runFail = <A, E>(eff: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(
    Effect.flip(eff).pipe(Effect.provide(RuntimeContext.phantom)),
  );

interface Frame {
  id: number;
  op: string;
  [field: string]: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fake peer socket: records every frame, answers with a canned reply frame
 * (`undefined` = never answered), and can push unsolicited frames or drop.
 */
const fakePeer = (answer: (frame: Frame) => Reply | undefined) => {
  const sent: Frame[] = [];
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  let url = "";
  const emit = (type: string, ev: unknown) => {
    for (const cb of listeners.get(type) ?? []) cb(ev);
  };
  const socket: WebSocketLike = {
    send: (data) => {
      const frame = JSON.parse(data) as Frame;
      sent.push(frame);
      const reply = answer(frame);
      if (reply === undefined) return;
      queueMicrotask(() =>
        emit("message", { data: JSON.stringify({ id: frame.id, ...reply }) }),
      );
    },
    close: () => emit("close", {}),
    addEventListener: (type, cb) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
  };
  return {
    sent,
    connect: (handshake: string) => {
      url = handshake;
      return socket;
    },
    get url() {
      return url;
    },
    /** An unsolicited server frame (`{ op: "t", t }`). */
    push: (frame: unknown) => emit("message", { data: JSON.stringify(frame) }),
    /** The isolate died. */
    drop: () => emit("close", {}),
  };
};

/** A `fetch` that records what fell through to it (nothing session-shaped should). */
const recorder = (body: unknown = {}) => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
};

const ack = { t: 7, txEid: 13194139533319, tempids: { ada: 17 }, datoms: 3 };

describe("the handshake", () => {
  test("the socket url is the ws form of /db/:name/session, with the token as a query param", () => {
    const peer = fakePeer(() => undefined);
    openSession({
      url: "https://peer.example.com/",
      name: "a.b-c_1",
      token: Redacted.make("s3cret"),
      connect: peer.connect,
    });
    expect(peer.url).toBe(
      "wss://peer.example.com/db/a.b-c_1/session?token=s3cret",
    );

    const plain = fakePeer(() => undefined);
    openSession({ url: "http://localhost:8787", name: "movies", connect: plain.connect });
    expect(plain.url).toBe("ws://localhost:8787/db/movies/session");
  });
});

describe("requests become frames", () => {
  test("transact posts one frame and resolves the ack", async () => {
    const peer = fakePeer((frame) =>
      frame.op === "transact" ? { body: ack } : undefined,
    );
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    expect(await run(db.transact([{ ":user/name": "Ada" }]))).toEqual(ack);
    expect(peer.sent).toEqual([
      { id: 1, op: "transact", tx: [{ ":user/name": "Ada" }] },
    ]);
    // the ack's t is basis movement this socket has already seen
    expect(session.t).toBe(7);
  });

  test("q, pull, entity and info each become their op — and ids increment", async () => {
    const peer = fakePeer(() => ({ body: { t: 1, root: 1, result: [], entity: null } }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    await run(db.q("[]", [1]));
    await run(db.asOf(3).history().pull(17, "[*]"));
    await run(db.asOf(42).entity(17));
    await run(db.info());

    expect(peer.sent).toEqual([
      { id: 1, op: "q", query: "[]", inputs: [1] },
      { id: 2, op: "pull", eid: 17, pattern: "[*]", asOf: 3, history: true },
      { id: 3, op: "entity", eid: 17, asOf: 42 },
      { id: 4, op: "info" },
    ]);
  });

  test("the x-ripple-min-t read fence is lifted into the frame's minT", async () => {
    const peer = fakePeer(() => ({ body: { t: 1, root: 1, result: [] } }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    await run(db.q("[]", [], { minT: 7 }));
    await run(db.q("[]"));

    expect(peer.sent[0].minT).toBe(7);
    expect("minT" in peer.sent[1]).toBe(false);
  });

  test("frames sent before the socket opens are queued, then flushed in order", async () => {
    const opened: (() => void)[] = [];
    const peer = fakePeer(() => ({ body: { t: 1, root: 1, result: [] } }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: (url) => {
        const socket = peer.connect(url);
        // a real socket is CONNECTING until its open event
        return {
          ...socket,
          send: (d: string) => socket.send(d),
          readyState: 0,
          addEventListener: (type, cb) => {
            if (type === "open") opened.push(() => cb({}));
            socket.addEventListener(type, cb);
          },
        } satisfies WebSocketLike;
      },
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const first = run(db.q("[1]"));
    const second = run(db.q("[2]"));
    await Bun.sleep(5);
    expect(peer.sent).toHaveLength(0); // nothing may be written before open

    for (const open of opened) open();
    await first;
    await second;
    expect(peer.sent.map((f) => f.query)).toEqual(["[1]", "[2]"]);
  });

  test("routes that are not this database's session fall through to the fetch seam", async () => {
    const peer = fakePeer(() => ({ body: {} }));
    const base = recorder({ ok: true, service: "ripple", stage: "test", time: 1 });
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
      fetch: base.fetch,
    });
    const system = Client.makeSystem({
      url: "https://peer.example.com",
      fetch: session.fetch,
    });

    expect((await run(system.health())).ok).toBe(true);
    // another database on the same peer is not this socket's business
    await run((await Effect.runPromise(system.create("other"))).info());

    expect(base.calls).toEqual([
      "https://peer.example.com/health",
      "https://peer.example.com/db/other/info",
    ]);
    expect(peer.sent).toHaveLength(0);
  });
});

describe("replies become responses", () => {
  test("reply headers are the query meta, exactly as the HTTP path decodes them", async () => {
    const peer = fakePeer(() => ({
      body: { t: 42, root: 9, result: [["Ada"]], explain: [{ clause: 0 }] },
      headers: {
        "x-ripple-ms": "3",
        "x-ripple-r2-gets": "0",
        "x-ripple-cache-hits": "2",
        "x-ripple-colo": "IAD",
        "x-ripple-basis-t": "42",
        "x-ripple-basis-hit": "1",
        "x-ripple-basis-behind": "1",
      },
    }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const r = await run(db.query("[]", [], { explain: true }));
    expect(r.t).toBe(42);
    expect(r.explain).toEqual([{ clause: 0 }]);
    expect(r.meta).toEqual({
      ms: 3,
      r2Gets: 0,
      cacheHits: 2,
      colo: "IAD",
      replicaHint: undefined,
      basisT: 42,
      basisHit: true,
      basisReason: undefined,
      basisBehind: true,
    });
    expect(session.t).toBe(42);
  });

  test("a 413 reply frame is the same QueryBudgetExceeded the HTTP path yields", async () => {
    const peer = fakePeer(() => ({
      status: 413,
      body: {
        error: "budget",
        code: "query/budget-exceeded",
        clause: "[?e ?a ?v]",
        cells: 9,
        limit: 8,
      },
    }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const e = await runFail(db.q("[:find ?e ?a ?v :where [?e ?a ?v]]"));
    expect(e._tag).toBe("QueryBudgetExceeded");
    if (e._tag === "QueryBudgetExceeded") {
      expect(e.limit).toBe(8);
      expect(e.clause).toBe("[?e ?a ?v]");
    }
  });

  test("a rejected transaction still arrives as TxRejected", async () => {
    const peer = fakePeer(() => ({
      status: 409,
      body: { error: "unique conflict", tag: "TxRejected", code: "tx/unique-conflict" },
    }));
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });
    const e = await runFail(db.transact([{ ":user/email": "ada@example.com" }]));
    expect(e._tag).toBe("TxRejected");
    expect(e.message).toBe("unique conflict");
  });

  test("out-of-order replies land on the request that asked", async () => {
    const peer = fakePeer(() => undefined);
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const first = run(db.q<number[]>("[1]"));
    const second = run(db.q<number[]>("[2]"));
    await Bun.sleep(5);
    expect(peer.sent.map((f) => f.id)).toEqual([1, 2]);

    peer.push({ id: 2, status: 200, body: { t: 1, root: 1, result: [2] } });
    peer.push({ id: 1, status: 200, body: { t: 1, root: 1, result: [1] } });
    expect(await first).toEqual([1]);
    expect(await second).toEqual([2]);
  });
});

describe("basis movement", () => {
  test("an unsolicited t frame moves session.t and fires onT; t is monotonic", async () => {
    const peer = fakePeer(() => undefined);
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const seen: number[] = [];
    const off = session.onT((t) => seen.push(t));

    peer.push({ op: "t", t: 5 });
    peer.push({ op: "t", t: 4 }); // stale: ignored
    peer.push({ op: "t", t: 9 });
    off();
    peer.push({ op: "t", t: 11 });

    expect(seen).toEqual([5, 9]);
    expect(session.t).toBe(11);
  });
});

describe("a socket that goes away", () => {
  test("close rejects everything in flight as NetworkError, and stays closed", async () => {
    const peer = fakePeer(() => undefined); // never answers
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const inFlight = runFail(db.info());
    await Bun.sleep(5);
    expect(peer.sent).toHaveLength(1);

    session.close();
    const e = await inFlight;
    expect(e._tag).toBe("NetworkError");
    expect((await runFail(db.info()))._tag).toBe("NetworkError");
    expect(peer.sent).toHaveLength(1); // nothing was written after the close
  });

  test("the isolate dying (a close frame) fails the in-flight request too", async () => {
    const peer = fakePeer(() => undefined);
    const session = openSession({
      url: "https://peer.example.com",
      name: "movies",
      connect: peer.connect,
    });
    const db = Client.make({
      url: "https://peer.example.com",
      name: "movies",
      fetch: session.fetch,
    });

    const inFlight = runFail(db.q("[]"));
    await Bun.sleep(5);
    peer.drop();
    expect((await inFlight)._tag).toBe("NetworkError");
  });
});

describe("the typed client rides the socket", () => {
  test("connect ensures the catalog, then q / pull / transact are frames", async () => {
    const peer = fakePeer((frame) => {
      switch (frame.op) {
        case "transact":
          return { body: { t: 2, txEid: 1, tempids: { "tmp-1": 1001 }, datoms: 4 } };
        case "q":
          return { body: { t: 2, root: 2, result: [[1001, "Ada"]] } };
        case "pull":
          return { body: { t: 2, result: { name: "Ada" } } };
        default:
          return { status: 404, body: { error: "no such op" } };
      }
    });
    const base = recorder({ ok: true, service: "ripple", stage: "test", time: 1 });

    const { session, db } = await run(
      SchemaFxSession.connect({
        url: "https://peer.example.com",
        name: "movies",
        catalog: Movies,
        connect: peer.connect,
        fetch: base.fetch,
      }),
    );

    // the catalog ensure is the socket's first frame — no second HTTP client
    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0].op).toBe("transact");
    expect(base.calls).toHaveLength(0);

    const rows = await run(db.q((q) => q.where("?e", User.name, "?n").find("?e", "?n")));
    expect(isEid(rows[0][0])).toBe(true);
    expect(rows[0][1]).toBe("Ada");
    expect(peer.sent[1]).toEqual({
      id: 2,
      op: "q",
      query: { find: ["?e", "?n"], where: [["?e", ":user/name", "?n"]] },
      inputs: [],
    });

    expect(await run(rows[0][0].pull({ name: User.name }))).toEqual({ name: "Ada" });
    expect(peer.sent[2]).toEqual({
      id: 3,
      op: "pull",
      eid: 1001,
      pattern: [{ kind: "attr", attr: ":user/name", reverse: false, as: "name" }],
    });

    await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );
    expect(peer.sent[3]).toEqual({
      id: 4,
      op: "transact",
      tx: [[":db/add", "tmp-1", ":user/name", "Ada"]],
    });

    // peer-level health is not database-scoped: it falls through to `fetch`
    expect((await run(db.health())).ok).toBe(true);
    expect(base.calls).toEqual(["https://peer.example.com/health"]);
    expect(session.t).toBe(2);
    session.close();
  });

  test("a failed ensure closes the socket it opened", async () => {
    const peer = fakePeer(() => ({
      status: 409,
      body: { error: "unique conflict", tag: "TxRejected", code: "tx/unique-conflict" },
    }));
    const e = await runFail(
      SchemaFxSession.connect({
        url: "https://peer.example.com",
        name: "movies",
        catalog: Movies,
        connect: peer.connect,
      }),
    );
    expect(e._tag).toBe("SchemaEnsureError");
  });
});
