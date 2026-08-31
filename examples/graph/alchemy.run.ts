import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Identity, Server } from "./resources.ts";

export default Alchemy.Stack(
  "ramose-example-graph",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Ramose.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const identity = yield* Identity;
    const server = yield* Server;
    return { identityUrl: identity.url, peerUrl: server.url };
  }),
);
