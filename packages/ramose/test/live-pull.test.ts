/**
 * `db.livePull` — a standing `db.pull` as a `Stream`.
 *
 * Session clients pull against the overlay. Apply is the notify: pending /
 * ack / `{ op: "tx" }` / `{ op: "resync" }`. `null` (entity retracted) is
 * a legitimate emission. Pinned views still emit once from the peer.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { Connection } from "../src/internal/core/conn.ts";
import { toWireDatom } from "../src/internal/core/log.ts";
import { client, fakePeer, settle, type Frame, type Reply } from "./peer.ts";
import { catalogWorld, snapshotOf, txSnap } from "./overlay-seed.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;

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

const shape = { name: User.name, age: User.age.optional };

const adaWorld = async (age = 36) => {
  const conn = await catalogWorld(Movies);
  const added = txSnap(
    await conn.transact([
      { ":db/id": "ada", ":user/name": "Ada", ":user/age": age },
    ]),
  );
  const snap = await snapshotOf(conn);
  return { conn, eid: added.tempids.ada, ...snap };
};

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
      return { body: { t: state.t, result: null } };
    },
  });

describe("pull and livePull are two terminals over one shape", () => {
  test("the first pass emits the projection, locally", async () => {
    const world = await adaWorld();
    const peer = peerAt({ t: world.t, datoms: world.datoms });
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const ada = { id: world.eid };

    expect(await db.pull(ada, shape)).toEqual({ name: "Ada", age: 36 });
    const live = collect(db.effect.livePull(ada, shape));
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(peer.frameOps("q")).toHaveLength(0);
    expect(peer.frameOps("pull")).toHaveLength(0);
    expect(peer.frames.some((f) => f.op === "sync")).toBe(true);

    await live.stop();
    await c.dispose();
  });
});

describe("the basis is the wake", () => {
  test("a tx frame re-runs the pull locally", async () => {
    const world = await adaWorld(36);
    const peer = peerAt({ t: world.t, datoms: world.datoms });
    const c = client(peer);
    const ada = { id: world.eid };
    const live = collect(c.ramose.db("movies", Movies).effect.livePull(ada, shape));
    await settle();
    expect(live.seen).toHaveLength(1);

    const older = txSnap(
      await world.conn.transact([{ ":db/id": world.eid, ":user/age": 37 }]),
    );
    peer.push({ op: "tx", t: older.t, datoms: older.datoms });
    await settle();

    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual({ name: "Ada", age: 37 });
    expect(peer.frameOps("pull")).toEqual([]);

    await live.stop();
    await c.dispose();
  });

  test("retractEntity on the same connection emits null, and the stream keeps standing", async () => {
    const world = await adaWorld();
    const state = { t: world.t, datoms: world.datoms, ackT: 30, conn: world.conn };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const ada = { id: world.eid };
    const live = collect(db.effect.livePull(ada, shape));
    await settle();
    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);

    await run(
      db.effect.transact(function* (tx) {
        yield* tx.delete(world.eid);
      }),
    );
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }, null]);
    expect(live.done).toBe(false);
    expect(peer.frameOps("pull")).toEqual([]);

    peer.push({ op: "resync", t: Math.max(world.t, 31), datoms: world.datoms });
    await settle();
    expect(live.seen).toHaveLength(3);
    expect(live.seen[2]).toEqual({ name: "Ada", age: 36 });

    await live.stop();
    await c.dispose();
  });
});

describe("livePull survives the network like live", () => {
  test("a dropped socket reconnects in place and the stream keeps emitting", async () => {
    const world = await adaWorld(36);
    const state = { t: world.t, datoms: world.datoms };
    const peer = peerAt(state);
    const c = client(peer);
    const ada = { id: world.eid };
    const live = collect(c.ramose.db("movies", Movies).effect.livePull(ada, shape));
    await settle();
    expect(live.seen).toHaveLength(1);
    expect(peer.sockets).toHaveLength(1);

    await world.conn.transact([{ ":db/id": world.eid, ":user/age": 37 }]);
    const snap = await snapshotOf(world.conn);
    state.t = snap.t;
    state.datoms = snap.datoms;
    peer.drop();
    await settle(60);

    expect(peer.sockets).toHaveLength(2);
    expect(live.seen.at(-1)).toEqual({ name: "Ada", age: 37 });
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("Unauthorized re-reads the token and re-authenticates in place; the stream never sees it", async () => {
    const world = await adaWorld();
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
    const live = collect(
      c.ramose.db("movies", Movies).effect.livePull({ id: world.eid }, shape),
    );
    await settle();

    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.map((f) => f.op)).toEqual(["sync", "auth", "sync"]);
    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
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
    const live = collect(c.ramose.db("movies", Movies).effect.livePull({ id: 17 }, shape));
    await settle();

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("Unauthorized");
    await c.dispose();
  });
});

describe("a pinned view has no news", () => {
  test("livePull over asOf emits once and completes", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 5, result: { name: "Ada", age: 36 } } }),
    });
    const c = client(peer);
    const live = collect(
      c.ramose.db("movies", Movies).asOf(3).effect.livePull({ id: 17 }, shape),
    );
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("pull")[0].asOf).toBe(3);

    peer.push({ op: "tx", t: 99, datoms: [] });
    await settle();
    expect(live.seen).toHaveLength(1);
    await c.dispose();
  });

  test("livePull over history emits once and completes", async () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 5, result: { name: "Ada", age: 36 } } }),
    });
    const c = client(peer);
    const live = collect(
      c.ramose.db("movies", Movies).history.effect.livePull({ id: 17 }, shape),
    );
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("pull")[0].history).toBe(true);
    await c.dispose();
  });
});
