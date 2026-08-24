/**
 * The stack: providers and outputs.
 *
 * Run it with `bun alchemy dev examples/kv-style/alchemy.run.ts` (from the repo
 * root — the Worker's `main` is repo-relative), then curl the `url` output.
 *
 * Everything that touches the engine (`Alchemy.Stack`, `Cloudflare.providers()`)
 * stays in this file; the Worker that bundles itself with
 * `main: import.meta.url` lives in `app.ts`. See the note there for the
 * alchemy 2.0.0-beta.72 bundling issue that forces the split.
 */

import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "./app.ts";
import { Server } from "./resources.ts";

export default Alchemy.Stack(
  "ramose-example",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const app = yield* App;
    return {
      url: app.url,
      peerUrl: server.url,
    };
  }),
);
