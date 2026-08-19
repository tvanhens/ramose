/**
 * Todos — the smallest end-to-end Ramose app: a catalog, a live query and
 * typed writes, with no auth and no policy.
 *
 * Local dev — one command brings up everything:
 *
 *   bun run dev:todos
 *
 * which is `bun alchemy dev examples/todos/alchemy.run.ts` with the env vars
 * miniflare needs defaulted (CI=1, ALCHEMY_STATE=local, placeholder
 * CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN — see .cursor/CLOUD.md). The
 * peer serves http://localhost:1337 and the `Ui` resource below starts the
 * Vite dev server on http://localhost:5173 once the peer is up, pointed at it
 * through VITE_RAMOSE_URL.
 *
 * Deploy: `bun alchemy deploy examples/todos/alchemy.run.ts`, then
 * `VITE_RAMOSE_URL=<peerUrl> bunx vite build examples/todos`.
 */

import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Server } from "./resources.ts";
import { Todos } from "./schema.ts";

/**
 * The one place the catalog is installed: `install()` as a deploy-time
 * resource, ordered after the server it names. `db.install()` is an ordinary
 * idempotent transaction, so a redeploy costs one no-op tx.
 */
export const TodosDb = Ramose.Database("todos", { server: Server, catalog: Todos });

/**
 * The app's dev server, as a stack resource. `Command.Dev` is a long-lived
 * process that only exists under `alchemy dev` — on `alchemy deploy` it is a
 * no-op (build the SPA yourself and host it wherever you like). It runs in
 * Alchemy's dev sidecar, so it survives the user-code restarts `--watch`
 * triggers when a Worker source changes.
 *
 * Yielding `Server` is what orders the graph: Vite starts after the peer is
 * serving, and `VITE_RAMOSE_URL` points at wherever the peer actually came
 * up. `--strictPort` keeps the UI on :5173 instead of silently drifting to
 * :5174, so the URL the docs tell you to open is the one you get.
 */
export const Ui = Command.Dev(
  "Ui",
  Effect.gen(function* () {
    const server = yield* Server;
    return {
      command: "bunx vite examples/todos --port 5173 --strictPort",
      env: { VITE_RAMOSE_URL: server.url },
    };
  }),
);

export default Alchemy.Stack(
  // physical name pinned; product is Ramose — the app id keys deployed state
  // (and the Worker names derived from it), so renaming it would orphan it.
  "ripple-todos",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Ramose.providers(),
      Command.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    yield* TodosDb;
    const ui = yield* Ui;
    return { peerUrl: server.url, uiUrl: ui.url };
  }),
);
