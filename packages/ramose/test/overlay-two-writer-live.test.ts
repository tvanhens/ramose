/**
 * Overlay db is the store; apply is the notify. Two session clients
 * (phone + computer, same principal, same db) each move a *different
 * existing* issue. After both `{ op: tx }` frames apply, **both live
 * streams** show both moves. No remount, no resync dump, no `q()` as
 * the pass. No stubbed `nudge` / `holdApply`.
 *
 * Nearby pins stay green while this is red:
 * - session-follow walks two sockets (no overlay, no live, not HTTPS)
 * - overlay two-writer races inject `{ op: tx }` into *one* overlay
 * - e2e "write on another connection" is a sequential *create*
 *
 * HTTPS `transact` is real `Connection.transact`. `{ op: tx }` comes from
 * QueryReplicaDO `applyDatoms` → `notifySessions` (no `clientTxId` — HTTPS
 * never sets writerEcho). A later writer's ack is `t+1` and must not drop
 * the other device's `t`. The pin delivers **only** `{ op: tx }` frames.
 * Reef `applyPendingMove` is paint-before-the-next-frame, not this scrape.
 */

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import { Attr, Catalog, type Db, Namespace, Query } from "../src/db/internal.ts";
import { toWireDatom, type LogEntry, type RootRecord } from "../src/internal/core/index.ts";
import { MemoryBucket } from "../src/internal/storage/memory.ts";
import type { RamoseEnv } from "../src/internal/transactor/index.ts";
import { sqliteLike } from "./internal/transactor/harness.ts";
import { openSession, type Session, type SocketLike } from "../src/worker/session.ts";
import { client, fakePeer, settle, type Call, type FakePeer } from "./peer.ts";
import { catalogWorld, snapshotOf } from "./overlay-seed.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: any,
      readonly env: any,
    ) {}
  },
}));

const { QueryReplicaDO } = await import("../src/internal/replica/replica-do.ts");

class ReplicaSocket implements SocketLike {
  readonly frames: Record<string, unknown>[] = [];
  closed = false;
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(): void {}
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

type ReplicaWalk = {
  readonly basisT: number;
  fetch(request: Request): Promise<Response>;
  applyDatoms(e: LogEntry): Promise<void>;
  adoptRoot(rec: RootRecord): void;
  live: Map<ReplicaSocket, Session>;
};

const bootReplica = async (watermark: number) => {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF;");
  const sockets: ReplicaSocket[] = [];
  const state = {
    storage: {
      sql: sqliteLike(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: ReplicaSocket) => {
      sockets.push(ws);
    },
    abort: () => {},
    id: { toString: () => "replica-two-writer" },
  };
  const env = {
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
  const replica = new QueryReplicaDO(state as never, env) as unknown as ReplicaWalk;
  const ready = await replica.fetch(new Request("https://replica/info?db=reef"));
  expect(ready.status).toBe(200);
  replica.adoptRoot(rootAt(watermark));
  const dispatch = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  const attach = () => {
    const socket = new ReplicaSocket();
    state.acceptWebSocket(socket);
    const session = openSession(socket, {
      listen: false,
      dispatch,
      seed: { lastT: 0, watermark },
      filterEntry: async (e) => ({ kind: "tx", datoms: e.datoms }),
    });
    replica.live.set(socket, session);
    return { socket, session };
  };
  return { replica, attach };
};

const Issue = Namespace("issue", {
  title: Attr(Schema.String),
  status: Attr(Schema.String),
  rank: Attr(Schema.Number),
});
const Board = Catalog({ issue: Issue });
const boardQuery = Query.q(() =>
  pipe(
    Query.entities(Issue),
    Query.select({
      title: Issue.title,
      status: Issue.status,
      rank: Issue.rank,
    }),
    Query.orderBy("rank", "asc"),
  ),
);

type BoardRow = { title: string; status: string; rank: number };

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

const collect = <A, E>(stream: Stream.Stream<A, E>) => {
  const seen: A[] = [];
  let error: unknown;
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (a) => Effect.sync(() => seen.push(a))).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          error = Cause.squash(cause);
        }),
      ),
    ),
  );
  return {
    seen,
    get error() {
      return error;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const statusesOf = (rows: readonly { title: string; status: string }[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of rows ?? []) out[row.title] = row.status;
  return out;
};

const bothMoves = (rows: readonly { title: string; status: string }[] | undefined): boolean => {
  const s = statusesOf(rows);
  return s.One === "doing" && s.Two === "done";
};

const waitBoards = async (
  phone: { readonly seen: ReadonlyArray<readonly { title: string; status: string }[]> },
  browser: { readonly seen: ReadonlyArray<readonly { title: string; status: string }[]> },
) => {
  for (let i = 0; i < 40; i++) {
    if (bothMoves(phone.seen.at(-1)) && bothMoves(browser.seen.at(-1))) return;
    await settle();
  }
};

const move = (db: Db<typeof Board>, id: number, status: string, rank: number) =>
  db.transact(function* (tx) {
    yield* tx.add(id, Issue.status, status);
    yield* tx.add(id, Issue.rank, rank);
  });

/**
 * Shared transactor + QueryReplicaDO + two session overlays. HTTPS commits
 * are real. Replica apply-then-push is real. Overlay sockets receive the
 * frames the replica actually sent — `{ op: tx }` only. A visible commit
 * is one frame; there is no leftover tick.
 */
const twoBoards = async (opts: { walk: "on-commit" | "after-acks" }) => {
  const server = await catalogWorld(Board);
  const seeded = await server.transact([
    { ":db/id": "one", ":issue/title": "One", ":issue/status": "todo", ":issue/rank": 1 },
    { ":db/id": "two", ":issue/title": "Two", ":issue/status": "todo", ":issue/rank": 2 },
  ]);
  const one = seeded.tempids.one;
  const two = seeded.tempids.two;
  expect(typeof one).toBe("number");
  expect(typeof two).toBe("number");

  const snap = await snapshotOf(server);
  const { replica, attach } = await bootReplica(snap.t);
  const replicaPhone = attach();
  const replicaBrowser = attach();

  const commits: LogEntry[] = [];
  let phonePeer!: FakePeer;
  let browserPeer!: FakePeer;
  const resyncs = { phone: 0, browser: 0 };
  const sent = {
    phone: new Set<number>(),
    browser: new Set<number>(),
  };

  const flushWalk = () => {
    const pushSide = (
      sock: ReplicaSocket,
      peer: FakePeer,
      side: "phone" | "browser",
    ) => {
      sock.frames.forEach((frame, i) => {
        if (sent[side].has(i)) return;
        if (frame.op !== "tx") return;
        sent[side].add(i);
        peer.socket.push(frame);
      });
    };
    pushSide(replicaPhone.socket, phonePeer, "phone");
    pushSide(replicaBrowser.socket, browserPeer, "browser");
  };

  const applyCommit = async (e: LogEntry) => {
    await replica.applyDatoms(e);
    if (opts.walk === "on-commit") flushWalk();
  };

  const http = async (call: Call) => {
    if (!call.url.endsWith("/transact")) return { body: { t: server.t } };
    const rep = await server.transact(call.body.tx);
    const entry: LogEntry = { t: rep.t, txInstant: rep.t, datoms: [...rep.txData] };
    commits.push(entry);
    if (opts.walk === "on-commit") await applyCommit(entry);
    else {
      // after-acks: apply on the replica now (sessions walk), overlay later
      await replica.applyDatoms(entry);
    }
    return {
      body: {
        t: rep.t,
        txEid: rep.txEid,
        tempids: rep.tempids,
        datoms: rep.txData.map(toWireDatom),
        clientTxId: call.body.clientTxId,
      },
    };
  };

  phonePeer = fakePeer({ http });
  browserPeer = fakePeer({ http });

  const wrapPush = (peer: FakePeer, side: "phone" | "browser") => {
    const orig = peer.sockets[0]!;
    const push = orig.push.bind(orig);
    orig.push = (frame: unknown) => {
      if ((frame as { op?: unknown }).op === "resync") resyncs[side] += 1;
      push(frame);
    };
  };

  const phoneC = client(phonePeer);
  const browserC = client(browserPeer);
  const phone = phoneC.ramose.db("reef", Board);
  const browser = browserC.ramose.db("reef", Board);

  await run(phone.q(boardQuery));
  await run(browser.q(boardQuery));
  phonePeer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
  browserPeer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
  wrapPush(phonePeer, "phone");
  wrapPush(browserPeer, "browser");
  await settle();

  const inboundMoves = async () => {
    const first = await server.transact([
      [":db/add", one, ":issue/status", "doing"],
      [":db/add", one, ":issue/rank", 10],
    ]);
    const later = await server.transact([
      [":db/add", two, ":issue/status", "done"],
      [":db/add", two, ":issue/rank", 20],
    ]);
    for (const rep of [first, later]) {
      const entry: LogEntry = { t: rep.t, txInstant: rep.t, datoms: [...rep.txData] };
      commits.push(entry);
      await replica.applyDatoms(entry);
    }
    return { first: first.t, later: later.t };
  };

  return {
    one,
    two,
    seedT: snap.t,
    commits,
    replica,
    replicaPhone,
    replicaBrowser,
    flushWalk,
    inboundMoves,
    resyncs,
    phone,
    browser,
    phoneC,
    browserC,
  };
};

describe("two clients move two existing issues", () => {
  test("after simultaneous non-conflicting updates, both live boards show both moves from { op: tx } frames alone", async () => {
    const world = await twoBoards({ walk: "after-acks" });
    const phoneLive = collect(world.phone.live(boardQuery));
    const browserLive = collect(world.browser.live(boardQuery));
    await settle();
    expect(statusesOf(phoneLive.seen.at(-1))).toEqual({ One: "todo", Two: "todo" });
    expect(statusesOf(browserLive.seen.at(-1))).toEqual({ One: "todo", Two: "todo" });
    const phoneEmissions = phoneLive.seen.length;
    const browserEmissions = browserLive.seen.length;

    const [phoneAck, browserAck] = await Promise.all([
      run(move(world.phone, world.one, "doing", 10)),
      run(move(world.browser, world.two, "done", 20)),
    ]);
    expect(phoneAck.t).not.toBe(browserAck.t);
    const first = Math.min(phoneAck.t, browserAck.t);
    const later = Math.max(phoneAck.t, browserAck.t);
    expect(later).toBe(first + 1);
    expect(world.commits.map((c) => c.t).sort((a, b) => a - b)).toEqual([first, later]);
    expect(world.replica.basisT).toBe(later);
    expect(world.replicaPhone.socket.frames.filter((f) => f.op === "tx").map((f) => f.t)).toEqual([
      first,
      later,
    ]);
    expect(world.replicaBrowser.socket.frames.filter((f) => f.op === "tx").map((f) => f.t)).toEqual([
      first,
      later,
    ]);
    expect(world.replicaPhone.socket.frames.some((f) => f.op === "t")).toBe(false);
    expect(world.replicaBrowser.socket.frames.some((f) => f.op === "t")).toBe(false);

    const resyncsBeforeWalk = { ...world.resyncs };
    world.flushWalk();
    await waitBoards(phoneLive, browserLive);

    expect(world.resyncs).toEqual(resyncsBeforeWalk);
    expect(phoneLive.seen.length).toBeGreaterThan(phoneEmissions);
    expect(browserLive.seen.length).toBeGreaterThan(browserEmissions);
    expect(statusesOf(phoneLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });
    expect(statusesOf(browserLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });
    expect(statusesOf(await run(world.phone.q(boardQuery)))).toEqual({
      One: "doing",
      Two: "done",
    });
    expect(statusesOf(await run(world.browser.q(boardQuery)))).toEqual({
      One: "doing",
      Two: "done",
    });

    await phoneLive.stop();
    await browserLive.stop();
    await world.phoneC.dispose();
    await world.browserC.dispose();
  });

  test("after simultaneous non-conflicting updates, both live boards show both moves (walk on each commit)", async () => {
    const world = await twoBoards({ walk: "on-commit" });
    const phoneLive = collect(world.phone.live(boardQuery));
    const browserLive = collect(world.browser.live(boardQuery));
    await settle();

    await Promise.all([
      run(move(world.phone, world.one, "doing", 10)),
      run(move(world.browser, world.two, "done", 20)),
    ]);
    await waitBoards(phoneLive, browserLive);

    expect(statusesOf(phoneLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });
    expect(statusesOf(browserLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });

    await phoneLive.stop();
    await browserLive.stop();
    await world.phoneC.dispose();
    await world.browserC.dispose();
  });

  test("two inbound { op: tx } frames (no local pending): both live boards show both moves", async () => {
    const world = await twoBoards({ walk: "after-acks" });
    const phoneLive = collect(world.phone.live(boardQuery));
    const browserLive = collect(world.browser.live(boardQuery));
    await settle();
    expect(statusesOf(phoneLive.seen.at(-1))).toEqual({ One: "todo", Two: "todo" });
    expect(statusesOf(browserLive.seen.at(-1))).toEqual({ One: "todo", Two: "todo" });
    const phoneEmissions = phoneLive.seen.length;
    const browserEmissions = browserLive.seen.length;

    const { first, later } = await world.inboundMoves();
    expect(later).toBe(first + 1);
    expect(world.replicaPhone.socket.frames.filter((f) => f.op === "tx").map((f) => f.t)).toEqual([
      first,
      later,
    ]);
    expect(world.replicaBrowser.socket.frames.filter((f) => f.op === "tx").map((f) => f.t)).toEqual([
      first,
      later,
    ]);
    expect(world.replicaPhone.socket.frames.some((f) => f.op === "t")).toBe(false);

    const resyncsBeforeWalk = { ...world.resyncs };
    world.flushWalk();
    await waitBoards(phoneLive, browserLive);

    expect(world.resyncs).toEqual(resyncsBeforeWalk);
    expect(phoneLive.seen.length).toBeGreaterThan(phoneEmissions);
    expect(browserLive.seen.length).toBeGreaterThan(browserEmissions);
    expect(statusesOf(phoneLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });
    expect(statusesOf(browserLive.seen.at(-1))).toEqual({ One: "doing", Two: "done" });

    await phoneLive.stop();
    await browserLive.stop();
    await world.phoneC.dispose();
    await world.browserC.dispose();
  });

});
