/**
 * The Ramose deployment for Reef: Server owns the peer. Auth is declared
 * once on `Ramose.Server` and applied onto the Worker — including the
 * Output-valued JWKS URL and CORS origins that interpolate over the auth
 * Worker. Extra bindings (`AUTH`) and `/db/*` routes stay on Server props;
 * they are not a second auth path.
 *
 * Auth wiring (the Alchemy seam — https://ramose.ai/guides/sign-in/):
 *
 *   auth.policy             domain/policy.ts, compiled to wire JSON at deploy
 *   auth.jwksUrl            the auth Worker's Better Auth JWKS endpoint —
 *                           an `Output.interpolate` over `Api.url`, which is
 *                           the one edge between the two Workers (the auth
 *                           Worker needs nothing back, so the graph is a DAG)
 *   auth.jwksService        the name of the `AUTH` service binding below, which
 *                           that fetch is dispatched through — deployed, both
 *                           Workers sit on `*.workers.dev`, and Cloudflare
 *                           answers a Worker→Worker subrequest there with
 *                           error 1042 instead of the key set (a failure the
 *                           local miniflare run cannot show you)
 *   auth.jwt                REEF_AUTH — the one AuthConfig the jwt plugin
 *                           and the mint route (`Ramose.claims`) also read,
 *                           so the cap equals the minted lifetime exactly
 *   auth.allowedOrigins     the Vite dev origin + the deployed SPA origin
 *                           (the auth Worker serves the built assets)
 */

import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Api } from "./api.ts";
import { REEF_DOMAIN, pinned, zoneOf } from "./domain.ts";
import { compiledPolicy } from "../domain/policy.ts";
import { operations } from "../app/mutations.ts";
import {
  AUTH_BASE_PATH,
  DEV_PEER_PORT,
  DEV_UI_ORIGIN,
  REEF_AUTH,
} from "../domain/shared.ts";

// Every workspace's datoms live in this bucket, so it is named explicitly on
// the published demo for the same reason `AuthDb` is — see ./domain.ts.
const Store = Cloudflare.R2.Bucket("Store", pinned("store"));

/**
 * The server resource: owns the peer, applies `auth` onto its env, and (on
 * a live deploy) proves it answers `/health`. No `databases:` and no
 * `Ramose.Database` — a workspace database is created at runtime, by the
 * browser, with `db.install()` under its creator's owner-class JWT
 * (`schemaClasses`, not a bypass class).
 *
 * The data plane rides the SPA's own origin: a route claims `/db/*` on the
 * demo hostname, whose remaining paths belong to the auth Worker's custom
 * domain. Same-origin means the browser never preflights a transact, and
 * there is one hostname to remember. The Worker keeps its workers.dev URL,
 * which is what `Ramose.Server` health-checks.
 */
export const Server = Ramose.Server("Ramose", {
  operations,
  main: import.meta.resolve("./peer.ts"),
  storage: Store,
  dev: { port: DEV_PEER_PORT },
  ...pinned("peer"),
  ...(REEF_DOMAIN
    ? { routes: [{ pattern: `${REEF_DOMAIN}/db/*`, zoneName: zoneOf(REEF_DOMAIN) }] }
    : {}),
  env: {
    // The service binding `auth.jwksService` names. Yielding the same `Api`
    // declaration the JWKS URL interpolates over reuses the one Worker, so
    // this adds an edge to the existing peer→auth dependency, not a cycle.
    AUTH: Api,
  },
  auth: {
    policy: compiledPolicy(),
    jwt: REEF_AUTH,
    jwksService: "AUTH",
    internalSecret: process.env.RAMOSE_INTERNAL_SECRET,
    jwksUrl: Effect.map(
      Api,
      (api) => Output.interpolate`${api.url}${AUTH_BASE_PATH}/jwks`,
    ),
    allowedOrigins: Effect.map(
      Api,
      (api) => Output.interpolate`${DEV_UI_ORIGIN},${api.url}`,
    ),
  },
});
