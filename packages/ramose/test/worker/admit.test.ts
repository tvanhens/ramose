import { beforeEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { RamoseEnv } from "../../src/RamoseEnv.ts";
import {
  requestCredential,
} from "../../src/worker/admit.ts";
import {
  handle,
  runFetch,
  type RequestInfo,
} from "../../src/worker/handle.ts";
import {
  JwtVerifier,
  fromEnv,
  resetJwtVerifier,
} from "../../src/worker/jwt.ts";
import { signToken } from "../sign-local-token.ts";
import { AUD, ISS, JWKS } from "../../../../test/local/auth-keys.ts";

const AUTH_ENV = {
  RAMOSE_JWKS_JSON: JWKS,
  RAMOSE_JWT_ISS: ISS,
  RAMOSE_JWT_AUD: AUD,
  RAMOSE_JWT_MAX_TTL: "900",
} as unknown as RamoseEnv;

beforeEach(() => {
  resetJwtVerifier();
});

const token = () => {
  const now = Math.floor(Date.now() / 1_000);
  return signToken("acme", "member", "user-ada", undefined, {
    iat: now,
    exp: now + 300,
  });
};

const fetch = (
  path: string,
  init: RequestInit = {},
  env: RamoseEnv = AUTH_ENV,
) => runFetch(new Request(`https://peer.example.test${path}`, init), env, {});

const body = (response: Response) =>
  response.json() as Promise<Record<string, unknown>>;

describe("request credential transport", () => {
  test("HTTP accepts one Bearer credential with a case-insensitive scheme", () => {
    for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
      const credential = requestCredential(
        new Request("https://peer.example.test/db/acme/info", {
          headers: { authorization: `${scheme} signed.jwt.value` },
        }),
      );
      expect(credential._tag).toBe("Success");
      if (credential._tag === "Success") {
        expect(Redacted.value(credential.success)).toBe("signed.jwt.value");
      }
    }
  });

  test("HTTP rejects missing, non-Bearer, multiple, and query credentials", () => {
    const requests = [
      new Request("https://peer.example.test/db/acme/info"),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Basic abc" },
      }),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Bearer one two" },
      }),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Bearer one,Bearer two" },
      }),
      new Request(
        "https://peer.example.test/db/acme/info?token=signed.jwt.value",
      ),
      new Request(
        "https://peer.example.test/db/acme/info?token=signed.jwt.value",
        { headers: { upgrade: "websocket" } },
      ),
      new Request(
        "https://peer.example.test/db/acme/query?token=signed.jwt.value",
        { method: "POST", headers: { upgrade: "websocket" } },
      ),
      new Request(
        "https://peer.example.test/db/acme/session?token=signed.jwt.value",
      ),
    ];
    for (const request of requests) {
      expect(requestCredential(request)._tag).toBe("Failure");
    }
  });

  test("WebSocket admission accepts query or Bearer transport and prefers Bearer", () => {
    const query = requestCredential(
      new Request(
        "https://peer.example.test/db/acme/session?token=query.jwt.value",
        { headers: { upgrade: "WebSocket" } },
      ),
    );
    expect(query._tag).toBe("Success");
    if (query._tag === "Success") {
      expect(Redacted.value(query.success)).toBe("query.jwt.value");
    }

    const bearer = requestCredential(
      new Request(
        "https://peer.example.test/db/acme/session?token=query.jwt.value",
        {
          headers: {
            upgrade: "websocket",
            authorization: "Bearer header.jwt.value",
          },
        },
      ),
    );
    expect(bearer._tag).toBe("Success");
    if (bearer._tag === "Success") {
      expect(Redacted.value(bearer.success)).toBe("header.jwt.value");
    }
  });

  test("WebSocket query transport requires exactly one non-empty token", () => {
    for (const search of [
      "",
      "?token=",
      "?token=one&token=two",
      "?token=has%20space",
    ]) {
      const request = new Request(
        `https://peer.example.test/db/acme/session${search}`,
        { headers: { upgrade: "websocket" } },
      );
      expect(requestCredential(request)._tag).toBe("Failure");
    }
  });
});

describe("production handle admission ordering", () => {
  test("/health remains open without JWT configuration", async () => {
    const response = await fetch(
      "/health",
      {},
      {} as unknown as RamoseEnv,
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, service: "ramose" });
  });

  test("gated /__test__ admin is not an external JWT path", async () => {
    const closed = await fetch("/__test__/db/acme/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    expect(closed.status).toBe(404);

    const open = await fetch(
      "/__test__/db/acme/checkpoint",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "status" }),
      },
      { RAMOSE_TEST_HOOKS: "1" } as unknown as RamoseEnv,
    );
    expect(open.status).toBe(200);
    expect(await body(open)).toMatchObject({ ok: true });
  });

  test("an invalid database name is hidden until authentication succeeds", async () => {
    const missing = await fetch("/db/-invalid/info");
    expect(missing.status).toBe(401);
    expect(await body(missing)).toEqual({ error: "unauthorized" });

    const validToken = await token();
    const admitted = await fetch("/db/-invalid/info", {
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(admitted.status).toBe(400);
    expect(await body(admitted)).toEqual({
      error: "invalid database name",
      stack: null,
    });
  });

  test("malformed percent-encoding is also hidden until authentication", async () => {
    const path = "/db/%E0%A4%A/info";
    expect((await fetch(path)).status).toBe(401);
    const validToken = await token();
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: "invalid database name",
      stack: null,
    });
  });

  test("a valid JWT reaches the still-closed data plane", async () => {
    const validToken = await token();
    const response = await fetch("/db/acme/info", {
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "unauthorized" });
  });

  test("HTTP query token is rejected even when it is valid", async () => {
    const validToken = await token();
    const absentHeader = await fetch(
      `/db/-invalid/info?token=${encodeURIComponent(validToken)}`,
    );
    expect(absentHeader.status).toBe(401);
    expect(await body(absentHeader)).toEqual({ error: "unauthorized" });

    const validBearer = await fetch(
      `/db/-invalid/info?token=${encodeURIComponent(validToken)}`,
      { headers: { authorization: `Bearer ${validToken}` } },
    );
    expect(validBearer.status).toBe(401);
    expect(await body(validBearer)).toEqual({ error: "unauthorized" });

    const spoofedUpgrade = await fetch(
      `/db/-invalid/info?token=${encodeURIComponent(validToken)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(spoofedUpgrade.status).toBe(401);
    expect(await body(spoofedUpgrade)).toEqual({ error: "unauthorized" });
  });

  test("WebSocket query and Bearer credentials use the same verifier contract", async () => {
    const validToken = await token();
    const query = await fetch(
      `/db/-invalid/session?token=${encodeURIComponent(validToken)}`,
      { headers: { upgrade: "WebSocket" } },
    );
    expect(query.status).toBe(400);

    const bearer = await fetch("/db/-invalid/session", {
      headers: {
        upgrade: "websocket",
        authorization: `bEaReR ${validToken}`,
      },
    });
    expect(bearer.status).toBe(400);

    const closed = await fetch(
      `/db/acme/session?token=${encodeURIComponent(validToken)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(closed.status).toBe(401);
  });

  test("external authentication errors expose only the opaque 401 body", async () => {
    const diagnosticToken = "not.a.jwt-with-private-diagnostic";
    const response = await fetch("/db/-invalid/info", {
      headers: { authorization: `Bearer ${diagnosticToken}` },
    });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toBe('{"error":"unauthorized"}');
    expect(text).not.toContain(diagnosticToken);
    expect(text).not.toContain("JWT");
    expect(text).not.toContain("claim");
  });

  test("named JWKS service missing denies data but cannot crash health", async () => {
    const missingBinding = {
      ...AUTH_ENV,
      RAMOSE_JWKS_JSON: undefined,
      RAMOSE_JWKS_URL: "https://issuer.example.test/jwks",
      RAMOSE_JWKS_SERVICE: "MISSING",
    } as unknown as RamoseEnv;
    const validToken = await token();
    expect(
      (
        await fetch(
          "/db/acme/info",
          { headers: { authorization: `Bearer ${validToken}` } },
          missingBinding,
        )
      ).status,
    ).toBe(401);
    expect((await fetch("/health", {}, missingBinding)).status).toBe(200);
  });

  test("request metadata retains pathname only, never token-bearing search", async () => {
    const diagnosticToken = "not.a.jwt-with-query-diagnostic";
    const request = new Request(
      `https://peer.example.test/db/acme/info?token=${diagnosticToken}`,
    );
    const info: RequestInfo = { db: "-", path: "-", route: "other" };
    const error = await Effect.runPromise(
      Effect.flip(
        handle(request, AUTH_ENV, Date.now(), info, {}).pipe(
          Effect.provideService(JwtVerifier, fromEnv(AUTH_ENV)),
        ),
      ),
    );
    expect(error._tag).toBe("Unauthorized");
    expect(info.path).toBe("/info");
    expect(info.path).not.toContain(diagnosticToken);
    expect(info.path).not.toContain("?");
  });
});
