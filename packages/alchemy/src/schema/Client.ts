/** Catalog-generic System / Database clients. Wraps today's untyped Ripple client. */

import type { TxData } from "@ripple/core";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type {
  DatabaseHealth,
  QueryOptions,
  QueryResponse,
  ReadDatabaseClient,
  ReadSystemClient,
  ReadWriteDatabaseClient,
  ReadWriteSystemClient,
  SystemSource,
  TxAck,
  WriteDatabaseClient,
  WriteSystemClient,
} from "../Client.ts";
import {
  makeReadSystemClient as makeUntypedReadSystemClient,
  makeReadWriteSystemClient as makeUntypedReadWriteSystemClient,
  makeWriteSystemClient as makeUntypedWriteSystemClient,
  systemSource,
  type SystemClientOptions,
} from "../Client.ts";
import { DATABASE_NAME_RE, invalidDatabaseName } from "../DatabaseName.ts";
import type { BadRequest, DatabaseError } from "../DatabaseTypes.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { makeEid, type EidPull } from "./Eid.ts";
import { schemaTx } from "./ensure.ts";
import { MissingPeer, noPeer, SchemaEnsureError } from "./Errors.ts";
import {
  queryBuilder,
  toQueryObject,
  type QueryBuilder,
  type QueryIo,
  type QuerySpec,
  type QueryVar,
} from "./Query.ts";
import {
  lowerWireTx,
  txBuilder,
  type TxBuilder,
  type WireTx,
  type YieldContext,
  type YieldError,
} from "./Tx.ts";

export type OpenError = BadRequest | SchemaEnsureError;

export type IoError = DatabaseError | MissingPeer;

/** Read half, generic on the catalog. No `transact`. */
export interface TypedReadDatabaseClient<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly name: string;

  /** Start a catalog-typed query builder. */
  q(): QueryBuilder<C, {}>;
  /**
   * Callback form: `yield* db.q(q => q.where(...).find(...))`.
   * The builder tracks bindings; `find` is the typed terminal.
   */
  q<A, E = IoError>(
    build: (
      q: QueryBuilder<C, {}>,
    ) => Effect.Effect<A, E, RuntimeContext>,
  ): Effect.Effect<A, E, RuntimeContext>;
  /** Untyped escape hatch — today's object / string query. */
  q<T = unknown>(
    query: string | object,
    inputs?: unknown[],
    options?: QueryOptions,
  ): Effect.Effect<T, IoError, RuntimeContext>;

  query<T = unknown>(
    query: string | object,
    inputs?: unknown[],
    options?: QueryOptions,
  ): Effect.Effect<QueryResponse<T>, IoError, RuntimeContext>;

  info(): Effect.Effect<Record<string, unknown>, IoError, RuntimeContext>;
  health(): Effect.Effect<DatabaseHealth, IoError, RuntimeContext>;

  asOf(t: number): TypedReadDatabaseClient<C>;
  history(): TypedReadDatabaseClient<C>;
}

/** Write half. */
export interface TypedWriteDatabaseClient<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly name: string;

  /**
   * Catalog-typed transaction. Generator is the happy path; an
   * Effect-returning callback stays for composition.
   */
  transact<Eff extends Effect.Effect<any, any, any>, A = unknown>(
    build: (tx: TxBuilder<C>) => Generator<Eff, A, never>,
  ): Effect.Effect<
    TxAck,
    DatabaseError | YieldError<Eff> | MissingPeer,
    RuntimeContext | YieldContext<Eff>
  >;
  transact<E = never, R = never>(
    build: (tx: TxBuilder<C>) => Effect.Effect<unknown, E, R>,
  ): Effect.Effect<TxAck, DatabaseError | E | MissingPeer, RuntimeContext | R>;

  /** Keyword-soup maps (`{ ":user/name": "Ada" }`), still catalog-checked. */
  transactWire(
    tx: WireTx<C>,
  ): Effect.Effect<TxAck, DatabaseError | MissingPeer, RuntimeContext>;

  /** Today's untyped escape hatch. */
  transactUntyped(
    tx: TxData,
  ): Effect.Effect<TxAck, DatabaseError | MissingPeer, RuntimeContext>;
}

export interface TypedReadWriteDatabaseClient<C extends AnyCatalog = AnyCatalog>
  extends TypedReadDatabaseClient<C>,
    TypedWriteDatabaseClient<C> {}

export interface TypedReadSystemClient {
  /**
   * Open a typed read client. Name validation is `BadRequest`.
   * Does **not** ensure the catalog — a read client cannot transact.
   * Schema must already be present (or be ensured by a write client).
   */
  create<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedReadDatabaseClient<C>, BadRequest, RuntimeContext>;
  connect<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedReadDatabaseClient<C>, BadRequest, RuntimeContext>;
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

export interface TypedWriteSystemClient {
  create<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedWriteDatabaseClient<C>, OpenError, RuntimeContext>;
  connect<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedWriteDatabaseClient<C>, OpenError, RuntimeContext>;
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

export interface TypedReadWriteSystemClient {
  create<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedReadWriteDatabaseClient<C>, OpenError, RuntimeContext>;
  connect<C extends AnyCatalog>(
    name: string,
    catalog: C,
  ): Effect.Effect<TypedReadWriteDatabaseClient<C>, OpenError, RuntimeContext>;
  health(): Effect.Effect<DatabaseHealth, DatabaseError, RuntimeContext>;
}

const isGenerator = (
  value: unknown,
): value is Generator<Effect.Effect<any, any, any>, unknown, never> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Iterator<unknown>).next === "function" &&
  typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";

const runGenerator = (
  gen: Generator<Effect.Effect<any, any, any>, unknown, unknown>,
): Effect.Effect<unknown, any, any> =>
  Effect.gen(function* () {
    let step = gen.next();
    while (!step.done) {
      const value = yield* step.value;
      step = gen.next(value);
    }
    return step.value;
  });

const runTxBody = <C extends AnyCatalog>(
  catalog: C,
  build: (tx: TxBuilder<C>) => unknown,
): Effect.Effect<TxData, any, any> => {
  const tx = txBuilder(catalog);
  const out = build(tx);
  const ops = (): Effect.Effect<TxData> => Effect.succeed(tx.spec.ops as TxData);
  const body = isGenerator(out)
    ? runGenerator(out)
    : (out as Effect.Effect<unknown, any, any>);
  return body.pipe(Effect.andThen(ops));
};

const wrapRows = <C extends AnyCatalog>(
  catalog: C,
  vars: readonly string[],
  eidVars: readonly string[] | undefined,
  result: unknown,
  pullFn: EidPull | undefined,
): unknown => {
  if (!Array.isArray(result)) return result;
  const eids = new Set(eidVars ?? []);
  return result.map((row) => {
    if (!Array.isArray(row)) return row;
    return vars.map((v, i) => {
      const cell = row[i];
      if (eids.has(v) && typeof cell === "number") {
        return makeEid(catalog, cell, pullFn);
      }
      return cell;
    });
  });
};

const queryIo = <C extends AnyCatalog>(
  catalog: C,
  raw: ReadDatabaseClient,
  pullFn: EidPull,
): QueryIo => ({
  find: (spec: QuerySpec, vars: readonly QueryVar[]) =>
    raw
      .q(toQueryObject(spec, vars), [], spec.options)
      .pipe(
        Effect.map((rows) =>
          wrapRows(catalog, vars, spec.eidVars, rows, pullFn),
        ),
      ),
  query: (spec: QuerySpec, vars: readonly QueryVar[]) =>
    raw
      .query(toQueryObject(spec, vars), [], spec.options)
      .pipe(
        Effect.map((res) => ({
          ...res,
          result: wrapRows(catalog, vars, spec.eidVars, res.result, pullFn),
        })),
      ),
});

const makeRead = <C extends AnyCatalog>(
  catalog: C,
  name: string,
  raw?: ReadDatabaseClient,
): TypedReadDatabaseClient<C> => {
  const io = raw
    ? queryIo(catalog, raw, (id, pattern, options) =>
        raw.pull(id, pattern, options),
      )
    : undefined;
  return {
    catalog,
    name,
    q: ((
      queryOrBuild?:
        | string
        | object
        | ((
            q: QueryBuilder<C, {}>,
          ) => Effect.Effect<unknown, DatabaseError, RuntimeContext>),
      inputs?: unknown[],
      options?: QueryOptions,
    ) => {
      if (queryOrBuild === undefined) return queryBuilder(catalog, io);
      if (typeof queryOrBuild === "function") {
        return queryOrBuild(queryBuilder(catalog, io));
      }
      return raw ? raw.q(queryOrBuild, inputs, options) : noPeer("q");
    }) as TypedReadDatabaseClient<C>["q"],
    query: (query, inputs, options) =>
      raw ? raw.query(query, inputs, options) : noPeer("query"),
    info: () => (raw ? raw.info() : noPeer("info")),
    health: () => (raw ? raw.health() : noPeer("health")),
    asOf: (t) => makeRead(catalog, name, raw?.asOf(t)),
    history: () => makeRead(catalog, name, raw?.history()),
  };
};

const makeWrite = <C extends AnyCatalog>(
  catalog: C,
  name: string,
  raw?: WriteDatabaseClient,
): TypedWriteDatabaseClient<C> => ({
  catalog,
  name,
  transact: ((build: (tx: TxBuilder<C>) => unknown) => {
    if (!raw) return noPeer("transact");
    return runTxBody(catalog, build).pipe(
      Effect.flatMap((ops) => raw.transact(ops)),
    );
  }) as unknown as TypedWriteDatabaseClient<C>["transact"],
  transactWire: (tx) => {
    if (!raw) return noPeer("transactWire");
    return lowerWireTx(catalog, tx).pipe(
      Effect.flatMap((ops) => raw.transact(ops)),
    );
  },
  transactUntyped: (tx) => (raw ? raw.transact(tx) : noPeer("transactUntyped")),
});

const makeReadWrite = <C extends AnyCatalog>(
  catalog: C,
  name: string,
  raw?: ReadWriteDatabaseClient,
): TypedReadWriteDatabaseClient<C> => ({
  ...makeRead(catalog, name, raw),
  ...makeWrite(catalog, name, raw),
});

const ensureSchema = (
  raw: WriteDatabaseClient,
  catalog: AnyCatalog,
): Effect.Effect<void, SchemaEnsureError, RuntimeContext> =>
  raw.transact([...schemaTx(catalog)]).pipe(
    Effect.map(() => undefined),
    Effect.mapError(
      (e) =>
        new SchemaEnsureError({
          message: e.message,
          cause: e,
        }),
    ),
  );

/** Name check, open the raw client, optionally ensure the catalog, wrap. */
const open = <Raw, Client, E = never>(
  createRaw: (name: string) => Effect.Effect<Raw, BadRequest>,
  name: string,
  wrap: (raw: Raw) => Client,
  ensure?: (raw: Raw) => Effect.Effect<void, E, RuntimeContext>,
): Effect.Effect<Client, BadRequest | E, RuntimeContext> => {
  if (!DATABASE_NAME_RE.test(name)) {
    return Effect.fail(invalidDatabaseName(name));
  }
  return Effect.gen(function* () {
    const raw = yield* createRaw(name);
    if (ensure) yield* ensure(raw);
    return wrap(raw);
  });
};

/**
 * Wrap an untyped read system (`Ripple.ReadSystem(Sys)`) so `create` /
 * `connect` take a catalog. Skips ensure — a read client cannot transact.
 */
export const fromRead = (untyped: ReadSystemClient): TypedReadSystemClient => {
  const create = <C extends AnyCatalog>(name: string, catalog: C) =>
    open((n) => untyped.create(n), name, (raw) => makeRead(catalog, name, raw));
  return { create, connect: create, health: () => untyped.health() };
};

/**
 * Wrap an untyped write system (`Ripple.WriteSystem(Sys)`) so `create` /
 * `connect` take a catalog and ensure it.
 */
export const fromWrite = (untyped: WriteSystemClient): TypedWriteSystemClient => {
  const create = <C extends AnyCatalog>(name: string, catalog: C) =>
    open(
      (n) => untyped.create(n),
      name,
      (raw) => makeWrite(catalog, name, raw),
      (raw) => ensureSchema(raw, catalog),
    );
  return { create, connect: create, health: () => untyped.health() };
};

/**
 * Wrap an untyped read-write system (`Ripple.ReadWriteSystem(Sys)`) so
 * `create` / `connect` take a catalog and ensure it.
 */
export const fromReadWrite = (
  untyped: ReadWriteSystemClient,
): TypedReadWriteSystemClient => {
  const create = <C extends AnyCatalog>(name: string, catalog: C) =>
    open(
      (n) => untyped.create(n),
      name,
      (raw) => makeReadWrite(catalog, name, raw),
      (raw) => ensureSchema(raw, catalog),
    );
  return { create, connect: create, health: () => untyped.health() };
};

/** Build the read half of the typed system client. */
export const makeReadSystemClient = (
  source: SystemSource,
): TypedReadSystemClient => fromRead(makeUntypedReadSystemClient(source));

/** Build the write half of the typed system client. */
export const makeWriteSystemClient = (
  source: SystemSource,
): TypedWriteSystemClient => fromWrite(makeUntypedWriteSystemClient(source));

/** Build the read-write typed system client. */
export const makeReadWriteSystemClient = (
  source: SystemSource,
): TypedReadWriteSystemClient =>
  fromReadWrite(makeUntypedReadWriteSystemClient(source));

/**
 * A typed system client over concrete values (no Alchemy Outputs).
 * Same idea as `Client.makeSystem`.
 */
export const makeSystem = (
  options: SystemClientOptions,
): TypedReadWriteSystemClient =>
  makeReadWriteSystemClient(systemSource(options));

/** @internal used by type fixtures that need a client without opening one. */
export const unsafeDatabase = <C extends AnyCatalog>(
  catalog: C,
  name = "db",
  raw?: ReadWriteDatabaseClient,
): TypedReadWriteDatabaseClient<C> => makeReadWrite(catalog, name, raw);

export const unsafeReadDatabase = <C extends AnyCatalog>(
  catalog: C,
  name = "db",
  raw?: ReadDatabaseClient,
): TypedReadDatabaseClient<C> => makeRead(catalog, name, raw);

export const unsafeWriteDatabase = <C extends AnyCatalog>(
  catalog: C,
  name = "db",
  raw?: WriteDatabaseClient,
): TypedWriteDatabaseClient<C> => makeWrite(catalog, name, raw);
