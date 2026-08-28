/**
 * The mint-route plugin, against a real Better Auth on the in-memory
 * adapter: session in, `{ token, class, exp }` out, signature verifiable
 * with the JWKS the jwt plugin's own /jwks endpoint publishes — the exact
 * key the peer's `RAMOSE_JWKS_URL` would read.
 *
 * Minting has no database input. The class is deployment-global identity,
 * not a role derived from a requested org or route.
 */

import { describe, expect, test } from "bun:test";
import type { AuthConfig } from "../../src/index.ts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { createLocalJWKSet, jwtVerify } from "jose";
import {
  type ClassOf,
  classOfRole,
  ramoseToken,
} from "../../src/better-auth/index.ts";
import { memoryDb } from "./support.ts";

const AUTH: AuthConfig = {
  issuer: "test-auth",
  audience: "ramose:test",
  ttl: 900,
};

/** Declared class vocabulary — only `classes` matters to the mint. */
const POLICY = { classes: ["authenticated", "member", "viewer"] as const };

const globalClassOf: ClassOf = ({ session }) => ({
  class: "authenticated",
  attrs: {
    ...(typeof session.user.name === "string" ? { name: session.user.name } : {}),
    ...(typeof session.user.email === "string" ? { email: session.user.email } : {}),
  },
});

const makeAuth = (options?: {
  readonly classOf?: ClassOf;
  readonly policy?: { readonly classes: readonly string[] };
  readonly path?: string;
  readonly withJwt?: boolean;
}) =>
  betterAuth({
    database: memoryAdapter(memoryDb()),
    secret: "a-test-secret-of-at-least-32-characters!",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    plugins: [
      ...(options?.withJwt === false
        ? []
        : [
            jwt({
              jwt: {
                issuer: AUTH.issuer,
                audience: AUTH.audience,
                expirationTime: `${AUTH.ttl}s`,
              },
            }),
          ]),
      ramoseToken({
        auth: AUTH,
        policy: options?.policy ?? POLICY,
        classOf: options?.classOf ?? globalClassOf,
        ...(options?.path === undefined ? {} : { path: options.path }),
      }),
    ],
  });

/** Sign a user up and return their id plus a `cookie` header for calls. */
const signUp = async (
  auth: {
    api: {
      signUpEmail: (input: {
        body: { email: string; password: string; name: string };
        returnHeaders: true;
      }) => Promise<{ headers: Headers; response: { user: { id: string } } }>;
    };
  },
  email: string,
) => {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: "password-1234", name: email },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, headers: new Headers({ cookie }) };
};

const statusOf = async (attempt: Promise<unknown>): Promise<number> => {
  try {
    await attempt;
    return 200;
  } catch (error) {
    if (error instanceof APIError) return error.statusCode;
    throw error;
  }
};

describe("ramoseToken", () => {
  test("mints without a database input: global class, no ramose.db, exp - iat = ttl", async () => {
    const auth = makeAuth();
    const user = await signUp(auth, "alice@acme.test");

    const minted = await auth.api.ramoseToken({ headers: user.headers });
    expect(minted.class).toBe("authenticated");
    expect(typeof minted.token).toBe("string");

    const jwks = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(minted.token, jwks, {
      issuer: AUTH.issuer,
      audience: AUTH.audience,
    });
    expect(payload.sub).toBe(user.userId);
    expect(payload.ramose).toEqual({
      class: "authenticated",
      attrs: { name: "alice@acme.test", email: "alice@acme.test" },
    });
    expect(payload.ramose).not.toHaveProperty("db");
    expect(payload).not.toHaveProperty("db");
    expect(payload.exp! - payload.iat!).toBe(AUTH.ttl);
    expect(payload.exp).toBe(minted.exp);
  });

  test("leftover body.db is ignored; the same session mints the same global class", async () => {
    const auth = makeAuth();
    const user = await signUp(auth, "alice@acme.test");
    const without = await auth.api.ramoseToken({ headers: user.headers });
    const withAcme = await auth.api.ramoseToken({
      body: { db: "acme" } as never,
      headers: user.headers,
    });
    const withOther = await auth.api.ramoseToken({
      body: { db: "other" } as never,
      headers: user.headers,
    });
    expect(without.class).toBe("authenticated");
    expect(withAcme.class).toBe("authenticated");
    expect(withOther.class).toBe("authenticated");

    const jwks = createLocalJWKSet(await auth.api.getJwks());
    for (const minted of [without, withAcme, withOther]) {
      const { payload } = await jwtVerify(minted.token, jwks);
      expect(payload.ramose).toEqual({
        class: "authenticated",
        attrs: { name: "alice@acme.test", email: "alice@acme.test" },
      });
      expect(payload.ramose).not.toHaveProperty("db");
    }
  });

  test("classOf returning null is 403 — no database is named", async () => {
    const auth = makeAuth({ classOf: () => null });
    const user = await signUp(auth, "user@acme.test");
    try {
      await auth.api.ramoseToken({ headers: user.headers });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).statusCode).toBe(403);
      expect((error as APIError).message).not.toMatch(/acme|ghost|database/i);
    }
  });

  test("no session is 401", async () => {
    const auth = makeAuth();
    expect(await statusOf(auth.api.ramoseToken({}))).toBe(401);
  });

  test("a class the policy does not declare is a 500 config error, not a mint", async () => {
    const auth = makeAuth({ classOf: () => "superuser" });
    const user = await signUp(auth, "user@acme.test");
    expect(await statusOf(auth.api.ramoseToken({ headers: user.headers }))).toBe(
      500,
    );
  });

  test("classOf may grant global attrs; they ride under ramose.attrs", async () => {
    const auth = makeAuth({
      classOf: ({ session }) => ({
        class: "authenticated",
        attrs: { email: session.user.email, locale: "en" },
      }),
    });
    const user = await signUp(auth, "user@acme.test");
    const minted = await auth.api.ramoseToken({ headers: user.headers });
    const jwks = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(minted.token, jwks);
    expect(payload.ramose).toEqual({
      class: "authenticated",
      attrs: { email: "user@acme.test", locale: "en" },
    });
    expect(payload.ramose).not.toHaveProperty("db");
  });

  test("without the jwt plugin, init fails with a pointed error", async () => {
    const auth = makeAuth({ withJwt: false });
    await expect(auth.api.ramoseToken({})).rejects.toThrow(
      /requires Better Auth's jwt plugin/,
    );
  });

  test("a custom path serves the same endpoint over HTTP without a database body", async () => {
    const auth = makeAuth({ path: "/ramose-token", classOf: () => "authenticated" });
    const user = await signUp(auth, "user@acme.test");
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/ramose-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: user.headers.get("cookie")!,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; class: string };
    expect(body.class).toBe("authenticated");
    expect(body.token.split(".")).toHaveLength(3);
  });
});

const SECRET_A = "a-test-secret-of-at-least-32-characters!";
const SECRET_B = "a-rotated-secret-of-at-least-32-chars!!";

const cookieFrom = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const getSession = (
  auth: { handler: (request: Request) => Response | Promise<Response> },
  cookie: string,
) =>
  auth.handler(
    new Request("http://localhost:3000/api/auth/get-session", {
      headers: { cookie },
    }),
  );

describe("JWKS secret rotation", () => {
  test("get-session 500s after the signing secret rotates (jwt set-auth-jwt hook)", async () => {
    const db = memoryDb();
    const jwtOnly = (secret: string, disableSettingJwtHeader?: boolean) =>
      betterAuth({
        database: memoryAdapter(db),
        secret,
        baseURL: "http://localhost:3000",
        emailAndPassword: { enabled: true },
        plugins: [
          jwt({
            ...(disableSettingJwtHeader === undefined
              ? {}
              : { disableSettingJwtHeader }),
            jwt: {
              issuer: AUTH.issuer,
              audience: AUTH.audience,
              expirationTime: `${AUTH.ttl}s`,
            },
          }),
        ],
      });

    const authA = jwtOnly(SECRET_A);
    await signUp(authA, "owner@acme.test");
    // Encrypt a JWKS private key with secret A — /jwks creates the first row.
    await authA.api.getJwks();

    const authB = jwtOnly(SECRET_B);
    const signedIn = await authB.api.signInEmail({
      body: { email: "owner@acme.test", password: "password-1234" },
      returnHeaders: true,
    });
    const cookie = cookieFrom(signedIn.headers);
    const broken = await getSession(authB, cookie);
    expect(broken.status).toBe(500);

    // Same cookie, same secret, but the get-session hook does not sign.
    const authBOff = jwtOnly(SECRET_B, true);
    const ok = await getSession(authBOff, cookie);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { user: { email: string } };
    expect(body.user.email).toBe("owner@acme.test");
  });

  test("ramoseToken heals JWKS so get-session and mint survive a rotated secret", async () => {
    const db = memoryDb();
    const withMint = (secret: string) =>
      betterAuth({
        database: memoryAdapter(db),
        secret,
        baseURL: "http://localhost:3000",
        emailAndPassword: { enabled: true },
        plugins: [
          jwt({
            jwt: {
              issuer: AUTH.issuer,
              audience: AUTH.audience,
              expirationTime: `${AUTH.ttl}s`,
            },
          }),
          ramoseToken({ auth: AUTH, policy: POLICY, classOf: globalClassOf }),
        ],
      });

    const authA = withMint(SECRET_A);
    const owner = await signUp(authA, "owner@acme.test");
    const first = await authA.api.ramoseToken({ headers: owner.headers });
    const keysBefore = (await authA.api.getJwks()).keys;
    expect(keysBefore.length).toBe(1);

    const authB = withMint(SECRET_B);
    const signedIn = await authB.api.signInEmail({
      body: { email: "owner@acme.test", password: "password-1234" },
      returnHeaders: true,
    });
    const cookie = cookieFrom(signedIn.headers);
    const session = await getSession(authB, cookie);
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { user: { email: string } };
    expect(sessionBody.user.email).toBe("owner@acme.test");

    const minted = await authB.api.ramoseToken({
      headers: new Headers({ cookie }),
    });
    expect(minted.class).toBe("authenticated");
    const keysAfter = (await authB.api.getJwks()).keys;
    expect(keysAfter.length).toBe(2);
    expect(keysAfter.map((k) => k.kid).sort()).not.toEqual(
      keysBefore.map((k) => k.kid).sort(),
    );

    const jwks = createLocalJWKSet(await authB.api.getJwks());
    const { payload } = await jwtVerify(minted.token, jwks, {
      issuer: AUTH.issuer,
      audience: AUTH.audience,
    });
    expect(payload.ramose).toEqual({
      class: "authenticated",
      attrs: { name: "owner@acme.test", email: "owner@acme.test" },
    });
    expect(payload.ramose).not.toHaveProperty("db");
    // The token minted under secret A still verifies — old public key stayed.
    const old = await jwtVerify(first.token, jwks, {
      issuer: AUTH.issuer,
      audience: AUTH.audience,
    });
    expect(old.payload.ramose).toEqual({
      class: "authenticated",
      attrs: { name: "owner@acme.test", email: "owner@acme.test" },
    });
  });
});

describe("classOfRole", () => {
  test("owner and admin map to owner; member to member; the rest to viewer", () => {
    expect(classOfRole("owner")).toBe("owner");
    expect(classOfRole("admin")).toBe("owner");
    expect(classOfRole("owner,member")).toBe("owner");
    expect(classOfRole("member")).toBe("member");
    expect(classOfRole("viewer")).toBe("viewer");
    expect(classOfRole("mystery-role")).toBe("viewer");
    expect(classOfRole("")).toBe("viewer");
  });
});
