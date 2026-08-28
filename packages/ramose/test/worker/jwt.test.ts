import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as Clock from "effect/Clock";
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
  temporalClaimsHold,
} from "../../src/worker/jwt.ts";

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);
const ISS = "https://issuer.example.test";
const AUD = "ramose:test";
const UTF8 = new TextEncoder();

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
    ramose: { class: "member" },
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
          ramose: { class: "member", attrs: value },
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
    const escapedText = '"'.repeat(MAX_STRING_LENGTH);
    const escapeHeavy = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`escaped${index}`, escapedText]),
    );
    const rawEscapeHeavyBytes = Object.entries(escapeHeavy).reduce(
      (bytes, [key, value]) =>
        bytes +
        UTF8.encode(key).byteLength +
        UTF8.encode(value).byteLength,
      0,
    );
    const encodedEscapeHeavyBytes = Object.entries(escapeHeavy).reduce(
      (bytes, [key, value]) =>
        bytes +
        UTF8.encode(JSON.stringify(key)).byteLength +
        UTF8.encode(JSON.stringify(value)).byteLength,
      0,
    );
    expect(escapedText.length).toBe(MAX_STRING_LENGTH);
    expect(rawEscapeHeavyBytes).toBeLessThan(MAX_JSON_ENCODED_BYTES);
    expect(encodedEscapeHeavyBytes).toBeGreaterThan(MAX_JSON_ENCODED_BYTES);
    const oversized = [
      { deep },
      broad,
      { list: Array.from({ length: MAX_COLLECTION_SIZE + 1 }, () => 1) },
      { text: "x".repeat(MAX_STRING_LENGTH + 1) },
      { ["k".repeat(MAX_STRING_LENGTH + 1)]: "value" },
      oversizedText,
      escapeHeavy,
    ];

    for (const attrs of oversized) {
      const token = await sign({
        payload: payload({
          ramose: { class: "member", attrs },
        }),
      });
      expectOpaque(await rejection(token), [token]);
    }
  });

  test("requires valid subject and Ramose class claims", async () => {
    const invalid = [
      payload({ sub: undefined }),
      payload({ sub: "" }),
      payload({ ramose: { class: "" } }),
      payload({ ramose: { class: "   " } }),
      payload({ ramose: { db: "acme" } }),
      payload({ ramose: undefined }),
    ];
    for (const invalidPayload of invalid) {
      const token = await sign({ payload: invalidPayload });
      expectOpaque(await rejection(token), [token]);
    }
  });

  test("verifies without ramose.db and ignores leftover ramose.db", async () => {
    const without = await verify(
      await sign({ payload: payload({ ramose: { class: "member" } }) }),
    );
    expect(without.principal.class).toBe("member");
    expect(without.principal).not.toHaveProperty("db");

    const leftover = await verify(
      await sign({
        payload: payload({ ramose: { db: "acme", class: "member" } }),
      }),
    );
    expect(leftover.principal.class).toBe("member");
    expect(leftover.principal).not.toHaveProperty("db");
  });

  test("maps every signature, registered-claim, time, and algorithm failure opaquely", async () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1_000);
    const frozen: Clock.Clock = {
      currentTimeMillisUnsafe: () => nowMs,
      currentTimeMillis: Effect.succeed(nowMs),
      monotonicTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
      monotonicTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
      currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
      sleep: () => Effect.void,
    };
    const rejectionAt = (token: string) =>
      Effect.runPromise(
        Effect.flip(
          Effect.provideService(verifyEffect(token), Clock.Clock, frozen),
        ),
      );
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
      expectOpaque(await rejectionAt(token), [
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

  test("configuring both remote and inline JWKS denies all", async () => {
    const token = await sign();
    const bothEnv = env([keyA.publicJwk], {
      RAMOSE_JWKS_URL: "https://issuer.example.test/jwks",
    });

    expectOpaque(await rejection(token, bothEnv), [token]);
  });

  test("memoizes one verifier and jose resolver per config", () => {
    const configured = env();
    expect(fromEnv(configured)).toBe(fromEnv({ ...configured }));
    expect(
      fromEnv({ ...configured, RAMOSE_JWT_MAX_TTL: "300" }),
    ).not.toBe(fromEnv(configured));
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
