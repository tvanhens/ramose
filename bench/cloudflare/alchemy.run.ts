import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AUD, ISS, JWKS } from "../../test/local/auth-keys.ts";

const stage = process.env.ALCHEMY_STAGE ?? process.env.STAGE ?? process.env.USER ?? "bench";
const capability = process.env.RAMOSE_BENCH_CAPABILITY;
if (capability === undefined || capability.length < 32) {
  throw new Error("RAMOSE_BENCH_CAPABILITY must be set to at least 32 characters");
}
const tuning = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]!]));

export const Server = Ramose.Server("Bench", {
  peer: "BenchPeer",
  storage: Cloudflare.R2.Bucket("BenchStore", { forceDestroy: true }),
  main: import.meta.resolve("./worker.ts"),
  auth: { jwksJson: JWKS, issuers: ISS, aud: AUD },
  env: {
    BENCH_SELF: Cloudflare.Workers.Self,
    RAMOSE_STAGE: stage,
    RAMOSE_TEST_HOOKS: "1",
    RAMOSE_TEST_CAPABILITY: capability,
    ...tuning(
      "RAMOSE_MAX_BATCH",
      "RAMOSE_BATCH_BUDGET_MS",
      "RAMOSE_OP_COALESCE_MS",
      "RAMOSE_INDEX_TX_THRESHOLD",
      "RAMOSE_INDEX_INTERVAL_MS",
      "RAMOSE_INDEX_MAX_TXS_PER_RUN",
      "RAMOSE_LOG_KEEP_TXS",
      "RAMOSE_TIMING_YIELDS",
      "RAMOSE_LOG_LEVEL",
    ),
  },
});

export default Alchemy.Stack(
  "ramose-bench",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    return { peerUrl: server.url };
  }),
);
