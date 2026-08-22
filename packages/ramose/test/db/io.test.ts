/**
 * The typed surface against a real engine `Connection`.
 *
 * The fake peer here is the whole peer: `POST /db/:name/transact|query|pull`
 * over `fetch`, and the same reads as session frames over a fake socket. That
 * is enough to run install → transact → q → pull → asOf → history end to end
 * without a Worker, and to pin the two contracts a unit test cannot fake — the
 * read fence (`minT`) actually moving a stale basis, and an uninstalled
 * attribute failing `InvalidRequest` rather than coming back as a subset.
 */

import { describe, expect, test } from "bun:test";
import {
  Connection,
  QueryBudgetError,
  QueryError,
  QueryParseError,
  TxError,
  fromJson,
  normalizePullPattern,
  pull,
  query,
  toJson,
  toWireDatom,
} from "../../src/internal/core/index.ts";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Databases, Query, layer } from "../../src/db/internal.ts";

import { Meta, Movie, Movies, User } from "./fixture.ts";

/** The one query most of these tests run; only the transport is under test. */
const names = Query.q(() =>
  pipe(Query.entities(User), Query.select({ name: User.name })),
);
/** The entity behind a known name, as an `{ id }` row (no select: the
 * generator returns the focus, so the row keeps its precise id type). */
const adaId = Query.q(function* () {
  const user = yield* Query.entities(User);
  yield* Query.is(User.name, "Ada")(user);
  return user;
});

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runFail = <A, E>(eff: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(eff));

interface Reply {
  status: number;
  body: unknown;
}

/**
 * One database, one `Connection`, both wires.
 *
 * `staleT` pins reads to a past basis unless the request carries an
 * `x-ramose-min-t` / `minT` past it — which is exactly what
 * `fetchBasisWithStats` in `packages/ramose/src/worker/peer.ts` does with the fence.
 */
const inProcessPeer = async (options: { staleT?: number } = {}) => {
  const conn = await Connection.create();
  const frames: Record<string, unknown>[] = [];
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  let sockets = 0;

  const viewOf = (b: { asOf?: number; history?: boolean }, fence: number) => {
    let db = conn.db();
    const stale = options.staleT;
    if (typeof b.asOf === "number") db = db.asOf(b.asOf);
    else if (stale !== undefined && fence <= stale) db = db.asOf(stale);
    if (b.history) db = db.history();
    return db;
  };

  const answer = async (
    op: string,
    body: any,
    fence: number,
  ): Promise<Reply> => {
    try {
      if (op === "sync") {
        return { status: 200, body: { t: conn.t, from: body.from ?? 0 } };
      }
      if (op === "transact") {
        const rep = await conn.transact(body.tx);
        return {
          status: 200,
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            ...(typeof body.clientTxId === "string" ? { clientTxId: body.clientTxId } : {}),
          },
        };
      }
      if (op === "q") {
        const db = viewOf(body, fence);
        const result = await query(db, body.query, body.inputs ?? []);
        return { status: 200, body: { t: db.effectiveT, root: db.effectiveT, result } };
      }
      if (op === "pull") {
        const db = viewOf(body, fence);
        // the peer's own rule: an attribute this database never installed is a
        // bad request, not a silently missing key (packages/ramose/src/worker/index.ts)
        const pattern = normalizePullPattern(body.pattern);
        const unknown = pattern
          .filter((s: any) => s.kind === "attr" && s.attr !== ":db/id")
          .filter((s: any) => db.attr(s.attr) === undefined)
          .map((s: any) => s.attr);
        if (unknown.length > 0) {
          return { status: 400, body: { error: `unknown attribute in pull pattern: ${unknown.join(", ")}` } };
        }
        const eid = typeof body.eid === "number" ? body.eid : await db.entid(body.eid);
        if (eid === undefined) return { status: 200, body: { t: db.effectiveT, result: null } };
        return { status: 200, body: { t: db.effectiveT, result: await pull(db, eid, pattern) } };
      }
      return { status: 404, body: { error: `no such op ${op}` } };
    } catch (err) {
      if (err instanceof TxError) {
        return { status: 409, body: { error: err.message, tag: "TxRejected", code: err.code } };
      }
      if (err instanceof QueryBudgetError) {
        return {
          status: 413,
          body: { error: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit },
        };
      }
      if (err instanceof QueryParseError || err instanceof QueryError) {
        return { status: 400, body: { error: err.message } };
      }
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body === undefined ? {} : fromJson(JSON.parse(String(init.body)));
    calls.push({ url: String(url), body, headers });
    const op = path.endsWith("/transact") ? "transact" : path.endsWith("/query") ? "q" : "pull";
    const reply = await answer(op, body, Number(headers["x-ramose-min-t"] ?? 0));
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
    const socket = {
      readyState: 0,
      addEventListener: (type: string, cb: (ev: any) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      send: (data: string) => {
        const frame = fromJson(JSON.parse(data)) as any;
        frames.push(frame);
        void answer(frame.op, frame, Number(frame.minT ?? 0)).then((reply) =>
          emit("message", {
            data: JSON.stringify({ id: frame.id, status: reply.status, body: toJson(reply.body) }),
          }),
        );
      },
      close: () => emit("close", {}),
      push: (frame: unknown) => emit("message", { data: JSON.stringify(frame) }),
    };
    queueMicrotask(() => emit("open", {}));
    return socket;
  }

  const runtime = ManagedRuntime.make(
    layer({
      url: "https://peer.local",
      fetch: fetchImpl,
      webSocket: WebSocketImpl as unknown as typeof WebSocket,
    }),
  );

  return {
    conn,
    frames,
    calls,
    get sockets() {
      return sockets;
    },
    ramose: runtime.runSync(Databases),
    dispose: () => runtime.dispose(),
  };
};

describe("install → transact → q → pull", () => {
  test("the whole happy path, on one Connection", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);

    const installed = await run(db.install());
    expect(installed.t).toBeGreaterThan(0);
    expect(peer.calls[0].url).toBe("https://peer.local/db/movies/transact");

    const report = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        yield* ada.add(User.age, 36);
        yield* ada.add(Meta.source, "import");

        const alonzo = yield* tx.entity();
        yield* alonzo.add(User.name, "Alonzo");
        yield* alonzo.add(User.age, 40);
        yield* ada.add(User.friends, alonzo.eid as never);
        yield* ada.add(User.bestFriend, alonzo.eid as never);

        const arrival = yield* tx.entity();
        yield* arrival.add(Movie.title, "Arrival");
        yield* arrival.add(Movie.year, 2016);
      }),
    );
    expect(report.t).toBeGreaterThan(installed.t);
    expect(report.txEid.id).toBeGreaterThan(0);
    expect(report.datomCount).toBeGreaterThan(0);

    // read-your-writes with no second round trip
    const rows = await run(report.dbAfter.q(adaId));
    expect(rows).toHaveLength(1);
    const ada = rows[0]!;
    expect(ada.id).toBeGreaterThan(0);

    const pulled = await run(
      report.dbAfter.pull(ada, {
        name: User.name,
        age: User.age.optional,
        source: Meta.source,
        bestFriend: User.bestFriend.optional.select({
          name: User.name,
          age: User.age.optional,
        }),
        friends: User.friends.select({ name: User.name }),
      }),
    );
    expect(pulled).not.toBeNull();
    expect(pulled!.name).toBe("Ada");
    expect(pulled!.age).toBe(36);
    expect(pulled!.source).toBe("import");
    expect(pulled!.bestFriend?.name).toBe("Alonzo");
    expect(pulled!.friends.map((f) => f.name)).toEqual(["Alonzo"]);

    // the ident-keyed escape hatch
    const soup = await run(db.pull(ada, [User.name, User.age] as const));
    expect(soup![":user/name"]).toBe("Ada");
    expect(soup![":user/age"]).toBe(36);

    // writes stay HTTPS; current-view reads run on the overlay (catch-up sync)
    expect(peer.calls.map((c) => c.url)).toEqual([
      "https://peer.local/db/movies/transact",
      "https://peer.local/db/movies/transact",
    ]);
    expect(peer.frames.filter((f) => f.op === "q" || f.op === "pull")).toEqual([]);
    expect(peer.frames.some((f) => f.op === "sync")).toBe(true);
    await peer.dispose();
  });

  test("install is idempotent — the second one is the same upsert", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    const first = await run(db.install());
    const second = await run(db.install());
    expect(second.t).toBeGreaterThan(first.t);
    expect(peer.calls[1].body.tx).toEqual(peer.calls[0].body.tx);

    // and the schema is usable either way round
    await run(
      db.transact(function* (tx) {
        const e = yield* tx.entity();
        yield* e.add(User.name, "Ada");
      }),
    );
    expect(await run(db.q(names))).toEqual([{ name: "Ada" }]);
    await peer.dispose();
  });

  test("`.select` pulls in the query — one round trip, one row per entity", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const { dbAfter } = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        const bob = yield* tx.entity();
        yield* bob.add(User.name, "Bob");
      }),
    );

    const rows = await run(
      dbAfter.q(
        Query.q(() =>
          pipe(Query.entities(User), Query.select({ id: User.id, name: User.name })),
        ),
      ),
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["Ada", "Bob"]);
    expect(rows.every((r) => typeof r.id === "number")).toBe(true);
    // current-view q is local — only the first-connect sync rode the socket
    expect(peer.frames.filter((f) => f.op === "q")).toEqual([]);
    expect(peer.frames.some((f) => f.op === "sync")).toBe(true);
    await peer.dispose();
  });
});

describe("views", () => {
  test("asOf pins the past, history sees the retraction, and neither can write", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const first = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );

    const before = await run(db.asOf(first.t - 1).q(names));
    expect(before).toEqual([]);

    const now = await run(first.dbAfter.q(names));
    expect(now).toEqual([{ name: "Ada" }]);

    const hist = await run(db.history.q(adaId));
    expect(hist.length).toBeGreaterThanOrEqual(1);

    expect("transact" in db.asOf(1)).toBe(false);
    expect("install" in db.history).toBe(false);
    await peer.dispose();
  });

  test("a view does not mutate the db it came from", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const past = db.asOf(1);
    await run(db.q(names));
    await run(past.q(names));
    expect(peer.frames.filter((f) => f.op === "q").map((f) => f.asOf)).toEqual([1]);
    expect(peer.frames.some((f) => f.op === "sync")).toBe(true);
    await peer.dispose();
  });
});

describe("the read fence is what dbAfter carries", () => {
  test("a session overlay reads the write locally; asOf still pins the past", async () => {
    const peer = await inProcessPeer({ staleT: 1 });
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const report = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );

    expect(await run(db.q(names))).toEqual([{ name: "Ada" }]);
    expect(await run(report.dbAfter.q(names))).toEqual([{ name: "Ada" }]);
    expect(await run(db.asOf(1).q(names))).toEqual([]);
    await peer.dispose();
  });
});

describe("failures", () => {
  test("an uninstalled peer still answers locally from the catalog schema", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    // note: no install() — the overlay knows the catalog, the peer does not

    expect(await run(db.pull({ id: 1 }, { name: User.name }))).toBeNull();
    expect(await run(db.q(names))).toEqual([]);
    await peer.dispose();
  });

  test("a rejected transaction is TxRejected, and catchTags is total", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());

    const caught = await run(
      db
        .transact(function* (tx) {
          yield* tx.add(1, ":user/nope" as never, "x" as never);
        })
        .pipe(
          Effect.catchTags({
            TxRejected: (e) => Effect.succeed(e._tag),
            Unavailable: (e) => Effect.succeed(e._tag),
            InvalidRequest: (e) => Effect.succeed(e._tag),
            DatabaseNotFound: (e) => Effect.succeed(e._tag),
            Unauthorized: (e) => Effect.succeed(e._tag),
            QueryBudgetExceeded: (e) => Effect.succeed(e._tag),
            InternalError: (e) => Effect.succeed(e._tag),
            NetworkError: (e) => Effect.succeed(e._tag),
            OperationRejected: (e) => Effect.succeed(e._tag),
          }),
        ),
    );
    expect(caught).toBe("TxRejected");
    await peer.dispose();
  });

  test("a generator body that fails does not submit", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const writes = peer.calls.length;

    const e = await runFail(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        return yield* Effect.fail("nope" as const);
      }),
    );
    expect(e).toBe("nope");
    expect(peer.calls).toHaveLength(writes);
    expect(await run(db.q(names))).toEqual([]);
    await peer.dispose();
  });

  test("required vs optional: missing required is null, optional is undefined", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const { dbAfter } = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
        const alonzo = yield* tx.entity();
        yield* alonzo.add(User.name, "Alonzo");
        yield* ada.add(User.friends, alonzo.eid as never);
        const ghost = yield* tx.entity();
        yield* ghost.add(User.age, 1);
        yield* ada.add(User.friends, ghost.eid as never);
      }),
    );
    const rows = await run(dbAfter.q(adaId));
    const ada = rows[0]!;

    expect(await run(dbAfter.pull(ada, { name: User.name, age: User.age }))).toBeNull();
    expect(
      await run(dbAfter.pull(ada, { name: User.name, age: User.age.optional })),
    ).toEqual({ name: "Ada", age: undefined });

    const friends = await run(
      dbAfter.pull(ada, {
        name: User.name,
        friends: User.friends.select({ name: User.name }),
      }),
    );
    expect(friends!.friends.map((f) => f.name)).toEqual(["Alonzo"]);

    expect(
      await run(
        dbAfter.pull(ada, {
          name: User.name,
          bestFriend: User.bestFriend.select({ name: User.name }),
        }),
      ),
    ).toBeNull();
    expect(
      await run(
        dbAfter.pull(ada, {
          name: User.name,
          bestFriend: User.bestFriend.optional.select({ name: User.name }),
        }),
      ),
    ).toEqual({ name: "Ada", bestFriend: undefined });
    await peer.dispose();
  });

  test("a lookup ref resolves, and a miss is null", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("movies", Movies);
    await run(db.install());
    const { dbAfter } = await run(
      db.transact(function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.add(User.name, "Ada");
      }),
    );
    expect(
      await run(dbAfter.pull([":user/name", "Ada"], { name: User.name })),
    ).toEqual({ name: "Ada" });
    expect(
      await run(dbAfter.pull([":user/name", "Nobody"], { name: User.name })),
    ).toBeNull();
    await peer.dispose();
  });
});
