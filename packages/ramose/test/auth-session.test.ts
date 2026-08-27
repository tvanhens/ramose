/**
 * The auth half of the socket.
 *
 * The first token rides the upgrade (a browser cannot set headers on a
 * WebSocket handshake), and `{ op: "auth", token }` swaps the principal on an
 * open socket. Nothing standing is torn down by a swap — that is the whole
 * point of the peer having an `auth` op, and it is what lets `db.live` keep
 * its stream across a token refresh.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { fromResponse } from "../src/db/Errors.ts";
import { pipe } from "effect/Function";
import { Query, seedWrite } from "../src/db/internal.ts";
import { client, scriptedPeer, until } from "./peer.ts";

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

const names = Query.q(() => pipe(Query.entities(User), Query.select({ name: User.name })));

describe("the credential on the wire", () => {
  test("the socket takes ?token=, the HTTPS write takes Authorization", async () => {
    const peer = scriptedPeer({
      http: () => ({ body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } }),
      answer: () => ({ body: { t: 2, root: 2, result: [] } }),
    });
    const c = client(peer, { token: Effect.succeed(Redacted.make("s3cret")) });
    const db = c.ramose.db("movies", Movies);

    await db.query(names);
    await run(seedWrite(db, function* (tx) { yield* tx.delete(1); }));

    expect(peer.sockets[0].url).toBe(
      "wss://peer.example.com/db/movies/session?token=s3cret",
    );
    // the upgrade is the only place the socket carries it — no auth frame
    expect(peer.frames.map((f) => f.op)).toEqual(["sync"]);
    expect(peer.calls[0].headers.authorization).toBe("Bearer s3cret");
    await c.dispose();
  });

  test("a 403 policy denial is Unauthorized with the attribute it tripped on", async () => {
    const peer = scriptedPeer({
      http: () => ({
        status: 403,
        body: { error: "Unauthorized", code: "policy", attr: ":doc/owner" },
      }),
    });
    const c = client(peer);
    const e = await runFail(seedWrite(
      c.ramose.db("movies", Movies), function* (tx) {
        yield* tx.delete(1);
      }),
    );
    expect(e._tag).toBe("Unauthorized");
    if (e._tag === "Unauthorized") {
      expect(e.code).toBe("policy");
      expect(e.attr).toBe(":doc/owner");
    }
    await c.dispose();
  });

  test("the same body classified straight off the HTTP path agrees", () => {
    const e = fromResponse(403, {
      error: "Unauthorized",
      code: "policy",
      attr: ":doc/owner",
    });
    expect(e._tag).toBe("Unauthorized");
    if (e._tag === "Unauthorized") {
      expect(e.code).toBe("policy");
      expect(e.attr).toBe(":doc/owner");
    }
    // an auth failure with no policy detail carries neither key
    const bare = fromResponse(401, { error: "no token" });
    expect(bare._tag).toBe("Unauthorized");
    if (bare._tag === "Unauthorized") {
      expect(bare.code).toBeUndefined();
      expect(bare.attr).toBeUndefined();
    }
  });
});

describe("a token swap is not a reconnect", () => {
  test("db.live keeps its stream and socket across an overlay tx; asOf still re-auths in place", async () => {
    const { catalogWorld, snapshotOf, txSnap } = await import("./overlay-seed.ts");
    const conn = await catalogWorld(Movies);
    await conn.transact([{ ":ramose/type": ":user", ":user/name": "Ada" }]);
    const snap = await snapshotOf(conn);
    let issued = 0;
    let refuse = false;
    const peer = scriptedPeer({
      answer: (frame) => {
        if (frame.op === "auth") return { ok: true };
        if (frame.op === "sync") {
          return { body: { t: snap.t, datoms: snap.datoms } };
        }
        if (refuse) {
          refuse = false;
          return { status: 401, body: { error: "token expired" } };
        }
        return { body: { t: 5, root: 5, result: [[{ name: "Ada" }], [{ name: "Bob" }]] } };
      },
    });
    const c = client(peer, {
      token: Effect.sync(() => Redacted.make(`token-${++issued}`)),
    });

    const seen: unknown[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(c.ramose.db("movies", Movies).effect.live(names), (rows) =>
        Effect.sync(() => {
          seen.push(rows);
        }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => Cause.squash(cause)))),
    );
    await until(() => seen.length >= 1);
    expect(seen).toEqual([[{ name: "Ada" }]]);

    const bob = txSnap(await conn.transact([{ ":ramose/type": ":user", ":user/name": "Bob" }]));
    peer.push({ op: "tx", t: bob.t, datoms: bob.datoms });
    await until(() => seen.length >= 2);
    expect(seen.at(-1)).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.sockets).toHaveLength(1);

    refuse = true;
    expect(
      await run(c.ramose.db("movies", Movies).asOf(5).query(names)),
    ).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.filter((f) => f.op === "auth")).toHaveLength(1);
    expect(peer.frames.find((f) => f.op === "auth")!.token).toBe("token-2");

    await Effect.runPromise(Fiber.interrupt(fiber));
    await c.dispose();
  });
});
