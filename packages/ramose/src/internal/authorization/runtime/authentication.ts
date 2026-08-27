/**
 * Authentication admission (AUTH-1).
 *
 * Verified JWT principals plus compiled policy are the only external
 * access model. No anonymous/open mode, RAMOSE_TOKEN, shared secret,
 * seed token, or API-key fallback. #344 implements verification.
 *
 * Admission runs before database, entity, or operation existence is
 * revealed (AUTH-5). Tickets are sealed here; a nonempty subject is
 * not proof of admission.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { CatalogVersion, DatabaseId, PolicyHash } from "../identities.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import type { AuthenticationAdmissionFailure } from "./failures.ts";
import { freezePrincipal } from "./principal-freeze.ts";

export interface AdmissionRequest {
  readonly database: DatabaseId;
  readonly token: Redacted.Redacted<string>;
  readonly route: "http" | "websocket";
}

export interface AdmissionTicket {
  readonly principal: AuthorizationPrincipal;
  readonly database: DatabaseId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly leaseEpoch: number;
  readonly expiresAt: number;
}

const sealedTickets = new WeakSet<object>();

/**
 * The only producer of a runtime-acceptable admission ticket.
 * Structural lookalikes and caller-built objects are not sealed.
 */
export const issueAdmissionTicket = (input: {
  readonly principal: AuthorizationPrincipal;
  readonly database: DatabaseId;
  readonly catalogVersion: CatalogVersion;
  readonly policyHash: PolicyHash;
  readonly leaseEpoch: number;
  readonly expiresAt: number;
}): AdmissionTicket => {
  const ticket: AdmissionTicket = Object.freeze({
    principal: freezePrincipal(input.principal),
    database: input.database,
    catalogVersion: input.catalogVersion,
    policyHash: input.policyHash,
    leaseEpoch: input.leaseEpoch,
    expiresAt: input.expiresAt,
  });
  sealedTickets.add(ticket);
  return ticket;
};

export const isVerifiedAdmissionTicket = (value: unknown): value is AdmissionTicket =>
  typeof value === "object" && value !== null && sealedTickets.has(value);

export interface AuthenticationAdmissionService {
  readonly admit: (
    request: AdmissionRequest,
  ) => Effect.Effect<AdmissionTicket, AuthenticationAdmissionFailure>;
}

export class AuthenticationAdmission extends Context.Service<
  AuthenticationAdmission,
  AuthenticationAdmissionService
>()("ramose/authorization/runtime/AuthenticationAdmission") {}
