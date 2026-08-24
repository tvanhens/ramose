/**
 * Constants shared by the auth Worker (infra/api.ts), the peer wiring
 * (infra/resources.ts) and the SPA (app/). Import-light on purpose: this module ends up in
 * the auth Worker bundle (`ramose/db` is the portable barrel, and
 * the `AuthConfig` import is type-only, so it erases).
 */

import type { AuthConfig } from "ramose";
import { isDatabaseName } from "ramose/db";

/**
 * The one verifier/minter contract (https://ramose.ai/guides/sign-in/):
 *
 * - `issuer` — the `iss` every Reef JWT carries and the peer pins
 *   (`RAMOSE_JWT_ISS`). An opaque agreed string — verification keys come
 *   from the JWKS URL, not from resolving this.
 * - `audience` — the `aud` every Reef JWT carries and the peer pins
 *   (`RAMOSE_JWT_AUD`).
 * - `ttl` — token lifetime in seconds. Better Auth signs `exp - iat` of
 *   exactly this and the peer caps accepted lifetimes at the same value
 *   (`RAMOSE_JWT_MAX_TTL`); the SPA re-mints slightly earlier.
 *
 * The jwt plugin's config, the mint route's payload (`Ramose.claims`) and the
 * peer's `RAMOSE_JWT_*` keys (from this same `REEF_AUTH`) all read this one
 * value, so they cannot drift.
 */
export const REEF_AUTH: AuthConfig = {
  issuer: "reef-demo-auth",
  audience: "ramose:reef",
  ttl: 900,
};

/** Where the SPA's Better Auth routes live on the auth Worker. */
export const AUTH_BASE_PATH = "/api/auth";

/** Pinned local-dev ports (`dev.port` on each Worker declaration). */
export const DEV_PEER_PORT = 1337;
export const DEV_API_PORT = 1338;
export const DEV_UI_ORIGIN = "http://localhost:5173";

/**
 * The policy classes, in the order the policy declares them. The role →
 * class mapping (owner|admin → admin, member → member, else viewer) is
 * `classOfRole` from `ramose/better-auth` — the mint plugin's default —
 * so Reef no longer spells it itself.
 */
export const CLASSES = ["admin", "member", "viewer"] as const;
export type RamoseClass = (typeof CLASSES)[number];

/**
 * Workspace slug = Ramose database name. `SLUG_RE` is Reef's friendlier
 * subset (lowercase, hyphens, at least two characters); `isDatabaseName` —
 * the peer's own rule, exported by `ramose/db` — is the outer
 * guard, so a slug that passes here can never be rejected as a database
 * name.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * First path segments the deployed demo has already spent. A workspace lives
 * at `/<slug>` and its issues at `/<slug>/issues/<id>`, so a slug that shadows
 * one of these would route a page request away from the SPA entirely:
 *
 *   db    the Ramose data plane. On https://reef.ramose.ai a Worker route
 *         claims `/db/*` for the peer, so `/db/issues/7` would answer with a
 *         peer error instead of the board.
 *   api   the auth Worker's, served ahead of the assets (`runWorkerFirst`),
 *         so `/api/issues/7` would 404 as JSON.
 *
 * Rejecting them in `isWorkspaceSlug` covers both ends at once: no such
 * workspace can be created, and `parsePath` falls back to the picker rather
 * than rendering a board whose links cannot work.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "db"]);

export const isWorkspaceSlug = (slug: string): boolean =>
  isDatabaseName(slug) && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
