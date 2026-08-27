/**
 * Authentication admission (AUTH-1).
 *
 * Verified JWT principals plus compiled policy are the only external
 * access model. No anonymous/open mode, RAMOSE_TOKEN, shared secret,
 * seed token, or API-key fallback. #344 implements verification.
 *
 * Admission runs before database, entity, or operation existence is
 * revealed (AUTH-5).
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { DatabaseId } from "../identities.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import type { AuthenticationAdmissionFailure } from "./failures.ts";

export interface AdmissionRequest {
  readonly database: DatabaseId;
  readonly token: Redacted.Redacted<string>;
  readonly route: "http" | "websocket";
}

export interface AdmissionTicket {
  readonly principal: AuthorizationPrincipal;
  readonly leaseEpoch: number;
  readonly expiresAt: number;
}

export interface AuthenticationAdmissionService {
  readonly admit: (
    request: AdmissionRequest,
  ) => Effect.Effect<AdmissionTicket, AuthenticationAdmissionFailure>;
}

export class AuthenticationAdmission extends Context.Service<
  AuthenticationAdmission,
  AuthenticationAdmissionService
>()("ramose/authorization/runtime/AuthenticationAdmission") {}
