/**
 * The mint-route plugin, against a real Better Auth on the in-memory
 * adapter: session in, `{ token, class, exp }` out, signature verifiable
 * with the JWKS the jwt plugin's own /jwks endpoint publishes — the exact
 * key the peer's `RAMOSE_JWKS_URL` would read.
 */

import { describe, expect, test } from "bun:test";
import type { AuthConfig } from "../../src/index.ts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { createLocalJWKSet, jwtVerify } from "jose";
import {
  type ClassOf,
  classOfRole,
  orgClassOf,
  ramoseToken,
} from "../../src/better-auth/index.ts";
import { memoryDb } from "./support.ts";

const AUTH: AuthConfig = {
  issuer: "test-auth",
  audience: "ramose:test",
  ttl: 900,
};

/** A minimal compiled policy — only `classes` matters to the mint. */
const POLICY = JSON.stringify({
  version: 1,
  principal: ":user/sub",
  classes: ["admin", "member", "viewer"],
  attrs: {},
  preset: {},
});

const makeAuth = (options?: {
  readonly classOf?: ClassOf;
  readonly policy?: string;
  readonly path?: string;
  readonly withJwt?: boolean;
}) =>
  betterAuth({
    database: memoryAdapter(memoryDb()),
    secret: "a-test-secret-of-at-least-32-characters!",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
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
        classOf: options?.classOf ?? orgClassOf(),
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
  test("mints a verifiable token for an org owner: class admin, exp - iat = ttl", async () => {
    const auth = makeAuth();
    const owner = await signUp(auth, "owner@acme.test");
    await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: owner.headers,
    });

    const minted = await auth.api.ramoseToken({
      body: { db: "acme" },
      headers: owner.headers,
    });
    expect(minted.class).toBe("admin");
    expect(typeof minted.token).toBe("string");

    // Verify against the jwt plugin's own JWKS — the peer's exact procedure.
    const jwks = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(minted.token, jwks, {
      issuer: AUTH.issuer,
      audience: AUTH.audience,
    });
    expect(payload.sub).toBe(owner.userId);
    expect(payload.ramose).toEqual({
      db: "acme",
      class: "admin",
      attrs: { name: "owner@acme.test", email: "owner@acme.test" },
    });
    expect(payload.exp! - payload.iat!).toBe(AUTH.ttl);
    expect(payload.exp).toBe(minted.exp);
  });

  test("an added member mints class member; a non-member is 403", async () => {
    const auth = makeAuth();
    const owner = await signUp(auth, "owner@acme.test");
    const member = await signUp(auth, "member@acme.test");
    const outsider = await signUp(auth, "outsider@acme.test");
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: owner.headers,
    });
    // addMember is server-only: no invitation dance needed in tests.
    await auth.api.addMember({
      body: { userId: member.userId, organizationId: org!.id, role: "member" },
    });

    const minted = await auth.api.ramoseToken({
      body: { db: "acme" },
      headers: member.headers,
    });
    expect(minted.class).toBe("member");

    expect(
      await statusOf(
        auth.api.ramoseToken({ body: { db: "acme" }, headers: outsider.headers }),
      ),
    ).toBe(403);
  });

  test("no such org and not-a-member are the same 403 — existence never leaks", async () => {
    const auth = makeAuth();
    const user = await signUp(auth, "user@acme.test");
    expect(
      await statusOf(
        auth.api.ramoseToken({ body: { db: "ghost" }, headers: user.headers }),
      ),
    ).toBe(403);
  });

  test("no session is 401", async () => {
    const auth = makeAuth();
    expect(await statusOf(auth.api.ramoseToken({ body: { db: "acme" } }))).toBe(
      401,
    );
  });

  test("an invalid database name is 400, before classOf runs", async () => {
    let ran = false;
    const auth = makeAuth({
      classOf: () => {
        ran = true;
        return "member";
      },
    });
    const user = await signUp(auth, "user@acme.test");
    for (const bad of ["has/slash", "has space", "-leading", ""]) {
      expect(
        await statusOf(
          auth.api.ramoseToken({ body: { db: bad }, headers: user.headers }),
        ),
      ).toBe(400);
    }
    expect(ran).toBe(false);
  });

  test("a class the policy does not declare is a 500 config error, not a mint", async () => {
    const auth = makeAuth({ classOf: () => "superuser" });
    const user = await signUp(auth, "user@acme.test");
    expect(
      await statusOf(
        auth.api.ramoseToken({ body: { db: "acme" }, headers: user.headers }),
      ),
    ).toBe(500);
  });

  test("classOf may grant attrs; they ride under ramose.attrs", async () => {
    const auth = makeAuth({
      classOf: ({ session, db }) => ({
        class: "member",
        attrs: { org: `org-of-${db}`, email: session.user.email },
      }),
    });
    const user = await signUp(auth, "user@acme.test");
    const minted = await auth.api.ramoseToken({
      body: { db: "acme" },
      headers: user.headers,
    });
    const jwks = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(minted.token, jwks);
    expect(payload.ramose).toEqual({
      db: "acme",
      class: "member",
      attrs: { org: "org-of-acme", email: "user@acme.test" },
    });
  });

  test("without the jwt plugin, init fails with a pointed error", async () => {
    const auth = makeAuth({ withJwt: false });
    await expect(
      auth.api.ramoseToken({ body: { db: "acme" } }),
    ).rejects.toThrow(/requires Better Auth's jwt plugin/);
  });

  test("a custom path serves the same endpoint over HTTP", async () => {
    const auth = makeAuth({ path: "/ramose-token", classOf: () => "member" });
    const user = await signUp(auth, "user@acme.test");
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/ramose-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: user.headers.get("cookie")!,
        },
        body: JSON.stringify({ db: "acme" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; class: string };
    expect(body.class).toBe("member");
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
          organization(),
          jwt({
            jwt: {
              issuer: AUTH.issuer,
              audience: AUTH.audience,
              expirationTime: `${AUTH.ttl}s`,
            },
          }),
          ramoseToken({ auth: AUTH, policy: POLICY, classOf: orgClassOf() }),
        ],
      });

    const authA = withMint(SECRET_A);
    const owner = await signUp(authA, "owner@acme.test");
    await authA.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: owner.headers,
    });
    const first = await authA.api.ramoseToken({
      body: { db: "acme" },
      headers: owner.headers,
    });
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
      body: { db: "acme" },
      headers: new Headers({ cookie }),
    });
    expect(minted.class).toBe("admin");
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
      db: "acme",
      class: "admin",
      attrs: { name: "owner@acme.test", email: "owner@acme.test" },
    });
    // The token minted under secret A still verifies — old public key stayed.
    const old = await jwtVerify(first.token, jwks, {
      issuer: AUTH.issuer,
      audience: AUTH.audience,
    });
    expect(old.payload.ramose).toEqual({
      db: "acme",
      class: "admin",
      attrs: { name: "owner@acme.test", email: "owner@acme.test" },
    });
  });
});

describe("classOfRole", () => {
  test("owner and admin map to admin; member to member; the rest to viewer", () => {
    expect(classOfRole("owner")).toBe("admin");
    expect(classOfRole("admin")).toBe("admin");
    expect(classOfRole("owner,member")).toBe("admin");
    expect(classOfRole("member")).toBe("member");
    expect(classOfRole("viewer")).toBe("viewer");
    expect(classOfRole("mystery-role")).toBe("viewer");
    expect(classOfRole("")).toBe("viewer");
  });
});
