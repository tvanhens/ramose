/**
 * `connect` — the promise-land client handle.
 *
 * App callers get {@link Client} (`db.query`, `db.run`, `db.live`) without a
 * `ManagedRuntime`. Effect's `layer` / `Databases` stay on `ramose/db/effect`.
 */

import type { AnySchema } from "./Schema.ts";
import { openConnected } from "./Databases.ts";
import type { Db } from "./Db.ts";
import type { TokenInput } from "./token.ts";

export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  /**
   * The bearer credential. It is re-read on every (re)connect and every
   * write, so a refresh needs no API of its own. A plain string, a
   * `() => string | Promise<string>`, or a {@link TokenInput} source
   * (`token.jwt` / `token.static`).
   */
  readonly token?: TokenInput | undefined;
  /** Injection seam — defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injection seam — defaults to the ambient `WebSocket`. */
  readonly webSocket?: typeof WebSocket | undefined;
}

/**
 * The handle {@link connect} returns: the same `db` as the hatch's
 * `Databases`, plus the close `layer` performs as its finalizer. Methods
 * on `db` are promises (`db.query`, `db.run`); Effect variants live on
 * `db.effect`.
 */
export interface Client {
  /** Pure — the same call as `Databases.db`: no network, no ensure, no socket. */
  db<C extends AnySchema>(name: string, schema: C): Db<C>;
  /**
   * Close every session socket this client opened; resolves once they are.
   * Idempotent, and after `close` reads fail rather than silently changing
   * transport (they do not fall back to POST).
   */
  close(): Promise<void>;
}

/**
 * A `Client` for app callers — a browser app, a script — so nothing
 * outside Effect land needs a `ManagedRuntime` just to build the client and
 * close its sockets. A thin wrapper over the factory `layer` uses, not a
 * second client; `layer` lives on `ramose/db/effect`.
 *
 * A provisioning mistake (malformed URL, no `fetch`) throws synchronously:
 * the same defects `layer` dies with.
 */
export const connect = (options: ClientOptions): Client => {
  const { databases, close } = openConnected(options);
  return {
    db: (name, catalog) => databases.db(name, catalog),
    close: () => {
      close();
      return Promise.resolve();
    },
  };
};
