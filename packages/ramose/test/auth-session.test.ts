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
import { query } from "../src/db/internal.ts";
import { client, fakePeer, settle } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runFail = <A, E>(eff: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(eff));

const names = query(User).select({ name: User.name });

describe("the credential on the wire", () => {
  test("the socket takes ?token=, the HTTPS write takes Authorization", async () => {
    const peer = fakePeer({
      http: () => ({ body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } }),
      answer: () => ({ body: { t: 2, root: 2, result: [] } }),
    });
    const c = client(peer, { token: Effect.succeed(Redacted.make("s3cret")) });
    const db = c.ramose.db("movies", Movies);

    await run(db.q(names));
    await run(db.transact(function* (tx) { yield* tx.retractEntity(1); }));

    expect(peer.sockets[0].url).toBe(
      "wss://peer.example.com/db/movies/session?token=s3cret",
    );
    // the upgrade is the only place the socket carries it — no auth frame
    expect(peer.frames.map((f) => f.op)).toEqual(["q"]);
    expect(peer.calls[0].headers.authorization).toBe("Bearer s3cret");
    await c.dispose();
  });

  test("a 403 policy denial is Unauthorized with the attribute it tripped on", async () => {
    const peer = fakePeer({
      http: () => ({
        status: 403,
        body: { error: "Unauthorized", code: "policy", attr: ":doc/owner" },
      }),
    });
    const c = client(peer);
    const e = await runFail(
      c.ramose.db("movies", Movies).transact(function* (tx) {
        yield* tx.retractEntity(1);
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
  test("db.live keeps its stream, its socket and its rows across the swap", async () => {
    const state = { t: 2, rows: [[{ name: "Ada" }]] as unknown[][] };
    let issued = 0;
    let refuse = false;
    const peer = fakePeer({
      answer: (frame) => {
        if (frame.op === "auth") return { ok: true };
        if (refuse) {
          refuse = false;
          return { status: 401, body: { error: "token expired" } };
        }
        return { body: { t: state.t, root: state.t, result: state.rows } };
      },
    });
    const c = client(peer, {
      token: Effect.sync(() => Redacted.make(`token-${++issued}`)),
    });

    const seen: unknown[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(c.ramose.db("movies", Movies).live(names), (rows) =>
        Effect.sync(() => {
          seen.push(rows);
        }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => Cause.squash(cause)))),
    );
    await settle();
    expect(seen).toEqual([[{ name: "Ada" }]]);

    // the peer expires the principal mid-flight; the next pass re-reads and swaps
    refuse = true;
    state.t = 5;
    state.rows = [[{ name: "Ada" }], [{ name: "Bob" }]];
    peer.push({ op: "t", t: 5 });
    await settle();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([{ name: "Ada" }, { name: "Bob" }]);
    // one socket throughout: the swap is a frame, not a reconnect
    expect(peer.sockets).toHaveLength(1);
    expect(peer.frames.map((f) => f.op)).toEqual(["q", "q", "auth", "q"]);
    expect(peer.frames[2].token).toBe("token-2");

    await Effect.runPromise(Fiber.interrupt(fiber));
    await c.dispose();
  });
});
