import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_JSON_ENCODED_BYTES,
  MAX_JSON_NODES,
  MAX_STRING_LENGTH,
} from "../../src/internal/authorization/bounds.ts";
import {
  fromEnv,
  resetJwtVerifier,
  serviceBindingFetch,
  temporalClaimsHold,
  type JwksServiceBinding,
} from "../../src/worker/jwt.ts";

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);
const ISS = "https://issuer.example.test";
const AUD = "ramose:test";

interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let keyA: TestKey;
let keyB: TestKey;

beforeAll(async () => {
  const makeKey = async (kid: string): Promise<TestKey> => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    return {
      kid,
      privateKey: pair.privateKey,
      publicJwk: {
        ...(await exportJWK(pair.publicKey)),
        alg: "ES256",
        kid,
        use: "sig",
      },
    };
  };
  [keyA, keyB] = await Promise.all([makeKey("key-a"), makeKey("key-b")]);
});

beforeEach(() => {
  resetJwtVerifier();
});

const env = (
  keys: readonly JWK[] = [keyA.publicJwk],
  over: Record<string, unknown> = {},
) =>
  ({
    RAMOSE_JWKS_JSON: JSON.stringify({ keys }),
    RAMOSE_JWT_ISS: ISS,
    RAMOSE_JWT_AUD: AUD,
    RAMOSE_JWT_MAX_TTL: "900",
    ...over,
  }) as Parameters<typeof fromEnv>[0];

interface SignOptions {
  readonly key?: TestKey;
  readonly header?: {
    readonly alg: string;
    readonly kid?: string;
    readonly [name: string]: unknown;
  };
  readonly payload?: JWTPayload;
}

const payload = (
  over: Record<string, unknown> = {},
): JWTPayload => {
  const now = nowSeconds();
  return {
    iss: ISS,
    aud: AUD,
    sub: "user-ada",
    iat: now,
    exp: now + 300,
    ramose: { db: "acme", class: "member" },
    ...over,
  };
};

const sign = async (options: SignOptions = {}): Promise<string> => {
  const signingKey = options.key ?? keyA;
  return new SignJWT(options.payload ?? payload())
    .setProtectedHeader(
      options.header ?? { alg: "ES256", kid: signingKey.kid },
    )
    .sign(signingKey.privateKey);
};

const verifyEffect = (
  token: string,
  verifierEnv = env(),
) => fromEnv(verifierEnv).verify(Redacted.make(token));

const verify = (token: string, verifierEnv = env()) =>
  Effect.runPromise(verifyEffect(token, verifierEnv));

const rejection = (token: string, verifierEnv = env()) =>
  Effect.runPromise(Effect.flip(verifyEffect(token, verifierEnv)));

const expectOpaque = (error: unknown, secrets: readonly string[] = []) => {
  expect((error as { readonly _tag?: unknown })._tag).toBe("Unauthorized");
  expect((error as Error).message).toBe("");
  const encoded = JSON.stringify(error);
  for (const secret of secrets) expect(encoded).not.toContain(secret);
  expect(encoded).not.toContain("JWT");
  expect(encoded).not.toContain("JWKS");
  expect(encoded).not.toContain("kid");
  expect(encoded).not.toContain("claim");
};

describe("JwtVerifier", () => {
  test("verifies a real token and constructs one immutable principal", async () => {
    const claims = payload({
      ramose: {
        db: "acme",
        class: "member",
        attrs: {
          active: true,
          displayName: "Ada",
          score: 2.5,
          roles: ["writer", "reader"],
          levels: [1, 2],
        },
      },
    });
    const token = await sign({ payload: claims });
    const verified = await verify(token);
    const iat = claims.iat as number;
    const exp = claims.exp as number;

    expect(verified.kid).toBe("key-a");
    expect(verified.iat).toBe(iat);
    expect(verified.exp).toBe(exp);
    expect(verified.principal).toEqual({
      kind: "user",
      class: "member",
      sub: "user-ada",
      claims: {
        sub: "user-ada",
        iss: ISS,
        aud: AUD,
        exp,
        attrs: {
          active: true,
          displayName: "Ada",
          score: 2.5,
          roles: ["writer", "reader"],
          levels: [1, 2],
        },
      },
      db: "acme",
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.principal)).toBe(true);
    expect(Object.isFrozen(verified.principal.claims)).toBe(true);
    expect(Object.isFrozen(verified.principal.claims.attrs!)).toBe(true);
    expect(
      Object.isFrozen(verified.principal.claims.attrs!.roles as object),
    ).toBe(true);
    expect(Redacted.isRedacted(verified.token)).toBe(true);
    expect(Redacted.value(verified.token)).toBe(token);
    expect("token" in verified.principal).toBe(false);
    expect(JSON.stringify(verified.principal)).not.toContain(token);
    expect(JSON.stringify(verified)).not.toContain(token);
  });

  test("accepts v1 scalar claims and one-dimensional scalar arrays", async () => {
    const token = await sign({
      payload: payload({
        ramose: {
          db: "acme",
          class: "member",
          attrs: {
            string: "value",
            long: 42,
            double: 1.5,
            boolean: false,
            strings: ["a", "b"],
            numbers: [1, 2.5],
            booleans: [true, false],
            empty: [],
          },
        },
      }),
    });
    const attrs = (await verify(token)).principal.claims.attrs!;
    expect(attrs).toEqual({
      string: "value",
      long: 42,
      double: 1.5,
      boolean: false,
      strings: ["a", "b"],
      numbers: [1, 2.5],
      booleans: [true, false],
      empty: [],
    });
    expect(Object.isFrozen(attrs.strings as object)).toBe(true);
    expect(Object.isFrozen(attrs.empty as object)).toBe(true);
  });

  test("rejects nested, null, and non-record attrs", async () => {
    const attrs = [
      { nested: { value: "no" } },
      { nested: [["no"]] },
      { value: null },
      ["not", "a", "record"],
      "not-a-record",
    ];
    for (const value of attrs) {
      const token = await sign({
        payload: payload({
          ramose: { db: "acme", class: "member", attrs: value },
        }),
      });
      expectOpaque(await rejection(token), [token]);
    }
  });

  test("fails closed when attrs exceed depth, nodes, collection, or string bounds", async () => {
    let deep: unknown = "leaf";
    for (let index = 0; index <= MAX_JSON_DEPTH; index++) {
      deep = { child: deep };
    }
    const broad = Object.fromEntries(
      Array.from({ length: MAX_COLLECTION_SIZE }, (_, index) => [
        `k${index}`,
        [index, index],
      ]),
    );
    expect(1 + MAX_COLLECTION_SIZE * 4).toBeGreaterThan(MAX_JSON_NODES);
    const oversizedText = {
      a: "x".repeat(MAX_STRING_LENGTH),
      b: "y".repeat(MAX_STRING_LENGTH),
      c: "z".repeat(MAX_STRING_LENGTH),
      d: "w".repeat(MAX_STRING_LENGTH),
      e: "v".repeat(MAX_STRING_LENGTH),
      f: "u".repeat(MAX_STRING_LENGTH),
      g: "t".repeat(MAX_STRING_LENGTH),
      h: "s".repeat(MAX_STRING_LENGTH),
      i: "r".repeat(MAX_STRING_LENGTH),
      j: "q".repeat(MAX_STRING_LENGTH),
      k: "p".repeat(MAX_STRING_LENGTH),
      l: "o".repeat(MAX_STRING_LENGTH),
      m: "n".repeat(MAX_STRING_LENGTH),
      n: "m".repeat(MAX_STRING_LENGTH),
      o: "l".repeat(MAX_STRING_LENGTH),
      p: "k".repeat(MAX_STRING_LENGTH),
      q: "j".repeat(MAX_STRING_LENGTH),
    };
    expect(17 * MAX_STRING_LENGTH).toBeGreaterThan(MAX_JSON_ENCODED_BYTES);
    const oversized = [
      { deep },
      broad,
      { list: Array.from({ length: MAX_COLLECTION_SIZE + 1 }, () => 1) },
      { text: "x".repeat(MAX_STRING_LENGTH + 1) },
      { ["k".repeat(MAX_STRING_LENGTH + 1)]: "value" },
      oversizedText,
    ];

    for (const attrs of oversized) {
      const token = await sign({
        payload: payload({
          ramose: { db: "acme", class: "member", attrs },
        }),
      });
      expectOpaque(await rejection(token), [token]);
    }
  });

  test("requires valid subject and Ramose database/class claims", async () => {
    const invalid = [
      payload({ sub: undefined }),
      payload({ sub: "" }),
      payload({ ramose: { db: "acme", class: "" } }),
      payload({ ramose: { db: "acme", class: "   " } }),
      payload({ ramose: { db: "has/slash", class: "member" } }),
      payload({ ramose: { class: "member" } }),
      payload({ ramose: { db: "acme" } }),
      payload({ ramose: undefined }),
    ];
    for (const invalidPayload of invalid) {
      const token = await sign({ payload: invalidPayload });
      expectOpaque(await rejection(token), [token]);
    }
  });

  test("maps every signature, registered-claim, time, and algorithm failure opaquely", async () => {
    const now = nowSeconds();
    const cases = [
      await sign({ header: { alg: "ES256" } }),
      await sign({ payload: payload({ exp: now - 6, iat: now - 100 }) }),
      await sign({ payload: payload({ nbf: now + 60 }) }),
      await sign({ payload: payload({ iat: now + 6, exp: now + 306 }) }),
      await sign({ payload: payload({ iat: now, exp: now + 901 }) }),
      await sign({ payload: payload({ iss: "https://wrong.example" }) }),
      await sign({ payload: payload({ aud: "wrong-audience" }) }),
      await sign({ payload: payload({ iat: undefined }) }),
      await sign({ payload: payload({ exp: undefined }) }),
      await sign({ payload: payload({ iat: now + 0.5 }) }),
      await sign({ payload: payload({ exp: now + 300.5 }) }),
      await sign({ payload: payload({ nbf: now - 0.5 }) }),
    ];

    const hmac = await new SignJWT(payload())
      .setProtectedHeader({ alg: "HS256", kid: "hmac-secret-kid" })
      .sign(new TextEncoder().encode("a-secret-that-must-not-leak"));
    cases.push(hmac);

    for (const token of cases) {
      expectOpaque(await rejection(token), [
        token,
        "wrong.example",
        "wrong-audience",
        "hmac-secret-kid",
      ]);
    }
  });

  test("applies temporal post-checks against the fresh verification time", () => {
    const now = 1_000;
    expect(temporalClaimsHold(now, now + 1, undefined, now * 1_000)).toBe(
      true,
    );
    expect(
      temporalClaimsHold(now, now + 1, undefined, (now + 6) * 1_000),
    ).toBe(true);
    expect(
      temporalClaimsHold(now, now + 1, undefined, (now + 7) * 1_000),
    ).toBe(false);

    expect(
      temporalClaimsHold(now + 5, now + 100, undefined, now * 1_000),
    ).toBe(true);
    expect(
      temporalClaimsHold(now + 6, now + 100, undefined, now * 1_000),
    ).toBe(false);
    expect(temporalClaimsHold(now, now + 100, now + 5, now * 1_000)).toBe(
      true,
    );
    expect(temporalClaimsHold(now, now + 100, now + 6, now * 1_000)).toBe(
      false,
    );
  });

  test("uses the configured issuer set and maximum lifetime default", async () => {
    const token = await sign({
      payload: payload({
        iss: "https://issuer-two.example",
        exp: nowSeconds() + 900,
      }),
    });
    const verifierEnv = env([keyA.publicJwk], {
      RAMOSE_JWT_ISS: `${ISS}, https://issuer-two.example`,
      RAMOSE_JWT_MAX_TTL: undefined,
    });
    expect((await verify(token, verifierEnv)).principal.claims.iss).toBe(
      "https://issuer-two.example",
    );
  });

  test("malformed or incomplete verifier configuration always denies", async () => {
    const token = await sign();
    const invalidEnvs = [
      env([], { RAMOSE_JWKS_JSON: undefined }),
      env([], { RAMOSE_JWKS_JSON: "not-json" }),
      env([], { RAMOSE_JWKS_JSON: '{"keys":"wrong"}' }),
      env([], { RAMOSE_JWT_ISS: undefined }),
      env([], { RAMOSE_JWT_AUD: undefined }),
      env([], { RAMOSE_JWT_MAX_TTL: "900.5" }),
    ];
    for (const invalidEnv of invalidEnvs) {
      expectOpaque(await rejection(token, invalidEnv), [token, "not-json"]);
    }
  });

  test("remote-only JWKS resolves through the named service", async () => {
    const token = await sign();
    const urls: string[] = [];
    const binding: JwksServiceBinding = {
      fetch: async (url) => {
        urls.push(url);
        return Response.json({ keys: [keyA.publicJwk] });
      },
    };
    const remoteEnv = env([], {
      RAMOSE_JWKS_JSON: undefined,
      RAMOSE_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      RAMOSE_JWKS_SERVICE: "JWKS",
      JWKS: binding,
    });
    expect((await verify(token, remoteEnv)).kid).toBe("key-a");
    expect(urls).toEqual([
      "https://issuer.example.test/.well-known/jwks.json",
    ]);
  });

  test("configuring both remote and inline JWKS denies all", async () => {
    const token = await sign();
    let fetched = false;
    const binding: JwksServiceBinding = {
      fetch: async () => {
        fetched = true;
        return Response.json({ keys: [keyA.publicJwk] });
      },
    };
    const bothEnv = env([keyA.publicJwk], {
      RAMOSE_JWKS_URL: "https://issuer.example.test/.well-known/jwks.json",
      RAMOSE_JWKS_SERVICE: "JWKS",
      JWKS: binding,
    });

    expectOpaque(await rejection(token, bothEnv), [token]);
    expect(fetched).toBe(false);
  });

  test("maps JWKS network and abort failures to the same Unauthorized", async () => {
    const token = await sign();
    const remote = (binding: JwksServiceBinding) =>
      env([], {
        RAMOSE_JWKS_JSON: undefined,
        RAMOSE_JWKS_URL: "https://jwks.example.test/keys?private=diagnostic",
        RAMOSE_JWKS_SERVICE: "JWKS",
        JWKS: binding,
      });

    const network = {
      fetch: async () => {
        throw new Error("JWKS private diagnostic");
      },
    };
    expectOpaque(await rejection(token, remote(network)), [
      token,
      "private diagnostic",
      "jwks.example.test",
    ]);

    resetJwtVerifier();
    const aborted = {
      fetch: async () => {
        throw new DOMException("secret abort reason", "AbortError");
      },
    };
    expectOpaque(await rejection(token, remote(aborted)), [
      token,
      "secret abort reason",
    ]);
  });

  test("memoizes one verifier and jose resolver per config", () => {
    const configured = env();
    expect(fromEnv(configured)).toBe(fromEnv({ ...configured }));
    expect(
      fromEnv({ ...configured, RAMOSE_JWT_MAX_TTL: "300" }),
    ).not.toBe(fromEnv(configured));
  });
});

describe("service-binding customFetch", () => {
  test("forwards jose's URL, headers, method, redirect, and AbortSignal", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const binding: JwksServiceBinding = {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ keys: [] });
      },
    };
    const headers = new Headers({ accept: "application/json", "x-test": "yes" });
    const controller = new AbortController();
    await serviceBindingFetch(binding)("https://issuer.example/jwks", {
      headers,
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://issuer.example/jwks");
    expect(calls[0]!.init.headers).toBe(headers);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe("issuer-owned overlapping-key rotation", () => {
  test("{A} → {A,B} → {B} trusts exactly the currently published kids", async () => {
    const tokenA = await sign({ key: keyA });
    const tokenB = await sign({ key: keyB });
    const onlyA = env([keyA.publicJwk]);
    const overlap = env([keyA.publicJwk, keyB.publicJwk]);
    const onlyB = env([keyB.publicJwk]);

    expect((await verify(tokenA, onlyA)).kid).toBe("key-a");
    expectOpaque(await rejection(tokenB, onlyA), [tokenB, "key-b"]);

    expect((await verify(tokenA, overlap)).kid).toBe("key-a");
    expect((await verify(tokenB, overlap)).kid).toBe("key-b");

    expect((await verify(tokenB, onlyB)).kid).toBe("key-b");
    expectOpaque(await rejection(tokenA, onlyB), [tokenA, "key-a"]);
  });
});
