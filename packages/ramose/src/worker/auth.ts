/**
 * Request-scoped caller metadata on the session/transactor wire.
 * Not an authorization decision.
 */

import type * as Redacted from "effect/Redacted";

export type PrincipalClaimScalar = string | number | boolean;
export type PrincipalClaimValue = PrincipalClaimScalar | readonly PrincipalClaimScalar[];
export type PrincipalAttrs = Readonly<Record<string, PrincipalClaimValue>>;

export interface Principal {
  readonly kind: "user";
  readonly class: string;
  readonly classes?: readonly string[];
  readonly sub?: string;
  readonly eid?: number;
  readonly claims: {
    readonly sub?: string;
    readonly iss?: string;
    readonly aud?: string | readonly string[];
    readonly exp?: number;
    readonly attrs?: PrincipalAttrs;
  };
  readonly db: string;
}

/**
 * Authentication result kept inside the Worker. The redacted token is
 * deliberately separate from the wire principal.
 */
export interface VerifiedPrincipal {
  readonly token: Redacted.Redacted<string>;
  readonly kid: string;
  readonly iat: number;
  readonly exp: number;
  readonly principal: Principal;
}
