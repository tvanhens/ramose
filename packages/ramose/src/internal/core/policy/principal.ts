/** The verified caller. Built by the peer from a JWT; frozen for the request. */

import type { ClaimPath } from "./ast.ts";

export interface PrincipalClaims {
  readonly sub?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  /** app claims (`ramose.attrs`), shaped by the policy's `claims` schema */
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface Principal {
  readonly kind: "service" | "user" | "anonymous";
  /** exactly one, declared in the policy's `classes` */
  readonly class: string;
  readonly sub?: string;
  /** the principal entity resolved via the policy's `principal` attribute */
  readonly eid?: number;
  readonly claims: PrincipalClaims;
  /** the database this principal is bound to (`ramose.db`) */
  readonly db: string;
}

/**
 * Admin skips every check. Deliberately keyed on the *class* alone: a service
 * token is not a data-plane admin on a named database, so `kind: "service"`
 * grants nothing on its own.
 */
export function isAdmin(p: Principal): boolean {
  return p.class === "admin";
}

/** A principal is bound to exactly one database — exact match, no globs. */
export function allows(p: Principal, dbName: string): boolean {
  return p.db === dbName;
}

export function claimValue(p: Principal, path: ClaimPath): unknown {
  let cur: unknown = p.claims;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function anonymousPrincipal(db: string, cls = "anonymous"): Principal {
  return { kind: "anonymous", class: cls, claims: {}, db };
}
