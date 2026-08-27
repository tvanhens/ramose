/**
 * Bounded JWKS loader. Clock owns cache TTL; jose does not.
 *
 * @internal
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import type { JSONWebKeySet } from "jose";
import { JwksUnavailable } from "./failures.ts";

export const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
export const JWKS_RETIRED_GRACE_MS = JWKS_CACHE_TTL_MS;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;
export const JWKS_MAX_GENERATIONS = 2;

export type AuthBindings = {
  readonly RAMOSE_JWKS_URL?: string | undefined;
  readonly RAMOSE_JWKS_JSON?: string | undefined;
  readonly RAMOSE_JWKS_SERVICE?: string | undefined;
  readonly RAMOSE_JWT_ISS?: string | undefined;
  readonly RAMOSE_JWT_AUD?: string | undefined;
  readonly RAMOSE_JWT_MAX_TTL?: string | undefined;
};

export interface JwksService {
  readonly keySet: Effect.Effect<JWTVerifyGetKey, JwksUnavailable>;
  readonly candidates: Effect.Effect<readonly JWTVerifyGetKey[], JwksUnavailable>;
  readonly invalidate: Effect.Effect<void>;
  readonly refresh: Effect.Effect<JWTVerifyGetKey, JwksUnavailable>;
}

export class Jwks extends Context.Service<Jwks, JwksService>()(
  "ramose/authorization/runtime/Jwks",
) {}

type Fetcher = {
  readonly fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
};

const isFetcher = (x: unknown): x is Fetcher =>
  typeof x === "object" && x !== null && typeof (x as Fetcher).fetch === "function";

const isAbort = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  ((cause as { name?: string }).name === "AbortError" ||
    (cause as { _tag?: string })._tag === "AbortError");

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isImportableJwk = (key: unknown): key is JSONWebKeySet["keys"][number] => {
  if (typeof key !== "object" || key === null || Array.isArray(key)) return false;
  const jwk = key as Record<string, unknown>;
  if (!nonEmptyString(jwk.kty)) return false;
  switch (jwk.kty) {
    case "EC":
      return nonEmptyString(jwk.crv) && nonEmptyString(jwk.x) && nonEmptyString(jwk.y);
    case "RSA":
      return nonEmptyString(jwk.n) && nonEmptyString(jwk.e);
    case "OKP":
      return nonEmptyString(jwk.crv) && nonEmptyString(jwk.x);
    default:
      return false;
  }
};

const parseJwks = (value: unknown): JSONWebKeySet | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return undefined;
  const importable = keys.filter(isImportableJwk);
  if (importable.length === 0) return undefined;
  return { keys: importable };
};

const unavailable = (message: string) => new JwksUnavailable({ message });

type Generation = {
  readonly at: number;
  readonly getKey: JWTVerifyGetKey;
  readonly fingerprint: string;
  readonly retiredAt?: number;
};

const PUBLIC_JWK_FIELDS = ["alg", "crv", "e", "kid", "kty", "n", "use", "x", "y"] as const;

const publicField = (key: JSONWebKeySet["keys"][number], field: (typeof PUBLIC_JWK_FIELDS)[number]) => {
  const value = (key as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
};

const fingerprintKey = (key: JSONWebKeySet["keys"][number]): string => {
  const publicFields: Record<string, string | null> = {};
  for (const field of PUBLIC_JWK_FIELDS) {
    publicFields[field] = publicField(key, field);
  }
  return JSON.stringify(publicFields);
};

export const fingerprintOf = (jwks: JSONWebKeySet): string =>
  jwks.keys.map(fingerprintKey).sort().join("\0");

const isLiveRetired = (generation: Generation, now: number): boolean =>
  generation.retiredAt !== undefined && now - generation.retiredAt < JWKS_RETIRED_GRACE_MS;

const pruneExpiredRetired = (now: number, generations: Generation[]): void => {
  for (let i = generations.length - 1; i >= 1; i--) {
    if (!isLiveRetired(generations[i]!, now)) generations.splice(i, 1);
  }
};

const combine = (now: number, generations: Generation[]): JWTVerifyGetKey => {
  pruneExpiredRetired(now, generations);
  const current = generations[0];
  if (current === undefined) {
    return async () => {
      throw unavailable("jwks");
    };
  }
  const live = generations.map((generation) => generation.getKey);
  if (live.length === 1) return live[0]!;
  return async (header, token) => {
    try {
      return await live[0]!(header, token);
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY"
      ) {
        for (let i = 1; i < live.length; i++) {
          try {
            return await live[i]!(header, token);
          } catch {
            // try older generation
          }
        }
      }
      throw cause;
    }
  };
};

const jwksFetch = (env: AuthBindings): Fetcher["fetch"] => {
  const name = env.RAMOSE_JWKS_SERVICE;
  if (!name) return (input, init) => fetch(input, init);
  const binding = (env as Record<string, unknown>)[name];
  if (!isFetcher(binding)) {
    throw unavailable("jwks");
  }
  return (input, init) => binding.fetch(input, init);
};

const loadRemote = (
  url: string,
  fetchImpl: Fetcher["fetch"],
): Effect.Effect<JSONWebKeySet, JwksUnavailable> =>
  Effect.tryPromise({
    try: (signal) =>
      fetchImpl(url, { signal }).then(async (response) => {
        if (!response.ok) throw unavailable("jwks");
        return response.json() as Promise<unknown>;
      }),
    catch: (cause) => {
      if (cause instanceof JwksUnavailable) return cause;
      if (isAbort(cause)) return unavailable("cancelled");
      return unavailable("jwks");
    },
  }).pipe(
    Effect.flatMap((body) => {
      const parsed = parseJwks(body);
      return parsed === undefined
        ? Effect.fail(unavailable("jwks"))
        : Effect.succeed(parsed);
    }),
    Effect.timeoutOrElse({
      duration: `${JWKS_FETCH_TIMEOUT_MS} millis`,
      orElse: () => Effect.fail(unavailable("jwks")),
    }),
  );

export const createJwks = (env: AuthBindings): JwksService => {
  const generations: Generation[] = [];
  let stale = false;
  let lastKidRefreshAt = 0;
  let lastRemoteAttemptAt = 0;
  let pending: Deferred.Deferred<JWTVerifyGetKey, JwksUnavailable> | undefined;
  const loadedByFiber = new WeakSet<object>();
  let fetchImpl: Fetcher["fetch"] | undefined;
  let fetchError: JwksUnavailable | undefined;
  try {
    fetchImpl = env.RAMOSE_JWKS_URL ? jwksFetch(env) : undefined;
  } catch (cause) {
    fetchError = cause instanceof JwksUnavailable ? cause : unavailable("jwks");
  }

  const localJson = (): JSONWebKeySet | undefined => {
    if (!env.RAMOSE_JWKS_JSON) return undefined;
    try {
      return parseJwks(JSON.parse(env.RAMOSE_JWKS_JSON));
    } catch {
      return undefined;
    }
  };

  const push = (at: number, jwks: JSONWebKeySet): JWTVerifyGetKey => {
    const fingerprint = fingerprintOf(jwks);
    const current = generations[0];
    if (current !== undefined && current.fingerprint === fingerprint) {
      generations[0] = { at, getKey: current.getKey, fingerprint };
      stale = false;
      return combine(at, generations);
    }
    if (current !== undefined) {
      generations[0] = { ...current, retiredAt: at };
    }
    generations.unshift({ at, getKey: createLocalJWKSet(jwks), fingerprint });
    generations.splice(JWKS_MAX_GENERATIONS);
    stale = false;
    return combine(at, generations);
  };

  const markLoaded = Effect.withFiber((fiber) =>
    Effect.sync(() => {
      loadedByFiber.add(fiber);
    }),
  );

  const unmarkLoaded = Effect.withFiber((fiber) =>
    Effect.sync(() => {
      loadedByFiber.delete(fiber);
    }),
  );

  const loadedByThisFiber = Effect.withFiber((fiber) => Effect.succeed(loadedByFiber.has(fiber)));

  const awaitPending = (d: Deferred.Deferred<JWTVerifyGetKey, JwksUnavailable>) =>
    Effect.gen(function* () {
      const keys = yield* Deferred.await(d);
      yield* markLoaded;
      return keys;
    });

  const doLoad = (now: number): Effect.Effect<JWTVerifyGetKey, JwksUnavailable> =>
    Effect.gen(function* () {
      const url = env.RAMOSE_JWKS_URL;
      if (url) {
        lastRemoteAttemptAt = now;
        const parsed = yield* loadRemote(url, fetchImpl as Fetcher["fetch"]);
        return push(now, parsed);
      }
      const parsed = localJson();
      if (parsed === undefined) return yield* unavailable("jwks");
      return push(now, parsed);
    });

  // Isolate-wide: at most one in-flight JWKS load. Joiners await the same Deferred.
  const loadOnce = (now: number): Effect.Effect<JWTVerifyGetKey, JwksUnavailable> =>
    Effect.gen(function* () {
      if (pending !== undefined) return yield* awaitPending(pending);
      const d = yield* Deferred.make<JWTVerifyGetKey, JwksUnavailable>();
      if (pending !== undefined) return yield* awaitPending(pending);
      pending = d;
      yield* doLoad(now).pipe(
        Effect.matchEffect({
          onFailure: (e) => {
            if (generations[0] !== undefined) stale = false;
            return Deferred.fail(d, e);
          },
          onSuccess: (a) => Deferred.succeed(d, a),
        }),
        Effect.ensuring(
          Effect.gen(function* () {
            pending = undefined;
            yield* Deferred.fail(d, unavailable("jwks"));
          }),
        ),
      );
      yield* markLoaded;
      return yield* Deferred.await(d);
    });

  const keySet = Effect.gen(function* () {
    if (fetchError !== undefined) return yield* fetchError;
    const now = yield* Clock.currentTimeMillis;
    const current = generations[0];
    if (lastRemoteAttemptAt !== 0 && now - lastRemoteAttemptAt < JWKS_REFRESH_COOLDOWN_MS) {
      if (current === undefined) return yield* unavailable("jwks");
      yield* unmarkLoaded;
      return combine(now, generations);
    }
    if (!stale && current !== undefined && now - current.at < JWKS_CACHE_TTL_MS) {
      yield* unmarkLoaded;
      return combine(now, generations);
    }
    return yield* loadOnce(now);
  }).pipe(Effect.withSpan("Jwks.keySet"));

  const candidates = keySet.pipe(
    Effect.map(() => generations.map((generation) => generation.getKey)),
    Effect.withSpan("Jwks.candidates"),
  );

  const invalidate = Effect.sync(() => {
    stale = true;
  });

  const refresh = Effect.gen(function* () {
    if (fetchError !== undefined) return yield* fetchError;
    const now = yield* Clock.currentTimeMillis;
    if (pending !== undefined) return yield* Deferred.await(pending);

    const current = generations[0];
    const alreadyLoaded = yield* loadedByThisFiber;
    // Same admit already awaited this generation, or it was loaded at this
    // Clock instant (TestClock: now === current.at). Do not refetch — the
    // just-loaded set cannot contain an unknown kid. Cache-hit + new kid
    // after the clock moves is allowed below (generation.at is in the past).
    if (alreadyLoaded || (current !== undefined && now - current.at === 0)) {
      if (lastKidRefreshAt === 0) lastKidRefreshAt = now;
      if (current === undefined) return yield* unavailable("jwks");
      return combine(now, generations);
    }

    if (lastKidRefreshAt !== 0 && now - lastKidRefreshAt < JWKS_REFRESH_COOLDOWN_MS) {
      if (current === undefined) return yield* unavailable("jwks");
      return combine(now, generations);
    }
    lastKidRefreshAt = now;
    stale = true;
    // Kid-miss refresh is gated by lastKidRefreshAt. Load directly so a
    // rotation fetch can proceed while lastRemoteAttemptAt still cools
    // keySet (TTL / stale / failed-parse retries).
    return yield* loadOnce(now);
  }).pipe(Effect.withSpan("Jwks.refresh"));

  return { keySet, candidates, invalidate, refresh };
};
