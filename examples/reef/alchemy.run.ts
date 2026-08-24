/**
 * Reef — the flagship Ramose demo. A multi-tenant, real-time issue tracker:
 * every workspace is its own Ramose database, Better Auth (organizations +
 * JWKS-published JWTs) is the identity plane, and the compiled policy on the
 * peer enforces admin / member / viewer per datom.
 *
 * Local dev — one command brings up everything:
 *
 *   bun run dev:reef
 *
 * which is `bun alchemy dev examples/reef/alchemy.run.ts`. `applyLocalDev()`
 * fills the placeholder Cloudflare credentials miniflare needs. The
 * peer serves http://localhost:1337, the auth Worker http://localhost:1338,
 * and the `Ui` resource below starts the Vite dev server on
 * http://localhost:5173 once both Workers are up. Vite proxies /api to the
 * auth Worker so cookies stay same-origin.
 *
 * Deploy: `bun alchemy deploy examples/reef/alchemy.run.ts`, then
 * `VITE_RAMOSE_URL=<peerUrl> bunx vite build examples/reef` and deploy once
 * more so the built SPA ships as the auth Worker's assets.
 */

import * as Ramose from "ramose";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Api } from "./src/infra/api.ts";
import { Server } from "./src/infra/resources.ts";
import { DEV_API_PORT, DEV_UI_ORIGIN } from "./src/domain/shared.ts";

Ramose.applyLocalDev();

/**
 * The SPA's dev server, as a stack resource. `Command.Dev` is a long-lived
 * process that only exists under `alchemy dev` — on `alchemy deploy` it is a
 * no-op (the built SPA ships as the auth Worker's assets instead). It runs in
 * Alchemy's dev sidecar, so it survives the user-code restarts `--watch`
 * triggers when a Worker source changes.
 *
 * `--strictPort` matters: `DEV_UI_ORIGIN` is pinned in the auth Worker's
 * `trustedOrigins` and the peer's `RAMOSE_ALLOWED_ORIGINS`, so silently
 * drifting to :5174 would break cookies and CORS. Better to fail loudly.
 *
 * The env keys are what order the graph — the UI starts after both Workers
 * are serving, and points at wherever they actually came up.
 */
export const Ui = Command.Dev(
  "Ui",
  Effect.gen(function* () {
    // Yielding the declarations registers (or reuses) both Workers in the
    // stack and hands back resources whose attributes are Outputs — the
    // engine resolves them at reconcile, after the Workers are serving.
    const api = yield* Api;
    const server = yield* Server;
    return {
      command: `bunx vite examples/reef --port ${new URL(DEV_UI_ORIGIN).port} --strictPort`,
      env: {
        // `url` is optional on a Worker in general (no workers.dev route);
        // under `alchemy dev` it is always the local port — fall back to it.
        REEF_API_URL: Output.map(
          api.url,
          (url) => url ?? `http://localhost:${DEV_API_PORT}`,
        ),
        VITE_RAMOSE_URL: server.url,
      },
    };
  }),
);

export default Alchemy.Stack(
  "ramose-reef",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Ramose.providers(),
      Command.providers(),
    ),
    state:
      process.env.ALCHEMY_STATE === "local"
        ? Alchemy.localState()
        : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const server = yield* Server;
    const ui = yield* Ui;
    return { apiUrl: api.url, peerUrl: server.url, uiUrl: ui.url };
  }),
);
