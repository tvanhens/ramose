/**
 * `Ramose.token` — the shipped token sources.
 *
 * `token.jwt(mint)` turns "here is how to fetch a JWT" into the `token`
 * Effect the layer re-reads on every (re)connect and every `/transact`:
 * minted lazily, cached, single-flight, re-minted inside a margin of the
 * payload's `exp`. Failure typing is the contract that matters — a thrown
 * mint is `NetworkError` (transient, `live` retries), a thrown `DbError`
 * passes through (an `Unauthorized` mint fails `live` terminally).
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import { layer, Query, seedWrite, token, Unauthorized } from "../src/db/internal.ts";
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

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned compact JWT — the source decodes, it never verifies. */
const jwtOf = (claims: Record<string, unknown>): string =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;

/** A `Date.now` epoch round in seconds, so `exp * 1000` math is exact. */
const BASE = 1_700_000_000_000;

const read = (source: { token: () => Promise<string> }) => source.token();

describe("token.jwt mints lazily and caches", () => {
  test("nothing is minted until the first read, and one mint serves many", async () => {
    let mints = 0;
    const jwt = jwtOf({ exp: Math.floor((Date.now() + 3_600_000) / 1000) });
    const source = token.jwt(async () => {
      mints += 1;
      return jwt;
    });
    const peer = scriptedPeer();
    const c = client(peer, { token: source });
    const db = c.ramose.db("movies", Movies);

    // building the source, the layer and the db minted nothing
    expect(mints).toBe(0);

    await run(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );
    expect(mints).toBe(1);
    expect(peer.calls[0]!.headers.authorization).toBe(`Bearer ${jwt}`);

    await run(
      seedWrite(db, function* (tx) {
        const bob = yield* tx.entity();
        yield* bob.set(User.name, "Bob");
      }),
    );
    // the second transact re-read the Effect, and the cache answered
    expect(mints).toBe(1);
    expect(peer.calls[1]!.headers.authorization).toBe(`Bearer ${jwt}`);

    await c.dispose();
  });

  test("mint may resolve to the route's body: { token } passes through", async () => {
    const jwt = jwtOf({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      ramose: { db: "acme", class: "member" },
    });
    // what reef's /api/ramose-token actually returns
    const source = token.jwt(async () => ({
      token: jwt,
      class: "member",
      exp: 0,
    }));

    expect(await read(source)).toBe(jwt);
    // the claims come from the JWT payload, not the body's side channel
    expect((await source.claims()).ramose?.class).toBe("member");
  });

  test("concurrent readers share one in-flight mint", async () => {
    let mints = 0;
    const source = token.jwt(async () => {
      mints += 1;
      await Bun.sleep(20);
      return jwtOf({ exp: Math.floor((Date.now() + 3_600_000) / 1000) });
    });

    // a reconnect and a transact at once, in miniature
    const [a, b] = await Promise.all([read(source), read(source)]);
    expect(mints).toBe(1);
    expect(a).toBe(b);
  });
});

describe("token.jwt refreshes on the payload's exp", () => {
  test("a read inside the margin re-mints; outside it the cache answers", async () => {
    try {
      setSystemTime(new Date(BASE));
      let mints = 0;
      // ten-minute token, default two-minute margin: refresh at +8 minutes
      const source = token.jwt(async () => {
        mints += 1;
        return jwtOf({ exp: (BASE + 600_000) / 1000 + mints });
      });

      await read(source);
      expect(mints).toBe(1);

      setSystemTime(new Date(BASE + 479_000));
      await read(source);
      expect(mints).toBe(1);

      setSystemTime(new Date(BASE + 481_000));
      await read(source);
      expect(mints).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("a lifetime shorter than the margin refreshes at half-life, not per read", async () => {
    try {
      setSystemTime(new Date(BASE));
      let mints = 0;
      // one-minute token against a two-minute margin: refresh at +30s
      const source = token.jwt(async () => {
        mints += 1;
        return jwtOf({ exp: (BASE + 60_000) / 1000 + 60 * (mints - 1) });
      });

      await read(source);
      await read(source);
      expect(mints).toBe(1);

      setSystemTime(new Date(BASE + 29_000));
      await read(source);
      expect(mints).toBe(1);

      setSystemTime(new Date(BASE + 31_000));
      await read(source);
      expect(mints).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("refreshMargin is the caller's knob", async () => {
    try {
      setSystemTime(new Date(BASE));
      let mints = 0;
      // ten-minute token, five-minute margin: refresh at +5 minutes
      const source = token.jwt(
        async () => {
          mints += 1;
          return jwtOf({ exp: (BASE + 600_000) / 1000 + mints });
        },
        { refreshMarginMs: 5 * 60 * 1000 },
      );

      await read(source);
      setSystemTime(new Date(BASE + 299_000));
      await read(source);
      expect(mints).toBe(1);

      setSystemTime(new Date(BASE + 301_000));
      await read(source);
      expect(mints).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("a payload with no exp is static until invalidate()", async () => {
    try {
      setSystemTime(new Date(BASE));
      let mints = 0;
      const source = token.jwt(async () => {
        mints += 1;
        return jwtOf({ sub: "user_1" });
      });

      await read(source);
      setSystemTime(new Date(BASE + 365 * 24 * 3_600_000));
      await read(source);
      expect(mints).toBe(1);

      source.invalidate();
      await read(source);
      expect(mints).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("invalidate() drops the cache: the next read mints", async () => {
    let mints = 0;
    const source = token.jwt(async () => {
      mints += 1;
      return jwtOf({
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
        n: mints,
      });
    });

    const first = await read(source);
    expect(mints).toBe(1);

    source.invalidate();
    const second = await read(source);
    expect(mints).toBe(2);
    expect(second).not.toBe(first);
  });

  test("invalidate() during an in-flight mint keeps that result out of the cache", async () => {
    let mints = 0;
    const source = token.jwt(async () => {
      mints += 1;
      await Bun.sleep(20);
      return jwtOf({
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
        n: mints,
      });
    });

    // the old tenant's mint is in flight when the tenant switches
    const inflight = read(source);
    source.invalidate();
    await inflight;

    // the settled mint did not resurrect into the cache: the next read mints
    await read(source);
    expect(mints).toBe(2);
  });
});

describe("claims() is the decoded payload, UI hints only", () => {
  test("decodes ramose.class, and its mint is the same cache", async () => {
    let mints = 0;
    const source = token.jwt(async () => {
      mints += 1;
      return jwtOf({
        sub: "user_01HQ8ZK",
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
        ramose: { db: "acme", class: "member" },
      });
    });

    expect(source.peek()).toBeUndefined();
    const claims = await source.claims();
    expect(claims.ramose?.class).toBe("member");
    expect(claims.sub).toBe("user_01HQ8ZK");
    expect(mints).toBe(1);
    expect(source.peek()?.ramose?.class).toBe("member");

    // the token read reuses what claims() minted
    await read(source);
    expect(mints).toBe(1);
  });

  test("token.static carries a fixed credential, decoded when it is a JWT", async () => {
    const jwt = jwtOf({ ramose: { db: "acme", class: "admin" } });
    const source = token.static(jwt);
    expect(await read(source)).toBe(jwt);
    expect((await source.claims()).ramose?.class).toBe("admin");
    expect(source.peek()?.ramose?.class).toBe("admin");

    // not a JWT: no claims, but the credential still flows
    const opaque = token.static("s3cret");
    expect(await read(opaque)).toBe("s3cret");
    expect(await opaque.claims()).toEqual({});
    expect(opaque.peek()).toEqual({});
    opaque.invalidate(); // a no-op, not an error
    expect(await read(opaque)).toBe("s3cret");
  });
});

describe("failure typing on the wire", () => {
  test("a throwing mint surfaces as NetworkError on transact", async () => {
    const source = token.jwt(async () => {
      throw new Error("the auth endpoint is down");
    });
    const peer = scriptedPeer();
    const c = client(peer, { token: source });
    const db = c.ramose.db("movies", Movies);

    const error = await runFail(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );
    expect((error as { _tag?: string })._tag).toBe("NetworkError");
    expect(String((error as { message: string }).message)).toContain(
      "the auth endpoint is down",
    );
    // the mint failed before the wire: nothing reached the peer
    expect(peer.calls).toHaveLength(0);

    await c.dispose();
  });

  test("a mint that throws Unauthorized fails transact with that tag", async () => {
    const source = token.jwt(async () => {
      throw new Unauthorized({ message: "session revoked" });
    });
    const peer = scriptedPeer();
    const c = client(peer, { token: source });
    const db = c.ramose.db("movies", Movies);

    const error = await runFail(
      seedWrite(db, function* (tx) {
        const ada = yield* tx.entity();
        yield* ada.set(User.name, "Ada");
      }),
    );
    // the DbError passes through untouched — no NetworkError wrapping
    expect((error as { _tag?: string })._tag).toBe("Unauthorized");
    expect(peer.calls).toHaveLength(0);

    await c.dispose();
  });

  test("live retries a throwing mint as it does any NetworkError", async () => {
    let failures = 1;
    const source = token.jwt(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mint hiccup");
      }
      return jwtOf({ exp: Math.floor((Date.now() + 3_600_000) / 1000) });
    });
    const { catalogWorld, snapshotOf } = await import("./overlay-seed.ts");
    const world = await catalogWorld(Movies);
    await world.transact([{ ":user/name": "Ada" }]);
    const snap = await snapshotOf(world);
    const peer = scriptedPeer({
      answer: (frame) =>
        frame.op === "sync"
          ? { body: { t: snap.t, datoms: snap.datoms } }
          : { body: { t: 5, result: [[{ name: "Ada" }]] } },
    });
    const c = client(peer, { token: source });
    const live = collect(c.ramose.db("movies", Movies).effect.live(names));

    // the wire's transient ladder retries the failed connect in place
    await until(() => live.seen.length >= 1);
    expect(live.error).toBeUndefined();
    expect(live.seen).toEqual([[{ name: "Ada" }]]);
    // the fresh mint authenticated the (re)connect
    expect(peer.socket.url).toContain("token=");

    await live.stop();
    await c.dispose();
  });

  test("a mint that throws Unauthorized fails live terminally", async () => {
    const source = token.jwt(async () => {
      throw new Unauthorized({ message: "session revoked" });
    });
    const peer = scriptedPeer();
    const c = client(peer, { token: source });
    const live = collect(c.ramose.db("movies", Movies).effect.live(names));
    await until(() => live.done);

    expect(live.done).toBe(true);
    expect((live.error as { _tag?: string })?._tag).toBe("Unauthorized");
    expect((live.error as { message?: string })?.message).toBe(
      "session revoked",
    );
    // terminal before any socket existed
    expect(peer.sockets).toHaveLength(0);
    await c.dispose();
  });
});

describe("both token forms typecheck on the layer", () => {
  test("a TokenSource and a bare Effect are both hatch tokens", () => {
    const source = token.jwt(async () => "jwt");
    // the layers are values; building them opens nothing
    const viaSource = layer({ url: "https://peer.example.com", token: source });
    const viaEffect = layer({
      url: "https://peer.example.com",
      token: Effect.succeed(Redacted.make("x")),
    });
    expect(viaSource).toBeDefined();
    expect(viaEffect).toBeDefined();
  });
});
