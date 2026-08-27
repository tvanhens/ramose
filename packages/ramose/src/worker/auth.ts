/**
 * Request-scoped caller metadata on the session/transactor wire.
 * Not an authorization decision. JWT verification is live; the data
 * plane stays fail-closed until catalog + filtered Db (#421/#423).
 */

import type { VerifiedPrincipal } from "../internal/authorization/runtime/verified-principal.ts";

export interface Principal {
  readonly kind: "user";
  readonly class: string;
  readonly classes?: readonly string[];
  readonly sub?: string;
  readonly eid?: number;
  readonly claims: {
    readonly sub?: string;
    readonly iss?: string;
    readonly aud?: string;
    readonly exp?: number;
    readonly attrs?: Readonly<Record<string, unknown>>;
  };
  readonly db: string;
}

export const toWirePrincipal = (p: VerifiedPrincipal): Principal => ({
  kind: "user",
  class: p.classes[0] ?? "",
  classes: p.classes,
  sub: p.subject,
  claims: {
    sub: p.claims.sub,
    iss: p.claims.iss,
    aud: p.claims.aud,
    exp: p.claims.exp,
    ...(p.claims.attrs === undefined ? {} : { attrs: p.claims.attrs }),
  },
  db: p.database,
});

/** `Authorization: Bearer …`, else `?token=` (a browser cannot set headers on an upgrade). */
export function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  if (match !== null) return match[1];
  try {
    const t = new URL(request.url).searchParams.get("token");
    if (t !== null && t.length > 0) return t;
  } catch {
    // a relative sub-request url: header only
  }
  return undefined;
}
