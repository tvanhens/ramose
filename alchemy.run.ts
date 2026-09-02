import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const stage = process.env.ALCHEMY_STAGE ?? process.env.STAGE ?? process.env.USER ?? "dev";
const tuning = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]!]));

export const Store = Cloudflare.R2.Bucket("Store");

export const Analytics = Cloudflare.AnalyticsEngine.Dataset("Analytics", { dataset: "ripple_tx" });

const auth: Ramose.ServerAuth = {
  jwksUrl: process.env.RAMOSE_JWKS_URL,
  issuers: process.env.RAMOSE_JWT_ISS,
  aud: process.env.RAMOSE_JWT_AUD,
  maxTtl: process.env.RAMOSE_JWT_MAX_TTL === undefined ? undefined : Number(process.env.RAMOSE_JWT_MAX_TTL),
  allowedOrigins: process.env.RAMOSE_ALLOWED_ORIGINS,
};

export const Server = Ramose.Server("Ramose", {
  peer: "Worker",
  storage: Store,
  main: import.meta.resolve("./e2e-peer.ts"),
  env: {
    ANALYTICS: Analytics,
    RAMOSE_STAGE: stage,
    ...tuning(
      "RAMOSE_MAX_BATCH",
      "RAMOSE_BATCH_BUDGET_MS",
      "RAMOSE_OP_COALESCE_MS",
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

  "ripple",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),

    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    return { url: server.url, peerUrl: server.url };
  }),
);
