/**
 * Bounded JWKS loader. Clock owns cache TTL; jose does not.
 *
 * @internal
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import type { JSONWebKeySet } from "jose";
import { JwksUnavailable } from "./failures.ts";

export const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
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
  readonly invalidate: Effect.Effect<void>;
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

const parseJwks = (value: unknown): JSONWebKeySet | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return undefined;
  return value as JSONWebKeySet;
};

const unavailable = (message: string) => new JwksUnavailable({ message });

type Generation = {
  readonly at: number;
  readonly getKey: JWTVerifyGetKey;
};

const combine = (generations: readonly Generation[]): JWTVerifyGetKey => {
  const current = generations[0];
  if (current === undefined) {
    return async () => {
      throw unavailable("jwks");
    };
  }
  if (generations.length === 1) return current.getKey;
  return async (header, token) => {
    try {
      return await current.getKey(header, token);
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY"
      ) {
        for (let i = 1; i < generations.length; i++) {
          try {
            return await generations[i]!.getKey(header, token);
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
  );

export const createJwks = (env: AuthBindings): JwksService => {
  const generations: Generation[] = [];
  let stale = false;
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
    generations.unshift({ at, getKey: createLocalJWKSet(jwks) });
    generations.splice(JWKS_MAX_GENERATIONS);
    stale = false;
    return combine(generations);
  };

  const keySet = Effect.gen(function* () {
    if (fetchError !== undefined) return yield* fetchError;
    const now = yield* Clock.currentTimeMillis;
    const current = generations[0];
    if (!stale && current !== undefined && now - current.at < JWKS_CACHE_TTL_MS) {
      return combine(generations);
    }
    const url = env.RAMOSE_JWKS_URL;
    if (url) {
      const parsed = yield* loadRemote(url, fetchImpl as Fetcher["fetch"]);
      return push(now, parsed);
    }
    const parsed = localJson();
    if (parsed === undefined) return yield* unavailable("jwks");
    return push(now, parsed);
  }).pipe(Effect.withSpan("Jwks.keySet"));

  const invalidate = Effect.sync(() => {
    stale = true;
  });

  return { keySet, invalidate };
};
