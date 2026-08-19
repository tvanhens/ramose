/**
 * `db.livePull` — a standing `db.pull` as a `Stream`.
 *
 * The two terminals share one subject and shape, so everything `pull` can
 * project `livePull` can too. The standing loop is the one `live` uses
 * (`standing` in `Db.ts`): re-run on every basis tick and after a local
 * `transact`, dedupe by digest, retry with backoff, fail only on the
 * terminal refusals, and over a pinned view emit once and complete.
 *
 * What is specific to a pull: the emission is one projection or `null`,
 * and `null` (the entity retracted, a required field gone) is a legitimate
 * emission — the stream keeps standing after it.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { client, fakePeer, settle, type Frame, type Reply } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

/** Drain a stream into an array on its own fiber, as a hook would. */
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

const ada = { id: 17 };
const shape = { name: User.name, age: User.age.optional };

/** The wire pattern `shape` lowers to. */
const shapeWire = [
  { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
  { kind: "attr", attr: ":user/age", reverse: false, as: "age" },
];

/** A peer whose entity and basis the test moves under it. */
const peerAt = (state: {
  t: number;
  entity: unknown;
  ackT?: number;
  answer?: (frame: Frame) => Reply | undefined;
}) =>
  fakePeer({
    http: () => ({
      body: { t: state.ackT ?? state.t, txEid: 1, tempids: {}, datoms: 1 },
    }),
    answer: (frame) => {
      const custom = state.answer?.(frame);
      if (custom !== undefined) return custom;
      return { body: { t: state.t, result: state.entity } };
    },
  });

describe("pull and livePull are two terminals over one shape", () => {
  test("the first pass emits the projection, over a pull frame", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    expect(await run(db.pull(ada, shape))).toEqual({ name: "Ada", age: 36 });
    const live = collect(db.livePull(ada, shape));
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    // both terminals took the pull op with the same lowered shape
    expect(peer.frameOps("q")).toHaveLength(0);
    expect(peer.frameOps("pull").map((f) => f.pattern)).toEqual([
      shapeWire,
      shapeWire,
    ]);
    expect(peer.frameOps("pull").map((f) => f.eid)).toEqual([17, 17]);

    await live.stop();
    await c.dispose();
  });
});

describe("the basis is the wake", () => {
  test("a t frame re-runs the pull at that fence", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).livePull(ada, shape));
    await settle();
    expect(live.seen).toHaveLength(1);

    state.t = 9;
    state.entity = { name: "Ada", age: 37 };
    peer.push({ op: "t", t: 9 });
    await settle();

    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual({ name: "Ada", age: 37 });
    expect(peer.frameOps("pull").map((f) => f.minT)).toEqual([undefined, 9]);

    await live.stop();
    await c.dispose();
  });

  test("a tick the projection did not notice is not an emission", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).livePull(ada, shape));
    await settle();
    expect(live.seen).toHaveLength(1);

    // the basis moves (some other write), the entity does not
    state.t = 9;
    peer.push({ op: "t", t: 9 });
    await settle();
    // ...so the pull re-ran at the new fence but nothing was re-emitted
    expect(peer.frameOps("pull").map((f) => f.minT)).toEqual([undefined, 9]);
    expect(live.seen).toHaveLength(1);

    // the next tick that changes the projection is news again
    state.t = 12;
    state.entity = { name: "Ada", age: 40 };
    peer.push({ op: "t", t: 12 });
    await settle();
    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual({ name: "Ada", age: 40 });

    await live.stop();
    await c.dispose();
  });

  test("retractEntity on the same connection emits null, and the stream keeps standing", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } as unknown, ackT: 30 };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const live = collect(db.livePull(ada, shape));
    await settle();
    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);

    // the local write bumps the basis; the entity is gone at the new fence
    state.t = 30;
    state.entity = null;
    await run(
      db.transact(function* (tx) {
        yield* tx.retractEntity(17);
      }),
    );
    await settle();

    // `null` is a legitimate emission, not an end
    expect(live.seen).toEqual([{ name: "Ada", age: 36 }, null]);
    expect(live.done).toBe(false);
    expect(peer.frameOps("pull").at(-1)?.minT).toBe(30);

    // ...and it stays null until something changes it back
    state.t = 42;
    state.entity = { name: "Ada", age: 36 };
    peer.push({ op: "t", t: 42 });
    await settle();
    expect(live.seen).toHaveLength(3);
    expect(live.seen[2]).toEqual({ name: "Ada", age: 36 });

    await live.stop();
    await c.dispose();
  });
});

describe("livePull survives the network like live", () => {
  test("a dropped socket reconnects in place and the stream keeps emitting", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } as unknown };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).livePull(ada, shape));
    await settle();
    expect(live.seen).toHaveLength(1);
    expect(peer.sockets).toHaveLength(1);

    state.entity = { name: "Ada", age: 37 };
    peer.drop();
    await settle(60);

    expect(peer.sockets).toHaveLength(2);
    expect(live.seen.at(-1)).toEqual({ name: "Ada", age: 37 });
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("Unauthorized re-reads the token and re-authenticates in place; the stream never sees it", async () => {
    let issued = 0;
    let refusals = 1;
    const state = {
      t: 5,
      entity: { name: "Ada", age: 36 },
      answer: (frame: Frame) => {
        if (frame.op === "auth") return { ok: true };
        if (frame.op === "pull" && refusals > 0) {
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
    const live = collect(c.ramose.db("movies", Movies).livePull(ada, shape));
    await settle();

    // the swap happened on the same socket, and the stream never saw it
    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.map((f) => f.op)).toEqual(["pull", "auth", "pull"]);
    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("a refusal that survives the fresh token fails the stream", async () => {
    const peer = peerAt({
      t: 5,
      entity: null,
      answer: () => ({ status: 401, body: { error: "no" } }),
    });
    const c = client(peer, { token: Effect.succeed(Redacted.make("stale")) });
    const live = collect(c.ramose.db("movies", Movies).livePull(ada, shape));
    await settle();

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("Unauthorized");
    await c.dispose();
  });
});

describe("a pinned view has no news", () => {
  test("livePull over asOf emits once and completes", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(
      c.ramose.db("movies", Movies).asOf(3).livePull(ada, shape),
    );
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("pull")[0].asOf).toBe(3);

    peer.push({ op: "t", t: 99 });
    await settle();
    expect(live.seen).toHaveLength(1);
    await c.dispose();
  });

  test("livePull over history emits once and completes", async () => {
    const state = { t: 5, entity: { name: "Ada", age: 36 } };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(
      c.ramose.db("movies", Movies).history.livePull(ada, shape),
    );
    await settle();

    expect(live.seen).toEqual([{ name: "Ada", age: 36 }]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("pull")[0].history).toBe(true);
    await c.dispose();
  });
});
