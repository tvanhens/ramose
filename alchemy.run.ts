/**
 * Ramose infrastructure — Alchemy (Effect-based API, alchemy 2.x).
 *
 * Server owns the peer (R2, both Durable Object classes, PEER_COMPAT, fixed
 * STORE / TRANSACTOR / REPLICA bindings). This stack adds Analytics Engine,
 * the e2e operations entry, and optional auth env from the process.
 *
 *   bun alchemy dev                 # local dev (miniflare emulates R2 + DOs)
 *   bun alchemy deploy              # deploy to the current stage (default: $USER)
 *   bun alchemy deploy --stage prod
 *   bun alchemy destroy
 *
 * Verified against https://alchemy.run/llms.txt, /cloudflare/compute/workers
 * and /cloudflare/compute/durable-objects for alchemy 2.0.0-beta.72.
 */

import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const stage = process.env.ALCHEMY_STAGE ?? process.env.STAGE ?? process.env.USER ?? "dev";
const tuning = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]!]));

/** Content-addressed segment / log / root storage. Everything except `root/current` is immutable. */
export const Store = Cloudflare.R2.Bucket("Store");

/**
 * Workers Analytics Engine dataset for tx/http telemetry (`env.ANALYTICS`).
 *
 * Declared with the `env` form rather than the doc's two-phase Effect form
 * (`Cloudflare.Worker(name, props, Effect.gen(… WriteDataset(Analytics) …))`):
 * that form binds under the *dataset resource's* logical id and expects the
 * Worker body to be authored inline (`main: import.meta.url`, handlers
 * returned from the generator). The peer is a plain async Worker whose
 * script also re-exports both Durable Object classes (single-script pattern,
 * packages/ramose/src/worker/index.ts), so the DOs would lose their env. The `env`
 * form emits the same binding — `{ type: "analytics_engine", name: "ANALYTICS",
 * dataset: "ripple_tx" }` (alchemy/src/Cloudflare/Workers/WorkerAsyncBindings.ts
 * `isDataset` arm) — under the name we choose, so the Worker *and* both DOs see
 * `env.ANALYTICS.writeDataPoint`. The Effect-shaped client lives in the Worker
 * instead (packages/ramose/src/worker/analytics.ts).
 */
// `dataset: "ripple_tx"` — physical name pinned; product is Ramose. Renaming it
// would start a fresh dataset and orphan every point already written.
export const Analytics = Cloudflare.AnalyticsEngine.Dataset("Analytics", { dataset: "ripple_tx" });

/** Server auth (https://ramose.ai/reference/server/), all opt-in: nothing set deploys today's peer. */
const auth: Ramose.ServerAuth = {
  policy: process.env.RAMOSE_POLICY,
  jwksUrl: process.env.RAMOSE_JWKS_URL,
  issuers: process.env.RAMOSE_JWT_ISS,
  aud: process.env.RAMOSE_JWT_AUD,
  maxTtl: process.env.RAMOSE_JWT_MAX_TTL === undefined ? undefined : Number(process.env.RAMOSE_JWT_MAX_TTL),
  allowedOrigins: process.env.RAMOSE_ALLOWED_ORIGINS,
  // Worker→DO secret. Unset = a fresh one per deploy, which is fine: the Worker
  // and both DO classes are one script and rotate together.
  internalSecret: process.env.RAMOSE_INTERNAL_SECRET,
};

/**
 * The Ramose server on this peer Worker (`ramose`).
 *
 * Server owns the peer. `peer: "Worker"` keeps the Alchemy logical id this
 * stack has always used (renaming it would orphan already-deployed stages).
 * `main` registers the e2e operations so `db.run` works in test/e2e.
 *
 * Consumers get an Effect-native client — `yield* Ramose.Databases(Server)`,
 * then `ramose.db("movies", Movies)` (pure) — over `Ramose.layer` (service
 * binding when the host Worker has one, HTTPS otherwise).
 * See examples/kv-style/ (resources.ts + app.ts + alchemy.run.ts).
 */
export const Server = Ramose.Server("Ramose", {
  peer: "Worker",
  storage: Store,
  main: import.meta.resolve("./e2e-peer.ts"),
  env: {
    ANALYTICS: Analytics,
    RAMOSE_STAGE: stage,
    ...tuning(
      "RAMOSE_MAX_BATCH",
      "RAMOSE_QUERY_MAX_CELLS",
      "RAMOSE_LOG_LEVEL",
      "RAMOSE_INDEX_TX_THRESHOLD",
      "RAMOSE_INDEX_INTERVAL_MS",
      "RAMOSE_LOG_KEEP_TXS",
      "RAMOSE_REPLICA_HINT",
      "RAMOSE_CACHE_BASIS",
      "RAMOSE_CACHE_MODE",
      "RAMOSE_TIMING_YIELDS",
    ),
  },
  auth,
});

export default Alchemy.Stack(
  // App name "ripple": physical name pinned; product is Ramose. It prefixes the
  // deployed Worker / DO / R2 names (`ripple-worker-<stage>-…`), so renaming it
  // would orphan every already-deployed stage.
  "ripple",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
    // State lives in Cloudflare by default; ALCHEMY_STATE=local keeps a file
    // store instead (offline `bun alchemy dev` against the local emulation).
    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    return { url: server.url, peerUrl: server.url };
  }),
);
