import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Web } from "./src/infra/web.ts";
import { Server } from "./src/infra/resources.ts";

export default Alchemy.Stack(
  "ramose-reef",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Ramose.providers(),
    ),
    state:
      process.env.ALCHEMY_STATE === "local"
        ? Alchemy.localState()
        : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const web = yield* Web;
    const server = yield* Server;
    return { appUrl: web.url, peerUrl: server.url };
  }),
);
