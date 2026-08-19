/**
 * The stack: providers, the deploy-time catalog install, outputs.
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
import { Movies } from "./schema.ts";

// ── the catalog install ────────────────────────────────────────────────────
//
// `Ramose.Database` is not a cloud object: a database is a name, and this is
// "install this catalog on that name". The engine orders it after the server
// (the `server` prop is the dependency), and the provider talks plain HTTPS to
// whatever URL the server just resolved to — the local dev server's, under
// `alchemy dev`. `install()` is idempotent, so a redeploy costs one no-op tx.
//
// Names invented per request (`/t/:tenant` in app.ts) are not resources: they
// call `db.install()` at tenant-creation instead.

export const MoviesDb = Ramose.Database("movies", { server: Server, catalog: Movies });

export default Alchemy.Stack(
  // physical name pinned; product is Ramose — the app id keys deployed state
  // (and the Worker names derived from it), so renaming it would orphan it.
  "ripple-example",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const app = yield* App;
    yield* MoviesDb;
    return {
      url: app.url,
      peerUrl: server.url,
    };
  }),
);
