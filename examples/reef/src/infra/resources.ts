/**
 * The Ramose deployment for Reef: the peer Worker (R2 + Transactor DO +
 * QueryReplica DO) with the compiled workspace policy armed, and the
 * `Ramose.Server` resource on top of it.
 *
 * Auth wiring (the Alchemy seam — https://ramose.ai/guides/sign-in/):
 *
 *   RAMOSE_POLICY           domain/policy.ts, compiled to wire JSON at deploy
 *   RAMOSE_JWKS_URL         the auth Worker's Better Auth JWKS endpoint —
 *                           an `Output.interpolate` over `Api.url`, which is
 *                           the one edge between the two Workers (the auth
 *                           Worker needs nothing back, so the graph is a DAG)
 *   RAMOSE_JWKS_SERVICE     the name of the `AUTH` service binding below, which
 *                           that fetch is dispatched through — deployed, both
 *                           Workers sit on `*.workers.dev`, and Cloudflare
 *                           answers a Worker→Worker subrequest there with
 *                           error 1042 instead of the key set (a failure the
 *                           local miniflare run cannot show you)
 *   RAMOSE_JWT_ISS/_AUD     REEF_AUTH — the one AuthConfig the jwt plugin
 *   RAMOSE_JWT_MAX_TTL      and the mint route (`Ramose.claims`) also read,
 *                           so the cap equals the minted lifetime exactly
 *   RAMOSE_ALLOWED_ORIGINS  the Vite dev origin + the deployed SPA origin
 *                           (the auth Worker serves the built assets)
 *
 * `authEnv` also mints the Worker→DO internal secret a configured policy
 * arms. The Output-valued keys can't go through `authEnv` (it normalises
 * strings), so they are spelled directly with their `AUTH_ENV_KEYS` names.
 */

import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Api } from "./api.ts";
import { REEF_DOMAIN, pinned, zoneOf } from "./domain.ts";
import { compiledPolicy } from "../domain/policy.ts";
import {
  AUTH_BASE_PATH,
  DEV_PEER_PORT,
  DEV_UI_ORIGIN,
  REEF_AUTH,
} from "../domain/shared.ts";

// Every workspace's datoms live in this bucket, so it is named explicitly on
// the published demo for the same reason `AuthDb` is — see ./domain.ts.
const Store = Cloudflare.R2.Bucket("Store", pinned("store"));
const Transactor = Cloudflare.DurableObject("TransactorDO", { className: "TransactorDO" });
const Replica = Cloudflare.DurableObject("QueryReplicaDO", { className: "QueryReplicaDO" });

export const RamoseWorker = Cloudflare.Worker("Peer", {
  main: import.meta.resolve("ramose/worker"),
  compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
  dev: { port: DEV_PEER_PORT },
  // The data plane rides the SPA's own origin: a route claims `/db/*` on the
  // demo hostname, whose remaining paths belong to the auth Worker's custom
  // domain. Same-origin means the browser never preflights a transact, and
  // there is one hostname to remember. The Worker keeps its workers.dev URL,
  // which is what `Ramose.Server` health-checks below.
  ...pinned("peer"),
  ...(REEF_DOMAIN
    ? { routes: [{ pattern: `${REEF_DOMAIN}/db/*`, zoneName: zoneOf(REEF_DOMAIN) }] }
    : {}),
  env: {
    STORE: Store,
    TRANSACTOR: Transactor,
    REPLICA: Replica,
    ...Ramose.authEnv({
      policy: compiledPolicy(),
      auth: REEF_AUTH,
      jwksService: "AUTH",
      internalSecret: process.env.RAMOSE_INTERNAL_SECRET,
    }),
    // The service binding `RAMOSE_JWKS_SERVICE` names. Yielding the same `Api`
    // declaration the JWKS URL interpolates over reuses the one Worker, so
    // this adds an edge to the existing peer→auth dependency, not a cycle.
    AUTH: Api,
    // Yielding the Api declaration registers (or reuses) the Worker in the
    // stack and hands back the resource whose attributes are Outputs — the
    // interpolation is then resolved by the engine at reconcile.
    [Ramose.AUTH_ENV_KEYS.jwksUrl]: Effect.map(
      Api,
      (api) => Output.interpolate`${api.url}${AUTH_BASE_PATH}/jwks`,
    ),
    [Ramose.AUTH_ENV_KEYS.allowedOrigins]: Effect.map(
      Api,
      (api) => Output.interpolate`${DEV_UI_ORIGIN},${api.url}`,
    ),
  },
});

/**
 * The server resource: resolves the peer's URL and (on a live deploy) proves
 * it answers `/health`. No `Ramose.Database` anywhere — a workspace database
 * is created at runtime, by the browser, with `db.install()` under its
 * creator's admin-class JWT.
 */
export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
