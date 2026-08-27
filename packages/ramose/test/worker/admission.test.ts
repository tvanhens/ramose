/**
 * Worker `/db/*` admission: JWT is verified, then the data plane stays 401.
 */

import { describe, expect, mock, test } from "bun:test";
import { AUD, ISS, JWKS, SHARED_TOKEN } from "../../../../test/local/auth-keys.ts";
import type { RamoseEnv } from "../../src/RamoseEnv.ts";
import { bearerOf } from "../../src/worker/auth.ts";
import { signToken } from "../sign-local-token.ts";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { createServer } = await import("../../src/worker/index.ts");

const env = {
  STORE: {},
  TRANSACTOR: {},
  REPLICA: {},
  RAMOSE_JWKS_JSON: JWKS,
  RAMOSE_JWT_ISS: ISS,
  RAMOSE_JWT_AUD: AUD,
} as unknown as RamoseEnv;

const server = createServer();

const fetchOf = (url: string, init?: RequestInit) =>
  server.fetch(new Request(url, init), env);

const UNAUTHORIZED = JSON.stringify({ error: "unauthorized" });

describe("bearerOf", () => {
  test("Authorization Bearer then ?token=", () => {
    expect(
      bearerOf(new Request("https://peer.example/db/acme/info", { headers: { authorization: "Bearer abc" } })),
    ).toBe("abc");
    expect(bearerOf(new Request("https://peer.example/db/acme/session?token=xyz"))).toBe("xyz");
    expect(bearerOf(new Request("https://peer.example/db/acme/info"))).toBeUndefined();
  });
});

describe("createServer admission", () => {
  test("/health 200", async () => {
    const res = await fetchOf("https://peer.example/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("/ is 404", async () => {
    expect((await fetchOf("https://peer.example/")).status).toBe(404);
  });

  test("OPTIONS is 204", async () => {
    expect((await fetchOf("https://peer.example/db/acme/info", { method: "OPTIONS" })).status).toBe(204);
  });

  test("/db/acme/info no token → 401 { error: unauthorized }", async () => {
    const res = await fetchOf("https://peer.example/db/acme/info");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("shared token s3cret → same 401 body", async () => {
    const res = await fetchOf("https://peer.example/db/acme/info", {
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("valid signed JWT → same 401 body (data plane still closed)", async () => {
    const jwt = await signToken("acme", "member");
    const res = await fetchOf("https://peer.example/db/acme/info", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("expired JWT → same 401 body", async () => {
    const jwt = await signToken("acme", "member", "user_ada", undefined, {
      iat: 0,
      exp: 1,
    });
    const res = await fetchOf("https://peer.example/db/acme/info", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("iss mismatch → same 401 body", async () => {
    const jwt = await signToken("acme", "member", "user_ada", undefined, { iss: "https://evil.test" });
    const res = await fetchOf("https://peer.example/db/acme/info", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("GET /db/acme/session?token=… → same 401", async () => {
    const jwt = await signToken("acme", "member");
    const res = await fetchOf(`https://peer.example/db/acme/session?token=${encodeURIComponent(jwt)}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("Authorization Bearer and ?token= both reach admit (still 401)", async () => {
    const jwt = await signToken("acme", "member");
    const header = await fetchOf("https://peer.example/db/acme/info", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const query = await fetchOf(`https://peer.example/db/acme/info?token=${encodeURIComponent(jwt)}`);
    expect(header.status).toBe(401);
    expect(query.status).toBe(401);
    expect(await header.text()).toBe(await query.text());
    expect(await fetchOf("https://peer.example/db/acme/info").then((r) => r.text())).toBe(UNAUTHORIZED);
  });

  test("/db/!!!/info no token → 401 not 400 (AUTH-5)", async () => {
    const res = await fetchOf("https://peer.example/db/!!!/info");
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(400);
    expect(await res.text()).toBe(UNAUTHORIZED);
  });

  test("missing vs expired vs valid JWT are byte-identical 401 JSON", async () => {
    const expired = await signToken("acme", "member", "user_ada", undefined, { iat: 0, exp: 1 });
    const valid = await signToken("acme", "member");
    const bodies = await Promise.all([
      fetchOf("https://peer.example/db/acme/info").then(async (r) => ({ status: r.status, body: await r.text() })),
      fetchOf("https://peer.example/db/acme/info", {
        headers: { authorization: `Bearer ${expired}` },
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
      fetchOf("https://peer.example/db/acme/info", {
        headers: { authorization: `Bearer ${valid}` },
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
    ]);
    expect(new Set(bodies.map((b) => b.status))).toEqual(new Set([401]));
    expect(new Set(bodies.map((b) => b.body))).toEqual(new Set([UNAUTHORIZED]));
  });
});
