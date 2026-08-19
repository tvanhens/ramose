/**
 * `ramose/better-auth` — the Better Auth server plugin that mints the
 * workspace-scoped JWTs a Ramose peer verifies (docs/AUTH_LAYER.md §1).
 *
 * Ramose verifies tokens and never issues them, so every app repeats the
 * same mint route: read the Better Auth session, decide the caller's policy
 * class for the requested database, build the payload with `Ramose.claims`,
 * sign it with `signJWT`. {@link ramoseToken} is that route as a plugin —
 * the app keeps exactly one decision, {@link ClassOf}.
 *
 * It requires Better Auth's `jwt` plugin and signs with the same JWKS key,
 * so the peer's `RAMOSE_JWKS_URL` (the jwt plugin's `/jwks` endpoint) reads
 * the matching public half with no extra key management.
 *
 * ```typescript
 * betterAuth({
 *   plugins: [
 *     organization(),
 *     jwt({ jwt: { issuer: AUTH.issuer, audience: AUTH.audience,
 *                  expirationTime: `${AUTH.ttl}s` } }),
 *     ramoseToken({ auth: AUTH, policy: compiledPolicy, classOf: orgClassOf() }),
 *   ],
 * });
 * ```
 *
 * The route is `POST {basePath}/ramose/token { db } → { token, class, exp }`
 * — the shape `Ramose.token.jwt` accepts unchanged. The paired browser
 * plugin lives on `ramose/better-auth/client`.
 */

import { type AuthConfig, claims } from "../index.ts";
import { isDatabaseName } from "../db/index.ts";
import type { CompiledPolicy } from "../internal/core/policy/ast.ts";
import {
  BetterAuthError,
  type BetterAuthPlugin,
  type GenericEndpointContext,
  type Session,
  type User,
} from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { type JwtOptions, signJWT } from "better-auth/plugins/jwt";
import * as z from "zod";

/** The Better Auth session, as {@link ClassOf} sees it. */
export interface SessionInfo {
  readonly session: Session & Record<string, unknown>;
  readonly user: User & Record<string, unknown>;
}

/** What {@link ClassOf} decides: a class, optionally with `ramose.attrs`. */
export interface ClassGrant {
  /** The policy class the token selects (`ramose.class`). */
  readonly class: string;
  /** App claims (`ramose.attrs`), decoded by the policy's `claims` struct. */
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** What {@link ClassOf} receives: the caller, the database, the endpoint. */
export interface ClassOfInput {
  /** The authenticated Better Auth session (the mint route requires one). */
  readonly session: SessionInfo;
  /** The database the caller asked a token for (already a valid name). */
  readonly db: string;
  /**
   * The Better Auth endpoint context — `ctx.context.adapter` for lookups,
   * `ctx.headers` / `ctx.request` for anything request-scoped.
   */
  readonly ctx: GenericEndpointContext;
}

/**
 * The one decision the app owns: the caller's policy class for `db`, or
 * `null` for no access (a 403 that leaks nothing — "no org with that slug"
 * and "not a member of it" are the same answer). Return a {@link ClassGrant}
 * to also carry `ramose.attrs`.
 */
export type ClassOf = (
  input: ClassOfInput,
) => string | ClassGrant | null | Promise<string | ClassGrant | null>;

export interface RamoseTokenOptions {
  /**
   * The verifier/minter contract — the same `AuthConfig` the peer's
   * `Ramose.authEnv({ auth })` pins, so a minted lifetime can never exceed
   * the verifier's cap.
   */
  readonly auth: AuthConfig;
  /** Resolves the caller's class for the requested database; see {@link ClassOf}. */
  readonly classOf: ClassOf;
  /**
   * The compiled policy (`Ramose.Policy.compile(policy)` JSON, or parsed).
   * Optional; when given, a class the policy does not declare fails the mint
   * instead of minting a token that grants nothing.
   */
  readonly policy?: CompiledPolicy | string;
  /**
   * Where the route lives under Better Auth's `basePath`.
   * @default "/ramose/token" — which Better Auth's client proxy exposes as
   * `authClient.ramose.token`.
   */
  readonly path?: string;
}

/**
 * The mint-route server plugin. `POST {path} { db }` with a session cookie
 * answers `{ token, class, exp }`; `classOf` returning `null` is a 403 and a
 * missing session a 401. Requires the `jwt` plugin (checked at init) and
 * signs with its JWKS via the same server-only path as `auth.api.signJWT`.
 */
export const ramoseToken = (options: RamoseTokenOptions) => {
  return {
    id: "ramose-token",
    init: (ctx) => {
      if (!(ctx.options.plugins ?? []).some((plugin) => plugin.id === "jwt")) {
        throw new BetterAuthError(
          "ramose: the ramoseToken plugin requires Better Auth's jwt plugin — " +
            "it signs with the same JWKS the peer's RAMOSE_JWKS_URL reads. " +
            "Add jwt() to the plugins array.",
        );
      }
    },
    endpoints: {
      ramoseToken: createAuthEndpoint(
        options.path ?? "/ramose/token",
        {
          method: "POST",
          body: z.object({
            db: z.string().meta({
              description: "The Ramose database this token is to be bound to",
            }),
          }),
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              operationId: "mintRamoseToken",
              description:
                "Mint a Ramose JWT bound to one database, signed with the jwt plugin's JWKS",
              responses: {
                "200": {
                  description: "The minted token",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          token: { type: "string" },
                          class: { type: "string" },
                          exp: { type: "number" },
                        },
                        required: ["token", "class", "exp"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const session = ctx.context.session;
          const db = ctx.body.db;
          // The peer would 400 this anyway; failing at mint keeps the error
          // near its cause. `claims` re-checks, but after `classOf` ran.
          if (!isDatabaseName(db)) {
            throw new APIError("BAD_REQUEST", {
              message: `ramose: ${JSON.stringify(db)} is not a valid database name`,
            });
          }
          const granted = await options.classOf({ session, db, ctx });
          const grant: ClassGrant | null =
            typeof granted === "string" ? { class: granted } : granted;
          if (grant === null) {
            // One answer for "no such database" and "not a member of it".
            throw new APIError("FORBIDDEN", {
              message: "ramose: no access to this database",
            });
          }
          let payload: ReturnType<typeof claims>;
          try {
            payload = claims(
              options.auth,
              {
                sub: session.user.id,
                db,
                class: grant.class,
                attrs: grant.attrs,
              },
              options.policy,
            );
          } catch (cause) {
            // `db` was validated above, so what `claims` rejects here is
            // deploy configuration: a class the policy does not declare, or
            // a bad ttl. The caller cannot fix either.
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
          // Sign with the jwt plugin's own options so the key (JWKS row,
          // alg, encryption) is exactly the one /jwks publishes.
          const jwtPlugin = ctx.context.options.plugins?.find(
            (plugin) => plugin.id === "jwt",
          ) as { options?: JwtOptions } | undefined;
          // Spread: `signJWT` wants jose's index-signed `JWTPayload`, which
          // a named interface is not assignable to.
          const token = await signJWT(ctx, {
            options: jwtPlugin?.options,
            payload: { ...payload },
          });
          return ctx.json({ token, class: grant.class, exp: payload.exp });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};

// ── the organization-plugin default, opt-in ────────────────────────────────

/**
 * The org-role → policy-class mapping Reef established: `owner` and `admin`
 * are `admin`, `member` is `member`, anything else (or absent) is `viewer`.
 * Better Auth roles can be comma-separated; the first one decides.
 */
export const classOfRole = (role: string): "admin" | "member" | "viewer" => {
  const primary = role.split(",")[0]?.trim() ?? role;
  switch (primary) {
    case "owner":
    case "admin":
      return "admin";
    case "member":
      return "member";
    default:
      return "viewer";
  }
};

export interface OrgClassOfOptions {
  /**
   * Role → class. Return `null` to deny a role outright.
   * @default {@link classOfRole}
   */
  readonly map?: (role: string) => string | null;
}

/**
 * A {@link ClassOf} for the `organization` plugin's tables, for apps where
 * an organization's slug *is* the Ramose database name: the caller's member
 * row in the org whose slug is `db` decides the class ({@link classOfRole}
 * by default); no such org or no membership is `null` → 403.
 */
export const orgClassOf = (options?: OrgClassOfOptions): ClassOf => {
  const map = options?.map ?? classOfRole;
  return async ({ session, db, ctx }) => {
    const org = await ctx.context.adapter.findOne<{ id: string }>({
      model: "organization",
      where: [{ field: "slug", value: db }],
    });
    if (org === null) return null;
    const member = await ctx.context.adapter.findOne<{ role: string }>({
      model: "member",
      where: [
        { field: "organizationId", value: org.id },
        { field: "userId", value: session.user.id },
      ],
    });
    return member === null ? null : map(member.role);
  };
};
