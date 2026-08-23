/**
 * `db.basis()` — where is the basis?
 *
 * One `GET /db/:name/info` over HTTPS for a live view (the session's `t` is 0
 * before the first frame and lags a fresh peer; `/info` is authoritative and
 * cheap), `{ t }` with zero I/O for `asOf(t)`, and the live basis for
 * `history`. Observing a newer basis bumps the session — the same rule as
 * `transact` — so a standing `live` that missed a tick re-runs.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import { Query } from "../src/db/internal.ts";
import { type Call, client, fakePeer, redacted, settle } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;
const runFail = async <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<any> => {
  if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value));
  try {
    await value;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
};

/** Drain a stream into an array on its own fiber, as `useLive` would. */
const collect = <A, E>(stream: Stream.Stream<A, E>) => {
  const seen: A[] = [];
  let error: unknown;
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (a) =>
      Effect.sync(() => {
        seen.push(a);
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
    seen,
    get error() {
      return error;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const names = Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name })));
const row = (name: string) => [{ name }];

/** `/info` at `state.t` over HTTPS, reads at `state` over the socket. */
const peerAt = (state: { t: number; rows: unknown[][] }) =>
  fakePeer({
    answer: () => ({ body: { t: state.t, root: state.t, result: state.rows } }),
    http: (call: Call) =>
      call.method === "GET" && call.url.endsWith("/db/movies/info")
        ? { body: { db: "movies", t: state.t } }
        : { body: { t: state.t, txEid: 1, tempids: {}, datoms: 1 } },
  });

describe("db.basis()", () => {
  test("one GET /db/:name/info, with the bearer, returns the peer's t", async () => {
    const state = { t: 42, rows: [] as unknown[][] };
    const peer = peerAt(state);
    const c = client(peer, { token: Effect.succeed(redacted("s3cret")) });

    expect(await run(c.ramose.db("movies", Movies).basis())).toEqual({ t: 42 });
    expect(peer.calls).toHaveLength(1);
    expect(peer.calls[0]).toMatchObject({
      method: "GET",
      url: "https://peer.example.com/db/movies/info",
    });
    expect(peer.calls[0]!.headers.authorization).toBe("Bearer s3cret");

    await c.dispose();
  });

  test("asOf(5).basis() is { t: 5 } — no request, no socket", async () => {
    const peer = peerAt({ t: 42, rows: [] });
    const c = client(peer);

    expect(await run(c.ramose.db("movies", Movies).asOf(5).basis())).toEqual({
      t: 5,
    });
    expect(peer.calls).toHaveLength(0);
    expect(peer.frames).toHaveLength(0);
    expect(peer.sockets).toHaveLength(0);

    await c.dispose();
  });

  test("history.basis() is the live basis", async () => {
    const state = { t: 7, rows: [] as unknown[][] };
    const peer = peerAt(state);
    const c = client(peer);

    expect(await run(c.ramose.db("movies", Movies).history.basis())).toEqual({
      t: 7,
    });
    expect(peer.calls).toHaveLength(1);

    await c.dispose();
  });

  test("a 404 maps to DatabaseNotFound", async () => {
    const peer = fakePeer({
      http: () => ({ status: 404, body: { error: "no such database" } }),
    });
    const c = client(peer);

    const failure = await runFail(c.ramose.db("movies", Movies).basis());
    expect(failure._tag).toBe("DatabaseNotFound");

    await c.dispose();
  });

  test("a standing live wakes after basis() observes a newer t", async () => {
    const { catalogWorld, snapshotOf } = await import("./overlay-seed.ts");
    const conn = await catalogWorld(Movies);
    await conn.transact([{ ":user/name": "Ada" }]);
    const snap = await snapshotOf(conn);
    const state = { t: snap.t, rows: [row("Ada")] };
    const peer = fakePeer({
      answer: (frame) =>
        frame.op === "sync"
          ? { body: { t: snap.t, datoms: snap.datoms } }
          : { body: { t: state.t, root: state.t, result: state.rows } },
      http: (call: Call) =>
        call.method === "GET" && call.url.endsWith("/db/movies/info")
          ? { body: { db: "movies", t: state.t } }
          : { body: { t: state.t, txEid: 1, tempids: {}, datoms: 1 } },
    });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const live = collect(db.effect.live(names));
    await settle();
    expect(live.seen).toEqual([[{ name: "Ada" }]]);

    // the peer moved; basis() bumps the session. Overlay data is unchanged,
    // so digest-dedup keeps a single emission and no /query is sent.
    state.t = 9;
    expect(await db.basis()).toEqual({ t: 9 });
    await settle();

    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(peer.frameOps("q")).toEqual([]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });
});
