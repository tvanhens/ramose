/**
 * `Databases` — the client, as a Context service.
 *
 * The key *is* the client: `yield* Ripple.Databases` hands back something with
 * one method, `db(name, catalog)`, and that call is pure — no network, no
 * ensure, no socket. A Worker binding therefore does zero network per request,
 * and a browser never installs schema.
 *
 * `layer(options)` is the portable way to get one: a scoped layer whose
 * finalizer closes whatever sockets were opened. Getting a `Databases` cannot
 * fail (`Layer<Databases, never, never>`) — a malformed URL or a missing
 * `fetch` is a provisioning mistake, so it is a defect, not a `DbError`.
 */

import { fromJson, toJson } from "@ripple/core/json.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { AnyCatalog } from "./Catalog.ts";
import { type Db, makeDb, type Wire } from "./Db.ts";
import { type DbError, fromResponse, NetworkError } from "./Errors.ts";
import {
  type FetchLike,
  fromStandardFetch,
  globalFetch,
  minTHeader,
  record,
  retryTransient,
  send,
} from "./http.ts";
import {
  globalWebSocket,
  openSession,
  type Session,
  type SocketFactory,
} from "./session.ts";

/** One method, because a database is a name. */
export interface DatabasesShape {
  db<C extends AnyCatalog>(name: string, catalog: C): Db<C>;
}

/**
 * The capability. Yield it to get the client:
 *
 * ```typescript
 * const ripple = yield* Ripple.Databases;
 * const db = ripple.db("todos", Todos);
 * ```
 */
export class Databases extends Context.Service<Databases, DatabasesShape>()(
  "Ripple.Databases",
) {}

export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  /**
   * The bearer credential, in the one form the client takes. It is re-read on
   * every (re)connect and every `/transact`, so a refresh needs no API of its
   * own. Static: `Effect.succeed(Redacted.make(t))`.
   */
  readonly token?: Effect.Effect<Redacted.Redacted<string>> | undefined;
  /** Injection seam — defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injection seam — defaults to the ambient `WebSocket`. */
  readonly webSocket?: typeof WebSocket | undefined;
}

// ── the internal factory ───────────────────────────────────────────────────

/**
 * @internal What {@link makeDatabases} needs. Deliberately looser than
 * {@link ClientOptions}: the Worker-side transports resolve their URL and
 * token from bound Alchemy Outputs, so both are Effects, and a service binding
 * supplies a `fetch` that is not the global one.
 */
export interface DatabasesConfig {
  /** Where to send. An Effect, so a deploy-time Output can be read per call. */
  readonly url: Effect.Effect<string>;
  readonly token?: Effect.Effect<Redacted.Redacted<string>> | undefined;
  /** `env.Peer.fetch` in a Worker, the ambient `fetch` everywhere else. */
  readonly fetch: FetchLike;
  /** Omit for an HTTPS-only client: reads fall back to POST, `live` is unavailable. */
  readonly webSocket?: SocketFactory | undefined;
  /** Extra headers on every HTTPS request (`x-ripple-replica-hint`, …). */
  readonly headers?: Record<string, string> | undefined;
}

/** The credential as the wire wants it: a string, or nothing. */
const bearer = (
  token: Effect.Effect<Redacted.Redacted<string>> | undefined,
): Effect.Effect<string | undefined> =>
  token === undefined
    ? Effect.succeed(undefined)
    : token.pipe(
        Effect.map((t) => {
          const value = Redacted.value(t);
          return value.length > 0 ? value : undefined;
        }),
      );

const dbPath = (name: string, rest: string): string =>
  `/db/${encodeURIComponent(name)}${rest}`;

const networkError = (cause: unknown): NetworkError =>
  new NetworkError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/**
 * @internal Build a client over an arbitrary transport, plus the finalizer
 * that closes its sockets.
 *
 * This is the seam the Alchemy-side transports use: a Worker service binding
 * passes `fetch: (url, init) => env.Peer.fetch(url, init)` with the synthetic
 * origin as `url` and no `webSocket` — reads then go over the same binding as
 * HTTPS POSTs, and `live` is unavailable. A public-URL transport passes the
 * peer's URL and, when it wants `live`, a `webSocket` factory.
 */
export const makeDatabases = (
  config: DatabasesConfig,
): { readonly databases: DatabasesShape; readonly close: () => void } => {
  const sessions = new Map<string, Session>();
  let closed = false;

  const token = (): Promise<Redacted.Redacted<string> | undefined> =>
    Effect.runPromise(config.token ?? Effect.succeed(undefined)).then(
      (t) => t as Redacted.Redacted<string> | undefined,
    );

  const session = (name: string): Session | undefined => {
    if (config.webSocket === undefined) return undefined;
    let existing = sessions.get(name);
    if (existing === undefined) {
      existing = openSession({
        url: () => Effect.runPromise(config.url),
        name,
        token: config.token === undefined ? undefined : token,
        connect: config.webSocket,
      });
      // past the finalizer, a socket-backed client stays socket-backed: reads
      // fail rather than silently changing transport
      if (closed) existing.close();
      sessions.set(name, existing);
    }
    return existing;
  };

  /**
   * A read as one session frame. Transient failures walk the same retry
   * ladder as HTTPS: a platform error the peer relays over the socket, or a
   * socket that dropped mid-request (the next attempt reopens it) — unless the
   * client is closed, where nothing reopens and the failure is immediate.
   */
  const frame = (
    socket: Session,
    op: "q" | "pull",
    body: Record<string, unknown>,
    minT: number | undefined,
  ): Effect.Effect<unknown, DbError> =>
    retryTransient(() =>
      Effect.tryPromise({
        try: () =>
          socket.request({
            op,
            ...record(toJson(body)),
            ...(minT === undefined ? {} : { minT }),
          }),
        catch: networkError,
      }).pipe(
        Effect.flatMap((reply) =>
          reply.status >= 200 && reply.status < 300
            ? Effect.succeed(fromJson(reply.body))
            : Effect.fail(
                fromResponse(reply.status, reply.body, {
                  get: (h) => reply.headers?.[h.toLowerCase()] ?? null,
                }),
              ),
        ),
      ),
      { while: () => !socket.closed },
    );

  /** The same read as one HTTPS POST — the fallback when there is no socket. */
  const post = (
    name: string,
    op: "q" | "pull",
    body: Record<string, unknown>,
    minT: number | undefined,
  ): Effect.Effect<unknown, DbError> =>
    Effect.gen(function* () {
      const result = yield* send({
        fetch: config.fetch,
        url: yield* config.url,
        method: "POST",
        path: dbPath(name, op === "q" ? "/query" : "/pull"),
        token: yield* bearer(config.token),
        headers: { ...(config.headers ?? {}), ...minTHeader(minT) },
        body,
      });
      return result.body;
    });

  const wire: Wire = {
    session,
    read: (name, op, body, minT) => {
      const socket = session(name);
      return socket === undefined
        ? post(name, op, body, minT)
        : frame(socket, op, body, minT);
    },
    transact: (name, tx) =>
      Effect.gen(function* () {
        const result = yield* send({
          fetch: config.fetch,
          url: yield* config.url,
          method: "POST",
          path: dbPath(name, "/transact"),
          // re-read per transact, exactly as on every (re)connect
          token: yield* bearer(config.token),
          headers: config.headers,
          body: { tx },
        });
        return result.body;
      }),
    info: (name) =>
      Effect.gen(function* () {
        const result = yield* send({
          fetch: config.fetch,
          url: yield* config.url,
          method: "GET",
          path: dbPath(name, "/info"),
          token: yield* bearer(config.token),
          headers: config.headers,
        });
        return result.body;
      }),
  };

  return {
    databases: {
      db: <C extends AnyCatalog>(name: string, catalog: C) =>
        makeDb(wire, name, catalog),
    },
    close: () => {
      closed = true;
      for (const s of sessions.values()) s.close();
    },
  };
};

/** A malformed URL, or no `fetch` at all, is a provisioning mistake: a defect. */
const configure = (
  options: ClientOptions,
): Effect.Effect<DatabasesConfig> =>
  Effect.suspend(() => {
    try {
      new URL(options.url);
    } catch {
      return Effect.die(
        new Error(`ripple: malformed url ${JSON.stringify(options.url)}`),
      );
    }
    const ambient = typeof fetch === "undefined" ? undefined : fetch;
    const chosen = options.fetch ?? ambient;
    if (chosen === undefined) {
      return Effect.die(
        new Error("ripple: no global fetch — pass `fetch` to Ripple.layer({ … })"),
      );
    }
    const socket: SocketFactory | undefined =
      options.webSocket === undefined
        ? globalWebSocket()
        : (url) => new options.webSocket!(url) as never;
    return Effect.succeed({
      url: Effect.succeed(options.url.replace(/\/+$/, "")),
      token: options.token,
      fetch:
        options.fetch === undefined ? globalFetch : fromStandardFetch(chosen),
      webSocket: socket,
    });
  });

/**
 * A `Databases` over a peer URL. Scoped: the sockets it opens are closed when
 * the layer's scope closes (a `ManagedRuntime` disposed with the page, a
 * `Layer.launch`, a test).
 */
export const layer = (options: ClientOptions): Layer.Layer<Databases> =>
  Layer.effect(
    Databases,
    Effect.gen(function* () {
      const { databases, close } = makeDatabases(yield* configure(options));
      yield* Effect.addFinalizer(() => Effect.sync(close));
      return databases;
    }),
  );
