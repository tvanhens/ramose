/**
 * `db.principal()` — the session tells the client who it is.
 *
 * The peer resolves `sub → eid` at its end (one AVET lookup on the policy's
 * principal attribute), so the client never queries for its own entity:
 * `/info` carries `principal: { eid, class }` and the answer is cached per
 * session generation. `eid: null` (no row yet) is never cached — the row may
 * be written at any moment, and re-reading after that write is the point. An
 * in-place `auth` swap supersedes both: its ack names the new principal.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { client, fakePeer, httpsClient, redacted, settle } from "./peer.ts";

import { Movies, User } from "./db/fixture.ts";
import { query } from "../src/db/internal.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runFail = <A, E>(eff: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(eff));

const names = query(User).select({ name: User.name });

/** `/info` at a mutable principal; reads answer over the socket. */
const peerWith = (state: {
  principal: { eid: number | null; class: string } | undefined;
}) =>
  fakePeer({
    answer: () => ({ body: { t: 2, root: 2, result: [] } }),
    http: (call) =>
      call.method === "GET" && call.url.endsWith("/db/movies/info")
        ? {
            body: {
              db: "movies",
              t: 2,
              ...(state.principal === undefined
                ? {}
                : { principal: state.principal }),
            },
          }
        : { body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } },
  });

const infoCalls = (peer: { calls: { url: string; method: string }[] }) =>
  peer.calls.filter(
    (c) => c.method === "GET" && c.url.endsWith("/db/movies/info"),
  ).length;

describe("db.principal()", () => {
  test("one GET /db/:name/info, with the bearer; the eid is Eid-shaped data", async () => {
    const state = { principal: { eid: 7, class: "member" } as const };
    const peer = peerWith(state);
    const c = client(peer, { token: Effect.succeed(redacted("s3cret")) });
    const db = c.ramose.db("movies", Movies);

    expect(await run(db.principal())).toEqual({
      eid: { id: 7 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(1);
    expect(peer.calls[0]!.headers.authorization).toBe("Bearer s3cret");

    // a resolved entity is stable: the second ask is the cache
    expect(await run(db.principal())).toEqual({
      eid: { id: 7 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(1);

    await c.dispose();
  });

  test("eid: null is never cached — the ask after the row is written sees it", async () => {
    const state = {
      principal: { eid: null, class: "member" } as {
        eid: number | null;
        class: string;
      },
    };
    const peer = peerWith(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    expect(await run(db.principal())).toEqual({ eid: null, class: "member" });
    expect(await run(db.principal())).toEqual({ eid: null, class: "member" });
    expect(infoCalls(peer)).toBe(2); // no row yet: every ask goes to the peer

    // the row lands (an ensureSelf-style transact); the very next ask resolves
    state.principal = { eid: 9, class: "member" };
    expect(await run(db.principal())).toEqual({
      eid: { id: 9 },
      class: "member",
    });
    expect(await run(db.principal())).toEqual({
      eid: { id: 9 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(3); // …and is cached from then on

    await c.dispose();
  });

  test("a reconnect re-reads: the cache is per session generation", async () => {
    const state = { principal: { eid: 7, class: "member" } };
    const peer = peerWith(state);
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    await run(db.q(names)); // opens the socket: generation moves
    expect(await run(db.principal())).toEqual({
      eid: { id: 7 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(1);

    peer.drop(); // the socket dies; the token may differ on the next connect
    await settle();
    await run(db.q(names)); // reconnects
    expect(peer.sockets).toHaveLength(2);

    expect(await run(db.principal())).toEqual({
      eid: { id: 7 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(2);

    await c.dispose();
  });

  test("an in-place auth swap answers from its ack — no /info round trip", async () => {
    let refuse = true;
    const peer = fakePeer({
      answer: (frame) => {
        if (frame.op === "auth") {
          return { ok: true, principal: { eid: 21, class: "member" } };
        }
        if (refuse) {
          refuse = false;
          return { status: 401, body: { error: "token expired" } };
        }
        return { body: { t: 2, root: 2, result: [] } };
      },
    });
    const c = client(peer, { token: Effect.succeed(redacted("t")) });
    const db = c.ramose.db("movies", Movies);

    await run(db.q(names)); // 401 → auth frame → retried on the same socket
    expect(peer.frameOps("auth")).toHaveLength(1);

    expect(await run(db.principal())).toEqual({
      eid: { id: 21 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(0);

    await c.dispose();
  });

  test("a swap whose ack says { eid: null } voids what /info said before it", async () => {
    const state = {
      principal: { eid: 7, class: "member" } as {
        eid: number | null;
        class: string;
      },
    };
    let refuse = false;
    const peer = fakePeer({
      answer: (frame) => {
        if (frame.op === "auth") {
          return {
            ok: true,
            principal: { eid: null, class: "member" },
          };
        }
        if (refuse) {
          refuse = false;
          return { status: 401, body: { error: "token expired" } };
        }
        return { body: { t: 2, root: 2, result: [] } };
      },
      http: (call) =>
        call.method === "GET" && call.url.endsWith("/db/movies/info")
          ? { body: { db: "movies", t: 2, principal: state.principal } }
          : { body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } },
    });
    const c = client(peer, { token: Effect.succeed(redacted("t")) });
    const db = c.ramose.db("movies", Movies);

    await run(db.q(names));
    expect(await run(db.principal())).toEqual({
      eid: { id: 7 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(1);

    // the peer expires the principal; the next read swaps in place
    refuse = true;
    await run(db.q(names));
    expect(peer.frameOps("auth")).toHaveLength(1);

    // the old eid must not be served: the swapped principal has no row yet
    state.principal = { eid: null, class: "member" };
    expect(await run(db.principal())).toEqual({ eid: null, class: "member" });
    expect(infoCalls(peer)).toBe(2);

    // …until it does; the fresh answer is cached against this ack
    state.principal = { eid: 33, class: "member" };
    expect(await run(db.principal())).toEqual({
      eid: { id: 33 },
      class: "member",
    });
    expect(await run(db.principal())).toEqual({
      eid: { id: 33 },
      class: "member",
    });
    expect(infoCalls(peer)).toBe(3);

    await c.dispose();
  });

  test("an HTTPS-only client works the same way (no socket to generation-key on)", async () => {
    const state = { principal: { eid: 5, class: "admin" } };
    const peer = fakePeer({
      http: (call) =>
        call.method === "GET" && call.url.endsWith("/db/movies/info")
          ? { body: { db: "movies", t: 2, principal: state.principal } }
          : { body: { t: 2, txEid: 1, tempids: {}, datoms: 1 } },
    });
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);

    expect(await run(db.principal())).toEqual({
      eid: { id: 5 },
      class: "admin",
    });
    expect(await run(db.principal())).toEqual({
      eid: { id: 5 },
      class: "admin",
    });
    expect(infoCalls(peer)).toBe(1);

    close();
  });

  test("a peer that reports no principal is an InternalError, not a guess", async () => {
    const peer = peerWith({ principal: undefined });
    const c = client(peer);
    const e = await runFail(c.ramose.db("movies", Movies).principal());
    expect(e._tag).toBe("InternalError");
    await c.dispose();
  });

  test("a bad database name fails InvalidRequest without touching the wire", async () => {
    const peer = peerWith({ principal: { eid: 1, class: "member" } });
    const c = client(peer);
    const e = await runFail(c.ramose.db("no spaces", Movies).principal());
    expect(e._tag).toBe("InvalidRequest");
    expect(peer.calls).toHaveLength(0);
    await c.dispose();
  });
});
