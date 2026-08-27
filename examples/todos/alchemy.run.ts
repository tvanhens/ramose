/**
 * Todos — the smallest end-to-end Ramose peer: a catalog and typed writes,
 * with no auth and no policy.
 *
 * Local dev — one command brings up the peer:
 *
 *   bun run dev:todos
 *
 * `bun run dev:todos` sets CI / ALCHEMY_STATE and placeholder Cloudflare
 * credentials the local emulator insists on. The peer serves
 * http://localhost:1337.
 *
 * Deploy: `bun alchemy deploy examples/todos/alchemy.run.ts`.
 */

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
