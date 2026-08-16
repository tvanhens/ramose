/**
 * The typed entry point to the session socket.
 *
 * `connect` is `SchemaFx`'s `create` with a different transport underneath: one
 * WebSocket to `GET /db/:name/session` instead of a request per call. The typed
 * surface is not rebuilt for it — the socket is a {@link FetchLike}, so the
 * ordinary untyped system client is built over it and wrapped by
 * {@link fromReadWrite} exactly as the HTTP one is. Every typed path
 * (`db.q(q => q.where(…).find(…))`, `Eid.pull(…)`, `db.transact(…)`, the
 * catalog ensure itself) therefore rides the socket unchanged, and the peer
 * sees frames rather than a byte pipe.
 *
 * @example
 * ```typescript
 * const { session, db } = yield* SchemaFx.Session.connect({
 *   url: "https://ripple.example.workers.dev",
 *   name: "movies",
 *   catalog: Movies,
 *   token,
 * });
 * session.onT((t) => console.log("basis moved", t));
 * yield* db.transact(function* (tx) { … });
 * ```
 */

import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { FetchLike } from "../Client.ts";
import {
  makeReadWriteSystemClient as makeUntypedReadWriteSystemClient,
  systemSource,
} from "../Client.ts";
import { openSession, type Session, type SessionOptions } from "../Session.ts";
import type { AnyCatalog } from "./Catalog.ts";
import {
  fromReadWrite,
  type OpenError,
  type TypedReadWriteDatabaseClient,
} from "./Client.ts";

/** The socket, and the one database it is bound to. */
export interface TypedSession<C extends AnyCatalog = AnyCatalog> {
  /** The transport: `t`, `onT`, `close`. */
  readonly session: Session;
  /** The catalog-typed client speaking it. */
  readonly db: TypedReadWriteDatabaseClient<C>;
}

export interface TypedSessionOptions<C extends AnyCatalog> extends SessionOptions {
  readonly catalog: C;
}

/**
 * Open a session socket and a catalog-typed client over it. Ensures the catalog
 * (one `transact` frame) before handing the client back, same as
 * `SchemaFx.makeSystem(...).create(name, catalog)`; the socket is closed if that
 * fails, so a failed `connect` leaves nothing open.
 */
export const connect = <C extends AnyCatalog>(
  options: TypedSessionOptions<C>,
): Effect.Effect<TypedSession<C>, OpenError, RuntimeContext> =>
  Effect.gen(function* () {
    const session = openSession(options);
    const fetch: FetchLike = session.fetch;
    const system = fromReadWrite(
      makeUntypedReadWriteSystemClient(
        systemSource({
          url: options.url,
          token: options.token,
          headers: options.headers,
          fetch,
        }),
      ),
    );
    const db = yield* system
      .create(options.name, options.catalog)
      .pipe(Effect.tapError(() => Effect.sync(() => session.close())));
    return { session, db };
  });
