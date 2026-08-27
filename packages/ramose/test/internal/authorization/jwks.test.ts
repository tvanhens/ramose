/**
 * JWKS loader: local JSON, remote HTTP, rotation, TTL, bounds, cancel.
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { AUD, ISS, JWKS, PUBLIC_JWK } from "../../../../../test/local/auth-keys.ts";
import { AuthenticationAdmission } from "../../../src/internal/authorization/runtime/authentication.ts";
import { JwksUnavailable } from "../../../src/internal/authorization/runtime/failures.ts";
import {
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_REFRESH_COOLDOWN_MS,
  JWKS_RETIRED_GRACE_MS,
  Jwks,
  fingerprintOf,
} from "../../../src/internal/authorization/runtime/jwks.ts";
import {
  authenticationLayer,
  jwksLayer,
  localAuthenticationLayer,
} from "../../../src/internal/authorization/runtime/layer.ts";
import { signToken } from "../../sign-local-token.ts";

const leak = (value: unknown): string => {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v;
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return undefined;
    seen.add(v);
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return JSON.stringify(walk(value));
};

const withClock = <A>(layer: Layer.Layer<A>) => Layer.mergeAll(layer, TestClock.layer());

const admit = (env: object, database: string, token: string) =>
  Effect.gen(function* () {
    // Default-signed tokens use wall-clock iat; TestClock starts at epoch 0.
    yield* TestClock.setTime(Date.now());
    const admission = yield* AuthenticationAdmission;
    return yield* admission.admit({
      database,
      token: Redacted.make(token),
      route: "http",
    });
  }).pipe(Effect.provide(withClock(authenticationLayer(env as never))));

const jwk = (kid: string) => ({ ...PUBLIC_JWK, kid });

const NEXT_PRIVATE_JWK = {
  crv: "P-256",
  d: "EEDGOYpwRiWfCDUXczEF4lxuS7rQ0kw81o_4RrQ6DsU",
  kty: "EC",
  x: "55dblMdJ4FYrk0jrIw8xq740BpsO3SOJICt7ngaJFRA",
  y: "_muRPmbAkbysyAfSF2LuUThtKG2_46yuqsAkT6Hrb7k",
} as const;

const NEXT_PUBLIC_JWK = {
  crv: "P-256",
  kty: "EC",
  x: NEXT_PRIVATE_JWK.x,
  y: NEXT_PRIVATE_JWK.y,
  alg: "ES256",
  kid: "test",
} as const;

describe("Jwks", () => {
  test("local JWKS JSON works", async () => {
    const token = await signToken("acme", "member");
    const admitted = await Effect.runPromise(
      admit({ RAMOSE_JWKS_JSON: JWKS, RAMOSE_JWT_ISS: ISS, RAMOSE_JWT_AUD: AUD }, "acme", token),
    );
    expect(admitted.principal.subject).toBe("user_ada");
  });

  test("remote JWKS via Bun.serve", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const token = await signToken("acme", "member");
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const admitted = await Effect.runPromise(admit(env, "acme", token));
      expect(admitted.principal.database).toBe("acme");
      expect(fetches).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("rotation: unknown kid refetches; old kid still works if published", async () => {
    let keys: object[] = [jwk("test")];
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const oldTok = await signToken("acme", "member", "user_ada", undefined, { kid: "test" });
      const nextTok = await signToken("acme", "member", "user_ada", undefined, { kid: "next" });
      // Same-admit skip treats now === generation.at as "just loaded". Advance
      // the clock so this is a cache-hit + new kid (generation.at is in the past).
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          yield* tryAdmit(oldTok);
          expect(fetches).toBe(1);

          yield* TestClock.adjust(1);
          keys = [jwk("test"), jwk("next")];
          const rotated = yield* tryAdmit(nextTok);
          expect(rotated.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);

          const still = yield* tryAdmit(oldTok);
          expect(still.principal.subject).toBe("user_ada");
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("concurrent cold keySet coalesces to one remote fetch", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const env = { RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks` };
      await Effect.runPromise(
        Effect.gen(function* () {
          const jwks = yield* Jwks;
          yield* Effect.all(
            Array.from({ length: 10 }, () => jwks.keySet),
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.provide(withClock(jwksLayer(env)))),
      );
      expect(fetches).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("concurrent unknown-kid admits on a warm cache refresh at most once", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const good = await signToken("acme", "member", "user_ada", undefined, { kid: "test" });
      const unknowns = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          signToken("acme", "member", "user_ada", undefined, { kid: `rand-${i}` }),
        ),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          yield* admission.admit({
            database: "acme",
            token: Redacted.make(good),
            route: "http",
          });
          expect(fetches).toBe(1);

          // Cache-hit + new kid: generation.at must be older than this admit.
          yield* TestClock.adjust(1);
          yield* Effect.all(
            unknowns.map((tok) =>
              Effect.flip(
                admission.admit({
                  database: "acme",
                  token: Redacted.make(tok),
                  route: "http",
                }),
              ),
            ),
            { concurrency: "unbounded" },
          );
          expect(fetches).toBe(2);
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("cold unknown-kid single admit fetches once, not twice", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const unknown = await signToken("acme", "member", "user_ada", undefined, { kid: "missing" });
      const failed = await Effect.runPromise(Effect.flip(admit(env, "acme", unknown)));
      expect(failed._tag === "AuthenticationRejected" || failed._tag === "JwksUnavailable").toBe(true);
      expect(fetches).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("network failure → JwksUnavailable / admit reject; no JWKS or token", async () => {
    const token = await signToken("acme", "member");
    const refused = await Effect.runPromise(
      Effect.flip(
        admit(
          {
            RAMOSE_JWKS_URL: "http://127.0.0.1:1/jwks",
            RAMOSE_JWT_ISS: ISS,
            RAMOSE_JWT_AUD: AUD,
          },
          "acme",
          token,
        ),
      ),
    );
    expect(refused._tag === "JwksUnavailable" || refused._tag === "AuthenticationRejected").toBe(true);
    const dumped = leak(refused);
    expect(dumped).not.toContain(token);
    expect(JSON.stringify(refused)).not.toContain(token);
    expect(JSON.stringify(refused)).not.toContain("keys");

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 500 }),
    });
    try {
      const boom = await Effect.runPromise(
        Effect.flip(
          admit(
            {
              RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
              RAMOSE_JWT_ISS: ISS,
              RAMOSE_JWT_AUD: AUD,
            },
            "acme",
            token,
          ),
        ),
      );
      expect(boom).toBeInstanceOf(JwksUnavailable);
      expect(JSON.stringify(boom)).not.toContain(token);
      expect(boom.message).toBe("jwks");
    } finally {
      server.stop(true);
    }
  });

  test("silent issuer times out JWKS fetch as JwksUnavailable without leaking the token", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        started();
        await Bun.sleep(10_000);
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    const token = await signToken("acme", "member");
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const startedAt = performance.now();
      const failed = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.gen(function* () {
              const admission = yield* AuthenticationAdmission;
              return yield* admission.admit({
                database: "acme",
                token: Redacted.make(token),
                route: "http",
              });
            }),
          );
          yield* Effect.promise(() => startedP);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(`${JWKS_FETCH_TIMEOUT_MS} millis`);
          return yield* Effect.flip(Fiber.join(fiber));
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(failed).toBeInstanceOf(JwksUnavailable);
      expect(failed.message).toBe("jwks");
      const dumped = leak(failed);
      expect(dumped).not.toContain(token);
      expect(dumped).not.toContain("cancelled");
    } finally {
      server.stop(true);
    }
  });

  test("unknown-kid JWKS refresh is cooled down; rotation still works after cooldown", async () => {
    let keys: object[] = [jwk("test")];
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const good = await signToken("acme", "member", "user_ada", undefined, { kid: "test" });
      const unknownA = await signToken("acme", "member", "user_ada", undefined, { kid: "rand-a" });
      const unknownB = await signToken("acme", "member", "user_ada", undefined, { kid: "rand-b" });
      const nextTok = await signToken("acme", "member", "user_ada", undefined, { kid: "next" });

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          yield* tryAdmit(good);
          expect(fetches).toBe(1);

          // First kid-miss on a cache-hit: generation.at is in the past so
          // refresh is allowed once (same-instant skip does not apply).
          yield* TestClock.adjust(1);
          const firstMiss = yield* Effect.flip(tryAdmit(unknownA));
          expect(firstMiss._tag === "AuthenticationRejected" || firstMiss._tag === "JwksUnavailable").toBe(
            true,
          );
          expect(fetches).toBe(2);

          const secondMiss = yield* Effect.flip(tryAdmit(unknownB));
          expect(secondMiss.message).toBe("jwks");
          expect(fetches).toBe(2);

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          keys = [jwk("test"), jwk("next")];
          const rotated = yield* tryAdmit(nextTok);
          expect(rotated.principal.subject).toBe("user_ada");
          expect(fetches).toBe(3);
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("cancellation aborts the JWKS fetch without leaking the token", async () => {
    let clientSignal: AbortSignal | null | undefined;
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        started();
        await Bun.sleep(10_000);
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    const token = await signToken("acme", "member");
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWKS_SERVICE: "JWKS",
        JWKS: {
          fetch: (input: string | Request, init?: RequestInit) => {
            clientSignal = init?.signal;
            return fetch(input, init);
          },
        },
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(admit(env, "acme", token));
          yield* Effect.promise(() => startedP);
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause) || Cause.hasFails(exit.cause)).toBe(true);
      }
      expect(clientSignal).toBeDefined();
      expect(clientSignal?.aborted).toBe(true);
      const dumped = leak(exit);
      expect(dumped).not.toContain(token);
      expect(dumped).not.toContain(JWKS);
    } finally {
      server.stop(true);
    }
  });

  test("cache TTL via TestClock refetches after TTL", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const env = { RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks` };
      const load = Effect.gen(function* () {
        const jwks = yield* Jwks;
        return yield* jwks.keySet;
      }).pipe(Effect.provide(withClock(jwksLayer(env))));

      await Effect.runPromise(load);
      expect(fetches).toBe(1);
      await Effect.runPromise(load);
      expect(fetches).toBe(1);

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.adjust("5 minutes");
          const jwks = yield* Jwks;
          return yield* jwks.keySet;
        }).pipe(Effect.provide(withClock(jwksLayer(env)))),
      );
      expect(fetches).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("unchanged JWKS refetch does not evict the previous distinct generation", async () => {
    let keys: object[] = [jwk("a")];
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const issued = Math.floor(Date.now() / 1000);
      const tok = (name: string) =>
        signToken("acme", "member", "user_ada", undefined, {
          kid: name,
          iat: issued,
          exp: issued + 100,
        });
      const tokenA = await tok("a");
      const tokenB = await tok("b");
      const unknown = await tok("missing");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          const first = yield* tryAdmit(tokenA);
          expect(first.principal.subject).toBe("user_ada");
          expect(fetches).toBe(1);

          yield* TestClock.adjust(1);
          keys = [jwk("b")];
          const rotated = yield* tryAdmit(tokenB);
          expect(rotated.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);

          const stillA = yield* tryAdmit(tokenA);
          expect(stillA.principal.subject).toBe("user_ada");

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          const miss = yield* Effect.flip(tryAdmit(unknown));
          expect(miss._tag === "AuthenticationRejected" || miss._tag === "JwksUnavailable").toBe(true);
          expect(fetches).toBe(3);

          const keptA = yield* tryAdmit(tokenA);
          const keptB = yield* tryAdmit(tokenB);
          expect(keptA.principal.subject).toBe("user_ada");
          expect(keptB.principal.subject).toBe("user_ada");
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("retired generation stays trusted for a bounded grace, then is dropped", async () => {
    let keys: object[] = [jwk("a")];
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const issued = Math.floor(Date.now() / 1000);
      const tok = (name: string) =>
        signToken("acme", "member", "user_ada", undefined, {
          kid: name,
          iat: issued,
          exp: issued + 600,
        });
      const tokenA = await tok("a");
      const tokenB = await tok("b");
      const unknown = await tok("missing");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          yield* tryAdmit(tokenA);
          expect(fetches).toBe(1);

          yield* TestClock.adjust(1);
          keys = [jwk("b")];
          const rotated = yield* tryAdmit(tokenB);
          expect(rotated.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);

          const stillA = yield* tryAdmit(tokenA);
          expect(stillA.principal.subject).toBe("user_ada");

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          const miss = yield* Effect.flip(tryAdmit(unknown));
          expect(miss._tag === "AuthenticationRejected" || miss._tag === "JwksUnavailable").toBe(true);
          expect(fetches).toBe(3);

          const keptA = yield* tryAdmit(tokenA);
          const keptB = yield* tryAdmit(tokenB);
          expect(keptA.principal.subject).toBe("user_ada");
          expect(keptB.principal.subject).toBe("user_ada");

          yield* TestClock.adjust(JWKS_RETIRED_GRACE_MS);
          const expiredA = yield* Effect.flip(tryAdmit(tokenA));
          expect(expiredA.message).toBe("jwks");
          const stillB = yield* tryAdmit(tokenB);
          expect(stillB.principal.subject).toBe("user_ada");
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("fingerprintOf covers full public JWK material, not kid only", () => {
    const original = fingerprintOf({ keys: [PUBLIC_JWK] });
    const sameKidNewCoords = fingerprintOf({
      keys: [{ ...PUBLIC_JWK, x: "changed-x-coordinate-same-kid" }],
    });
    expect(original).not.toBe(sameKidNewCoords);

    const rsa = fingerprintOf({ keys: [{ kty: "RSA", n: "abc", e: "AQAB" }] });
    const rsaOtherN = fingerprintOf({ keys: [{ kty: "RSA", n: "def", e: "AQAB" }] });
    expect(rsa).not.toBe(rsaOtherN);

    const withPrivate = fingerprintOf({
      keys: [{ ...PUBLIC_JWK, d: "secret-must-not-fingerprint" }],
    });
    expect(withPrivate).toBe(original);
  });

  test("same kid with different public material is a new generation", async () => {
    let keys: object[] = [PUBLIC_JWK];
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const issued = Math.floor(Date.now() / 1000);
      const over = { kid: "test" as const, iat: issued, exp: issued + 600 };
      const tokenA = await signToken("acme", "member", "user_ada", undefined, over);
      const tokenB = await signToken("acme", "member", "user_ada", undefined, {
        ...over,
        jwk: NEXT_PRIVATE_JWK,
      });
      const unknown = await signToken("acme", "member", "user_ada", undefined, {
        kid: "missing",
        iat: issued,
        exp: issued + 600,
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const jwks = yield* Jwks;
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          const first = yield* tryAdmit(tokenA);
          expect(first.principal.subject).toBe("user_ada");
          expect(fetches).toBe(1);

          // Same kid still matches generation A, so a kid-miss refresh will
          // not run. Invalidate after cooldown to publish new material.
          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          keys = [NEXT_PUBLIC_JWK];
          yield* jwks.invalidate;
          const rotated = yield* tryAdmit(tokenB);
          expect(rotated.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          const miss = yield* Effect.flip(tryAdmit(unknown));
          expect(miss._tag === "AuthenticationRejected" || miss._tag === "JwksUnavailable").toBe(true);
          expect(fetches).toBe(3);

          const stillB = yield* tryAdmit(tokenB);
          expect(stillB.principal.subject).toBe("user_ada");

          yield* TestClock.adjust(JWKS_RETIRED_GRACE_MS);
          const expiredA = yield* Effect.flip(tryAdmit(tokenA));
          expect(expiredA.message === "jwks" || expiredA.message === "claims").toBe(true);
          const keptB = yield* tryAdmit(tokenB);
          expect(keptB.principal.subject).toBe("user_ada");
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("bounded: at most 2 generations retained", async () => {
    let kid = "a";
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: [jwk(kid)] });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const issued = Math.floor(Date.now() / 1000);
      const tok = (name: string) =>
        signToken("acme", "member", "user_ada", undefined, {
          kid: name,
          iat: issued,
          exp: issued + 100,
        });
      const tokenA = await tok("a");
      const tokenB = await tok("b");
      const tokenC = await tok("c");

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const jwks = yield* Jwks;
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          kid = "a";
          yield* tryAdmit(tokenA);
          expect(fetches).toBe(1);

          kid = "b";
          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          yield* jwks.invalidate;
          yield* tryAdmit(tokenB);
          expect(fetches).toBe(2);

          kid = "c";
          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          yield* jwks.invalidate;
          yield* tryAdmit(tokenC);
          expect(fetches).toBe(3);

          const prev = yield* tryAdmit(tokenB);
          const current = yield* tryAdmit(tokenC);
          expect(prev.principal.subject).toBe("user_ada");
          expect(current.principal.subject).toBe("user_ada");

          const dropped = yield* Effect.flip(tryAdmit(tokenA));
          expect(dropped._tag === "AuthenticationRejected" || dropped._tag === "JwksUnavailable").toBe(
            true,
          );
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("RAMOSE_JWKS_SERVICE dispatches through the named binding", async () => {
    let fetches = 0;
    const env = {
      RAMOSE_JWKS_URL: "https://jwks.invalid/jwks",
      RAMOSE_JWKS_SERVICE: "JWKS",
      JWKS: {
        fetch: async () => {
          fetches += 1;
          return Response.json({ keys: [PUBLIC_JWK] });
        },
      },
      RAMOSE_JWT_ISS: ISS,
      RAMOSE_JWT_AUD: AUD,
    };
    const token = await signToken("acme", "member");
    const admitted = await Effect.runPromise(admit(env, "acme", token));
    expect(admitted.principal.subject).toBe("user_ada");
    expect(fetches).toBe(1);

    const missing = await Effect.runPromise(
      Effect.flip(
        admit(
          {
            RAMOSE_JWKS_URL: "https://jwks.invalid/jwks",
            RAMOSE_JWKS_SERVICE: "JWKS",
            RAMOSE_JWT_ISS: ISS,
            RAMOSE_JWT_AUD: AUD,
          },
          "acme",
          token,
        ),
      ),
    );
    expect(missing).toBeInstanceOf(JwksUnavailable);
    expect(missing.message).toBe("jwks");
  });

  test("failed refresh keeps last generation and does not hammer until cooldown", async () => {
    let keys: object[] = [jwk("test")];
    let status = 200;
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        if (status !== 200) return new Response("nope", { status });
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const good = await signToken("acme", "member", "user_ada", undefined, { kid: "test" });
      const unknown = await signToken("acme", "member", "user_ada", undefined, { kid: "rand-fail" });
      const nextTok = await signToken("acme", "member", "user_ada", undefined, { kid: "next" });

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          yield* tryAdmit(good);
          expect(fetches).toBe(1);

          status = 500;
          yield* TestClock.adjust(1);
          const failed = yield* Effect.flip(tryAdmit(unknown));
          expect(failed._tag === "AuthenticationRejected" || failed._tag === "JwksUnavailable").toBe(
            true,
          );
          expect(fetches).toBe(2);

          const stillGood = yield* tryAdmit(good);
          expect(stillGood.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);

          const secondMiss = yield* Effect.flip(tryAdmit(unknown));
          expect(secondMiss.message).toBe("jwks");
          expect(fetches).toBe(2);

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          status = 200;
          keys = [jwk("test"), jwk("next")];
          const recovered = yield* tryAdmit(nextTok);
          expect(recovered.principal.subject).toBe("user_ada");
          expect(fetches).toBe(3);
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("failed TTL reload serves last generation and cools remote attempts", async () => {
    let fetches = 0;
    let status = 200;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        if (status !== 200) return new Response("nope", { status });
        return Response.json({ keys: [PUBLIC_JWK] });
      },
    });
    try {
      const env = { RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks` };
      await Effect.runPromise(
        Effect.gen(function* () {
          const jwks = yield* Jwks;
          yield* jwks.keySet;
          expect(fetches).toBe(1);

          status = 500;
          yield* TestClock.adjust("5 minutes");
          const failed = yield* Effect.flip(jwks.keySet);
          expect(failed).toBeInstanceOf(JwksUnavailable);
          expect(fetches).toBe(2);

          yield* jwks.keySet;
          expect(fetches).toBe(2);

          status = 200;
          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          yield* jwks.keySet;
          expect(fetches).toBe(3);
        }).pipe(Effect.provide(withClock(jwksLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("malformed remote JWKS is not cached; cooldown then recovery", async () => {
    let fetches = 0;
    let keys: object[] = [{ kty: "EC", kid: "test", crv: "P-256" }];
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const token = await signToken("acme", "member", "user_ada", undefined, { kid: "test" });

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const admission = yield* AuthenticationAdmission;
          const tryAdmit = (tok: string) =>
            admission.admit({
              database: "acme",
              token: Redacted.make(tok),
              route: "http",
            });

          const first = yield* Effect.flip(tryAdmit(token));
          expect(first).toBeInstanceOf(JwksUnavailable);
          expect(fetches).toBe(1);

          const retry = yield* Effect.flip(tryAdmit(token));
          expect(retry).toBeInstanceOf(JwksUnavailable);
          expect(fetches).toBe(1);

          yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS);
          keys = [PUBLIC_JWK];
          const recovered = yield* tryAdmit(token);
          expect(recovered.principal.subject).toBe("user_ada");
          expect(fetches).toBe(2);
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
    } finally {
      server.stop(true);
    }
  });

  test("mixed JWKS drops unimportable keys and caches the rest", async () => {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({
          keys: [{ kty: "EC", kid: "bad", crv: "P-256" }, PUBLIC_JWK],
        });
      },
    });
    try {
      const env = {
        RAMOSE_JWKS_URL: `http://127.0.0.1:${server.port}/jwks`,
        RAMOSE_JWT_ISS: ISS,
        RAMOSE_JWT_AUD: AUD,
      };
      const token = await signToken("acme", "member");
      const admitted = await Effect.runPromise(admit(env, "acme", token));
      expect(admitted.principal.subject).toBe("user_ada");
      expect(fetches).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("localAuthenticationLayer is isolated from the env WeakMap", async () => {
    const token = await signToken("acme", "member");
    const a = localAuthenticationLayer({ jwksJson: JWKS, issuers: ISS, aud: AUD });
    const b = localAuthenticationLayer({ jwksJson: '{"keys":[]}', issuers: ISS, aud: AUD });
    const ok = await Effect.runPromise(admitOfLayer(a, token));
    expect(ok.principal.subject).toBe("user_ada");
    const empty = await Effect.runPromise(Effect.flip(admitOfLayer(b, token)));
    expect(empty._tag).toBe("JwksUnavailable");
  });
});

const admitOfLayer = (layer: ReturnType<typeof localAuthenticationLayer>, token: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.now());
    const admission = yield* AuthenticationAdmission;
    return yield* admission.admit({
      database: "acme",
      token: Redacted.make(token),
      route: "http",
    });
  }).pipe(Effect.provide(withClock(layer)));
