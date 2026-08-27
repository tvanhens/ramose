/**
 * Immutable verified-principal value. Token material is never stored.
 *
 * @internal
 */

import type { JsonValue } from "../json.ts";
import type { AuthorizationPrincipal } from "../principal.ts";

export interface VerifiedClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface VerifiedPrincipal {
  readonly subject: string;
  readonly database: string;
  readonly classes: readonly string[];
  readonly claims: VerifiedClaims;
  readonly expiresAt: number;
}

const freeze = <T>(value: T): T => Object.freeze(value);

const freezeJson = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return freeze(value.map((item) => freezeJson(item))) as T;
  }
  return freeze(
    Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeJson(nested)])),
  ) as T;
};

export const makeVerifiedPrincipal = (input: {
  readonly subject: string;
  readonly database: string;
  readonly className: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat?: number | undefined;
  readonly nbf?: number | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}): VerifiedPrincipal => {
  const claims: VerifiedClaims = freeze({
    sub: input.subject,
    iss: input.iss,
    aud: input.aud,
    exp: input.exp,
    ...(input.iat === undefined ? {} : { iat: input.iat }),
    ...(input.nbf === undefined ? {} : { nbf: input.nbf }),
    ...(input.attrs === undefined ? {} : { attrs: freezeJson({ ...input.attrs }) }),
  });
  return freeze({
    subject: input.subject,
    database: input.database,
    classes: freeze([input.className]),
    claims,
    expiresAt: input.exp * 1000,
  });
};

/** Catalog resolves `me` later. */
export const toAuthorizationPrincipal = (p: VerifiedPrincipal): AuthorizationPrincipal => ({
  subject: p.subject,
  claims: { ...p.claims } as { readonly [key: string]: JsonValue },
  classes: [...p.classes],
});
