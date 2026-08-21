/**
 * `Databases` — the client, as a Context service.
 *
 * The key *is* the client: `yield* Ramose.Databases` hands back something with
 * one method, `db(name, catalog)`, and that call is pure — no network, no
 * ensure, no socket. A Worker binding therefore does zero network per request,
 * and a browser never installs schema.
 *
 * `layer(options)` is the portable way to get one: a scoped layer whose
 * finalizer closes whatever sockets were opened. Getting a `Databases` cannot
 * fail (`Layer<Databases, never, never>`) — a malformed URL or a missing
 * `fetch` is a provisioning mistake, so it is a defect, not a `DbError`.
 */

import { fromJson, toJson } from "../internal/core/json.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type { AnyCatalog } from "./Catalog.ts";
import { type Db, makeDb, type Wire } from "./Db.ts";
import {
  type DbError,
  fromResponse,
  InternalError,
  isDatabaseError,
  NetworkError,
} from "./Errors.ts";
import {
  type FetchLike,
  fromStandardFetch,
  globalFetch,
  minTHeader,
  record,
  retryTransient,
  send,
} from "./http.ts";
import { schemaTx } from "./ensure.ts";
import {
  defaultStore,
  openFollower,
  type Follower,
} from "./follower.ts";
import type { Overlay } from "./overlay.ts";
import type { ByteStore } from "./persist.ts";
import { connectSharedFollower, type PortClient } from "./port-client.ts";
import {
  globalWebSocket,
  openSession,
  type Session,
  type SessionPrincipal,
  type SocketFactory,
} from "./session.ts";
import type { TokenSource } from "./token.ts";

/** One method, because a database is a name. */
export interface DatabasesShape {
  db<C extends AnyCatalog>(name: string, catalog: C): Db<C>;
}

/**
 * The capability. Yield it to get the client:
 *
 * ```typescript
 * const ramose = yield* Ramose.Databases;
 * const db = ramose.db("todos", Todos);
 * ```
 */
export class Databases extends Context.Service<Databases, DatabasesShape>()(
  "Ramose.Databases",
) {}

export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  /**
   * The bearer credential. It is re-read on every (re)connect and every
   * `/transact`, so a refresh needs no API of its own. Static:
   * `Effect.succeed(Redacted.make(t))` or `token.static(t)`; a refreshing
   * JWT: `token.jwt(mint)` — a {@link TokenSource} is read via its `.token`.
   */
  readonly token?:
    | Effect.Effect<Redacted.Redacted<string>, DbError>
    | TokenSource
    | undefined;
  /** Injection seam — defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injection seam — defaults to the ambient `WebSocket`. */
  readonly webSocket?: typeof WebSocket | undefined;
  /**
   * Overlay persist. Tests inject a byte store (memory / temp dir). A
   * browser SharedWorker uses OPFS; the in-page fallback uses the same
   * seam when this is omitted.
   */
  readonly persist?: ByteStore | undefined;
  /**
   * `auto` (default): SharedWorker when it exists and this is not a test
   * fake. `page`: one in-page follower (no worker).
   */
  readonly follower?: "auto" | "page" | undefined;
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
  readonly token?:
    | Effect.Effect<Redacted.Redacted<string>, DbError>
    | undefined;
  /** `env.Peer.fetch` in a Worker, the ambient `fetch` everywhere else. */
  readonly fetch: FetchLike;
  /** Omit for an HTTPS-only client: reads fall back to POST, `live` is unavailable. */
  readonly webSocket?: SocketFactory | undefined;
  /** Extra headers on every HTTPS request (`x-ramose-replica-hint`, …). */
  readonly headers?: Record<string, string> | undefined;
  readonly persist?: ByteStore | undefined;
  readonly follower?: "auto" | "page" | undefined;
  /**
   * True when the caller injected a socket factory (tests, a custom
   * `webSocket`). SharedWorker stays off so the fake peer still owns the
   * session. `connect` / `layer` set this only when `options.webSocket`
   * was passed — an ambient `WebSocket` is not an injection.
   */
  readonly socketInjected?: boolean | undefined;
  /** Handshake bound for the SharedWorker. Constructor success is not a follower. */
  readonly workerReadyMs?: number | undefined;
}

/** The credential as the wire wants it: a string, or nothing. */
const bearer = (
  token: Effect.Effect<Redacted.Redacted<string>, DbError> | undefined,
): Effect.Effect<string | undefined, DbError> =>
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

/** `/info`'s `principal` field, parsed; `undefined` when the peer sent none. */
const parsePrincipal = (raw: unknown): SessionPrincipal | undefined => {
  const p = record(raw);
  if (typeof p.class !== "string") return undefined;
  return { eid: typeof p.eid === "number" ? p.eid : null, class: p.class };
};

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
  const overlays = new Map<string, Overlay>();
  const followers = new Map<string, Follower>();
  const ports = new Map<string, PortClient>();
  const catalogs = new Map<string, AnyCatalog>();
  let closed = false;
  const pageStore: ByteStore = {
    get: async (key) => (await resolvedStore()).get(key),
    put: async (key, value) => (await resolvedStore()).put(key, value),
    delete: async (key) => {
      const s = await resolvedStore();
      await s.delete?.(key);
    },
  };
  let storeOnce: Promise<ByteStore> | undefined;
  const resolvedStore = (): Promise<ByteStore> => {
    if (config.persist !== undefined) return Promise.resolve(config.persist);
    storeOnce ??= defaultStore();
    return storeOnce;
  };

  // SharedWorker is the one follower per origin. An injected socket is a
  // test (or custom) transport — stay in-page so the fake peer owns the
  // session. `configure` fills an ambient WebSocket as the *fallback*
  // factory; that is not an injection. `follower: "page"` is the documented
  // no-worker path.
  const socketInjected =
    config.socketInjected ?? config.webSocket !== undefined;
  const useShared =
    config.follower !== "page" &&
    !socketInjected &&
    typeof SharedWorker === "function";

  const workerReadyMs = config.workerReadyMs ?? 4_000;
  let workerPort: MessagePort | undefined;
  let workerCtorFailed = false;
  let workerFail: Promise<never> | undefined;
  const sharedPort = (): MessagePort | undefined => {
    if (!useShared || workerCtorFailed) return undefined;
    if (workerPort !== undefined) return workerPort;
    try {
      // Bundler-visible specifier — same file `ramose/follower-worker`
      // exports. Constructor success is the one follower: a timeout or
      // 404 must not fall through to a second in-page overlay.
      const sw = new SharedWorker(
        new URL("./follower-worker.js", import.meta.url),
        {
          type: "module",
          name: "ramose",
        },
      );
      workerFail = new Promise<never>((_, reject) => {
        const fail = () =>
          reject(new NetworkError({ message: "ramose: follower worker failed" }));
        sw.addEventListener("error", fail);
        (sw as unknown as { onerror: (ev: Event) => void }).onerror = fail;
      });
      sw.port.start();
      workerPort = sw.port;
      return workerPort;
    } catch {
      // No working constructor — the only in-page path.
      workerCtorFailed = true;
      return undefined;
    }
  };

  // rejects with the typed DbError itself (not a FiberFailure), so the
  // session's caller can tell a thrown Unauthorized from a transport failure
  const token = (): Promise<Redacted.Redacted<string> | undefined> =>
    config.token === undefined
      ? Promise.resolve(undefined)
      : Effect.runPromise(Effect.result(config.token)).then((result) =>
          Result.isFailure(result)
            ? Promise.reject(result.failure)
            : Promise.resolve(result.success),
        );

  const session = (name: string): Session | undefined => {
    // The SharedWorker owns the one session socket. Tabs do not open a
    // second follower. Constructor success keeps this path even when the
    // handshake is still outstanding — timeout does not spawn in-page.
    if (useShared && !workerCtorFailed && sharedPort() !== undefined) {
      return ports.get(name)?.session;
    }
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

  const bindShared = (name: string, client: PortClient): PortClient => {
    ports.set(name, client);
    if (config.token === undefined) {
      void client.auth("");
    } else {
      void token()
        .then((t) => client.auth(t === undefined ? "" : Redacted.value(t)))
        .catch(() => client.auth(""));
    }
    return client;
  };

  const handshakeShared = (
    sw: MessagePort,
    name: string,
    url: string,
    catalog: AnyCatalog | undefined,
  ): Promise<PortClient> => {
    const opened = connectSharedFollower(
      sw,
      {
        name,
        url,
        schema: catalog !== undefined ? schemaTx(catalog) : undefined,
      },
      { timeoutMs: workerReadyMs },
    );
    return workerFail === undefined
      ? opened
      : Promise.race([opened, workerFail]);
  };

  const ensureShared = async (name: string): Promise<PortClient> => {
    const hit = ports.get(name);
    if (hit !== undefined) return hit;
    const sw = sharedPort();
    if (sw === undefined) {
      throw new NetworkError({
        message: "ramose: follower worker did not start",
      });
    }
    const url = await Effect.runPromise(config.url);
    const catalog = catalogs.get(name);
    // Handshake is not a token mint. Hydrate / first paint run without
    // it; auth rides a follow-up so the socket and writes can wait.
    // Constructor success + no reply retries the same worker — it does
    // not become a per-tab store.
    try {
      return bindShared(name, await handshakeShared(sw, name, url, catalog));
    } catch (first) {
      try {
        return bindShared(name, await handshakeShared(sw, name, url, catalog));
      } catch {
        throw first instanceof NetworkError
          ? first
          : new NetworkError({
              message: "ramose: follower worker did not answer",
              cause: first,
            });
      }
    }
  };

  const pageOverlay = (name: string): Overlay | undefined => {
    if (session(name) === undefined) return undefined;
    let existing = overlays.get(name);
    if (existing !== undefined) return existing;
    const socket = session(name)!;
    const f = openFollower({
      name,
      session: socket,
      post: (tx, clientTxId) => postTx(name, tx, clientTxId),
      catalog: catalogs.get(name),
      store:
        config.persist ??
        (config.fetch === globalFetch ? pageStore : undefined),
    });
    followers.set(name, f);
    existing = f.overlay;
    overlays.set(name, existing);
    return existing;
  };

  const sharedStubs = new Map<string, Overlay>();

  const sharedOverlay = (name: string): Overlay => {
    const stub = sharedStubs.get(name);
    if (stub !== undefined) return stub;
    const wait = async (): Promise<Overlay> => {
      return (await ensureShared(name)).overlay;
    };
    const overlay: Overlay = {
      get confirmedT() {
        return ports.get(name)?.overlay.confirmedT ??
          overlays.get(name)?.confirmedT ??
          0;
      },
      get epoch() {
        return ports.get(name)?.overlay.epoch ?? overlays.get(name)?.epoch ?? 0;
      },
      onChange: (cb) => {
        let off = (): void => {};
        void wait().then((c) => {
          off = c.onChange(cb);
        });
        return () => off();
      },
      ready: () =>
        Effect.tryPromise({
          try: async () => {
            await Effect.runPromise((await wait()).ready());
          },
          catch: (cause) =>
            isDatabaseError(cause) ? cause : networkError(cause),
        }),
      read: (op, body) =>
        Effect.tryPromise({
          try: async () => Effect.runPromise((await wait()).read(op, body)),
          catch: (cause) =>
            isDatabaseError(cause) ? cause : networkError(cause),
        }),
      transact: (tx) =>
        Effect.tryPromise({
          try: async () => Effect.runPromise((await wait()).transact(tx)),
          catch: (cause) =>
            isDatabaseError(cause) ? cause : networkError(cause),
        }),
      handlePush: async () => {},
      snapshot: () => wait().then((c) => c.snapshot()),
      flush: () => wait().then((c) => c.flush()),
    };
    sharedStubs.set(name, overlay);
    return overlay;
  };

  const overlayOf = (name: string): Overlay | undefined => {
    if (useShared && !workerCtorFailed && sharedPort() !== undefined) {
      return sharedOverlay(name);
    }
    return pageOverlay(name);
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
        // a token source that failed typed keeps its tag (an Unauthorized
        // mint stays terminal); everything else here is transport
        catch: (cause) =>
          isDatabaseError(cause) ? cause : networkError(cause),
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

  const postTx = (
    name: string,
    tx: readonly unknown[],
    clientTxId?: string,
  ): Effect.Effect<unknown, DbError> =>
    Effect.gen(function* () {
      const result = yield* send({
        fetch: config.fetch,
        url: yield* config.url,
        method: "POST",
        path: dbPath(name, "/transact"),
        // re-read per transact, exactly as on every (re)connect
        token: yield* bearer(config.token),
        headers: config.headers,
        body: {
          tx,
          ...(clientTxId !== undefined ? { clientTxId } : {}),
        },
      });
      return result.body;
    });

  const info = (name: string): Effect.Effect<unknown, DbError> =>
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
    });

  /**
   * `db.principal()`'s answer, cached per session generation — a reconnect
   * authenticates afresh, so the cache is void with it. A `null` eid is never
   * cached: the row may be written at any moment, and re-reading after that
   * write is the whole point. An in-place `auth` swap supersedes both — its
   * ack names the new principal outright, or says its row does not exist yet,
   * which voids what `/info` said about the old one (`acked` pins the cache
   * entry to the ack it was read under, by identity).
   */
  const principals = new Map<
    string,
    {
      generation: number;
      acked: SessionPrincipal | undefined;
      value: SessionPrincipal;
    }
  >();

  const principal = (
    name: string,
  ): Effect.Effect<SessionPrincipal, DbError> =>
    Effect.suspend(() => {
      const socket = session(name);
      const acked = socket?.principal;
      // the swap's ack already named the entity: no request needed
      if (acked !== undefined && acked.eid !== null) {
        return Effect.succeed(acked);
      }
      const generation = socket?.generation ?? 0;
      const hit = principals.get(name);
      if (
        hit !== undefined &&
        hit.generation === generation &&
        hit.acked === acked &&
        hit.value.eid !== null
      ) {
        return Effect.succeed(hit.value);
      }
      return info(name).pipe(
        Effect.flatMap((body) => {
          const value = parsePrincipal(record(body).principal);
          if (value === undefined) {
            return Effect.fail<DbError>(
              new InternalError({
                message:
                  "ramose: the peer's /info reported no principal — it predates db.principal()",
              }),
            );
          }
          if (value.eid !== null) {
            principals.set(name, {
              generation: socket?.generation ?? 0,
              acked,
              value,
            });
          }
          return Effect.succeed(value);
        }),
      );
    });

  const wire: Wire = {
    session,
    bindCatalog: (name, catalog) => {
      catalogs.set(name, catalog);
    },
    overlay: overlayOf,
    read: (name, op, body, minT) => {
      const pinned = body.asOf !== undefined || body.history === true;
      if (!pinned) {
        const ov = overlayOf(name);
        if (ov !== undefined) return ov.read(op, body);
      }
      const socket = session(name);
      return socket === undefined
        ? post(name, op, body, minT)
        : frame(socket, op, body, minT);
    },
    transact: (name, tx, clientTxId) => postTx(name, tx, clientTxId),
    info,
    principal,
  };

  return {
    databases: {
      db: <C extends AnyCatalog>(name: string, catalog: C) =>
        makeDb(wire, name, catalog),
    },
    close: () => {
      closed = true;
      for (const s of sessions.values()) s.close();
      for (const f of followers.values()) f.close();
      for (const p of ports.values()) p.close();
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
        new Error(`ramose: malformed url ${JSON.stringify(options.url)}`),
      );
    }
    const ambient = typeof fetch === "undefined" ? undefined : fetch;
    const chosen = options.fetch ?? ambient;
    if (chosen === undefined) {
      return Effect.die(
        new Error(
          "ramose: no global fetch — pass `fetch` to Ramose.connect({ … }) or Ramose.layer({ … })",
        ),
      );
    }
    const socket: SocketFactory | undefined =
      options.webSocket === undefined
        ? globalWebSocket()
        : (url) => new options.webSocket!(url) as never;
    // a TokenSource is its `.token` Effect; the layer never sees the rest
    const token =
      options.token === undefined || Effect.isEffect(options.token)
        ? options.token
        : options.token.token;
    return Effect.succeed({
      url: Effect.succeed(options.url.replace(/\/+$/, "")),
      token,
      fetch:
        options.fetch === undefined ? globalFetch : fromStandardFetch(chosen),
      webSocket: socket,
      persist: options.persist,
      follower: options.follower,
      socketInjected: options.webSocket !== undefined,
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

/**
 * The handle {@link connect} returns: the same pure `db` as {@link Databases},
 * plus the close `layer` performs as its finalizer — and nothing else. In
 * particular no `run`: every `Db` method has `R = never`, so
 * `Effect.runPromise(db.q(…))` is how its Effects run.
 */
export interface Client {
  /** Pure — the same call as `Databases.db`: no network, no ensure, no socket. */
  db<C extends AnyCatalog>(name: string, catalog: C): Db<C>;
  /**
   * Close every session socket this client opened; resolves once they are.
   * Idempotent, and after `close` reads fail rather than silently changing
   * transport (they do not fall back to POST).
   */
  close(): Promise<void>;
}

/**
 * A `Client` for non-Effect callers — a browser app, a script — so nothing
 * outside Effect land needs a `ManagedRuntime` just to build the client and
 * close its sockets. A thin wrapper over the factory `layer` uses, not a
 * second client; `layer` stays the Effect-native entry.
 *
 * A provisioning mistake (malformed URL, no `fetch`) throws synchronously:
 * the same defects `layer` dies with.
 */
export const connect = (options: ClientOptions): Client => {
  // `configure` is synchronous — suspend + succeed/die — so `runSync` is honest
  const { databases, close } = makeDatabases(
    Effect.runSync(configure(options)),
  );
  return {
    db: (name, catalog) => databases.db(name, catalog),
    close: () => {
      close();
      return Promise.resolve();
    },
  };
};
