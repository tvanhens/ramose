/**
 * The Effect-native Ripple client.
 *
 * Two shapes, one implementation. A **system** client is the peer: it knows
 * where to send and with which credential, and `create(name)` / `connect(name)`
 * hand back a **database** client scoped to one `/db/:name` — the same fetch,
 * the same token, the same headers, a different path prefix. Naming a database
 * costs no request: the peer has no create-database endpoint, the first
 * transaction materializes it.
 *
 * Three ways to get a system client inside a stack: a Worker service binding
 * (`*SystemBinding`), plain HTTPS (`*SystemHttp`), or an Action / script
 * (`*SystemLocal`). They differ only in how the {@link SystemSource} — where
 * to send, with which token — is obtained; the request shapes, the JSON
 * transport and the error classification are shared.
 *
 * The wire format is exactly the peer Worker's HTTP API
 * (packages/worker/src/index.ts), and the body transport is
 * `toJson`/`fromJson` from `@ripple/core`, so instants (`Date`), byte arrays
 * and uuids survive the round trip — same as `@ripple/client`.
 */

import { fromJson, toJson } from "@ripple/core";
import type { TxData } from "@ripple/core";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { DATABASE_NAME_RE, invalidDatabaseName } from "./DatabaseName.ts";
import {
  type BadRequest,
  type DatabaseError,
  fromResponse,
  NetworkError,
} from "./DatabaseTypes.ts";

/** Where a system client sends, with which credential. Resolved per call. */
export interface SystemEndpoint {
  /** Peer base URL, no trailing slash (e.g. `https://ripple.example.workers.dev`). */
  readonly url: string;
  /** The peer's one bearer token, used for every database name; ignored when the peer runs with `RIPPLE_TOKEN` unset. */
  readonly token?: Redacted.Redacted<string> | string | undefined;
  /** Extra headers on every request (e.g. `x-ripple-replica-hint`). */
  readonly headers?: Record<string, string> | undefined;
}

/** Where a database client sends, as what, with which credential. Resolved per call. */
export interface DatabaseEndpoint extends SystemEndpoint {
  /** Ripple database name — the `:name` in `/db/:name`. */
  readonly name: string;
}

/** The `fetch` seam. A service binding supplies `env[…].fetch`; everything else the global. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
  },
) => Promise<Response>;

/**
 * Everything the client builders need. `endpoint` is an Effect so Alchemy
 * Outputs resolve lazily, per call — which is where the `RuntimeContext`
 * requirement on every client method comes from (see `SystemRuntime.ts`).
 */
export interface SystemSource {
  readonly endpoint: Effect.Effect<SystemEndpoint, never, RuntimeContext>;
  readonly fetch: FetchLike;
}

/** The same, plus the database name every `/db/:name` route hangs off. */
export interface DatabaseSource {
  readonly endpoint: Effect.Effect<DatabaseEndpoint, never, RuntimeContext>;
  readonly fetch: FetchLike;
}

/** Response meta carried by the `x-ripple-*` headers. */
export interface QueryMeta {
  readonly ms: number | null;
  readonly r2Gets: number | null;
  readonly cacheHits: number | null;
  readonly colo?: string | undefined;
  readonly replicaHint?: string | undefined;
  readonly basisT: number | null;
  readonly basisHit: boolean;
  readonly basisReason?: string | undefined;
  readonly basisBehind: boolean;
}

export interface TxAck {
  readonly t: number;
  readonly txEid: number;
  readonly tempids: Record<string, number>;
  readonly datoms: number;
}

export interface QueryResponse<T = unknown> {
  readonly t: number;
  readonly root: number;
  readonly result: T;
  readonly explain?: unknown[];
  readonly meta: QueryMeta;
}

/** Per-read options. `pull` / `entity` read only the fence; `explain` is query-only. */
export interface QueryOptions {
  /** Ask the planner for its clause-by-clause plan. */
  readonly explain?: boolean;
  /**
   * Read fence: the server refetches its basis when the cached one is older
   * than `t` (pass the `t` of your last transact for read-your-writes).
   */
  readonly minT?: number;
}

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly service: string;
  readonly stage: string;
  readonly time: number;
}

/** Read half: queries, pulls, entities, info, and the `asOf` / `history` views. */
export interface ReadDatabaseClient {
  /** Run a datalog query and return just the result relation. */
  q<T = unknown>(
    query: string | object,
    inputs?: unknown[],
    options?: QueryOptions,
  ): Effect.Effect<T, DatabaseError, RuntimeContext>;
  /** Run a datalog query and keep `t` / `root` / `explain` / the `x-ripple-*` meta. */
  query<T = unknown>(
    query: string | object,
    inputs?: unknown[],
    options?: QueryOptions,
  ): Effect.Effect<QueryResponse<T>, DatabaseError, RuntimeContext>;
  /** Pull a pattern from one entity (eid, lookup ref, or ident). */
  pull<T = Record<string, unknown> | null>(
    eid: number | string | [string, unknown],
    pattern: string | unknown[],
    options?: QueryOptions,
  ): Effect.Effect<T, DatabaseError, RuntimeContext>;
  /** The whole entity map, or `undefined` when it has no datoms. */
  entity(
    eid: number,
    options?: QueryOptions,
  ): Effect.Effect<
    Record<string, unknown> | undefined,
    DatabaseError,
    RuntimeContext
  >;
  /** Transactor + replica + peer stats for this database. */
  info(): Effect.Effect<Record<string, unknown>, DatabaseError, RuntimeContext>;
  /** Peer liveness (`GET /health`), not database-scoped. */
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
  /** Read-only view as of transaction `t`. */
  asOf(t: number): ReadDatabaseClient;
  /** History view — asserts *and* retracts, with tx and op. */
  history(): ReadDatabaseClient;
}

/** Write half. */
export interface WriteDatabaseClient {
  /** Submit a transaction; resolves once it is committed and durable. */
  transact(tx: TxData): Effect.Effect<TxAck, DatabaseError, RuntimeContext>;
}

export interface ReadWriteDatabaseClient
  extends ReadDatabaseClient,
    WriteDatabaseClient {}

/**
 * The peer, and every database on it.
 *
 * `create` and `connect` are the same function — a Ripple database is a name,
 * so opening one is arithmetic on a path, not a request. Neither wakes the
 * Durable Object; the first `transact` materializes the database, whether or
 * not it already had datoms. Only the *name* can be wrong, and it is checked
 * against {@link DATABASE_NAME_RE} before anything else, so an illegal name
 * fails the Effect with `BadRequest` instead of reaching the peer.
 */
export interface ReadSystemClient {
  /** A read client for Ripple database `name` on this peer. */
  create(name: string): Effect.Effect<ReadDatabaseClient, BadRequest>;
  /** Alias of {@link ReadSystemClient.create} — same implementation. */
  connect(name: string): Effect.Effect<ReadDatabaseClient, BadRequest>;
  /** Peer liveness (`GET /health`), not database-scoped. */
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

/** Write half of the peer. @see ReadSystemClient */
export interface WriteSystemClient {
  /** A write client for Ripple database `name` on this peer. */
  create(name: string): Effect.Effect<WriteDatabaseClient, BadRequest>;
  /** Alias of {@link WriteSystemClient.create} — same implementation. */
  connect(name: string): Effect.Effect<WriteDatabaseClient, BadRequest>;
  /** Peer liveness (`GET /health`), not database-scoped. */
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

/** Read + write. @see ReadSystemClient */
export interface ReadWriteSystemClient {
  /** A read-write client for Ripple database `name` on this peer. */
  create(name: string): Effect.Effect<ReadWriteDatabaseClient, BadRequest>;
  /** Alias of {@link ReadWriteSystemClient.create} — same implementation. */
  connect(name: string): Effect.Effect<ReadWriteDatabaseClient, BadRequest>;
  /** Peer liveness (`GET /health`), not database-scoped. */
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

/** The `asOf` / `history` coordinates a read view carries. */
interface View {
  readonly asOf?: number | undefined;
  readonly history?: boolean | undefined;
}

const number = (s: string | null): number | null =>
  s === null ? null : Number(s);

const metaOf = (headers: { get(name: string): string | null }): QueryMeta => ({
  ms: number(headers.get("x-ripple-ms")),
  r2Gets: number(headers.get("x-ripple-r2-gets")),
  cacheHits: number(headers.get("x-ripple-cache-hits")),
  colo: headers.get("x-ripple-colo") ?? undefined,
  replicaHint: headers.get("x-ripple-replica-hint") ?? undefined,
  basisT: number(headers.get("x-ripple-basis-t")),
  basisHit: headers.get("x-ripple-basis-hit") === "1",
  basisReason: headers.get("x-ripple-basis-reason") ?? undefined,
  basisBehind: headers.get("x-ripple-basis-behind") === "1",
});

/** Drop `undefined` fields — JSON would otherwise send them as `null`. */
const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

const bearer = (
  token: Redacted.Redacted<string> | string | undefined,
): string | undefined => {
  if (token === undefined) return undefined;
  const value = typeof token === "string" ? token : Redacted.value(token);
  return value.length > 0 ? value : undefined;
};

interface RawResult {
  readonly body: unknown;
  readonly headers: { get(name: string): string | null };
}

/**
 * One request: JSON in, `fromJson` out, non-2xx classified into a tagged
 * failure. Generic over the endpoint so the peer-level routes (`/health`) and
 * the database-level ones (`/db/:name/…`) share it — `path` is handed the
 * resolved endpoint, which is the only thing that knows the name.
 */
const send = <E extends SystemEndpoint>(
  source: {
    readonly endpoint: Effect.Effect<E, never, RuntimeContext>;
    readonly fetch: FetchLike;
  },
  method: string,
  path: (endpoint: E) => string,
  body?: unknown,
  extra?: Record<string, string>,
): Effect.Effect<RawResult, DatabaseError, RuntimeContext> =>
  Effect.gen(function* () {
    const endpoint = yield* source.endpoint;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(endpoint.headers ?? {}),
      ...(extra ?? {}),
    };
    const token = bearer(endpoint.token);
    if (token !== undefined) headers.authorization = `Bearer ${token}`;

    const response = yield* Effect.tryPromise({
      try: () =>
        source.fetch(endpoint.url + path(endpoint), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(toJson(body)),
        }),
      catch: (cause) =>
        new NetworkError({
          message: `ripple: ${method} ${path(endpoint)} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new NetworkError({
          message: "ripple: response body could not be read",
          cause,
        }),
    });

    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text };
    }

    if (!response.ok) {
      return yield* Effect.fail(
        fromResponse(response.status, parsed, response.headers),
      );
    }
    return { body: fromJson(parsed), headers: response.headers };
  });

const dbPath =
  (suffix: string) =>
  (endpoint: DatabaseEndpoint): string =>
    `/db/${encodeURIComponent(endpoint.name)}${suffix}`;

/** The read fence, as the header the peer reads it from. `explain` is body-side. */
const fenceHeaders = (
  options: QueryOptions | undefined,
): Record<string, string> | undefined =>
  options?.minT === undefined
    ? undefined
    : { "x-ripple-min-t": String(options.minT) };

const record = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

const makeRead = (source: DatabaseSource, view: View): ReadDatabaseClient => {
  const query = <T = unknown>(
    q: string | object,
    inputs: unknown[] = [],
    options: QueryOptions = {},
  ): Effect.Effect<QueryResponse<T>, DatabaseError, RuntimeContext> =>
    send(
      source,
      "POST",
      dbPath("/query"),
      compact({
        query: q,
        inputs,
        asOf: view.asOf,
        history: view.history === true ? true : undefined,
        explain: options.explain,
      }),
      fenceHeaders(options),
    ).pipe(
      Effect.map(({ body, headers }) => {
        const r = record(body);
        return {
          t: r.t as number,
          root: r.root as number,
          result: r.result as T,
          explain: r.explain as unknown[] | undefined,
          meta: metaOf(headers),
        };
      }),
    );

  return {
    query,
    q: <T = unknown>(
      q: string | object,
      inputs: unknown[] = [],
      options: QueryOptions = {},
    ) => query<T>(q, inputs, options).pipe(Effect.map((r) => r.result)),
    pull: <T = Record<string, unknown> | null>(
      eid: number | string | [string, unknown],
      pattern: string | unknown[],
      options: QueryOptions = {},
    ) =>
      send(
        source,
        "POST",
        dbPath("/pull"),
        compact({
          eid,
          pattern,
          asOf: view.asOf,
          history: view.history === true ? true : undefined,
        }),
        fenceHeaders(options),
      ).pipe(Effect.map(({ body }) => record(body).result as T)),
    entity: (eid: number, options: QueryOptions = {}) =>
      send(
        source,
        "GET",
        dbPath(
          `/entity/${eid}${view.asOf === undefined ? "" : `?asOf=${view.asOf}`}`,
        ),
        undefined,
        fenceHeaders(options),
      ).pipe(
        Effect.map(({ body }) => {
          const entity = record(body).entity;
          return entity === null || entity === undefined
            ? undefined
            : (entity as Record<string, unknown>);
        }),
      ),
    info: () =>
      send(source, "GET", dbPath("/info")).pipe(
        Effect.map(({ body }) => record(body)),
      ),
    health: () =>
      send(source, "GET", () => "/health").pipe(
        Effect.map(({ body }) => record(body) as unknown as DatabaseHealth),
      ),
    asOf: (t: number) => makeRead(source, { ...view, asOf: t }),
    history: () => makeRead(source, { ...view, history: true }),
  };
};

const makeWrite = (source: DatabaseSource): WriteDatabaseClient => ({
  transact: (tx: TxData) =>
    send(source, "POST", dbPath("/transact"), { tx }).pipe(
      Effect.map(({ body }) => record(body) as unknown as TxAck),
    ),
});

/** Build the read half of the database client. */
export const makeReadClient = (source: DatabaseSource): ReadDatabaseClient =>
  makeRead(source, {});

/** Build the write half of the database client. */
export const makeWriteClient = (source: DatabaseSource): WriteDatabaseClient =>
  makeWrite(source);

/** Build the read-write database client from its two halves. */
export const makeReadWriteClient = (
  source: DatabaseSource,
): ReadWriteDatabaseClient => ({
  ...makeRead(source, {}),
  ...makeWrite(source),
});

/**
 * Scope a system source to one database. Everything but the added
 * `endpoint.name` — url, token, headers, and the `fetch` function object
 * itself — is reused by reference; only the resolved endpoint is rewritten,
 * so an Alchemy Output still resolves lazily, per call.
 */
const scope = (source: SystemSource, name: string): DatabaseSource => ({
  endpoint: source.endpoint.pipe(
    Effect.map((endpoint) => ({ ...endpoint, name })),
  ),
  fetch: source.fetch,
});

/**
 * `create` / `connect`, for whichever privilege the system was bound with.
 * Validation is synchronous and total; nothing here touches the network, and
 * the endpoint Effect is not even run.
 */
const opener =
  <Client>(source: SystemSource, make: (source: DatabaseSource) => Client) =>
  (name: string): Effect.Effect<Client, BadRequest> =>
    DATABASE_NAME_RE.test(name)
      ? Effect.succeed(make(scope(source, name)))
      : Effect.fail(invalidDatabaseName(name));

const peerHealth = (source: SystemSource) => () =>
  send(source, "GET", () => "/health").pipe(
    Effect.map(({ body }) => record(body) as unknown as DatabaseHealth),
  );

/** Build the read half of the system client. */
export const makeReadSystemClient = (
  source: SystemSource,
): ReadSystemClient => {
  const create = opener(source, makeReadClient);
  return { create, connect: create, health: peerHealth(source) };
};

/** Build the write half of the system client. */
export const makeWriteSystemClient = (
  source: SystemSource,
): WriteSystemClient => {
  const create = opener(source, makeWriteClient);
  return { create, connect: create, health: peerHealth(source) };
};

/** Build the read-write system client. */
export const makeReadWriteSystemClient = (
  source: SystemSource,
): ReadWriteSystemClient => {
  const create = opener(source, makeReadWriteClient);
  return { create, connect: create, health: peerHealth(source) };
};

/** The ambient `fetch`, bound once. */
export const globalFetch: FetchLike = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });

export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  /** Ripple database name — the `:name` in `/db/:name`. */
  readonly name: string;
  readonly token?: Redacted.Redacted<string> | string | undefined;
  readonly headers?: Record<string, string> | undefined;
  /**
   * Injection seam — defaults to the ambient `fetch`.
   *
   * A Worker service binding fits straight through it, which keeps the request
   * on Cloudflare's internal network instead of the public internet:
   * `fetch: (url, init) => env.Peer.fetch(url, init)`. `url` is then only a
   * routing key for the peer, so any absolute base works.
   */
  readonly fetch?: FetchLike | undefined;
}

/** The same, minus the database name: a system client picks that per call. */
export interface SystemClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  readonly token?: Redacted.Redacted<string> | string | undefined;
  readonly headers?: Record<string, string> | undefined;
  /** Injection seam — defaults to the ambient `fetch`. @see ClientOptions.fetch */
  readonly fetch?: FetchLike | undefined;
}

/** A {@link DatabaseSource} over concrete values (no Alchemy Outputs involved). */
export const source = (options: ClientOptions): DatabaseSource => ({
  endpoint: Effect.succeed({
    url: options.url.replace(/\/+$/, ""),
    name: options.name,
    token: options.token,
    headers: options.headers,
  }),
  fetch: options.fetch ?? globalFetch,
});

/** A {@link SystemSource} over concrete values (no Alchemy Outputs involved). */
export const systemSource = (options: SystemClientOptions): SystemSource => ({
  endpoint: Effect.succeed({
    url: options.url.replace(/\/+$/, ""),
    token: options.token,
    headers: options.headers,
  }),
  fetch: options.fetch ?? globalFetch,
});

/**
 * A database client, for code that is not running inside an Alchemy stack —
 * bun scripts, tests, a server outside Cloudflare.
 *
 * @example
 * ```typescript
 * const db = Ripple.Client.make({ url: "https://ripple.example.workers.dev", name: "movies" });
 * const rows = yield* db.q(`[:find ?n :where [?e :user/name ?n]]`);
 * ```
 */
export const make = (options: ClientOptions): ReadWriteDatabaseClient =>
  makeReadWriteClient(source(options));

/**
 * The peer itself, for the same code — one client, one token, one `fetch`,
 * reaching every database on it through `create` / `connect`.
 *
 * @example
 * ```typescript
 * const system = Ripple.Client.makeSystem({ url: "https://ripple.example.workers.dev" });
 * const movies = yield* system.create("movies");
 * yield* movies.transact([{ ":user/name": "Ada" }]);
 * ```
 *
 * This is how db-per-tenant is meant to be done: a Worker passes its service
 * binding in as the `fetch` and opens the database per request.
 *
 * @example Db-per-tenant over a service binding
 * ```typescript
 * const system = Ripple.Client.makeSystem({
 *   url: "https://peer",                       // routing key only
 *   fetch: (url, init) => env.Peer.fetch(url, init),
 * });
 * const tenant = yield* system.create(tenantId);
 * const ack = yield* tenant.transact([{ ":user/name": "Ada" }]);
 * ```
 */
export const makeSystem = (
  options: SystemClientOptions,
): ReadWriteSystemClient => makeReadWriteSystemClient(systemSource(options));
