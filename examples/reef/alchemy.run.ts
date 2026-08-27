/**
 * Reef — the flagship Ramose demo stack: a multi-tenant issue tracker
 * backend. Every workspace is its own Ramose database, Better Auth
 * (organizations + JWKS-published JWTs) is the identity plane, and the
 * compiled policy on the peer enforces admin / member / viewer per datom.
 *
 * Local dev — one command brings up the peer and auth Worker:
 *
 *   bun run dev:reef
 *
 * which is `bun alchemy dev examples/reef/alchemy.run.ts`. `bun run
 * dev:reef` sets CI / ALCHEMY_STATE and placeholder Cloudflare
 * credentials the local emulator insists on. The peer serves
 * http://localhost:1337 and the auth Worker http://localhost:1338.
 *
 * Deploy: `bun alchemy deploy examples/reef/alchemy.run.ts`.
 */

import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Api } from "./src/infra/api.ts";
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
    const api = yield* Api;
    const server = yield* Server;
    return { apiUrl: api.url, peerUrl: server.url };
  }),
);
