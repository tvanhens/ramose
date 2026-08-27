/**
 * JWT admission: Effect Clock + real signed tokens.
 */

import { describe, expect, test } from "bun:test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { AUD, ISS, JWKS } from "../../../../../test/local/auth-keys.ts";
import { AuthenticationAdmission } from "../../../src/internal/authorization/runtime/authentication.ts";
import { authenticationLayer, localAuthenticationLayer } from "../../../src/internal/authorization/runtime/layer.ts";
import { toAuthorizationPrincipal } from "../../../src/internal/authorization/runtime/verified-principal.ts";
import { toWirePrincipal } from "../../../src/worker/auth.ts";
import { signToken } from "../../sign-local-token.ts";

const layer = localAuthenticationLayer({ jwksJson: JWKS, issuers: ISS, aud: AUD });
const testLayer = Layer.mergeAll(layer, TestClock.layer());

const run = <A, E>(effect: Effect.Effect<A, E, AuthenticationAdmission>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Default-signed tokens use wall-clock iat; TestClock starts at epoch 0.
      yield* TestClock.setTime(Date.now());
      return yield* effect;
    }).pipe(Effect.provide(testLayer)),
  );

const admitOf = (database: string, token: string, route: "http" | "websocket" = "http") =>
  Effect.gen(function* () {
    const admission = yield* AuthenticationAdmission;
    return yield* admission.admit({
      database,
      token: Redacted.make(token),
      route,
    });
  });

const failAdmit = (database: string, token: string) =>
  Effect.gen(function* () {
    const admission = yield* AuthenticationAdmission;
    return yield* Effect.flip(
      admission.admit({
        database,
        token: Redacted.make(token),
        route: "http",
      }),
    );
  });

const leak = (value: unknown, token: string): string => {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v;
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return undefined;
    seen.add(v);
    if (v instanceof Error) {
      return { ...v, name: v.name, message: v.message, stack: v.stack };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return JSON.stringify(walk(value));
};

describe("AuthenticationAdmission", () => {
  test("valid ES256 token → VerifiedPrincipal without token material", async () => {
    const token = await signToken("acme", "member", "user_ada", { org: "t1" });
    const admitted = await run(admitOf("acme", token));
    expect(Object.isFrozen(admitted.principal)).toBe(true);
    expect(Object.isFrozen(admitted.principal.claims)).toBe(true);
    expect("token" in admitted.principal).toBe(false);
    expect(admitted.principal.subject).toBe("user_ada");
    expect(admitted.principal.database).toBe("acme");
    expect(admitted.principal.classes).toEqual(["member"]);
    expect(admitted.principal.claims.sub).toBe("user_ada");
    expect(admitted.principal.claims.iss).toBe(ISS);
    expect(admitted.principal.claims.aud).toBe(AUD);
    expect(admitted.principal.claims.attrs).toEqual({ org: "t1" });
    expect(admitted.expiresAt).toBe(admitted.principal.claims.exp * 1000);
    expect(leak(admitted, token)).not.toContain(token);
    expect(leak(admitted, token)).not.toContain(JWKS);
  });

  test("toAuthorizationPrincipal / toWirePrincipal", async () => {
    const token = await signToken("acme", "admin");
    const { principal } = await run(admitOf("acme", token));
    const authz = toAuthorizationPrincipal(principal);
    expect(authz.subject).toBe("user_ada");
    expect(authz.classes).toEqual(["admin"]);
    expect("me" in authz).toBe(false);
    const wire = toWirePrincipal(principal);
    expect(wire).toEqual({
      kind: "user",
      class: "admin",
      classes: ["admin"],
      sub: "user_ada",
      claims: {
        sub: "user_ada",
        iss: ISS,
        aud: AUD,
        exp: principal.claims.exp,
      },
      db: "acme",
    });
  });

  test("expired token: valid at exp time, rejected later", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 0, exp: 100 });
    const atFifty = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(50_000);
        return yield* admitOf("acme", token);
      }),
    );
    expect(atFifty.principal.subject).toBe("user_ada");
    const later = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(101_000);
        return yield* failAdmit("acme", token);
      }),
    );
    expect(later._tag).toBe("AuthenticationRejected");
    expect(later.message).toBe("expired");
    expect(leak(later, token)).not.toContain(token);
  });

  test("nbf in the future", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { nbf: 1_000, iat: 0, exp: 2_000 });
    const failure = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        return yield* failAdmit("acme", token);
      }),
    );
    expect(failure.message).toBe("nbf");
    expect(leak(failure, token)).not.toContain(token);
  });

  test("issuer mismatch", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iss: "https://other.test" });
    const failure = await run(failAdmit("acme", token));
    expect(failure.message).toBe("iss");
  });

  test("audience mismatch", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { aud: "other-aud" });
    const failure = await run(failAdmit("acme", token));
    expect(failure.message).toBe("aud");
  });

  test("algorithm not on the allowlist", async () => {
    const hs = await signToken("acme", "member", "user_ada", undefined, { alg: "HS256" });
    const none = await signToken("acme", "member", "user_ada", undefined, { alg: "none" });
    expect((await run(failAdmit("acme", hs))).message).toBe("alg");
    expect((await run(failAdmit("acme", none))).message).toBe("alg");
    expect(leak(await run(failAdmit("acme", hs)), hs)).not.toContain(hs);
  });

  test("missing sub", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { sub: null });
    expect((await run(failAdmit("acme", token))).message).toBe("sub");
  });

  test("missing/invalid ramose.db or ramose.class", async () => {
    const noDb = await signToken("acme", "member", "user_ada", undefined, { ramose: { class: "member" } });
    const noClass = await signToken("acme", "member", "user_ada", undefined, { ramose: { db: "acme" } });
    const emptyClass = await signToken("acme", "member", "user_ada", undefined, {
      ramose: { db: "acme", class: "" },
    });
    expect((await run(failAdmit("acme", noDb))).message).toBe("claims");
    expect((await run(failAdmit("acme", noClass))).message).toBe("claims");
    expect((await run(failAdmit("acme", emptyClass))).message).toBe("claims");
  });

  test("ramose.db !== route database", async () => {
    const token = await signToken("acme", "member");
    expect((await run(failAdmit("other", token))).message).toBe("db");
  });

  test("invalid ramose.db is rejected even when it matches the route", async () => {
    const token = await signToken("!!!", "member");
    expect((await run(failAdmit("!!!", token))).message).toBe("db");
  });

  test("exp - iat > maxTtl", async () => {
    const tight = localAuthenticationLayer({
      jwksJson: JWKS,
      issuers: ISS,
      aud: AUD,
      maxTtl: 60,
    });
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 0, exp: 900 });
    const failure = await Effect.runPromise(
      failAdmit("acme", token).pipe(Effect.provide(Layer.mergeAll(tight, TestClock.layer()))),
    );
    expect(failure.message).toBe("ttl");
  });

  test("iat in the future is rejected as ttl", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 1_000, exp: 1_010 });
    const failure = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        return yield* failAdmit("acme", token);
      }),
    );
    expect(failure.message).toBe("ttl");
  });

  test("exp <= iat is rejected as ttl", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 10, exp: 10 });
    const failure = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        return yield* failAdmit("acme", token);
      }),
    );
    expect(failure.message).toBe("ttl");
  });

  test("fractional iat is rejected as ttl", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 1.5, exp: 100 });
    const failure = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(50_000);
        return yield* failAdmit("acme", token);
      }),
    );
    expect(failure.message).toBe("ttl");
  });

  test("missing iat with far-future exp is rejected as ttl", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, {
      iat: null,
      exp: 4_000_000_000,
    });
    const failure = await run(failAdmit("acme", token));
    expect(failure.message).toBe("ttl");
  });

  test("missing token", async () => {
    const failure = await run(failAdmit("acme", "   "));
    expect(failure.message).toBe("missing");
  });

  test("HTTP and websocket produce the same principal", async () => {
    const token = await signToken("acme", "member");
    const [http, websocket] = await run(
      Effect.all([admitOf("acme", token, "http"), admitOf("acme", token, "websocket")]),
    );
    expect(http.principal).toEqual(websocket.principal);
    expect(http.expiresAt).toBe(websocket.expiresAt);
  });

  test("failures contain no token or JWKS", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iss: "https://evil.test" });
    const failure = await run(failAdmit("acme", token));
    const dumped = leak(failure, token);
    expect(dumped).not.toContain(token);
    expect(dumped).not.toContain(JWKS);
    expect(dumped).not.toContain("keys");
    expect(failure.message).toMatch(/^(missing|expired|nbf|iss|aud|alg|sub|claims|db|ttl|jwks|cancelled)$/);
  });

  test("VerifiedPrincipal is frozen", async () => {
    const token = await signToken("acme", "member");
    const { principal } = await run(admitOf("acme", token));
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.claims)).toBe(true);
    expect(Object.isFrozen(principal.classes)).toBe(true);
    expect(() => {
      (principal as { subject: string }).subject = "mutated";
    }).toThrow();
  });

  test("nested ramose.attrs are deep-frozen", async () => {
    const token = await signToken("acme", "member", "user_ada", {
      org: { id: "t1", tags: ["a", "b"] },
      roles: ["admin", { name: "ops" }],
    });
    const { principal } = await run(admitOf("acme", token));
    const attrs = principal.claims.attrs as {
      org: { id: string; tags: string[] };
      roles: Array<string | { name: string }>;
    };
    expect(Object.isFrozen(attrs)).toBe(true);
    expect(Object.isFrozen(attrs.org)).toBe(true);
    expect(Object.isFrozen(attrs.org.tags)).toBe(true);
    expect(Object.isFrozen(attrs.roles)).toBe(true);
    expect(Object.isFrozen(attrs.roles[1])).toBe(true);
    expect(() => {
      attrs.org.id = "mutated";
    }).toThrow();
    expect(() => {
      attrs.org.tags.push("c");
    }).toThrow();
    expect(() => {
      (attrs.roles[1] as { name: string }).name = "mutated";
    }).toThrow();
  });

  test("incomplete issuer/audience fail closed", async () => {
    const token = await signToken("acme", "member");
    const noIss = localAuthenticationLayer({ jwksJson: JWKS, issuers: "", aud: AUD });
    const emptyAud = localAuthenticationLayer({ jwksJson: JWKS, issuers: ISS, aud: "" });
    const missingAud = authenticationLayer({
      RAMOSE_JWKS_JSON: JWKS,
      RAMOSE_JWT_ISS: ISS,
    });
    expect(
      (
        await Effect.runPromise(
          failAdmit("acme", token).pipe(Effect.provide(Layer.mergeAll(noIss, TestClock.layer()))),
        )
      ).message,
    ).toBe("iss");
    expect(
      (
        await Effect.runPromise(
          failAdmit("acme", token).pipe(Effect.provide(Layer.mergeAll(emptyAud, TestClock.layer()))),
        )
      ).message,
    ).toBe("aud");
    expect(
      (
        await Effect.runPromise(
          failAdmit("acme", token).pipe(Effect.provide(Layer.mergeAll(missingAud, TestClock.layer()))),
        )
      ).message,
    ).toBe("aud");
  });

  test("Clock.currentTimeMillis drives jwtVerify currentDate", async () => {
    const token = await signToken("acme", "member", "user_ada", undefined, { iat: 10, exp: 20 });
    const now = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(15_000);
        const admitted = yield* admitOf("acme", token);
        const clock = yield* Clock.currentTimeMillis;
        expect(admitted.principal.expiresAt).toBe(20_000);
        return clock;
      }),
    );
    expect(now).toBe(15_000);
  });
});

describe("Unauthorized mapping", () => {
  test("external mapping must not include token or JWKS", async () => {
    const token = await signToken("acme", "member");
    const exit = await Effect.runPromiseExit(
      admitOf("acme", "not-a-jwt").pipe(Effect.provide(testLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const dumped = leak(exit, token);
    expect(dumped).not.toContain(token);
    expect(dumped).not.toContain(JWKS);
  });
});
