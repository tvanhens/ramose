import { DEFAULT_JWT_MAX_TTL } from "../Auth.ts";
import { isDatabaseName } from "../db/DatabaseName.ts";
import {
  MAX_COLLECTION_SIZE,
  MAX_JSON_DEPTH,
  MAX_JSON_ENCODED_BYTES,
  MAX_JSON_NODES,
  MAX_STRING_LENGTH,
} from "../internal/authorization/bounds.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type CompactJWSHeaderParameters,
  type FetchImplementation,
  type JSONWebKeySet,
  type JWTPayload,
  type RemoteJWKSetOptions,
} from "jose";
import { Unauthorized } from "./errors.ts";
import {
  type Principal,
  type PrincipalAttrs,
  type PrincipalClaimScalar,
  type VerifiedPrincipal,
} from "./auth.ts";

const ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;
const CLOCK_TOLERANCE_SECONDS = 5;

type JwtVerifierEnv = Pick<
  RamoseEnv,
  | "RAMOSE_JWKS_URL"
  | "RAMOSE_JWKS_JSON"
  | "RAMOSE_JWKS_SERVICE"
  | "RAMOSE_JWT_ISS"
  | "RAMOSE_JWT_AUD"
  | "RAMOSE_JWT_MAX_TTL"
>;

export interface JwksServiceBinding {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface JwtVerifierClient {
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<VerifiedPrincipal, Unauthorized>;
}

export class JwtVerifier extends Context.Service<JwtVerifier, JwtVerifierClient>()(
  "ramose/worker/JwtVerifier",
) {}

const unauthorized = (): Unauthorized => new Unauthorized({});

const failure = <A = never>(): Result.Result<A, Unauthorized> =>
  Result.fail(unauthorized());

const nonBlankString = (value: unknown): Result.Result<string, Unauthorized> =>
  typeof value === "string" && value.trim().length > 0
    ? Result.succeed(value)
    : failure();

const integer = (value: unknown): Result.Result<number, Unauthorized> =>
  typeof value === "number" && Number.isInteger(value)
    ? Result.succeed(value)
    : failure();

const audience = (
  value: unknown,
): Result.Result<string | readonly string[], Unauthorized> => {
  if (typeof value === "string" && value.length > 0) return Result.succeed(value);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return Result.succeed(Object.freeze([...value]));
  }
  return failure();
};

type InspectFrame = {
  readonly value: unknown;
  readonly depth: number;
};

const UTF8 = new TextEncoder();

const encodedNumberBytes = (value: number): number =>
  Object.is(value, -0) || value === 0 ? 1 : String(value).length;

const attrsWithinBounds = (attrs: unknown): boolean => {
  const stack: InspectFrame[] = [{ value: attrs, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  const charge = (extraNodes: number, extraBytes: number): boolean => {
    nodes += extraNodes;
    bytes += extraBytes;
    return nodes <= MAX_JSON_NODES && bytes <= MAX_JSON_ENCODED_BYTES;
  };

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) return false;
      if (!charge(1, UTF8.encode(value).byteLength)) return false;
      continue;
    }
    if (typeof value === "boolean") {
      if (!charge(1, value ? 4 : 5)) return false;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!charge(1, encodedNumberBytes(value))) return false;
      continue;
    }
    if (typeof value !== "object" || value === null) return false;
    if (!charge(1, 0)) return false;
    if (depth > MAX_JSON_DEPTH || seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) return false;
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }

    const keys = Object.keys(value);
    if (keys.length > MAX_COLLECTION_SIZE) return false;
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      if (key.length > MAX_STRING_LENGTH) return false;
      if (!charge(1, UTF8.encode(key).byteLength)) return false;
      stack.push({
        value: (value as Record<string, unknown>)[key],
        depth: depth + 1,
      });
    }
  }
  return true;
};

const isClaimScalar = (value: unknown): value is PrincipalClaimScalar =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const freezeIterative = <A extends object>(root: A): A => {
  const pending: object[] = [root];
  const ordered: object[] = [];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  for (let index = ordered.length - 1; index >= 0; index--) {
    Object.freeze(ordered[index]!);
  }
  return root;
};

const principalAttrs = (
  value: unknown,
): Result.Result<PrincipalAttrs | undefined, Unauthorized> => {
  if (value === undefined) return Result.succeed(undefined);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !attrsWithinBounds(value)
  ) {
    return failure();
  }

  const attrs: Record<string, PrincipalClaimScalar | readonly PrincipalClaimScalar[]> =
    Object.create(null) as Record<
      string,
      PrincipalClaimScalar | readonly PrincipalClaimScalar[]
    >;
  for (const key of Object.keys(value)) {
    const claim = (value as Record<string, unknown>)[key];
    if (isClaimScalar(claim)) {
      attrs[key] = claim;
      continue;
    }
    if (!Array.isArray(claim) || !claim.every(isClaimScalar)) return failure();
    attrs[key] = [...claim];
  }
  return Result.succeed(freezeIterative(attrs));
};

const verifiedPrincipal = (
  token: Redacted.Redacted<string>,
  payload: JWTPayload,
  protectedHeader: CompactJWSHeaderParameters,
  nowMs: number,
  maxTtl: number,
): Result.Result<VerifiedPrincipal, Unauthorized> =>
  Result.gen(function* () {
    const kid = yield* nonBlankString(protectedHeader.kid);
    const sub = yield* nonBlankString(payload.sub);
    const iss = yield* nonBlankString(payload.iss);
    const aud = yield* audience(payload.aud);
    const iat = yield* integer(payload.iat);
    const exp = yield* integer(payload.exp);
    if (payload.nbf !== undefined) yield* integer(payload.nbf);

    const nowSeconds = Math.floor(nowMs / 1_000);
    if (iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) return yield* failure();
    const lifetime = exp - iat;
    if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > maxTtl) {
      return yield* failure();
    }

    const ramose = payload.ramose;
    if (typeof ramose !== "object" || ramose === null || Array.isArray(ramose)) {
      return yield* failure();
    }
    const db = yield* nonBlankString((ramose as Record<string, unknown>).db);
    if (!isDatabaseName(db)) return yield* failure();
    const principalClass = yield* nonBlankString(
      (ramose as Record<string, unknown>).class,
    );
    const attrs = yield* principalAttrs(
      (ramose as Record<string, unknown>).attrs,
    );

    const claims = Object.freeze({
      sub,
      iss,
      aud,
      exp,
      ...(attrs === undefined ? {} : { attrs }),
    });
    const principal: Principal = Object.freeze({
      kind: "user",
      class: principalClass,
      sub,
      claims,
      db,
    });
    return Object.freeze({ token, kid, iat, exp, principal });
  });

/** Adapt jose's exact fetch inputs to a Cloudflare service binding. */
export const serviceBindingFetch = (
  binding: JwksServiceBinding,
): FetchImplementation =>
  (url, options) =>
    binding.fetch(url, {
      headers: options.headers,
      method: options.method,
      redirect: options.redirect,
      signal: options.signal,
    });

const serviceBinding = (
  env: JwtVerifierEnv,
  name: string,
): JwksServiceBinding | undefined => {
  const candidate = (env as unknown as Record<string, unknown>)[name];
  return typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { readonly fetch?: unknown }).fetch === "function"
    ? (candidate as JwksServiceBinding)
    : undefined;
};

const parseIssuers = (value: string | undefined): readonly string[] =>
  value
    ?.split(",")
    .map((issuer) => issuer.trim())
    .filter((issuer) => issuer.length > 0) ?? [];

const parseMaxTtl = (value: string | undefined): number | undefined => {
  if (value === undefined || value.length === 0) return DEFAULT_JWT_MAX_TTL;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const denyAll = (): JwtVerifierClient => ({
  verify: () => Effect.fail(unauthorized()),
});

const makeVerifier = (env: JwtVerifierEnv): JwtVerifierClient => {
  try {
    const url = env.RAMOSE_JWKS_URL;
    const inline = env.RAMOSE_JWKS_JSON;
    const serviceName = env.RAMOSE_JWKS_SERVICE;
    const issuers = parseIssuers(env.RAMOSE_JWT_ISS);
    const aud = env.RAMOSE_JWT_AUD;
    const maxTtl = parseMaxTtl(env.RAMOSE_JWT_MAX_TTL);
    if (
      issuers.length === 0 ||
      typeof aud !== "string" ||
      aud.length === 0 ||
      maxTtl === undefined
    ) {
      return denyAll();
    }

    let resolver:
      | ReturnType<typeof createLocalJWKSet>
      | ReturnType<typeof createRemoteJWKSet>;
    if (typeof url === "string" && url.length > 0) {
      const options: RemoteJWKSetOptions = {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 5 * 60_000,
      };
      if (typeof serviceName === "string" && serviceName.length > 0) {
        const binding = serviceBinding(env, serviceName);
        if (binding === undefined) return denyAll();
        options[customFetch] = serviceBindingFetch(binding);
      }
      resolver = createRemoteJWKSet(new URL(url), options);
    } else if (typeof inline === "string" && inline.length > 0) {
      resolver = createLocalJWKSet(JSON.parse(inline) as JSONWebKeySet);
    } else {
      return denyAll();
    }

    const verify = Effect.fn("JwtVerifier.verify")(function* (
      token: Redacted.Redacted<string>,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      const verified = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(Redacted.value(token), resolver, {
            issuer: issuers.length === 1 ? issuers[0] : [...issuers],
            audience: aud,
            algorithms: [...ALGORITHMS],
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            currentDate: new Date(nowMs),
            requiredClaims: ["sub", "iat", "exp"],
          }),
        catch: () => unauthorized(),
      });
      return yield* Effect.fromResult(
        verifiedPrincipal(
          token,
          verified.payload,
          verified.protectedHeader,
          nowMs,
          maxTtl,
        ),
      );
    });
    return { verify };
  } catch {
    return denyAll();
  }
};

const verifierCache = new Map<string, JwtVerifierClient>();

/** Forget isolate-scoped verifier instances. Test hook only. */
export const resetJwtVerifier = (): void => {
  verifierCache.clear();
};

/** Build or reuse the isolate-scoped jose resolver for this auth config. */
export const fromEnv = (env: JwtVerifierEnv): JwtVerifierClient => {
  const key = JSON.stringify([
    env.RAMOSE_JWKS_URL,
    env.RAMOSE_JWKS_JSON,
    env.RAMOSE_JWKS_SERVICE,
    env.RAMOSE_JWT_ISS,
    env.RAMOSE_JWT_AUD,
    env.RAMOSE_JWT_MAX_TTL,
  ]);
  const cached = verifierCache.get(key);
  if (cached !== undefined) return cached;
  const verifier = makeVerifier(env);
  verifierCache.set(key, verifier);
  return verifier;
};
