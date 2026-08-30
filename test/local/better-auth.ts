import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { json, type LocalUrls } from "./fixtures.ts";

const PASSWORD = "password-1234";
const STANDARD = "/api/auth";

const cookieFrom = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const signUp = async (url: string, basePath: string, email: string) => {
  const result = await json(url, `${basePath}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  expect(result.status).toBe(200);
  return {
    cookie: cookieFrom(result.res.headers),
    userId: (result.body as { user: { id: string } }).user.id,
  };
};

const signIn = async (url: string, email: string) => {
  const result = await json(url, `${STANDARD}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(result.status).toBe(200);
  return cookieFrom(result.res.headers);
};

const postWithCookie = (
  url: string,
  path: string,
  cookie: string,
  body: unknown = {},
) =>
  json(url, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });

const getWithCookie = (url: string, path: string, cookie: string) =>
  json(url, path, { headers: { cookie } });

const getJwks = async (url: string) => {
  const result = await json(url, `${STANDARD}/jwks`);
  expect(result.status).toBe(200);
  return result.body as {
    keys: Array<Record<string, unknown> & { kid: string }>;
  };
};

const mint = (url: string, cookie: string, body: unknown = {}) =>
  postWithCookie(url, `${STANDARD}/ramose/token`, cookie, body);

export const registerBetterAuth = (ctx: { urls: () => LocalUrls }) => {
  describe("local Better Auth Worker + D1", () => {
    test("signup cookie mints deployment-global claims verifiable by the published JWKS", async () => {
      const { authUrl } = ctx.urls();
      const email = `alice-${crypto.randomUUID()}@acme.test`;
      const user = await signUp(authUrl, STANDARD, email);

      const without = await mint(authUrl, user.cookie);
      const withAcme = await mint(authUrl, user.cookie, { db: "acme" });
      const withOther = await mint(authUrl, user.cookie, { db: "other" });
      for (const result of [without, withAcme, withOther]) {
        expect(result.status).toBe(200);
        expect(result.body.class).toBe("authenticated");
      }

      const jwks = createLocalJWKSet(await getJwks(authUrl));
      for (const result of [without, withAcme, withOther]) {
        const minted = result.body as {
          token: string;
          class: string;
          exp: number;
        };
        const { payload } = await jwtVerify(minted.token, jwks, {
          issuer: "test-auth",
          audience: "ramose:test",
        });
        expect(payload.sub).toBe(user.userId);
        expect(payload.ramose).toEqual({
          class: "authenticated",
          attrs: { name: email, email },
        });
        expect(payload.ramose).not.toHaveProperty("db");
        expect(payload).not.toHaveProperty("db");
        expect(payload.exp! - payload.iat!).toBe(900);
        expect(payload.exp).toBe(minted.exp);
      }
    });

    test("missing, denied, undeclared, attribute, and custom-route cases cross the Worker", async () => {
      const { authUrl } = ctx.urls();
      expect((await mint(authUrl, "")).status).toBe(401);

      const denied = await signUp(
        authUrl,
        "/api/denied",
        `denied-${crypto.randomUUID()}@acme.test`,
      );
      const deniedMint = await postWithCookie(
        authUrl,
        "/api/denied/ramose/token",
        denied.cookie,
      );
      expect(deniedMint.status).toBe(403);
      expect(JSON.stringify(deniedMint.body)).not.toMatch(/ghost|database/i);

      const undeclared = await signUp(
        authUrl,
        "/api/undeclared",
        `undeclared-${crypto.randomUUID()}@acme.test`,
      );
      expect(
        (
          await postWithCookie(
            authUrl,
            "/api/undeclared/ramose/token",
            undeclared.cookie,
          )
        ).status,
      ).toBe(500);

      const attrsEmail = `attrs-${crypto.randomUUID()}@acme.test`;
      const attrs = await signUp(authUrl, "/api/attrs", attrsEmail);
      const attrsMint = await postWithCookie(
        authUrl,
        "/api/attrs/ramose/token",
        attrs.cookie,
      );
      expect(attrsMint.status).toBe(200);
      const attrsPayload = await jwtVerify(
        attrsMint.body.token,
        createLocalJWKSet(await getJwks(authUrl)),
      );
      expect(attrsPayload.payload.ramose).toEqual({
        class: "authenticated",
        attrs: { email: attrsEmail, locale: "en" },
      });

      const custom = await signUp(
        authUrl,
        "/api/custom",
        `custom-${crypto.randomUUID()}@acme.test`,
      );
      const customMint = await postWithCookie(
        authUrl,
        "/api/custom/ramose-token",
        custom.cookie,
      );
      expect(customMint.status).toBe(200);
      expect(customMint.body.class).toBe("authenticated");
      expect(customMint.body.token.split(".")).toHaveLength(3);
    });

    test("session and JWKS rows persist across a separately deployed Worker", async () => {
      const { authRestartUrl, authUrl } = ctx.urls();
      const user = await signUp(
        authUrl,
        STANDARD,
        `restart-${crypto.randomUUID()}@acme.test`,
      );
      const before = await mint(authUrl, user.cookie);
      expect(before.status).toBe(200);
      const keysBefore = await getJwks(authUrl);

      const session = await getWithCookie(
        authRestartUrl,
        `${STANDARD}/get-session`,
        user.cookie,
      );
      expect(session.status).toBe(200);
      expect(session.body.user.id).toBe(user.userId);
      const after = await mint(authRestartUrl, user.cookie);
      expect(after.status).toBe(200);
      const keysAfter = await getJwks(authRestartUrl);
      expect(keysAfter.keys.map((key) => key.kid).sort()).toEqual(
        keysBefore.keys.map((key) => key.kid).sort(),
      );
      await jwtVerify(before.body.token, createLocalJWKSet(keysAfter), {
        issuer: "test-auth",
        audience: "ramose:test",
      });
    });

    test("Ramose heals persisted JWKS after secret rotation and preserves old public keys", async () => {
      const { authRotatedUrl, authUrl } = ctx.urls();
      const email = `rotation-${crypto.randomUUID()}@acme.test`;
      const owner = await signUp(authUrl, STANDARD, email);
      const first = await mint(authUrl, owner.cookie);
      expect(first.status).toBe(200);
      const keysBefore = await getJwks(authUrl);
      expect(keysBefore.keys).toHaveLength(1);

      const rotatedCookie = await signIn(authRotatedUrl, email);
      const session = await getWithCookie(
        authRotatedUrl,
        `${STANDARD}/get-session`,
        rotatedCookie,
      );
      expect(session.status).toBe(200);
      expect(session.body.user.email).toBe(email);

      const rotated = await mint(authRotatedUrl, rotatedCookie);
      expect(rotated.status).toBe(200);
      const keysAfter = await getJwks(authRotatedUrl);
      expect(keysAfter.keys).toHaveLength(2);
      expect(keysAfter.keys.map((key) => key.kid).sort()).not.toEqual(
        keysBefore.keys.map((key) => key.kid).sort(),
      );

      const jwks = createLocalJWKSet(keysAfter);
      const current = await jwtVerify(rotated.body.token, jwks, {
        issuer: "test-auth",
        audience: "ramose:test",
      });
      expect(current.payload.ramose).toEqual({
        class: "authenticated",
        attrs: { name: email, email },
      });
      expect(current.payload.ramose).not.toHaveProperty("db");

      const old = await jwtVerify(first.body.token, jwks, {
        issuer: "test-auth",
        audience: "ramose:test",
      });
      expect(old.payload.ramose).toEqual({
        class: "authenticated",
        attrs: { name: email, email },
      });
    });
  });
};
