/**
 * Ramose through the Alchemy 2 + Effect interface, in the shape the KV docs
 * use: declare the deployment as a resource, bind it as a capability, use the
 * Effect-native client.
 *
 * The resource is the *server* (a Ramose peer Worker). A database is a *name*
 * on it — nothing is provisioned, so there is no resource per database: you
 * call `ramose.db(name, catalog)` (pure, no request) and install the catalog
 * once, either with `Ramose.Database` at deploy or `db.install()` at
 * tenant-creation.
 *
 * This directory is a *type-checked* example, not part of the deployed stack —
 * it is compiled by `bun run typecheck` so the public API can never drift from
 * the documentation, and it runs as-is under
 * `bun alchemy dev examples/kv-style/alchemy.run.ts`. To adopt it, copy the
 * four files into a project of your own.
 *
 *   resources.ts    ← you are here: the Ramose deployment (Worker + Server)
 *   schema.ts       shared catalog (User / Movies)
 *   app.ts          an app Worker that binds the server (its own module, so
 *                   `main: import.meta.url` bundles only the app)
 *   alchemy.run.ts  the stack: providers, the catalog install, outputs
 *
 * The split is not cosmetic: under alchemy 2.0.0-beta.72 a self-referential
 * `main: import.meta.url` in the same module as `Alchemy.Stack(…, { providers })`
 * pulls the engine into the Worker bundle and workerd dies with
 * `TypeError: t.resolve is not a function` (reproducible with zero Ramose code),
 * so the Worker declaration lives in its own file and is imported by the stack.
 */

import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";

// ── the Ramose deployment ──────────────────────────────────────────────────
//
// The server Worker is an *async* Worker: its entrypoint also re-exports both
// Durable Object classes (single-script pattern), so its bindings are declared
// with `env`, not with the Effect form.

const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", { className: "TransactorDO" });
const Replica = Cloudflare.DurableObject("QueryReplicaDO", { className: "QueryReplicaDO" });

export const RamoseWorker = Cloudflare.Worker("Peer", {
  main: import.meta.resolve("ramose/worker"),
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});

/**
 * The Ramose server on that Worker. Nothing is provisioned and no database
 * name is pinned here — the resource is the deployment: it resolves the
 * Worker's `url`, carries the shared `token`, and proves it answers `/health`
 * before anything downstream binds to it.
 *
 * Databases come later and per use: the bound capability *is* the client, so
 * `ramose.db("movies", Movies)` hands back a typed `Db` for `/db/movies/…`
 * with no request at all. `Ramose.Database` (at deploy) or `db.install()` (at
 * tenant creation) is the one place the catalog lands. The Transactor DO is
 * `idFromName("movies")`.
 */
export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
