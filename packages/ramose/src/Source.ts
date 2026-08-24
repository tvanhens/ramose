/**
 * @internal Where a transport sends, and with which credential.
 *
 * Not exported from `index.ts`: HTTP is Worker internals. The one
 * {@link import("./Databases.ts").layer} auto-picks a {@link ServerSource}
 * (service binding if present, else HTTPS); {@link serverDatabasesOf} turns
 * it into the server-side client (no `live` / `livePull`).
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type FetchLike, makeDatabases } from "./db/internal.ts";
import { trimSlashes } from "./db/http.ts";
import {
  type ServerDatabasesShape,
  withoutLive,
} from "./server-db.ts";

export type { ReadDatabasesShape, ServerDatabasesShape, ServerDb, ServerReadDb } from "./server-db.ts";
export { asRead, withoutLive } from "./server-db.ts";

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

/**
 * The server-side client over a source: no `webSocket`, and `live` /
 * `livePull` are not on the type (they always defect on this hop).
 */
export const serverDatabasesOf = (source: ServerSource): ServerDatabasesShape => {
  const databases = makeDatabases({
    url: source.endpoint.pipe(
      Effect.map((endpoint) => trimSlashes(endpoint.url)),
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
  return {
    db: (name, schema) => withoutLive(databases.db(name, schema)),
  };
};

/** @deprecated Use {@link serverDatabasesOf}. */
export const databasesOf = serverDatabasesOf;
