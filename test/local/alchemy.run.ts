import "./env.ts";
/**
 * Alchemy local-mode stack for Ramose integration tests.
 *
 * `Test.make({ dev: true })` deploys this once per file with the normal
 * sidecar topology (workerd, R2, both Durable Objects). Each test uses a
 * unique database name instead of resetting DO/R2 state.
 *
 *   bun run test:local
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ramose from "ramose";
import { makeApp } from "./app.ts";
import {
  Empty,
  Jwks,
  JwksBound,
  JwksUrlOnly,
  Open,
  Policy,
  PolicyClosed,
  PolicySchema,
  Seeded,
  Token,
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
    // workerName is an Output; Worker env classification unwraps it
    // when the App resource applies (RuntimeContext is ambient there).
    const app = yield* makeApp(open.workerName as unknown as string);
    const empty = yield* Empty;
    const token = yield* Token;
    const policy = yield* Policy;
    const policyClosed = yield* PolicyClosed;
    const policySchema = yield* PolicySchema;
    const seeded = yield* Seeded;
    const jwks = yield* Jwks;
    const jwksBound = yield* JwksBound;
    const jwksUrlOnly = yield* JwksUrlOnly;
    return {
      openUrl: open.url,
      emptyUrl: empty.url,
      tokenUrl: token.url,
      policyUrl: policy.url,
      policyClosedUrl: policyClosed.url,
      policySchemaUrl: policySchema.url,
      seededUrl: seeded.url,
      jwksUrl: jwks.url,
      jwksBoundUrl: jwksBound.url,
      jwksUrlOnlyUrl: jwksUrlOnly.url,
      appUrl: app.url,
    };
  }),
);

export default Stack;
