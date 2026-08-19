/**
 * @internal Where a transport sends, and with which credential.
 *
 * Not exported from `index.ts`: HTTP is Worker internals, not a second public
 * API. The two transports (`ServerBinding`, `ServerHttp`) differ only in how
 * they obtain a {@link ServerSource}; {@link databasesOf} turns either of them
 * into the one client, `Databases`, and {@link readDatabasesOf} into its
 * least-privilege half.
 *
 * `endpoint` is an Effect so an Alchemy Output can be read when the capability
 * binds (see `ServerRuntime.ts`); it requires nothing, so neither does any
 * client method.
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  type AnyCatalog,
  type DatabasesShape,
  type Db,
  type FetchLike,
  makeDatabases,
  type ReadDb,
} from "./db/internal.ts";

export interface ServerEndpoint {
  /** Base URL, no trailing slash (e.g. `https://ramose.example.workers.dev`). */
  readonly url: string;
  /** The server's one bearer token, used for every database name. */
  readonly token?: Redacted.Redacted<string> | string | undefined;
  /** Extra headers on every request (e.g. `x-ramose-replica-hint`). */
  readonly headers?: Record<string, string> | undefined;
}

export interface ServerSource {
  readonly endpoint: Effect.Effect<ServerEndpoint>;
  readonly fetch: FetchLike;
}

/** @internal One method, because a database is a name — and this half cannot write. */
export interface ReadDatabasesShape {
  db<C extends AnyCatalog>(name: string, catalog: C): ReadDb<C>;
}

/** @internal The client's read half: no `transact`, no `install`. */
export const readOnly = <C extends AnyCatalog>(db: Db<C>): ReadDb<C> => ({
  name: db.name,
  catalog: db.catalog,
  q: db.q,
  live: db.live,
  pull: db.pull,
  livePull: db.livePull,
  basis: db.basis,
  asOf: db.asOf,
  history: db.history,
});

/**
 * The client over a source. No `webSocket`: a Worker reaching the server
 * through a service binding has no browser socket to give, so reads take the
 * HTTPS fallback and `db.live` is not available on this side of the wire.
 */
export const databasesOf = (source: ServerSource): DatabasesShape =>
  makeDatabases({
    url: source.endpoint.pipe(
      Effect.map((endpoint) => endpoint.url.replace(/\/+$/, "")),
    ),
    token: source.endpoint.pipe(
      Effect.map((endpoint) =>
        Redacted.make(
          endpoint.token === undefined
            ? ""
            : typeof endpoint.token === "string"
              ? endpoint.token
              : Redacted.value(endpoint.token),
        ),
      ),
    ),
    fetch: source.fetch,
  }).databases;

/**
 * The same client, read-only. Least privilege is a *shape*, not a second
 * transport: the wire is identical (the server's one token, or the caller's
 * JWT, is what the peer actually enforces), so what this removes is the
 * ability to name a write at all — `ramose.db(name, catalog)` hands back a
 * `ReadDb<C>` with no `transact` and no `install`.
 */
export const readDatabasesOf = (source: ServerSource): ReadDatabasesShape => {
  const databases = databasesOf(source);
  return { db: (name, catalog) => readOnly(databases.db(name, catalog)) };
};
