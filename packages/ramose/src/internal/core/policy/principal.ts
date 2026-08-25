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
  /**
   * Resolved class set for this database. When absent, {@link classesOf}
   * reads `[class]` (today's token-carried class). This is the seam #215
   * will fill from grant data — bypass and schema-install consult
   * {@link classesOf}, not `class` directly.
   */
  readonly classes?: readonly string[];
  readonly sub?: string;
  /** the principal entity resolved via the policy's `principal` attribute */
  readonly eid?: number;
  readonly claims: PrincipalClaims;
  /** the database this principal is bound to (`ramose.db`) */
  readonly db: string;
}

/** Head fields standing is judged against. */
export interface PolicyStanding {
  readonly superuser?: string;
  readonly schemaClasses?: readonly string[];
}

/**
 * Classes this principal holds in the current database.
 * Today: the token-carried class. #215 swaps the source for grant data
 * without changing {@link isSuperuser} / {@link canChangeSchema}.
 */
export function classesOf(p: Principal): readonly string[] {
  return p.classes ?? [p.class];
}

export function holdsClass(p: Principal, name: string): boolean {
  return classesOf(p).includes(name);
}

/**
 * Total policy bypass. Standing, not a reserved class name: the policy
 * head names the class, and {@link classesOf} is the source.
 */
export function isSuperuser(p: Principal, policy: PolicyStanding): boolean {
  return policy.superuser !== undefined && holdsClass(p, policy.superuser);
}

/**
 * May install or grow schema. Superuser always may; otherwise the
 * principal must hold a class in `schemaClasses` (default `[superuser]`).
 */
export function canChangeSchema(p: Principal, policy: PolicyStanding): boolean {
  if (isSuperuser(p, policy)) return true;
  const allowed =
    policy.schemaClasses ?? (policy.superuser !== undefined ? [policy.superuser] : []);
  return allowed.some((c) => holdsClass(p, c));
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
