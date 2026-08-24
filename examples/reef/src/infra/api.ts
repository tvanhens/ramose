/**
 * The Reef auth Worker — Better Auth on Cloudflare D1 via
 * `@alchemy.run/better-auth`. The bridge to Ramose is not a custom route any
 * more: it is `ramose/better-auth`'s `ramoseToken` plugin.
 *
 * What it serves:
 *
 *   /api/auth/*         Better Auth: email+password sign-in, the organization
 *                       plugin (a Reef workspace *is* an org; its slug is the
 *                       Ramose database name), the jwt plugin (JWKS at
 *                       /api/auth/jwks — the peer's `RAMOSE_JWKS_URL`), and
 *                       the ramoseToken plugin: POST /api/auth/ramose/token
 *                       mints the workspace-scoped JWT the Ramose peer
 *                       verifies — `sub` is the Better Auth user id,
 *                       `ramose: { db, class }` comes from the caller's org
 *                       membership (role → class via `orgClassOf`), signed
 *                       with the same managed JWKS key.
 *   /*                  The built SPA (examples/reef/dist), assets-first with
 *                       single-page-app fallback. `bunx vite build` fills it;
 *                       during local dev the Vite dev server is used instead.
 *
 * This Worker never talks to the Ramose peer — the browser is the only data
 * plane client. That keeps the resource graph acyclic: the peer's env needs
 * this Worker's URL (JWKS), and this Worker needs nothing back.
 *
 * Module layout note: `main: import.meta.url` makes this the Worker bundle
 * entry, so `Alchemy.Stack` must live elsewhere (../../alchemy.run.ts).
 */

import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { orgClassOf, ramoseToken } from "ramose/better-auth";
import * as Cloudflare from "alchemy/Cloudflare";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { compiledPolicy } from "../domain/policy.ts";
import { REEF_DOMAIN, REEF_ORIGIN, pinned } from "./domain.ts";
import { ac, roles } from "../domain/roles.ts";
import {
  AUTH_BASE_PATH,
  DEV_API_PORT,
  DEV_UI_ORIGIN,
  REEF_AUTH,
} from "../domain/shared.ts";

/**
 * Better Auth's tables (user/session/org/member/invitation/jwks) live here.
 * Named explicitly on the published demo so a CI state-cache eviction adopts
 * this database instead of minting an empty one — see `./domain.ts`.
 */
export const AuthDb = Cloudflare.D1.Database("AuthDb", pinned("authdb"));

const json = (body: unknown, status = 200) =>
  HttpServerResponse.json(body, { status });

export const Api = Cloudflare.Worker(
  "Api",
  {
    main: import.meta.url,
    // Date must be >= 2026-02-19: below it, @cloudflare/unenv-preset swaps
    // the native workerd `process` for a hybrid whose `stdin` is not an
    // EventEmitter, and the Effect Worker runtime's Terminal layer (built for
    // every Effect-form Worker) crashes on `stdin.once` at isolate init.
    compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
    dev: { port: DEV_API_PORT },
    // The published demo owns the whole hostname: this Worker answers
    // everything except `/db/*`, which a route sends to the peer (see
    // ../infra/resources.ts). Attaching the domain here also makes `url`
    // resolve to it, so `RAMOSE_JWKS_URL` and `RAMOSE_ALLOWED_ORIGINS`
    // pick up the public origin with no further wiring.
    ...pinned("api"),
    ...(REEF_DOMAIN ? { domain: REEF_DOMAIN } : {}),
    // The built SPA. Assets are served first for everything that is not
    // /api/*; unknown paths fall back to index.html (SPA routing). The
    // committed dist/ placeholder keeps first-run `alchemy dev` working
    // before any `vite build`.
    assets: {
      directory: "./examples/reef/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: AUTH_BASE_PATH,
      emailAndPassword: { enabled: true },
      // Vite proxies /api in dev (cookies stay on :5173). Deployed, the
      // Worker serves the SPA on REEF_ORIGIN. Better Auth also trusts its
      // derived baseURL; the explicit list is so a Host-less or
      // workers.dev request cannot lock the demo origin out.
      trustedOrigins: [DEV_UI_ORIGIN, ...(REEF_ORIGIN ? [REEF_ORIGIN] : [])],
      // The demo ships no mailer, so accounts are auto-verified at creation —
      // otherwise the organization plugin's listUserInvitations 403s every
      // fresh account (EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION, an
      // unconditional check in Better Auth 1.6).
      databaseHooks: {
        user: {
          create: {
            before: async (user) => ({ data: { ...user, emailVerified: true } }),
          },
        },
      },
      plugins: [
        organization({
          ac,
          roles,
          // Invitations are in-app only: invitees see them on their next
          // sign-in via listUserInvitations. Nothing to send.
          async sendInvitationEmail() {},
        }),
        // docs:jwt-plugin
        jwt({
          // Reef never reads `set-auth-jwt`. The jwt plugin's default
          // /get-session after-hook signs an identity JWT on every session
          // fetch, which decrypts the JWKS private key. That key is
          // encrypted with BetterAuthSecret — Alchemy.Random, state-only,
          // reminted on a cache miss — so a rotated secret turns
          // `useSession` into a 500 and the SPA shows create-account
          // after a successful sign-in. `ramoseToken` heals JWKS for mint;
          // this flag keeps get-session off that path entirely.
          disableSettingJwtHeader: true,
          jwt: {
            issuer: REEF_AUTH.issuer,
            audience: REEF_AUTH.audience,
            expirationTime: `${REEF_AUTH.ttl}s`,
          },
        }),
        // enddocs:jwt-plugin
        // `POST /api/auth/ramose/token { db }` → `{ token, class, exp }`.
        // The session cookie authenticates the caller; `orgClassOf` maps
        // their membership in the org whose slug is `db` to a policy class
        // (owner|admin → admin, member → member, else viewer; no org and no
        // membership are the same 403); `Ramose.claims` builds the claim set
        // the peer verifies from the same REEF_AUTH the peer's env pins,
        // validated against the compiled policy; signing uses the same JWKS
        // key the /api/auth/jwks endpoint publishes.
        ramoseToken({
          auth: REEF_AUTH,
          policy: compiledPolicy(),
          classOf: orgClassOf(),
        }),
      ],
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = request.url.split("?")[0] ?? "/";
        if (path.startsWith(`${AUTH_BASE_PATH}/`)) {
          return yield* auth.fetch;
        }
        if (path === "/api/health") {
          return yield* json({ ok: true });
        }
        return yield* json({ error: "not found" }, 404);
      }),
    };
  }).pipe(Effect.provide(CloudflareD1(AuthDb))),
);

export default Api;
