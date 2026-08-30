import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Server } from "./resources.ts";

export default Alchemy.Stack(
  "ramose-todos",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Ramose.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    return { peerUrl: server.url };
  }),
);
