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
 * `ramose/internal/*` is the engine, reachable but unsupported: it is how
 * this test stands an in-process server up without a Worker. An app never
 * imports it — `ramose/db` and `ramose/react` are the surface.
 */

import { describe, expect, test } from "bun:test";
import * as Ramose from "ramose/db";
import {
  Connection,
  Index,
  fromJson,
  query,
  toJson,
  toWireDatom,
} from "ramose/internal/core";
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
import { createIssue, moveIssue, setTitle } from "../src/app/mutations.ts";

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

const inProcessPeer = async () => {
  const conn = await Connection.create();
  const pushes: ((frame: unknown) => void)[] = [];
  const frames: { op: string; [k: string]: unknown }[] = [];
  const httpPaths: string[] = [];
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
    if (op === "transact") {
      if (hold !== undefined) await hold;
      if (rejectNext !== undefined) {
        const denied = rejectNext;
        rejectNext = undefined;
        return denied;
      }
      const rep = await conn.transact(body.tx);
      return {
        status: 200,
        body: {
          t: rep.t,
          txEid: rep.txEid,
          tempids: rep.tempids,
          datoms: rep.txData.map(toWireDatom),
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
    httpPaths.push(new URL(url, "https://peer.local").pathname);
    const body = fromJson(JSON.parse(String(init.body))) as any;
    const reply = await answer("transact", body);
    return new Response(JSON.stringify(toJson(reply.body)), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  function WebSocketImpl(this: unknown, _url: string) {
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
            emit("message", {
              data: JSON.stringify({
                op: "resync",
                t: (reply.body as { t: number }).t,
                datoms: (reply.body as { datoms: unknown }).datoms,
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

  const ramose = Ramose.connect({
    url: "https://peer.local",
    fetch: fetchImpl,
    webSocket: WebSocketImpl as unknown as typeof WebSocket,
  });
  const db: ReefDb = ramose.db("coral-team", Reef);
  await Effect.runPromise(db.install());
  const seeded = await Effect.runPromise(
    db.transact(function* (tx) {
      const user = yield* tx.entity();
      yield* user.add(User.sub, "ada");
      yield* user.add(User.name, "Ada");
      yield* user.add(User.email, "ada@reef.test");
    }),
  );
  const people = await Effect.runPromise(seeded.dbAfter.q(peopleQuery));
  const myEid = people[0]!.id;

  return {
    conn,
    db,
    myEid,
    frames,
    httpPaths,
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
    dispose: () => ramose.close(),
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
    const board = live(peer.db.live(boardQuery));
    await awaitLive(board);
    expect(board.rows).toEqual([]);
    const qBefore = peer.queryOps().length;
    const httpBefore = peer.httpPaths.filter((p) => p.endsWith("/query")).length;

    peer.holdTransact();
    const created = Effect.runPromise(
      createIssue(peer.db, peer.myEid, undefined, {
        title: "Ship the overlay",
        status: "todo",
        priority: 2,
      }),
    );
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
    const moved = Effect.runPromise(moveIssue(peer.db, issueId, "doing", 2048));
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
    const board = live(peer.db.live(boardQuery));
    await awaitLive(board);

    await Effect.runPromise(
      createIssue(peer.db, peer.myEid, undefined, {
        title: "Draft",
        status: "todo",
        priority: 1,
      }),
    );
    await awaitLive(board, () => titles(board.rows).includes("Draft"));
    const issueId = board.rows![0]!.id;

    peer.holdTransact();
    const edited = Effect.runPromise(setTitle(peer.db, issueId, "Renamed"));
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
      tag: "TxRejected",
      code: "policy",
    });
    const denied = Effect.runPromise(
      Effect.flip(
        createIssue(peer.db, peer.myEid, board.rows![0]!.rank, {
          title: "Ghost",
          status: "todo",
          priority: 0,
        }),
      ),
    );
    await awaitLive(board, () => titles(board.rows).includes("Ghost"));
    expect(titles(board.rows)).toContain("Ghost");

    peer.releaseTransact();
    const err = await denied;
    await settle();
    expect(err._tag).toBe("TxRejected");
    expect(titles(board.rows)).toEqual(["Renamed"]);
    expect(peer.queryOps()).toHaveLength(qBefore);

    await board.stop();
    await peer.dispose();
  });

  test("an inbound filtered tx frame updates the board without /query", async () => {
    const peer = await inProcessPeer();
    const board = live(peer.db.live(boardQuery));
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
    await Effect.runPromise(
      createIssue(peer.db, peer.myEid, undefined, {
        title: "Only in the present",
        status: "todo",
        priority: 0,
      }),
    );

    const qBefore = peer.queryOps().length;
    const past = await Effect.runPromise(peer.db.asOf(seedT).q(boardQuery));
    expect(past).toEqual([]);
    expect(peer.queryOps().length).toBeGreaterThan(qBefore);

    const now = await Effect.runPromise(peer.db.q(boardQuery));
    expect(titles(now)).toEqual(["Only in the present"]);
    // current-view q is local — asOf was the only new socket `q`
    expect(peer.queryOps()).toHaveLength(qBefore + 1);

    await peer.dispose();
  });

  test("people and labels live on the same overlay as the board", async () => {
    const peer = await inProcessPeer();
    const people = await Effect.runPromise(peer.db.q(peopleQuery));
    const labels = await Effect.runPromise(peer.db.q(labelsQuery));
    expect(people.map((p) => p.name)).toEqual(["Ada"]);
    expect(labels).toEqual([]);
    expect(peer.queryOps()).toEqual([]);
    await peer.dispose();
  });
});
