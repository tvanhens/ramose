/**
 * The board's writes and live reads against a real engine `Connection`, over
 * the two wires the session client actually uses: `POST /transact` (outbox)
 * and a snapshot-then-tail socket. Current-view `boardQuery` / `useLive`
 * run on the overlay — a write paints before the POST returns, and an
 * inbound `{ op: "tx" }` re-runs locally. There is no `/query` refetch
 * because `t` moved.
 *
 * Pinned `asOf` / `history` still ride the peer (Reef's Time travel screen).
 *
 * Engine internals are workspace-relative: this test stands an in-process
 * server up without a Worker. An app never imports them — `ramose/db` and
 * `ramose/react` are the surface.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import { InternalError } from "../../../packages/ramose/src/db/Errors.ts";
import { schemaTx } from "../../../packages/ramose/src/db/ensure.ts";
import {
  Connection,
  Index,
  fromJson,
  query,
  toJson,
  toWireDatom,
} from "../../../packages/ramose/src/internal/core/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  boardQuery,
  labelsQuery,
  peopleQuery,
  type BoardRow,
  type ReefDb,
} from "../src/domain/queries.ts";
import { Issue, Reef, User } from "../src/domain/schema.ts";
import { createIssue, moveIssue, operations, setTitle } from "../src/app/mutations.ts";
import { buildOp, runBody } from "../../../packages/ramose/src/db/op-handle.ts";
import { seedWrite } from "../../../packages/ramose/src/db/internal.ts";
import { openWorkspace } from "../src/app/ramose.ts";

const settle = () => Bun.sleep(30);

const awaitLive = async (
  board: { rows: unknown; error: unknown },
  pred: () => boolean = () => board.rows !== undefined || board.error !== undefined,
) => {
  for (let i = 0; i < 100 && !pred(); i++) await Bun.sleep(20);
};

const snapshotOf = async (conn: Connection) => {
  const datoms: ReturnType<typeof toWireDatom>[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return { t: conn.t, datoms };
};

const inProcessPeer = async (opts?: { seed?: boolean }) => {
  const conn = await Connection.create();
  const pushes: ((frame: unknown) => void)[] = [];
  const frames: { op: string; [k: string]: unknown }[] = [];
  const resyncDumps: { t: number; datoms: number }[] = [];
  const httpPaths: string[] = [];
  let sockets = 0;
  let hold: Promise<void> | undefined;
  let releaseHold: (() => void) | undefined;
  let rejectNext:
    | { status: number; body: Record<string, unknown> }
    | undefined;

  const answer = async (op: string, body: any) => {
    if (op === "sync") {
      const snap = await snapshotOf(conn);
      return {
        status: 200,
        body: { t: snap.t, from: body.from ?? 0, datoms: snap.datoms },
      };
    }
    if (op === "op") {
      if (hold !== undefined) await hold;
      if (rejectNext !== undefined) {
        const denied = rejectNext;
        rejectNext = undefined;
        return denied;
      }
      const operation = operations.get(String(body.name ?? ""));
      if (operation === undefined) {
        return { status: 400, body: { error: `unknown operation: ${body.name}` } };
      }
      const built = buildOp({
        schema: Reef,
        db: "coral-team",
        principal: { eid: null, class: "admin", claims: {} },
        self: body.entity,
        effects: "run",
        effectCtx: {
          env: {},
          databases: {
            install: (catalog) =>
              Effect.tryPromise({
                try: () => conn.transact(schemaTx(catalog) as never),
                catch: (cause) =>
                  new InternalError({
                    message:
                      cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
          },
        },
        q: () => Effect.succeed([]),
        pull: () => Effect.succeed(null),
      });
      const prefix = await Effect.runPromise(
        runBody(operation, built.op, body.input),
      );
      const ops = built.ops();
      if (ops.length === 0) {
        return {
          status: 200,
          body: {
            t: conn.t,
            txEid: 0,
            tempids: {},
            datoms: [],
            output: prefix.output,
            clientOpId: body.clientOpId,
            clientTxId: body.clientOpId,
          },
        };
      }
      const rep = await conn.transact(ops as never);
      const datoms = rep.txData.map(toWireDatom);
      queueMicrotask(() => {
        for (const push of pushes) push({ op: "tx", t: rep.t, datoms });
      });
      return {
        status: 200,
        body: {
          t: rep.t,
          txEid: rep.txEid,
          tempids: rep.tempids,
          datoms,
          output: prefix.output,
          clientOpId: body.clientOpId,
          clientTxId: body.clientOpId,
        },
      };
    }
    if (op === "transact") {
      if (hold !== undefined) await hold;
      if (rejectNext !== undefined) {
        const denied = rejectNext;
        rejectNext = undefined;
        return denied;
      }
      const rep = await conn.transact(body.tx);
      const datoms = rep.txData.map(toWireDatom);
      // Replica apply-then-push: every attached session hears this t.
      // HTTPS never sets writerEcho, so the frame has no clientTxId.
      queueMicrotask(() => {
        for (const push of pushes) push({ op: "tx", t: rep.t, datoms });
      });
      return {
        status: 200,
        body: {
          t: rep.t,
          txEid: rep.txEid,
          tempids: rep.tempids,
          datoms,
          clientTxId: body.clientTxId,
        },
      };
    }
    let db = conn.db();
    if (typeof body.asOf === "number") db = db.asOf(body.asOf);
    if (body.history === true) db = db.history();
    if (op === "q") {
      return {
        status: 200,
        body: {
          t: db.effectiveT,
          root: db.effectiveT,
          result: await query(db, body.query, body.inputs ?? []),
        },
      };
    }
    return { status: 200, body: { t: conn.t } };
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url, "https://peer.local").pathname;
    httpPaths.push(path);
    if (path.endsWith("/info") && (init.method ?? "GET") === "GET") {
      const payload = jwtPayloadOf(init);
      const sub = typeof payload?.sub === "string" ? payload.sub : undefined;
      const ramose = payload?.ramose;
      const cls =
        ramose !== null &&
        typeof ramose === "object" &&
        typeof (ramose as { class?: unknown }).class === "string"
          ? (ramose as { class: string }).class
          : "member";
      let eid: number | null = null;
      if (sub !== undefined) {
        try {
          const found = await conn.db().entid([":user/sub", sub] as never);
          if (found !== undefined) eid = found;
        } catch {
          // First provision hits /info (for db.run) before /op installs the catalog.
        }
      }
      return new Response(
        JSON.stringify({ db: "coral-team", t: conn.t, principal: { eid, class: cls } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const raw = init.body;
    const body =
      raw === undefined || raw === ""
        ? {}
        : (fromJson(JSON.parse(String(raw))) as any);
    const reply = path.endsWith("/op")
      ? await answer("op", body)
      : await answer("transact", body);
    return new Response(JSON.stringify(toJson(reply.body)), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  function WebSocketImpl(this: unknown, _url: string) {
    sockets += 1;
    const listeners = new Map<string, ((ev: any) => void)[]>();
    const emit = (type: string, ev: unknown) => {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    };
    pushes.push((frame) => emit("message", { data: JSON.stringify(frame) }));
    const socket = {
      readyState: 0,
      addEventListener: (type: string, cb: (ev: any) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      send: (data: string) => {
        const frame = fromJson(JSON.parse(data)) as any;
        frames.push(frame);
        void answer(frame.op, frame).then((reply) => {
          if (frame.op === "sync" && Array.isArray((reply.body as { datoms?: unknown }).datoms)) {
            const datoms = (reply.body as { datoms: unknown[] }).datoms;
            resyncDumps.push({
              t: (reply.body as { t: number }).t,
              datoms: datoms.length,
            });
            emit("message", {
              data: JSON.stringify({
                op: "resync",
                t: (reply.body as { t: number }).t,
                datoms,
              }),
            });
          }
          emit("message", {
            data: JSON.stringify({
              id: frame.id,
              status: reply.status,
              body: toJson(reply.body),
            }),
          });
        });
      },
      close: () => emit("close", {}),
    };
    queueMicrotask(() => emit("open", {}));
    return socket;
  }

  const clients: Array<{ db: ReefDb; close: () => Promise<void> }> = [];
  const openClient = () => {
    const ramose = Ramose.connect({
      url: "https://peer.local",
      fetch: fetchImpl,
      webSocket: WebSocketImpl as unknown as typeof WebSocket,
    });
    const db: ReefDb = ramose.db("coral-team", Reef);
    const opened = { db, close: () => ramose.close() };
    clients.push(opened);
    return opened;
  };

  let db: ReefDb | undefined;
  let myEid: number | undefined;
  if (opts?.seed !== false) {
    const first = openClient();
    db = first.db;
    await db.install();
    const seeded = await Effect.runPromise(
      seedWrite(db, function* (tx) {
        yield* tx.put(User, {
          sub: "ada",
          role: "admin",
          name: "Ada",
          email: "ada@reef.test",
        });
      }),
    );
    const people = await seeded.dbAfter.query(peopleQuery);
    myEid = people[0]!.id;
  }

  return {
    conn,
    db: db as ReefDb,
    myEid: myEid as number,
    openClient,
    frames,
    httpPaths,
    fetch: fetchImpl,
    webSocket: WebSocketImpl as unknown as typeof WebSocket,
    sockets: () => sockets,
    resyncDumps: () => resyncDumps,
    closeClients: async () => {
      for (const c of clients) await c.close();
      clients.length = 0;
    },
    resetTraffic: () => {
      frames.length = 0;
      httpPaths.length = 0;
      resyncDumps.length = 0;
      sockets = 0;
    },
    queryOps: () => frames.filter((f) => f.op === "q"),
    holdTransact: () => {
      hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    },
    releaseTransact: () => {
      releaseHold?.();
      hold = undefined;
      releaseHold = undefined;
    },
    rejectNextTransact: (body: Record<string, unknown>, status = 409) => {
      rejectNext = { status, body };
    },
    pushTx: (datoms: readonly unknown[]) => {
      for (const push of pushes) push({ op: "tx", t: conn.t, datoms });
    },
    dispose: async () => {
      for (const c of clients) await c.close();
    },
  };
};

const live = (stream: Stream.Stream<readonly BoardRow[], Ramose.DbError>) => {
  let rows: readonly BoardRow[] | undefined;
  let error: unknown;
  let changes = 0;
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (next) =>
      Effect.sync(() => {
        rows = next;
        changes += 1;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          error = Cause.squash(cause);
        }),
      ),
    ),
  );
  return {
    get rows() {
      return rows;
    },
    get error() {
      return error;
    },
    get changes() {
      return changes;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const titles = (rows: readonly BoardRow[] | undefined) =>
  (rows ?? []).map((r) => r.title);

describe("the board's writes move the board's live stream", () => {
  test("create and move paint on the overlay before POST returns; no /query", async () => {
    const peer = await inProcessPeer();
    const board = live(peer.db.effect.live(boardQuery));
    await awaitLive(board);
    expect(board.rows).toEqual([]);
    const qBefore = peer.queryOps().length;
    const httpBefore = peer.httpPaths.filter((p) => p.endsWith("/query")).length;

    peer.holdTransact();
    const created = createIssue(peer.db, peer.myEid, undefined, {
      title: "Ship the overlay",
      status: "todo",
      priority: 2,
    });
    await awaitLive(board, () => titles(board.rows).includes("Ship the overlay"));
    expect(titles(board.rows)).toEqual(["Ship the overlay"]);
    expect(board.rows![0]!.status).toBe("todo");
    expect(board.rows![0]!.creator.name).toBe("Ada");
    expect(peer.queryOps()).toHaveLength(qBefore);
    expect(peer.httpPaths.filter((p) => p.endsWith("/query"))).toHaveLength(
      httpBefore,
    );

    peer.releaseTransact();
    await created;
    await settle();
    expect(titles(board.rows)).toEqual(["Ship the overlay"]);

    const issueId = board.rows![0]!.id;
    peer.holdTransact();
    const moved = moveIssue(peer.db, issueId, "doing", 2048);
    await awaitLive(
      board,
      () =>
        board.rows?.some((r) => r.title === "Ship the overlay" && r.status === "doing") ===
        true,
    );
    expect(board.rows![0]!.status).toBe("doing");
    expect(board.rows![0]!.rank).toBe(2048);
    expect(peer.queryOps()).toHaveLength(qBefore);
    expect(peer.httpPaths.filter((p) => p.endsWith("/query"))).toHaveLength(
      httpBefore,
    );

    peer.releaseTransact();
    await moved;
    await settle();
    expect(board.rows![0]!.status).toBe("doing");
    expect(board.error).toBeUndefined();

    await board.stop();
    await peer.dispose();
  });

  test("an edit paints locally, and a 409 drops the pending create", async () => {
    const peer = await inProcessPeer();
    const board = live(peer.db.effect.live(boardQuery));
    await awaitLive(board);

    await createIssue(peer.db, peer.myEid, undefined, {
      title: "Draft",
      status: "todo",
      priority: 1,
    });
    await awaitLive(board, () => titles(board.rows).includes("Draft"));
    const issueId = board.rows![0]!.id;

    peer.holdTransact();
    const edited = setTitle(peer.db, issueId, "Renamed");
    await awaitLive(board, () => titles(board.rows).includes("Renamed"));
    expect(titles(board.rows)).toEqual(["Renamed"]);
    peer.releaseTransact();
    await edited;
    await settle();
    expect(titles(board.rows)).toEqual(["Renamed"]);

    const qBefore = peer.queryOps().length;
    peer.holdTransact();
    peer.rejectNextTransact({
      error: "denied",
      tag: "OperationRejected",
      operation: "issue/create",
      reason: "policy",
    });
    const denied = createIssue(peer.db, peer.myEid, board.rows![0]!.rank, {
      title: "Ghost",
      status: "todo",
      priority: 0,
    }).then(
      () => {
        throw new Error("expected failure");
      },
      (error) => error,
    );
    await awaitLive(board, () => titles(board.rows).includes("Ghost"));
    expect(titles(board.rows)).toContain("Ghost");

    peer.releaseTransact();
    const err = await denied;
    await settle();
    expect(err._tag).toBe("OperationRejected");
    expect(titles(board.rows)).toEqual(["Renamed"]);
    expect(peer.queryOps()).toHaveLength(qBefore);

    await board.stop();
    await peer.dispose();
  });

  test("an inbound filtered tx frame updates the board without /query", async () => {
    const peer = await inProcessPeer();
    const board = live(peer.db.effect.live(boardQuery));
    await awaitLive(board);
    const qBefore = peer.queryOps().length;

    const other = await peer.conn.transact([
      {
        ":issue/title": "From another tab",
        ":issue/status": "doing",
        ":issue/priority": 3,
        ":issue/rank": 1024,
        ":issue/createdAt": new Date(),
        ":issue/creator": peer.myEid,
      },
    ]);
    peer.pushTx(other.txData.map(toWireDatom));
    await awaitLive(board, () => titles(board.rows).includes("From another tab"));

    expect(titles(board.rows)).toEqual(["From another tab"]);
    expect(board.rows![0]!.status).toBe("doing");
    expect(peer.queryOps()).toHaveLength(qBefore);

    await board.stop();
    await peer.dispose();
  });

  test("pinned asOf still reads the peer, not the overlay", async () => {
    const peer = await inProcessPeer();
    const seedT = peer.conn.t;
    await createIssue(peer.db, peer.myEid, undefined, {
      title: "Only in the present",
      status: "todo",
      priority: 0,
    });

    const qBefore = peer.queryOps().length;
    const past = await peer.db.asOf(seedT).query(boardQuery);
    expect(past).toEqual([]);
    expect(peer.queryOps().length).toBeGreaterThan(qBefore);

    const now = await peer.db.query(boardQuery);
    expect(titles(now)).toEqual(["Only in the present"]);
    // current-view q is local — asOf was the only new socket `q`
    expect(peer.queryOps()).toHaveLength(qBefore + 1);

    await peer.dispose();
  });

  test("two clients moving two existing issues both see both moves without refresh", async () => {
    const peer = await inProcessPeer();
    await createIssue(peer.db, peer.myEid, undefined, {
      title: "One",
      status: "todo",
      priority: 2,
    });
    await createIssue(peer.db, peer.myEid, 1024, {
      title: "Two",
      status: "todo",
      priority: 2,
    });

    const other = peer.openClient();
    const phone = live(peer.db.effect.live(boardQuery));
    const computer = live(other.db.effect.live(boardQuery));
    await awaitLive(phone, () => titles(phone.rows).length === 2);
    await awaitLive(computer, () => titles(computer.rows).length === 2);
    const one = phone.rows!.find((r) => r.title === "One")!.id;
    const two = phone.rows!.find((r) => r.title === "Two")!.id;
    const qBefore = peer.queryOps().length;
    const phoneEmissions = phone.changes;
    const computerEmissions = computer.changes;

    await Promise.all([
      moveIssue(peer.db, one, "doing", 10),
      moveIssue(other.db, two, "done", 20),
    ]);
    await awaitLive(
      phone,
      () =>
        phone.rows?.some((r) => r.title === "One" && r.status === "doing") ===
          true &&
        phone.rows?.some((r) => r.title === "Two" && r.status === "done") ===
          true,
    );
    await awaitLive(
      computer,
      () =>
        computer.rows?.some((r) => r.title === "One" && r.status === "doing") ===
          true &&
        computer.rows?.some((r) => r.title === "Two" && r.status === "done") ===
          true,
    );

    const statusOf = (rows: readonly BoardRow[] | undefined) =>
      Object.fromEntries((rows ?? []).map((r) => [r.title, r.status]));
    // live rows, not applyPendingMove
    expect(statusOf(phone.rows)).toEqual({ One: "doing", Two: "done" });
    expect(statusOf(computer.rows)).toEqual({ One: "doing", Two: "done" });
    expect(phone.changes).toBeGreaterThan(phoneEmissions);
    expect(computer.changes).toBeGreaterThan(computerEmissions);
    expect(peer.queryOps()).toHaveLength(qBefore);
    expect(phone.error).toBeUndefined();
    expect(computer.error).toBeUndefined();

    await phone.stop();
    await computer.stop();
    await peer.dispose();
  });

  test("two inbound { op: tx } frames (no local pending): both live boards show both moves", async () => {
    const peer = await inProcessPeer();
    await createIssue(peer.db, peer.myEid, undefined, {
      title: "One",
      status: "todo",
      priority: 2,
    });
    await createIssue(peer.db, peer.myEid, 1024, {
      title: "Two",
      status: "todo",
      priority: 2,
    });

    const other = peer.openClient();
    const phone = live(peer.db.effect.live(boardQuery));
    const computer = live(other.db.effect.live(boardQuery));
    await awaitLive(phone, () => titles(phone.rows).length === 2);
    await awaitLive(computer, () => titles(computer.rows).length === 2);
    const one = phone.rows!.find((r) => r.title === "One")!.id;
    const two = phone.rows!.find((r) => r.title === "Two")!.id;
    const qBefore = peer.queryOps().length;
    const phoneEmissions = phone.changes;
    const computerEmissions = computer.changes;

    const first = await peer.conn.transact([
      [":db/add", one, ":issue/status", "doing"],
      [":db/add", one, ":issue/rank", 10],
    ]);
    peer.pushTx(first.txData.map(toWireDatom));
    const later = await peer.conn.transact([
      [":db/add", two, ":issue/status", "done"],
      [":db/add", two, ":issue/rank", 20],
    ]);
    peer.pushTx(later.txData.map(toWireDatom));

    await awaitLive(
      phone,
      () =>
        phone.rows?.some((r) => r.title === "One" && r.status === "doing") ===
          true &&
        phone.rows?.some((r) => r.title === "Two" && r.status === "done") ===
          true,
    );
    await awaitLive(
      computer,
      () =>
        computer.rows?.some((r) => r.title === "One" && r.status === "doing") ===
          true &&
        computer.rows?.some((r) => r.title === "Two" && r.status === "done") ===
          true,
    );

    const statusOf = (rows: readonly BoardRow[] | undefined) =>
      Object.fromEntries((rows ?? []).map((r) => [r.title, r.status]));
    expect(statusOf(phone.rows)).toEqual({ One: "doing", Two: "done" });
    expect(statusOf(computer.rows)).toEqual({ One: "doing", Two: "done" });
    expect(phone.changes).toBeGreaterThan(phoneEmissions);
    expect(computer.changes).toBeGreaterThan(computerEmissions);
    expect(peer.queryOps()).toHaveLength(qBefore);

    await phone.stop();
    await computer.stop();
    await peer.dispose();
  });

  test("people and labels live on the same overlay as the board", async () => {
    const peer = await inProcessPeer();
    const people = await peer.db.query(peopleQuery);
    const labels = await peer.db.query(labelsQuery);
    expect(people.map((p) => p.name)).toEqual(["Ada"]);
    expect(labels).toEqual([]);
    expect(peer.queryOps().filter((f) => f.asOf === undefined)).toEqual([]);
    await peer.dispose();
  });
});

const jwtOf = (claims: Record<string, unknown>): string => {
  const b64url = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
};

const jwtPayloadOf = (init: RequestInit): Record<string, unknown> | undefined => {
  const raw = init.headers;
  const auth =
    raw instanceof Headers
      ? (raw.get("authorization") ?? raw.get("Authorization"))
      : raw === undefined || Array.isArray(raw)
        ? undefined
        : ((raw as Record<string, string>).authorization ??
          (raw as Record<string, string>).Authorization);
  if (auth == null) return undefined;
  const part = auth.replace(/^Bearer\s+/i, "").split(".")[1];
  if (part === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const countingConnect = () => {
  let connects = 0;
  const connect: typeof Ramose.connect = (opts) => {
    connects += 1;
    return Ramose.connect(opts);
  };
  return {
    connect,
    get connects() {
      return connects;
    },
  };
};

describe("refresh open is one session, not two", () => {
  test("provision:false does not connect; the board client pays one resync dump", async () => {
    const peer = await inProcessPeer();
    await peer.closeClients();
    peer.resetTraffic();

    const user = { id: "ada", name: "Ada", email: "ada@reef.test" };
    const token = Ramose.token.jwt(async () =>
      jwtOf({ sub: user.id, ramose: { db: "coral-team", class: "admin" } }),
    );
    const counted = countingConnect();
    const opts = {
      token,
      url: "https://peer.local",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      connect: counted.connect,
    };

    const ws = await openWorkspace("coral-team", false, opts);
    expect(ws.cls).toBe("admin");
    expect(counted.connects).toBe(0);
    expect(peer.sockets()).toBe(0);
    expect(peer.resyncDumps()).toEqual([]);

    const client = counted.connect({
      url: opts.url,
      token: ws.token,
      fetch: opts.fetch,
      webSocket: opts.webSocket,
    });
    try {
      const db = client.db("coral-team", Reef);
      const who = await db.principal();
      expect(who.eid as number | null).toBe(peer.myEid);
      expect(counted.connects).toBe(1);
      // principal() is GET /info — no replica session yet
      expect(peer.sockets()).toBe(0);
      expect(peer.resyncDumps()).toEqual([]);

      const board = live(db.effect.live(boardQuery));
      await awaitLive(board);
      expect(peer.sockets()).toBe(1);
      expect(peer.resyncDumps()).toHaveLength(1);
      expect(peer.resyncDumps()[0]!.datoms).toBeGreaterThan(0);
      await board.stop();
    } finally {
      await client.close();
      await peer.dispose();
    }
  });

  test("a viewer open still uses one overlay and has no myEid", async () => {
    const peer = await inProcessPeer();
    await peer.closeClients();
    peer.resetTraffic();

    const user = { id: "vie", name: "Vie", email: "vie@reef.test" };
    const token = Ramose.token.jwt(async () =>
      jwtOf({ sub: user.id, ramose: { db: "coral-team", class: "viewer" } }),
    );
    const counted = countingConnect();
    const opts = {
      token,
      url: "https://peer.local",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      connect: counted.connect,
    };

    const ws = await openWorkspace("coral-team", false, opts);
    expect(ws.cls).toBe("viewer");
    expect(counted.connects).toBe(0);

    const client = counted.connect({
      url: opts.url,
      token: ws.token,
      fetch: opts.fetch,
      webSocket: opts.webSocket,
    });
    try {
      const db = client.db("coral-team", Reef);
      const who = await db.principal();
      expect(who.eid).toBeNull();
      expect(counted.connects).toBe(1);
      expect(peer.sockets()).toBe(0);

      const board = live(db.effect.live(boardQuery));
      await awaitLive(board);
      expect(peer.sockets()).toBe(1);
      expect(peer.resyncDumps()).toHaveLength(1);
      await board.stop();
    } finally {
      await client.close();
      await peer.dispose();
    }
  });

  test("provision still installs; the later board open is one new overlay", async () => {
    const peer = await inProcessPeer({ seed: false });
    const user = { id: "ada", name: "Ada", email: "ada@reef.test" };
    const token = Ramose.token.jwt(async () =>
      jwtOf({ sub: user.id, ramose: { db: "coral-team", class: "admin" } }),
    );
    const counted = countingConnect();
    const opts = {
      token,
      url: "https://peer.local",
      fetch: peer.fetch,
      webSocket: peer.webSocket,
      connect: counted.connect,
    };

    await openWorkspace("coral-team", true, opts);
    expect(counted.connects).toBe(1);
    expect(peer.sockets()).toBe(1);
    expect(peer.resyncDumps().length).toBeGreaterThanOrEqual(1);
    expect(peer.resyncDumps()[0]!.datoms).toBeGreaterThan(0);
    // in-process peer has no auth layer; seed the row the real peer writes
    await peer.conn.transact([
      { ":user/sub": "ada", ":user/role": "admin", ":user/name": "Ada", ":user/email": "ada@reef.test" },
    ]);

    peer.resetTraffic();
    const afterProvision = counted.connects;

    const ws = await openWorkspace("coral-team", false, opts);
    expect(counted.connects).toBe(afterProvision);
    expect(peer.sockets()).toBe(0);
    expect(peer.resyncDumps()).toEqual([]);

    const client = counted.connect({
      url: opts.url,
      token: ws.token,
      fetch: opts.fetch,
      webSocket: opts.webSocket,
    });
    try {
      const db = client.db("coral-team", Reef);
      const who = await db.principal();
      expect(who.eid).toBeGreaterThan(0);
      expect(counted.connects).toBe(afterProvision + 1);
      expect(peer.sockets()).toBe(0);

      const board = live(db.effect.live(boardQuery));
      await awaitLive(board);
      expect(peer.sockets()).toBe(1);
      expect(peer.resyncDumps()).toHaveLength(1);
      expect(peer.resyncDumps()[0]!.datoms).toBeGreaterThan(0);
      await board.stop();
    } finally {
      await client.close();
      await peer.dispose();
    }
  });
});
