/**
 * `db.live` — a standing `db.q` as a `Stream`.
 *
 * The two terminals share one builder callback, so everything `q` can express
 * `live` can too. What is specific to `live` is time: it re-runs when the
 * session's basis moves (a `{ op: "t" }` tick, or a local `transact`), it
 * reconnects in place rather than failing, it fails only on the terminal
 * refusals, and over a pinned view it emits once and completes.
 *
 * Its requirements channel is `never`: teardown is fiber interruption, and
 * there is no `Scope` in the type.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { query } from "../src/db/internal.ts";
import { client, fakePeer, settle, type Frame, type Reply } from "./peer.ts";

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

/** The wire query `names` lowers to: one find-pull, the namespace scope. */
const namesWire = {
  find: [
    ["pull", "?e", [{ kind: "attr", attr: ":user/name", reverse: false, as: "name" }]],
  ],
  where: [
    [
      "or",
      ["?e", ":user/name", "_"],
      ["?e", ":user/age", "_"],
      ["?e", ":user/friends", "_"],
      ["?e", ":user/bestFriend", "_"],
    ],
    // `name` is not `.optional`: the required field is the peer's to enforce
    ["?e", ":user/name", "_"],
  ],
};

/** One find-pull row, as the peer sends it. */
const row = (name: string) => [{ name }];

/** A peer whose relation and basis the test moves under it. */
const peerAt = (state: {
  t: number;
  rows: unknown[][];
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
      return { body: { t: state.t, root: state.t, result: state.rows } };
    },
  });

describe("q and live are two terminals over one query", () => {
  test("the same query value runs once, or stands up", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    expect(await run(db.q(names))).toEqual([{ name: "Ada" }]);
    const live = collect(db.live(names));
    await settle();
    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(peer.frameOps("q").map((f) => f.query)).toEqual([
      namesWire,
      namesWire,
    ]);

    await live.stop();
    await c.dispose();
  });

  test("the pull rides in the query: one op, and the rows are the peer's", async () => {
    const state = { t: 5, rows: [row("Ada"), row("Cy")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();

    // exactly what the peer sent, reshaped — the client drops nothing
    expect(live.seen[0]).toEqual([{ name: "Ada" }, { name: "Cy" }]);
    // one op for the whole pass — no client-side N+1
    expect(peer.frameOps("pull")).toHaveLength(0);
    expect(peer.frameOps("q")).toHaveLength(1);

    await live.stop();
    await c.dispose();
  });
});

describe("the basis is the wake", () => {
  test("a t frame re-runs the query at that fence", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();
    expect(live.seen).toHaveLength(1);

    state.t = 9;
    state.rows = [row("Ada"), row("Bob")];
    peer.push({ op: "t", t: 9 });
    await settle();

    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.frameOps("q").map((f) => f.minT)).toEqual([undefined, 9]);

    await live.stop();
    await c.dispose();
  });

  test("a tick the rows did not notice is not an emission", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();
    expect(live.seen).toHaveLength(1);

    // the basis moves (some other write), the relation does not
    state.t = 9;
    peer.push({ op: "t", t: 9 });
    await settle();
    // ...so the query re-ran at the new fence but nothing was re-emitted
    expect(peer.frameOps("q").map((f) => f.minT)).toEqual([undefined, 9]);
    expect(live.seen).toHaveLength(1);

    // the next tick that changes the rows is news again
    state.t = 12;
    state.rows = [row("Ada"), row("Bob")];
    peer.push({ op: "t", t: 12 });
    await settle();
    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual([{ name: "Ada" }, { name: "Bob" }]);

    await live.stop();
    await c.dispose();
  });

  test("a local transact bumps the basis, so a standing live re-runs", async () => {
    const state = { t: 5, rows: [row("Ada")], ackT: 30 };
    const peer = peerAt(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);
    const live = collect(db.live(names));
    await settle();
    expect(live.seen).toHaveLength(1);

    state.t = 30;
    state.rows = [row("Ada"), row("Bob")];
    await run(
      db.transact(function* (tx) {
        const bob = yield* tx.entity();
        yield* bob.add(User.name, "Bob");
      }),
    );
    await settle();

    // no invalidation call: the write's own ack carried the new basis
    expect(live.seen).toHaveLength(2);
    expect(live.seen[1]).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.frameOps("q").at(-1)?.minT).toBe(30);

    await live.stop();
    await c.dispose();
  });

  test("interrupting the fiber is the whole teardown", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();
    const frames = peer.frames.length;

    await live.stop();
    peer.push({ op: "t", t: 9 });
    await settle();

    expect(peer.frames).toHaveLength(frames);
    expect(live.seen).toHaveLength(1);
    await c.dispose();
  });
});

describe("live survives the network", () => {
  test("a dropped socket reconnects in place and the stream keeps emitting", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();
    expect(live.seen).toHaveLength(1);
    expect(peer.sockets).toHaveLength(1);

    state.rows = [row("Ada"), row("Bob")];
    peer.drop();
    await settle(60);

    expect(peer.sockets).toHaveLength(2);
    expect(live.seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("a 5xx is retried with backoff, not surfaced", async () => {
    let failures = 1;
    const state = {
      t: 5,
      rows: [row("Ada")],
      answer: (frame: Frame) => {
        if (frame.op !== "q" || failures === 0) return undefined;
        failures -= 1;
        return { status: 500, body: { error: "the replica is having a moment" } };
      },
    };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));

    await settle();
    expect(live.seen).toHaveLength(0);
    expect(live.error).toBeUndefined();

    await settle(400); // the first backoff is 250ms
    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("Unauthorized re-reads the token and reconnects; a second refusal is terminal", async () => {
    let issued = 0;
    let refusals = 1;
    const state = {
      t: 5,
      rows: [row("Ada")],
      answer: (frame: Frame) => {
        if (frame.op === "auth") return { ok: true };
        if (frame.op === "q" && refusals > 0) {
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

    // the swap happened on the same socket, and the stream never saw it
    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.map((f) => f.op)).toEqual(["q", "auth", "q"]);
    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(live.error).toBeUndefined();

    await live.stop();
    await c.dispose();
  });

  test("a refusal that survives the fresh token fails the stream", async () => {
    const peer = peerAt({
      t: 5,
      rows: [],
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
      rows: [],
      answer: () => ({ status: 400, body: { error: "unknown attribute" } }),
    });
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).live(names));
    await settle();

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("InvalidRequest");
    expect(peer.frameOps("q")).toHaveLength(1);
    await c.dispose();
  });
});

describe("a pinned view has no news", () => {
  test("live over asOf emits once and completes", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).asOf(3).live(names));
    await settle();

    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    expect(live.done).toBe(true);
    expect(peer.frameOps("q")[0].asOf).toBe(3);

    peer.push({ op: "t", t: 99 });
    await settle();
    expect(live.seen).toHaveLength(1);
    await c.dispose();
  });

  test("live over history emits once and completes", async () => {
    const state = { t: 5, rows: [row("Ada")] };
    const peer = peerAt(state);
    const c = client(peer);
    const live = collect(c.ramose.db("movies", Movies).history.live(names));
    await settle();

    expect(live.seen).toHaveLength(1);
    expect(live.done).toBe(true);
    expect(peer.frameOps("q")[0].history).toBe(true);
    await c.dispose();
  });
});
