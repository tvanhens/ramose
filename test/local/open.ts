/**
 * The open (unauthenticated) peer used by the host App Worker.
 *
 * The Worker is declared here (hatch) so App can service-bind it. Durable
 * Object logical ids match `ownedPeerDurableObjects` so this peer shares
 * the same local DO namespaces as the other owned Servers.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Ramose from "ramose";
import { operations } from "./ops.ts";

export const OpenPeer = Cloudflare.Worker("OpenPeer", {
  main: import.meta.resolve("./worker.ts"),
  compatibility: Ramose.PEER_COMPAT,
  env: {
    [Ramose.PEER_BINDINGS.store]: Cloudflare.R2.Bucket("OpenStore"),
    [Ramose.PEER_BINDINGS.transactor]: Cloudflare.DurableObject(
      Ramose.PEER_DO_CLASSES.transactor,
      { className: Ramose.PEER_DO_CLASSES.transactor },
    ),
    [Ramose.PEER_BINDINGS.replica]: Cloudflare.DurableObject(
      Ramose.PEER_DO_CLASSES.replica,
      { className: Ramose.PEER_DO_CLASSES.replica },
    ),
  },
});

export const Open = Ramose.Server("Open", {
  worker: OpenPeer,
  operations,
});
