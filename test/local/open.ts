/**
 * The open (unauthenticated) peer used by the host App Worker.
 *
 * The Worker is declared here (hatch) so App can service-bind it without
 * importing a `Ramose.Server` into an Effect-Worker bundle. `app-main.ts`
 * is a plain async handler; `app.ts` puts this Worker in `env.Open`.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Ramose from "ramose";
import { operations } from "./ops.ts";

export const OpenPeer = Cloudflare.Worker("OpenPeer", {
  main: import.meta.resolve("./worker.ts"),
  compatibility: Ramose.PEER_COMPAT,
  env: {
    [Ramose.PEER_BINDINGS.store]: Cloudflare.R2.Bucket("OpenStore"),
    [Ramose.PEER_BINDINGS.transactor]: Cloudflare.DurableObject("OpenTransactor", {
      className: Ramose.PEER_DO_CLASSES.transactor,
    }),
    [Ramose.PEER_BINDINGS.replica]: Cloudflare.DurableObject("OpenReplica", {
      className: Ramose.PEER_DO_CLASSES.replica,
    }),
  },
});

export const Open = Ramose.Server("Open", {
  worker: OpenPeer,
  operations,
});
