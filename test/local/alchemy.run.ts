import "./env.ts";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ramose from "ramose";
import LocalAuthRestartWorker from "./better-auth-restart-worker.ts";
import LocalAuthRotatedWorker from "./better-auth-rotated-worker.ts";
import LocalAuthWorker from "./better-auth-worker.ts";
import {
  Conformance,
  Empty,
  GraphPaths,
  Jwks,
  JwksBound,
  JwksUrlOnly,
  McpBudget,
  NativeOperations,
  Open,
  Policy,
  PolicyClosed,
  PolicySchema,
  Seeded,
  Token,
  TransactorTest,
} from "./resources.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Ramose.providers());

export const Stack = Alchemy.Stack(
  "ramose-local",
  {
    providers,
    state: Alchemy.inMemoryState(),
  },
  Effect.gen(function* () {
    const open = yield* Open;

    const empty = yield* Empty;
    const token = yield* Token;
    const transactorTest = yield* TransactorTest;
    const policy = yield* Policy;
    const policyClosed = yield* PolicyClosed;
    const policySchema = yield* PolicySchema;
    const nativeOperations = yield* NativeOperations;
    const mcpBudget = yield* McpBudget;
    const graphPaths = yield* GraphPaths;
    const conformance = yield* Conformance;
    const seeded = yield* Seeded;
    const jwks = yield* Jwks;
    const jwksBound = yield* JwksBound;
    const jwksUrlOnly = yield* JwksUrlOnly;
    const auth = yield* LocalAuthWorker;
    const authRestart = yield* LocalAuthRestartWorker;
    const authRotated = yield* LocalAuthRotatedWorker;
    return {
      openUrl: open.url,
      emptyUrl: empty.url,
      tokenUrl: token.url,
      transactorUrl: transactorTest.url,
      policyUrl: policy.url,
      policyClosedUrl: policyClosed.url,
      policySchemaUrl: policySchema.url,
      nativeOperationsUrl: nativeOperations.url,
      mcpBudgetUrl: mcpBudget.url,
      graphPathsUrl: graphPaths.url,
      conformanceUrl: conformance.url,
      seededUrl: seeded.url,
      jwksUrl: jwks.url,
      jwksBoundUrl: jwksBound.url,
      jwksUrlOnlyUrl: jwksUrlOnly.url,
      authUrl: auth.url,
      authRestartUrl: authRestart.url,
      authRotatedUrl: authRotated.url,
    };
  }),
);

export default Stack;
