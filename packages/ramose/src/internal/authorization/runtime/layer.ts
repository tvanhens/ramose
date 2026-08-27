/**
 * Isolate-scoped JWKS + admission layers. Cached per env object so the
 * JWKS generation cache survives across requests.
 *
 * @internal
 */

import * as Layer from "effect/Layer";
import type { RamoseEnv } from "../../../RamoseEnv.ts";
import { AuthenticationAdmission, createAuthentication } from "./authentication.ts";
import { Jwks, createJwks, type AuthBindings } from "./jwks.ts";

export type { AuthBindings };

type Cached = {
  readonly jwks: Layer.Layer<Jwks>;
  readonly auth: Layer.Layer<AuthenticationAdmission | Jwks>;
};

const cache = new WeakMap<object, Cached>();

const build = (env: AuthBindings): Cached => {
  const jwks = createJwks(env);
  const admission = createAuthentication(env, jwks);
  return {
    jwks: Layer.succeed(Jwks, jwks),
    auth: Layer.mergeAll(Layer.succeed(Jwks, jwks), Layer.succeed(AuthenticationAdmission, admission)),
  };
};

const cachedOf = (env: object): Cached => {
  const hit = cache.get(env);
  if (hit !== undefined) return hit;
  const built = build(env as AuthBindings);
  cache.set(env, built);
  return built;
};

export const jwksLayer = (env: RamoseEnv | AuthBindings): Layer.Layer<Jwks> =>
  cachedOf(env).jwks;

export const authenticationLayer = (
  env: RamoseEnv | AuthBindings,
): Layer.Layer<AuthenticationAdmission | Jwks> => cachedOf(env).auth;

export const localAuthenticationLayer = (options: {
  readonly jwksJson: string;
  readonly issuers: readonly string[] | string;
  readonly aud: string;
  readonly maxTtl?: number | undefined;
}): Layer.Layer<AuthenticationAdmission | Jwks> => {
  const env: AuthBindings = {
    RAMOSE_JWKS_JSON: options.jwksJson,
    RAMOSE_JWT_ISS:
      typeof options.issuers === "string" ? options.issuers : options.issuers.join(","),
    RAMOSE_JWT_AUD: options.aud,
    ...(options.maxTtl === undefined ? {} : { RAMOSE_JWT_MAX_TTL: String(options.maxTtl) }),
  };
  return build(env).auth;
};
