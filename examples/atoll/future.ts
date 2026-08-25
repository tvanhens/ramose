/**
 * `ramose@future` — the API proposed by #312 (the graph of graphs) and #313
 * (traits), written down as **design fiction**. Nothing in this file runs: the
 * schema constructors build inert values so the example files typecheck and
 * autocomplete, and everything that would touch a network or a database throws.
 *
 * The point is the ergonomics loop:
 *
 *   1. Change a spelling here (or in workspace.ts / org.ts / app.tsx).
 *   2. `bun run typecheck`.
 *   3. Read the app files again and ask whether they got better or worse.
 *
 * Types are pragmatic, not production-grade: good enough that `Issue.tags`
 * autocompletes through a composed trait and a wrong operation payload is a
 * red squiggle, loose where full inference would be its own project (query
 * `where`, policy fragments, lookup refs). Places where the *typing itself*
 * is the open question are marked `ergonomics:` — grep for that.
 */

import type * as ES from "effect/Schema";

const notYet = (): Error =>
  new Error("atoll is design fiction — this API does not run yet");

// ── values ───────────────────────────────────────────────────────────────────

/** Entity id. The real API brands this per-schema (`Eid<typeof S>`). */
export type Eid = number;

/** The row variable an auth rule's inner lambda binds. Opaque. */
export interface RowVar {
  readonly _row: "row";
}

/**
 * A query fragment. Callable so the #312 spelling `Q.some(...)(ws)` — apply a
 * fragment to an explicit row variable — typechecks alongside the implicit-row
 * spelling `Q.is(Issue.creator, me)` that today's `rule:` arms use.
 *
 * ergonomics: two spellings for "a predicate on a row" is itself the finding —
 * see README §rules.
 */
export interface Fragment {
  (row: RowVar | Eid): Fragment;
  readonly _tag: "fragment";
}

const fragment = (): Fragment => {
  const apply = (() => fragment()) as { (row: RowVar | Eid): Fragment } & {
    _tag?: "fragment";
  };
  apply._tag = "fragment";
  return apply as Fragment;
};

export interface ReverseRef {
  readonly _reverse: string;
}

/** Query combinators, loosely typed — predicates are not the experiment here. */
export const Q = {
  eq: (_a: unknown, _b: unknown): Fragment => fragment(),
  is: (_field: AnyField, _value: unknown): Fragment => fragment(),
  some: (_reverse: ReverseRef, _cond: Fragment): Fragment => fragment(),
  and: (..._conds: readonly Fragment[]): Fragment => fragment(),
  or: (..._conds: readonly Fragment[]): Fragment => fragment(),
  not: (_cond: Fragment): Fragment => fragment(),
  fact: (_row: unknown, _attr: unknown, _value: unknown): Fragment => fragment(),
};

// ── fields ───────────────────────────────────────────────────────────────────

/**
 * What a field default may read (#313 rule 8). Defaults return **values**;
 * policy rules return **queries**; the shapes never mix.
 *
 * ergonomics: what belongs in here? `now` and `me` cover every example both
 * issues give. Anything more (txn id? parent-graph facts?) starts to look like
 * an operation body, which already exists.
 */
export interface DefaultCtx {
  readonly now: Date;
  readonly me: Eid;
}

export interface FieldOpts<T> {
  readonly optional?: boolean;
  readonly doc?: string;
  /**
   * ergonomics: option-bag `unique: "upsert"` replaces today's wrapper
   * `Field.unique(Ramose.string(), "upsert")` — one less nesting level.
   */
  readonly unique?: "upsert" | "reject";
  readonly default?: (ctx: DefaultCtx) => T;
}

export interface FieldDef<T> {
  readonly field: true;
  readonly kind: string;
  /** Stamped by `Entity()` / `Trait()` — `:namespace/key`. */
  readonly ident: string;
  readonly opts: FieldOpts<T> | undefined;
  /**
   * ergonomics: chained `.many()` (#313's `Ramose.string().many()`) replaces
   * today's wrapper `Field.many(Ramose.Ref(Label))`.
   */
  many(): FieldDef<readonly T[]>;
  readonly reverse: ReverseRef;
  /** `Taggable.tags.is("urgent")` — element-typed on many-fields. */
  is(value: (T extends readonly (infer U)[] ? U : T) | RowVar | Eid): Fragment;
}

export type AnyField = FieldDef<any>;

/** `[User.sub, "some-sub"]` — address a row by a unique attribute. */
export type LookupRef = readonly [AnyField, unknown];

const fieldDef = <T>(kind: string, opts?: FieldOpts<T>): FieldDef<T> => ({
  field: true,
  kind,
  ident: ":unstamped/unstamped",
  opts,
  many: () => fieldDef<readonly T[]>(`${kind}[]`),
  reverse: { _reverse: kind },
  is: () => fragment(),
});

export const string = (opts?: FieldOpts<string>): FieldDef<string> =>
  fieldDef("string", opts);
export const boolean = (opts?: FieldOpts<boolean>): FieldDef<boolean> =>
  fieldDef("boolean", opts);
export const float = (opts?: FieldOpts<number>): FieldDef<number> =>
  fieldDef("float", opts);
export const timestamp = (opts?: FieldOpts<Date>): FieldDef<Date> =>
  fieldDef("timestamp", opts);
export const Enum = <const V extends readonly [string, ...string[]]>(
  _values: V,
  opts?: FieldOpts<V[number]>,
): FieldDef<V[number]> => fieldDef("enum", opts);
/**
 * A ref may target an entity or a trait (#313 rule 5). The thunk form exists
 * for definition-order cycles (self-referential schemas) — same reason
 * `Graph()` accepts one.
 */
export const Ref = <T extends RefTarget>(
  _target: T | (() => T),
  opts?: FieldOpts<Eid>,
): FieldDef<Eid> => fieldDef("ref", opts);

// ── traits and entities (#313) ───────────────────────────────────────────────

export type FieldMap = Record<string, AnyField>;

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never;

/** Field accessors plus the implicit `id`. */
export type Accessors<F> = { readonly [K in keyof F]: F[K] } & {
  readonly id: FieldDef<Eid>;
};

export type TraitDef<N extends string, F extends FieldMap> = {
  readonly trait: N;
  readonly fields: F;
} & Accessors<F>;

export type AnyTrait = TraitDef<string, any>;

const stampFields = <F extends FieldMap>(ns: string, fields: F): F => {
  const out: Record<string, AnyField> = {};
  for (const [key, def] of Object.entries(fields)) {
    out[key] = { ...def, ident: `:${ns}/${key}` };
  }
  return out as F;
};

export const Trait = <N extends string, F extends FieldMap>(
  name: N,
  fields: F,
): TraitDef<N, F> => {
  const stamped = stampFields(name, fields);
  return {
    trait: name,
    fields: stamped,
    ...stamped,
    id: fieldDef<Eid>("id"),
  } as TraitDef<N, F>;
};

type FieldsOf<T> = T extends TraitDef<any, infer F> ? F : never;
type ComposedFields<W extends readonly AnyTrait[]> = [W[number]] extends [never]
  ? unknown
  : UnionToIntersection<FieldsOf<W[number]>>;

/**
 * TypeScript-side, composition is intersection (#313): `Issue.tags` is
 * `:taggable/tags`, the same attribute on every composer.
 */
export type EntityDef<
  N extends string,
  F extends FieldMap,
  W extends readonly AnyTrait[],
> = {
  readonly entity: N;
  readonly fields: F & ComposedFields<W>;
  readonly composes: W;
} & Accessors<F & ComposedFields<W>>;

export type AnyEntity = EntityDef<string, any, any>;
export type RefTarget = AnyEntity | AnyTrait;

export const Entity = <
  N extends string,
  F extends FieldMap,
  const W extends readonly AnyTrait[] = [],
>(
  name: N,
  fields: F,
  opts?: { readonly with: W },
): EntityDef<N, F, W> => {
  // ergonomics: name collisions between a trait's field keys and the entity's
  // own (or two traits') must be an install()-time AND type-level error —
  // never last-wins (#313 rule 3). The intersection type silently allows the
  // clash today; the real implementation needs a mapped-type guard here.
  const own = stampFields(name, fields);
  const merged: Record<string, AnyField> = {};
  for (const trait of opts?.with ?? []) Object.assign(merged, trait.fields);
  Object.assign(merged, own);
  return {
    entity: name,
    fields: merged,
    composes: opts?.with ?? [],
    ...merged,
    id: fieldDef<Eid>("id"),
  } as unknown as EntityDef<N, F, W>;
};

// ── schema and catalog ───────────────────────────────────────────────────────

export interface SchemaDef<E extends Record<string, AnyEntity>> {
  readonly entities: E;
}
export type AnySchema = SchemaDef<Record<string, AnyEntity>>;

export const Schema = <E extends Record<string, AnyEntity>>(
  entities: E,
): SchemaDef<E> => ({ entities });

/**
 * A catalog is a named value: schema + policy under a permanent key (#312).
 * The key is a storage-coupled name — treat it like an ident, rename never.
 */
export interface CatalogDef<K extends string, S extends AnySchema> {
  readonly key: K;
  readonly schema: S;
  readonly policy: PolicyDef;
}
export type AnyCatalog = CatalogDef<string, any>;

export const Catalog = <K extends string, S extends AnySchema>(
  key: K,
  cfg: { readonly schema: S; readonly policy: PolicyDef },
): CatalogDef<K, S> => ({ key, schema: cfg.schema, policy: cfg.policy });

// ── the system traits (#312) ─────────────────────────────────────────────────

type GraphFieldMap = {
  readonly name: FieldDef<string>;
  readonly doc: FieldDef<string>;
  readonly catalog: FieldDef<string>;
};

export type GraphComposition<C extends AnyCatalog> = TraitDef<
  "graph",
  GraphFieldMap
> & {
  /** The closed-over catalog — composition metadata, not trait identity. */
  readonly childCatalog: () => C;
};

const graphTrait = Trait("graph", {
  name: string({ doc: "path segment; unique in the parent, across kinds" }),
  doc: string({ optional: true, doc: "description for discovery" }),
  catalog: string({ doc: "registry key of the catalog this graph runs" }),
});

const graphFn = <C extends AnyCatalog>(
  catalog: C | (() => C),
): GraphComposition<C> =>
  ({
    ...graphTrait,
    childCatalog: () =>
      typeof catalog === "function" ? (catalog as () => C)() : catalog,
  }) as GraphComposition<C>;

// `Object.assign` cannot overwrite a function's built-in readonly `name`, so
// the trait's field accessors are attached with defineProperty. The type-level
// intersection is what the app files see: `Ramose.Graph` is both callable
// (compose it, closing over a catalog) and a trait (query root, ref target).
for (const [key, value] of Object.entries(graphTrait)) {
  Object.defineProperty(graphFn, key, {
    value,
    writable: true,
    configurable: true,
  });
}

/**
 * The one `graph` trait (#312): every call returns the same trait identity,
 * closing over the catalog its composer's rows will run. `Server` harvests the
 * closures by reachability at boot. The thunk form is for self-nesting —
 * `Graph(() => folderCatalog)` inside `folderCatalog`'s own schema.
 */
export const Graph = graphFn as typeof graphFn &
  TraitDef<"graph", GraphFieldMap>;

/**
 * API keys as rows (#312 §Agents): compose this on an entity, and its rows are
 * revocable credentials. The engine resolves bearer `rk_` keys through the
 * shared `:api-key/hash` ident; retract the row to revoke.
 */
export const ApiKey = Trait("api-key", {
  hash: string({ doc: "hash of the secret; the secret itself is never stored" }),
  sub: string({ doc: "the principal name this key authenticates" }),
});

// ── policy (#312's one function shape) ───────────────────────────────────────

export interface Claims {
  readonly sub: string;
  readonly [claim: string]: unknown;
}

export interface Auth {
  readonly claim: Claims;
  /** The caller's principal row — absent before provisioning (creates, entry). */
  readonly me?: Eid;
}

/**
 * Every auth decision point: `true`, or a function of the caller returning a
 * fragment — either directly (implicit row, today's `rule:` style) or as
 * `(row) => Fragment` (#312's explicit-row style). Absence means deny.
 *
 * ergonomics: this union is the load-bearing question of the whole example —
 * see README §rules for the tally of which arms use which shape.
 */
export type Rule =
  | true
  | ((auth: Auth) => Fragment | ((row: RowVar) => Fragment));

export interface EntityArms {
  readonly read?: Rule | readonly Rule[];
  /**
   * THE entry decision for graph rows (#312 model statement 3).
   * ergonomics: should be a type error on a kind that does not compose
   * `Graph`; that needs arms typed per-entity against its compositions.
   */
  readonly enter?: Rule;
  readonly fields?: Record<string, Rule>;
}

export interface PolicyDef {
  readonly _tag: "policy";
}

export const policy = <S extends AnySchema>(
  _config: {
    readonly schema: S;
    readonly principal: FieldDef<string>;
    readonly operations: OperationsDef;
    readonly claims?: ES.Top;
  },
  _arms: { readonly [K in keyof S["entities"]]?: EntityArms } & {
    readonly operations?: Record<string, Rule>;
  },
): PolicyDef => ({ _tag: "policy" });

// ── operations ───────────────────────────────────────────────────────────────

export type RowInput<E extends RefTarget> = {
  readonly [K in keyof E["fields"]]?: E["fields"][K] extends FieldDef<infer T>
    ? (T extends Eid ? Eid | LookupRef : T) | undefined
    : never;
};

export interface OpCtx {
  /** The caller's principal row in this graph. */
  readonly principal: Eid;
  /** The operation's resolved target — bound when the op declares `on`. */
  readonly self: { readonly eid: Eid };
  put<E extends AnyEntity>(entity: E, row: RowInput<E>): Eid;
  update<E extends AnyEntity>(
    entity: E,
    target: Eid | { readonly eid: Eid },
    patch: RowInput<E>,
  ): void;
  set(target: Eid | { readonly eid: Eid }, field: AnyField, value: unknown): void;
  remove(
    target: Eid | { readonly eid: Eid },
    field: AnyField,
    value?: unknown,
  ): void;
  delete(target: Eid | { readonly eid: Eid }): void;
  query<R>(q: QueryDef<any, R>): Promise<readonly R[]>;
  /**
   * ergonomics: operation bodies replay (optimistic prefix), so they cannot
   * generate randomness. Secret material must come from an engine-side, run-
   * once context — same problem `new Date()` has today. Is a namespaced ctx
   * helper the right door, or should ApiKey ship its own system operation?
   */
  readonly apiKeys: {
    mint(): { readonly secret: string; readonly hash: string };
  };
}

export interface OperationDef<I, O, On extends RefTarget | undefined> {
  readonly opName: string;
  readonly on: On;
  /** Phantom — keeps I/O/On inference honest. */
  readonly _types?: { readonly i: I; readonly o: O; readonly on: On };
}

type OutputOf<O> = O extends ES.Top ? ES.Schema.Type<O> : void;

const operationImpl = <
  Input extends ES.Top,
  const On extends RefTarget | undefined = undefined,
  Output extends ES.Top | undefined = undefined,
>(
  name: string,
  config: {
    readonly on?: On;
    readonly input: Input;
    readonly output?: Output;
    readonly doc?: string;
  },
  _handler: (
    op: OpCtx,
    input: ES.Schema.Type<Input>,
  ) => OutputOf<Output> | Promise<OutputOf<Output>>,
): OperationDef<ES.Schema.Type<Input>, OutputOf<Output>, On> => ({
  opName: name,
  on: config.on as On,
});

export const Operation = Object.assign(operationImpl, {
  /** Set the named fields on the target — today's `Op.patch`, unchanged. */
  patch: <
    E extends AnyEntity,
    const K extends readonly (keyof E["fields"] & string)[],
  >(
    name: string,
    entity: E,
    _keys: K,
    _opts?: { readonly doc?: string },
  ): OperationDef<Pick<RowInput<E>, K[number]>, void, E> => ({
    opName: name,
    on: entity,
  }),
});

export interface OperationsDef {
  readonly _tag: "operations";
  readonly names: readonly string[];
}

export const defineOperations = (
  _schema: AnySchema,
  ops: Record<string, OperationDef<any, any, any>>,
): OperationsDef => ({ _tag: "operations", names: Object.keys(ops) });

// ── queries ──────────────────────────────────────────────────────────────────

export type SelectShape = Record<string, AnyField>;
type RowOfShape<S extends SelectShape> = {
  readonly [K in keyof S]: S[K] extends FieldDef<infer T> ? T : never;
};

export interface QueryDef<Root, R> {
  readonly _root?: Root;
  readonly _row?: R;
  where(
    ...conds: readonly (Fragment | Record<string, unknown>)[]
  ): QueryDef<Root, R>;
  select<S extends SelectShape>(shape: S): QueryDef<Root, RowOfShape<S>>;
  orderBy(field: AnyField, dir?: "asc" | "desc"): QueryDef<Root, R>;
}

const queryDef = <Root, R>(): QueryDef<Root, R> => ({
  where: () => queryDef(),
  select: () => queryDef(),
  orderBy: () => queryDef(),
});

export const Query = {
  /** A trait is a valid query root (#313 rule 6) — `Query.from(Ramose.Graph)`. */
  from: <Root extends RefTarget>(_root: Root): QueryDef<Root, never> =>
    queryDef(),
  is: (field: AnyField, value: unknown): Fragment => Q.is(field, value),
};

export type Row<Qy> = Qy extends QueryDef<any, infer R> ? R : never;

// ── server ───────────────────────────────────────────────────────────────────

/**
 * The whole engine configuration (#312 §The root). The catalog registry is
 * harvested from `root` by reachability: entities → composed traits →
 * closed-over catalogs, recursing, visited set stopping cycles.
 */
export const Server = (
  _name: string,
  _config: {
    /** The root graph's catalog. The root is its own parent; config, not a row. */
    readonly root: AnyCatalog;
    /** The one bypass: operator subs. Recovery and bootstrap, nothing else. */
    readonly admins: readonly string[];
    readonly auth: {
      readonly issuer: string;
      readonly audience: string;
      readonly jwks: string;
    };
  },
): { fetch(request: Request): Promise<Response> } => ({
  fetch: () => Promise.reject(notYet()),
});

// ── client ───────────────────────────────────────────────────────────────────

export interface TokenSource {
  readonly _tag: "token";
}
export const token = {
  jwt: (_mint: () => Promise<string>): TokenSource => ({ _tag: "token" }),
};

export interface GraphHandle<C extends AnyCatalog> {
  readonly path: string;
  readonly catalog: C;
  run<I, O>(op: OperationDef<I, O, undefined>, input: I): Promise<O>;
  run<I, O>(op: OperationDef<I, O, RefTarget>, target: Eid, input: I): Promise<O>;
  query<R>(q: QueryDef<any, R>): Promise<readonly R[]>;
}

export interface Client {
  /**
   * Open a graph by path, asserting its catalog. Entry runs the graph's
   * `enter` function in its parent; deny → 401, indistinguishable from
   * never-existed.
   *
   * ergonomics: the caller names the catalog the data already stamps — a
   * mismatch is a runtime error. See README §client for the typed-handle
   * alternative.
   */
  open<C extends AnyCatalog>(path: string, catalog: C): GraphHandle<C>;
  close(): Promise<void>;
}

export const connect = (_opts: {
  readonly url: string;
  readonly token: TokenSource;
}): Client => ({
  open: <C extends AnyCatalog>(path: string, catalog: C): GraphHandle<C> => ({
    path,
    catalog,
    run: () => Promise.reject(notYet()),
    query: () => Promise.reject(notYet()),
  }),
  close: () => Promise.resolve(),
});

// ── react (would live in ramose/react) ───────────────────────────────────────

export const useLiveQuery = <R,>(
  _db: GraphHandle<AnyCatalog>,
  _query: QueryDef<any, R>,
): { readonly data: readonly R[] | undefined } => ({ data: undefined });

export function useOperation<I, O>(
  db: GraphHandle<AnyCatalog>,
  op: OperationDef<I, O, undefined>,
): { readonly run: (input: I) => Promise<O> };
export function useOperation<I, O>(
  db: GraphHandle<AnyCatalog>,
  op: OperationDef<I, O, RefTarget>,
): { readonly run: (target: Eid, input: I) => Promise<O> };
export function useOperation(
  _db: GraphHandle<AnyCatalog>,
  _op: OperationDef<unknown, unknown, RefTarget | undefined>,
): { readonly run: (...args: readonly unknown[]) => Promise<unknown> } {
  return { run: () => Promise.reject(notYet()) };
}
