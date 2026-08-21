/**
 * `db.live` — a standing `db.q` as a `Stream`.
 *
 * Session clients run the engine against the overlay. The stream re-runs
 * when that overlay mutates: apply is the notify (pending, ack,
 * `{ op: "tx" }`, `{ op: "resync" }`). Not a `/query` refetch because `t`
 * moved. Pinned `asOf` / `history` still emit once from the peer.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { query } from "../src/db/internal.ts";
import type { Connection } from "../src/internal/core/conn.ts";
import { toWireDatom } from "../src/internal/core/log.ts";
import { client, fakePeer, settle, until, type Frame, type Reply } from "./peer.ts";
import { catalogWorld, snapshotOf, txSnap } from "./overlay-seed.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

/** Drain a stream into an array on its own fiber, as `useLive` would. */
const collect = <A, E>(stream: Stream.Stream<A, E>) => {
  const seen: A[] = [];
  let error: unknown;
  let done = false;
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
      Effect.andThen(() =>
        Effect.sync(() => {
          done = true;
        }),
      ),
    ),
  );
  return {
    seen,
    get error() {
      return error;
    },
    get done() {
      return done;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const names = query(User).select({ name: User.name });

const users = async (...who: string[]) => {
  const conn = await catalogWorld(Movies);
  const snaps = [];
  for (const name of who) {
    snaps.push(txSnap(await conn.transact([{ ":user/name": name }])));
  }
  return { conn, snaps, ...(await snapshotOf(conn)) };
};

/** A peer that dumps `state.datoms` on first sync (the #112 resync-then-ack). */
const peerAt = (state: {
  t: number;
  datoms: unknown[];
  ackT?: number;
  conn?: Connection;
  answer?: (frame: Frame) => Reply | undefined;
}) =>
  fakePeer({
    http: async (call) => {
      if (call.url.endsWith("/transact") && state.conn !== undefined) {
        const rep = await state.conn.transact(call.body.tx);
        return {
          body: {
            t: state.ackT ?? rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      }
      return {
        body: { t: state.ackT ?? state.t, txEid: 1, tempids: {}, datoms: [] },
      };
    },
    answer: (frame) => {
      const custom = state.answer?.(frame);
      if (custom !== undefined) return custom;
      if (frame.op === "sync") {
        return { body: { t: state.t, from: frame.from ?? 0, datoms: state.datoms } };
      }
      return { body: { t: state.t, root: state.t, result: [] } };
    },
  });

describe("q and live are two terminals over one query", () => {
  test("the same query value runs once, or stands up", async () => {
    const world = await users("Ada");
    const state = { t: world.t, datoms: world.datoms };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    await until(async () =>
      JSON.stringify(await run(db.q(names))) === JSON.stringify([{ name: "Ada" }]),
    );
    expect(await run(db.q(names))).toEqual([{ name: "Ada" }]);
    const live = collect(db.live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(peer.frameOps("q")).toEqual([]);
    expect(peer.frames.some((f) => f.op === "sync")).toBe(true);

    await live.stop();
    await c.dispose();
  });

  test("the pull rides in the query: one local pass, no N+1", async () => {
    const world = await users("Ada", "Cy");
    const peer = peerAt({ t: world.t, datoms: world.datoms });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) ===
      JSON.stringify([{ name: "Ada" }, { name: "Cy" }]),
    );

    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Cy" }]);
    expect(peer.frameOps("pull")).toHaveLength(0);
    expect(peer.frameOps("q")).toHaveLength(0);

    await live.stop();
    await c.dispose();
  });
});

describe("paint is the wake", () => {
  test("a tx frame re-runs the query locally — no { op: t } required", async () => {
    const world = await users("Ada");
    const state = { t: world.t, datoms: world.datoms };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    const n = live.seen.length;

    const bob = txSnap(await world.conn.transact([{ ":user/name": "Bob" }]));
    state.t = bob.t;
    peer.push({ op: "tx", t: bob.t, datoms: bob.datoms });
    await until(() => live.seen.length === n + 1);

    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.frameOps("q")).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("a local transact is visible to live before POST returns", async () => {
    const world = await users("Ada");
    const state = { t: world.t, datoms: world.datoms, ackT: 30, conn: world.conn };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const live = collect(db.live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    const n = live.seen.length;

    await run(
      db.transact(function* (tx) {
        const bob = yield* tx.entity();
        yield* bob.add(User.name, "Bob");
      }),
    );
    await until(() => live.seen.length === n + 1);

    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.frameOps("q")).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("interrupting the fiber is the whole teardown", async () => {
    const world = await users("Ada");
    const peer = peerAt({ t: world.t, datoms: world.datoms });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    const frames = peer.frames.length;
    const n = live.seen.length;

    await live.stop();
    peer.push({ op: "tx", t: world.t + 1, datoms: [] });
    await settle();

    expect(peer.frames).toHaveLength(frames);
    expect(live.seen).toHaveLength(n);
    await c.dispose();
  });
});

describe("live survives the network", () => {
  test("a dropped socket reconnects in place and the stream keeps emitting", async () => {
    const world = await users("Ada");
    const state = { t: world.t, datoms: world.datoms };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    expect(peer.sockets).toHaveLength(1);

    const bob = txSnap(await world.conn.transact([{ ":user/name": "Bob" }]));
    state.t = bob.t;
    state.datoms = (await snapshotOf(world.conn)).datoms;
    peer.drop();
    await settle(60);

    expect(peer.sockets).toHaveLength(2);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("a 5xx is retried with backoff, not surfaced", async () => {
    const world = await users("Ada");
    let failures = 1;
    const state = {
      t: world.t,
      datoms: world.datoms,
      answer: (frame: Frame) => {
        if (frame.op !== "sync" || failures === 0) return undefined;
        failures -= 1;
        return { status: 500, body: { error: "the replica is having a moment" } };
      },
    };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));

    await settle();
    expect(live.error).toBeUndefined();

    await until(() =>
      JSON.stringify(live.seen.at(-1)) === JSON.stringify([{ name: "Ada" }]),
    );
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("Unauthorized re-reads the token and reconnects; a second refusal is terminal", async () => {
    const world = await users("Ada");
    let issued = 0;
    let refusals = 1;
    const state = {
      t: world.t,
      datoms: world.datoms,
      answer: (frame: Frame) => {
        if (frame.op === "auth") return { ok: true };
        if (frame.op === "sync" && refusals > 0) {
          refusals -= 1;
          return { status: 401, body: { error: "token expired" } };
        }
        return undefined;
      },
    };
    const peer = peerAt(state);
    const c = client(peer, {
      token: Effect.sync(() => Redacted.make(`token-${++issued}`)),
    });
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();

    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.map((f) => f.op)).toEqual(["sync", "auth", "sync"]);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("a refusal that survives the fresh token fails the stream", async () => {
    const peer = peerAt({
      t: 5,
      datoms: [],
      answer: () => ({ status: 401, body: { error: "no" } }),
    });
    const c = client(peer, { token: Effect.succeed(Redacted.make("stale")) });
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("Unauthorized");
    await c.dispose();
  });

  test("a terminal InvalidRequest fails the stream rather than retrying", async () => {
    const peer = peerAt({
      t: 5,
      datoms: [],
      answer: () => ({ status: 400, body: { error: "unknown attribute" } }),
    });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).asOf(5).live(names));
    await settle();

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("InvalidRequest");
    expect(peer.frameOps("q")).toHaveLength(1);
    await c.dispose();
  });
});

describe("a pinned view has no news", () => {
  test("live over asOf emits once and completes", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 5, root: 5, result: [[{ name: "Ada" }]] } }),
    });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).asOf(3).live(names));
    await settle();

    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("q")[0].asOf).toBe(3);

    peer.push({ op: "tx", t: 99, datoms: [] });
    await settle();
    expect(live.seen).toHaveLength(1);
    await c.dispose();
  });

  test("live over history emits once and completes", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 5, root: 5, result: [[{ name: "Ada" }]] } }),
    });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).history.live(names));
    await settle();

    expect(live.seen).toHaveLength(1);
    expect(live.done).toBe(true);
    expect(peer.frameOps("q")[0].history).toBe(true);
    await c.dispose();
  });
});
