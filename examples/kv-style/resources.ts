/**
 * Ramose through the Alchemy 2 + Effect interface, in the shape the KV docs
 * use: declare the deployment as a resource, bind it as a capability, use the
 * Effect-native client.
 *
 * The resource is the *server* (a Ramose peer Worker). A database is a *name*
 * on it — nothing is provisioned. Catalog publication is authoritative.
 *
 * This directory is a *type-checked* example, not part of the deployed stack —
 * it is compiled by `bun run typecheck` so the public API can never drift from
 * the documentation, and it runs as-is under
 * `bun alchemy dev examples/kv-style/alchemy.run.ts`. To adopt it, copy the
 * six files into a project of your own.
 *
 *   resources.ts    ← you are here: the Ramose deployment (Server owns the peer)
 *   schema.ts       shared catalog (User / Movies)
 *   operations.ts   the writes (`db.run` is the only write path)
 *   peer.ts         the peer Worker entry the server bundles as `main`
 *   app.ts          an app Worker that binds the server (its own module, so
 *                   `main: import.meta.url` bundles only the app)
 *   alchemy.run.ts  the stack: providers, outputs
 *
 * The split is not cosmetic: under alchemy 2.0.0-beta.72 a self-referential
 * `main: import.meta.url` in the same module as `Alchemy.Stack(…, { providers })`
 * pulls the engine into the Worker bundle and workerd dies with
 * `TypeError: t.resolve is not a function` (reproducible with zero Ramose code),
 * so the Worker declaration lives in its own file and is imported by the stack.
 */

import * as Ramose from "ramose";

/**
 * The owned peer. Server declares the Worker, both Durable Object classes,
 * PEER_COMPAT, and the fixed bindings.
 */
export const Server = Ramose.Server("Ramose", {
  main: import.meta.resolve("./peer.ts"),
});
