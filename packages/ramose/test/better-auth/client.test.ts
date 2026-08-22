/**
 * The client plugin, end to end: `authClient.ramose.token({ db })` against a
 * real Better Auth handler, and the browser loop it exists for —
 * `Ramose.token.jwt(() => authClient.ramose.token({ db }))`.
 */

import { describe, expect, test } from "bun:test";
import type { AuthConfig } from "../../src/index.ts";
import * as Ramose from "../../src/db/index.ts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ramoseTokenClient } from "../../src/better-auth/client.ts";
import { orgClassOf, ramoseToken } from "../../src/better-auth/index.ts";
import { memoryDb } from "./support.ts";

const AUTH: AuthConfig = {
  issuer: "test-auth",
  audience: "ramose:test",
  ttl: 900,
};

const auth = betterAuth({
  database: memoryAdapter(memoryDb()),
  secret: "a-test-secret-of-at-least-32-characters!",
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
    ramoseToken({ auth: AUTH, classOf: orgClassOf() }),
  ],
});

const signUp = async (email: string) => {
  const { headers } = await auth.api.signUpEmail({
    body: { email, password: "password-1234", name: email },
    returnHeaders: true,
  });
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
};

/** An auth client whose fetch is the server's handler — no sockets. */
const clientFor = (cookie: string) =>
  createAuthClient({
    baseURL: "http://localhost:3000/api/auth",
    plugins: [ramoseTokenClient()],
    fetchOptions: {
      customFetchImpl: (input, init) =>
        auth.handler(new Request(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), cookie } })),
    },
  });

describe("ramoseTokenClient", () => {
  test("authClient.ramose.token resolves the mint body", async () => {
    const cookie = await signUp("owner@acme.test");
    await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: new Headers({ cookie }),
    });

    const minted = await clientFor(cookie).ramose.token({ db: "acme" });
    expect(minted.class).toBe("admin");
    expect(minted.token.split(".")).toHaveLength(3);
    expect(minted.exp * 1000).toBeGreaterThan(Date.now());
  });

  test("pairs with Ramose.token.jwt: claims decode, token reads redacted", async () => {
    const cookie = await signUp("owner@wave.test");
    await auth.api.createOrganization({
      body: { name: "Wave", slug: "wave" },
      headers: new Headers({ cookie }),
    });
    const client = clientFor(cookie);

    const source = Ramose.token.jwt(() => client.ramose.token({ db: "wave" }));
    const claims = await source.claims();
    expect(claims.ramose).toEqual({
      db: "wave",
      class: "admin",
      attrs: { name: "owner@wave.test", email: "owner@wave.test" },
    });

    const token = Redacted.value(await Effect.runPromise(source.token));
    expect(token.split(".")).toHaveLength(3);
  });

  test("a 403 throws Ramose's Unauthorized — terminal through token.jwt, not retried", async () => {
    const cookie = await signUp("outsider@acme.test");
    const attempt = clientFor(cookie).ramose.token({ db: "acme" });
    await expect(attempt).rejects.toBeInstanceOf(Ramose.Unauthorized);
  });

  test("no session throws Unauthorized too", async () => {
    const attempt = clientFor("").ramose.token({ db: "acme" });
    await expect(attempt).rejects.toBeInstanceOf(Ramose.Unauthorized);
  });
});
