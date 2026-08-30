import { describe, expect, test } from "bun:test";
import { claims, type AuthConfig } from "../src/Auth.ts";
import { AUTH_ENV_KEYS, authEnv } from "../src/Server.ts";

const AUTH: AuthConfig = {
  issuer: "https://auth.acme.example",
  audience: "ramose:peer:prod",
  ttl: 900,
};

const POLICY = { classes: ["admin", "member", "viewer"] as const };

describe("claims", () => {
  test("builds the exact payload the peer verifies; exp - iat === ttl", () => {
    const now = new Date("2026-08-18T12:00:00.750Z");
    const payload = claims(AUTH, { sub: "user_01HQ8ZK", class: "member", now });
    expect(payload).toEqual({
      iss: "https://auth.acme.example",
      aud: "ramose:peer:prod",
      sub: "user_01HQ8ZK",
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 900,
      ramose: { class: "member" },
    });
    expect(payload.exp! - payload.iat!).toBe(AUTH.ttl);
  });

  test("iat defaults to now, in whole seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = claims(AUTH, { sub: "u", class: "member" });
    const after = Math.ceil(Date.now() / 1000);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(payload.exp! - payload.iat!).toBe(AUTH.ttl);
  });

  test("attrs ride under ramose.attrs, and are absent when not given", () => {
    const withAttrs = claims(AUTH, {
      sub: "u",
      class: "member",
      attrs: { org: "org_42" },
    });
    expect(withAttrs.ramose?.attrs).toEqual({ org: "org_42" });
    const without = claims(AUTH, { sub: "u", class: "member" });
    expect("attrs" in (without.ramose ?? {})).toBe(false);
  });

  test("an undeclared class throws when a policy is given…", () => {
    expect(() =>
      // @ts-expect-error
      claims(AUTH, { sub: "u", class: "superuser" }, POLICY),
    ).toThrow(/"superuser" is not declared/);
  });

  test("…and passes without one; a declared class always passes", () => {
    expect(claims(AUTH, { sub: "u", class: "superuser" }).ramose?.class).toBe(
      "superuser",
    );
    expect(
      claims(AUTH, { sub: "u", class: "viewer" }, POLICY).ramose?.class,
    ).toBe("viewer");
  });

  test("a policy value's classes are checked the same way as compiled JSON", () => {
    const policyValue = { _tag: "Policy" as const, classes: ["admin", "member"] as const };
    expect(
      claims(AUTH, { sub: "u", class: "member" }, policyValue).ramose?.class,
    ).toBe("member");
    expect(() =>
      // @ts-expect-error
      claims(AUTH, { sub: "u", class: "viewer" }, policyValue),
    ).toThrow(/"viewer" is not declared/);
  });

  test("a non-positive or fractional ttl is a config error — NumericDate is whole seconds", () => {
    for (const bad of [0, -900, 900.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        claims({ ...AUTH, ttl: bad }, { sub: "u", class: "member" }),
      ).toThrow(/positive whole number of seconds/);
    }
  });
});

describe("authEnv accepts the AuthConfig as `jwt`", () => {
  const loose = {
    jwksUrl: "https://auth.acme.example/.well-known/jwks.json",
    issuers: AUTH.issuer,
    aud: AUTH.audience,
    maxTtl: AUTH.ttl,
    allowedOrigins: "https://app.acme.example",
  };

  test("`{ jwt }` produces exactly the loose form's env", () => {
    const fromConfig = authEnv({
      jwksUrl: loose.jwksUrl,
      jwt: AUTH,
      allowedOrigins: loose.allowedOrigins,
    });
    expect(fromConfig).toEqual(authEnv(loose));
  });

  test("the env keys and values, pinned", () => {
    const env = authEnv({
      jwksUrl: loose.jwksUrl,
      jwt: AUTH,
      allowedOrigins: loose.allowedOrigins,
    });
    expect(env).toEqual({
      RAMOSE_JWKS_URL: "https://auth.acme.example/.well-known/jwks.json",
      RAMOSE_JWT_ISS: "https://auth.acme.example",
      RAMOSE_JWT_AUD: "ramose:peer:prod",
      RAMOSE_JWT_MAX_TTL: "900",
      RAMOSE_ALLOWED_ORIGINS: "https://app.acme.example",
    });
  });

  test("an explicitly set loose key wins over the config — additive, not exclusive", () => {
    const env = authEnv({ jwt: AUTH, maxTtl: 300 });
    expect(env[AUTH_ENV_KEYS.maxTtl]).toBe("300");
    expect(env[AUTH_ENV_KEYS.issuers]).toBe(AUTH.issuer);
    expect(env[AUTH_ENV_KEYS.aud]).toBe(AUTH.audience);
  });

  test("a config alone binds the three keys and nothing else", () => {
    expect(authEnv({ jwt: AUTH })).toEqual({
      RAMOSE_JWT_ISS: "https://auth.acme.example",
      RAMOSE_JWT_AUD: "ramose:peer:prod",
      RAMOSE_JWT_MAX_TTL: "900",
    });
  });
});
