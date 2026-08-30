import * as Cloudflare from "alchemy/Cloudflare";
import * as Ramose from "ramose";
import { AUD, ISS, JWKS } from "./auth-keys.ts";
import { Open } from "./open.ts";
import { TEST_HOOKS_ENV } from "./test-hooks-env.ts";

export { Open };

const worker = import.meta.resolve("./worker.ts");
const empty = import.meta.resolve("./empty-worker.ts");
const production = import.meta.resolve("./production-worker.ts");
const operationWorker = import.meta.resolve("./operation-worker.ts");
const graphPathWorker = import.meta.resolve("./graph-path-worker.ts");
const conformanceWorker = import.meta.resolve("./conformance-worker.ts");

const jwtAuth = () =>
  ({
    jwksJson: JWKS,
    issuers: ISS,
    aud: AUD,
  }) satisfies Ramose.ServerAuth;

export const Empty = Ramose.Server("Empty", {
  peer: "EmptyPeer",
  storage: "EmptyStore",
  main: production,
  env: TEST_HOOKS_ENV,
});

export const Token = Ramose.Server("Token", {
  peer: "TokenPeer",
  storage: "TokenStore",
  main: empty,
  env: TEST_HOOKS_ENV,
});

export const TransactorTest = Ramose.Server("TransactorTest", {
  peer: "TransactorTestPeer",
  storage: "TransactorTestStore",
  main: empty,
  env: {
    ...TEST_HOOKS_ENV,
    RAMOSE_INDEX_TX_THRESHOLD: "20",
    RAMOSE_INDEX_INTERVAL_MS: "600000",
    RAMOSE_INDEX_MAX_TXS_PER_RUN: "5",
    RAMOSE_LOG_KEEP_TXS: "3",
    RAMOSE_MAX_BATCH: "8",
    RAMOSE_TIMING_YIELDS: "1",
  },
});

export const Policy = Ramose.Server("Policy", {
  peer: "PolicyPeer",
  storage: "PolicyStore",
  main: worker,
  auth: {
    ...jwtAuth(),
    allowedOrigins: ["https://app.acme.test"],
  },
  env: TEST_HOOKS_ENV,
});

export const PolicyClosed = Ramose.Server("PolicyClosed", {
  peer: "PolicyClosedPeer",
  storage: "PolicyClosedStore",
  main: empty,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

export const PolicySchema = Ramose.Server("PolicySchema", {
  peer: "PolicySchemaPeer",
  storage: "PolicySchemaStore",
  main: empty,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

export const NativeOperations = Ramose.Server("NativeOperations", {
  peer: "NativeOperationsPeer",
  storage: "NativeOperationsStore",
  main: operationWorker,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

export const McpBudget = Ramose.Server("McpBudget", {
  peer: "McpBudgetPeer",
  storage: "McpBudgetStore",
  main: operationWorker,
  auth: jwtAuth(),
  env: { ...TEST_HOOKS_ENV, RAMOSE_QUERY_MAX_CELLS: "1" },
});

export const GraphPaths = Ramose.Server("GraphPaths", {
  peer: "GraphPathsPeer",
  storage: "GraphPathsStore",
  main: graphPathWorker,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

export const Conformance = Ramose.Server("Conformance", {
  peer: "ConformancePeer",
  storage: "ConformanceStore",
  main: conformanceWorker,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

export const Seeded = Ramose.Server("Seeded", {
  peer: "SeededPeer",
  storage: "SeededStore",
  main: empty,
  env: TEST_HOOKS_ENV,
});

export const Jwks = Cloudflare.Worker("Jwks", {
  main: import.meta.resolve("./jwks.ts"),
});

export const JwksBound = Ramose.Server("JwksBound", {
  peer: "JwksBoundPeer",
  storage: "JwksBoundStore",
  main: empty,
  auth: {
    jwksUrl: "https://jwks.invalid/jwks",
    jwksService: "JWKS",
    issuers: ISS,
    aud: AUD,
  },
  env: { JWKS: Jwks, ...TEST_HOOKS_ENV },
});

export const JwksUrlOnly = Ramose.Server("JwksUrlOnly", {
  peer: "JwksUrlOnlyPeer",
  storage: "JwksUrlOnlyStore",
  main: empty,
  auth: {
    jwksUrl: "https://jwks.invalid/jwks",
    issuers: ISS,
    aud: AUD,
  },
  env: TEST_HOOKS_ENV,
});
