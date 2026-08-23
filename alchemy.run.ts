/**
 * Ramose infrastructure — Alchemy (Effect-based API, alchemy 2.x).
 *
 * One Worker (the peer; it also exports both Durable Object classes —
 * single-script pattern), two SQLite-backed Durable Object namespaces, one R2
 * bucket bound to the Worker and therefore reachable from both DO classes.
 *
 * The Worker is an *async* Worker (plain `export default { fetch }` +
 * `export { TransactorDO, QueryReplicaDO }` from the entrypoint); bindings
 * are declared with `env` and typed via `Cloudflare.InferEnv`. New Durable
 * Object classes are created SQLite-backed by Alchemy.
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
 * returned from the generator). This Worker is a plain async Worker whose
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
  internalSecret: process.env.RAMOSE_POLICY === undefined ? undefined : Ramose.internalSecret(process.env.RAMOSE_INTERNAL_SECRET),
};

/** One Transactor per logical database (single writer); N QueryReplicas per database. */
export const Transactor = Cloudflare.DurableObject("TransactorDO", { className: "TransactorDO" });
export const Replica = Cloudflare.DurableObject("QueryReplicaDO", { className: "QueryReplicaDO" });

export const Worker = Cloudflare.Worker("Worker", {
  // `main` is a path, not a specifier — Alchemy `realpath`s it. The published
  // default is `ramose/worker` (`createServer()` with an empty registry). This
  // stack registers the e2e operations so `db.run` works in test/e2e.
  main: import.meta.resolve("./e2e-peer.ts"),
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: {
    STORE: Store,
    TRANSACTOR: Transactor,
    REPLICA: Replica,
    ANALYTICS: Analytics,
    RAMOSE_STAGE: stage,
    // tuning knobs (see packages/ramose/src/internal/transactor/env.ts); only bound when set
    ...tuning("RAMOSE_MAX_BATCH", "RAMOSE_QUERY_MAX_CELLS", "RAMOSE_LOG_LEVEL", "RAMOSE_INDEX_TX_THRESHOLD", "RAMOSE_INDEX_INTERVAL_MS", "RAMOSE_LOG_KEEP_TXS", "RAMOSE_REPLICA_HINT", "RAMOSE_CACHE_BASIS", "RAMOSE_CACHE_MODE", "RAMOSE_TIMING_YIELDS"),
    // RAMOSE_TOKEN: Config.redacted("RAMOSE_TOKEN")  ← the peer's one bearer token for prod
    // RAMOSE_POLICY / _JWKS_URL / _JWT_ISS / _JWT_AUD / _JWT_MAX_TTL / _ALLOWED_ORIGINS / _INTERNAL_SECRET
    ...Ramose.authEnv(auth),
  },
});

/** Typed `env` for the Worker entrypoint (mirrors packages/ramose/src/internal/transactor/env.ts#RamoseEnv). */
export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

/**
 * The Ramose server on this peer Worker (`ramose`).
 *
 * Nothing is provisioned and no database name is pinned here: a Ramose
 * database is a *name*, the Transactor DO is `idFromName(name)` and the
 * log/segments live under `db/<name>/…` in the bucket, so the first
 * transaction materializes it. What the resource buys is the deployment —
 * the resolved `url`, the shared bearer `token`, and a deploy-time proof
 * that the server is actually serving (`GET /health`) before anything
 * binds to it. Installing a catalog on one of its names is
 * `Ramose.Database("name", { server: Server, catalog })`.
 *
 * Consumers get an Effect-native client — `yield* Ramose.ReadWriteDatabases(Server)`,
 * then `ramose.db("movies", Movies)` (pure) — over a Worker service binding
 * (`Ramose.ServerBinding`) or plain HTTPS (`Ramose.ServerHttp`).
 * See examples/kv-style/ (resources.ts + app.ts + alchemy.run.ts).
 *
 * Note the same async-env limitation as `Analytics` above: a custom resource
 * cannot be declared in a Worker's `env: {}` (the classifier chain in
 * alchemy/src/Cloudflare/Workers/WorkerAsyncBindings.ts is closed over
 * Cloudflare's own resource types). Attribute Outputs still work —
 * `env: { RAMOSE_URL: Server.url }` lowers to a `plain_text` binding — and the
 * `Ramose.*Databases` capabilities bind themselves.
 */
// The `"Ramose"` argument is the resource's *logical* id only: `Ramose.Server`
// provisions nothing (it resolves the Worker's URL and probes `/health`) and its
// `delete` is a no-op, so re-keying the state row orphans no Cloudflare object.
export const Server = Ramose.Server("Ramose", { worker: Worker, auth });

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
    const worker = yield* Worker;
    const server = yield* Server;
    return { url: worker.url, peerUrl: server.url };
  }),
);
