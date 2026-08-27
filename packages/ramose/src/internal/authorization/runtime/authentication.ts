/**
 * JWT admission (AUTH-2). HTTP and WebSocket share one verify contract.
 *
 * @internal
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { DEFAULT_JWT_MAX_TTL } from "../../../Auth.ts";
import { isDatabaseName } from "../../../db/DatabaseName.ts";
import { envInt } from "../../transactor/env.ts";
import { AuthenticationRejected, type AuthenticationAdmissionFailure } from "./failures.ts";
import { type JwksService } from "./jwks.ts";
import { makeVerifiedPrincipal, type VerifiedPrincipal } from "./verified-principal.ts";

const ALGS = ["RS256", "ES256", "EdDSA"] as const;

export interface AdmissionRequest {
  readonly database: string;
  readonly token: Redacted.Redacted<string>;
  readonly route: "http" | "websocket";
}

export interface VerifiedAdmission {
  readonly principal: VerifiedPrincipal;
  readonly expiresAt: number;
}

export interface AuthenticationAdmissionService {
  readonly admit: (
    request: AdmissionRequest,
  ) => Effect.Effect<VerifiedAdmission, AuthenticationAdmissionFailure>;
}

export class AuthenticationAdmission extends Context.Service<
  AuthenticationAdmission,
  AuthenticationAdmissionService
>()("ramose/authorization/runtime/AuthenticationAdmission") {}

export type AdmissionEnv = {
  readonly RAMOSE_JWT_ISS?: string | undefined;
  readonly RAMOSE_JWT_AUD?: string | undefined;
  readonly RAMOSE_JWT_MAX_TTL?: string | undefined;
};

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const rejected = (message: string) => new AuthenticationRejected({ message });

const isNoMatchingKey = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY";

const joseReason = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) return "claims";
  const code = (cause as { code?: string }).code;
  const claim = (cause as { claim?: string }).claim;
  if (code === "ERR_JWT_EXPIRED") return "expired";
  if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JOSE_NOT_SUPPORTED") return "alg";
  if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID") {
    return "jwks";
  }
  if (claim === "nbf") return "nbf";
  if (claim === "iss") return "iss";
  if (claim === "aud") return "aud";
  if (claim === "exp") return "expired";
  return "claims";
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateClaims = (
  payload: JWTPayload,
  request: AdmissionRequest,
  now: number,
  maxTtl: number,
  fallbackAud: string,
): Result.Result<VerifiedPrincipal, AuthenticationRejected> =>
  Result.gen(function* () {
    if (typeof payload.exp !== "number") return yield* Result.fail(rejected("expired"));
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== "number" || payload.nbf * 1000 > now) {
        return yield* Result.fail(rejected("nbf"));
      }
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return yield* Result.fail(rejected("sub"));
    }
    if (!isPlainObject(payload.ramose)) return yield* Result.fail(rejected("claims"));
    const ramose = payload.ramose;
    if (typeof ramose.db !== "string" || typeof ramose.class !== "string" || ramose.class.length === 0) {
      return yield* Result.fail(rejected("claims"));
    }
    if (ramose.db !== request.database) return yield* Result.fail(rejected("db"));
    if (!isDatabaseName(ramose.db)) return yield* Result.fail(rejected("db"));
    if (ramose.attrs !== undefined && !isPlainObject(ramose.attrs)) {
      return yield* Result.fail(rejected("claims"));
    }
    if (typeof payload.iat !== "number") return yield* Result.fail(rejected("ttl"));
    if (payload.exp - payload.iat > maxTtl) return yield* Result.fail(rejected("ttl"));
    if (typeof payload.iss !== "string" || payload.iss.length === 0) {
      return yield* Result.fail(rejected("iss"));
    }
    return makeVerifiedPrincipal({
      subject: payload.sub,
      database: ramose.db,
      className: ramose.class,
      iss: payload.iss,
      aud: fallbackAud,
      exp: payload.exp,
      iat: payload.iat,
      nbf: typeof payload.nbf === "number" ? payload.nbf : undefined,
      attrs: ramose.attrs === undefined ? undefined : (ramose.attrs as Record<string, unknown>),
    });
  });

const verifyOnce = (
  token: string,
  keys: JWTVerifyGetKey,
  now: number,
  issuers: readonly string[],
  aud: string,
): Effect.Effect<JWTPayload, AuthenticationRejected> =>
  Effect.tryPromise({
    try: () =>
      jwtVerify(token, keys, {
        algorithms: [...ALGS],
        issuer: [...issuers],
        audience: aud,
        currentDate: new Date(now),
      }).then((verified) => verified.payload),
    catch: (cause) =>
      rejected(isNoMatchingKey(cause) ? "kid" : joseReason(cause)),
  });

export const createAuthentication = (
  env: AdmissionEnv,
  jwks: JwksService,
): AuthenticationAdmissionService => {
  const issuers = csv(env.RAMOSE_JWT_ISS);
  const aud = env.RAMOSE_JWT_AUD;
  const maxTtl = envInt(env.RAMOSE_JWT_MAX_TTL, DEFAULT_JWT_MAX_TTL);

  const admit = Effect.fn("AuthenticationAdmission.admit")(function* (request: AdmissionRequest) {
    const token = Redacted.value(request.token).trim();
    if (token.length === 0) return yield* rejected("missing");
    if (issuers.length === 0) return yield* rejected("iss");
    if (aud === undefined || aud.length === 0) return yield* rejected("aud");

    const now = yield* Clock.currentTimeMillis;
    const keys = yield* jwks.keySet;
    let payload = yield* verifyOnce(token, keys, now, issuers, aud).pipe(Effect.result);
    if (Result.isFailure(payload) && payload.failure.message === "kid") {
      yield* jwks.invalidate;
      const rotated = yield* jwks.keySet;
      payload = yield* verifyOnce(token, rotated, now, issuers, aud).pipe(Effect.result);
    }
    if (Result.isFailure(payload)) {
      return yield* rejected(
        payload.failure.message === "kid" ? "jwks" : payload.failure.message,
      );
    }
    const principal = yield* Effect.fromResult(
      validateClaims(payload.success, request, now, maxTtl, aud),
    );
    return { principal, expiresAt: principal.expiresAt };
  });

  return { admit };
};
