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
  Jwks,
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
      await Effect.runPromise(admit(env, "acme", oldTok));
      expect(fetches).toBe(1);

      keys = [jwk("test"), jwk("next")];
      const nextTok = await signToken("acme", "member", "user_ada", undefined, { kid: "next" });
      const rotated = await Effect.runPromise(admit(env, "acme", nextTok));
      expect(rotated.principal.subject).toBe("user_ada");
      expect(fetches).toBe(2);

      const still = await Effect.runPromise(admit(env, "acme", oldTok));
      expect(still.principal.subject).toBe("user_ada");
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

      kid = "a";
      await Effect.runPromise(admit(env, "acme", tokenA));
      kid = "b";
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const jwks = yield* Jwks;
          yield* jwks.invalidate;
          const admission = yield* AuthenticationAdmission;
          return yield* admission.admit({
            database: "acme",
            token: Redacted.make(tokenB),
            route: "http",
          });
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
      kid = "c";
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const jwks = yield* Jwks;
          yield* jwks.invalidate;
          const admission = yield* AuthenticationAdmission;
          return yield* admission.admit({
            database: "acme",
            token: Redacted.make(tokenC),
            route: "http",
          });
        }).pipe(Effect.provide(withClock(authenticationLayer(env)))),
      );
      expect(fetches).toBe(3);

      const prev = await Effect.runPromise(admit(env, "acme", tokenB));
      const current = await Effect.runPromise(admit(env, "acme", tokenC));
      expect(prev.principal.subject).toBe("user_ada");
      expect(current.principal.subject).toBe("user_ada");

      const dropped = await Effect.runPromise(Effect.flip(admit(env, "acme", tokenA)));
      expect(dropped._tag === "AuthenticationRejected" || dropped._tag === "JwksUnavailable").toBe(
        true,
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

  test("localAuthenticationLayer is isolated from the env WeakMap", async () => {
    const token = await signToken("acme", "member");
    const a = localAuthenticationLayer({ jwksJson: JWKS, issuers: ISS, aud: AUD });
    const b = localAuthenticationLayer({ jwksJson: '{"keys":[]}', issuers: ISS, aud: AUD });
    const ok = await Effect.runPromise(admitOfLayer(a, token));
    expect(ok.principal.subject).toBe("user_ada");
    const empty = await Effect.runPromise(Effect.flip(admitOfLayer(b, token)));
    expect(empty._tag).toBe("AuthenticationRejected");
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
