/**
 * `connect` — the promise-land client handle.
 *
 * App callers get {@link Client} (`db.query`, `db.run`, `db.live`) without a
 * `ManagedRuntime`. Effect's `layer` / `Databases` stay on `ramose/db/effect`.
 *
 * This module is scanned by `scripts/check-client-dts.ts` with no allowlist
 * exemption: do not add `effect` to any exported type (`Client`,
 * `ClientOptions`, `connect`).
 */

import type { AnySchema } from "./Schema.ts";
import type { Db } from "./Db.ts";
import { NetworkError } from "./Errors.ts";
import { trimSlashes } from "./http.ts";
import { configFromClientOptions, makeDatabases } from "./factory.ts";
import {
  type AnyOperations,
  checkOperationsCoverage,
} from "./Operation.ts";
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
  /**
   * The registry this client ships. {@link Client.checkOperations} compares
   * its ids to the peer's `GET /health` list.
   */
  readonly operations?: AnyOperations | undefined;
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
  /**
   * `GET /health` and fail if the peer is missing any client-shipped op id.
   * No-op when `operations` was not passed to {@link connect}.
   */
  checkOperations(): Promise<void>;
}

const healthOperationsOf = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null) return [];
  const listed = (body as { operations?: unknown }).operations;
  if (!Array.isArray(listed)) return [];
  return listed.filter((n): n is string => typeof n === "string");
};

const checkClientOperations = async (options: ClientOptions): Promise<void> => {
  if (options.operations === undefined) return;
  const url = trimSlashes(options.url);
  const fetchFn = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${url}/health`, { method: "GET" });
  } catch (cause) {
    throw new NetworkError({
      message: `ramose: server at ${url} is unreachable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new NetworkError({
      message: `ramose: server at ${url} answered /health with ${response.status}`,
    });
  }
  checkOperationsCoverage(options.operations, healthOperationsOf(body));
};

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
  const { databases, close } = makeDatabases(configFromClientOptions(options));
  return {
    db: (name, catalog) => databases.db(name, catalog),
    close: () => {
      close();
      return Promise.resolve();
    },
    checkOperations: () => checkClientOperations(options),
  };
};
