/** Catalog-generic transaction builder. `transact(function* (tx) { … })` is the happy path. */

import * as Effect from "effect/Effect";
import { isAttrRef, lowerAttr } from "./attrRef.ts";
import type { AnyCatalog } from "./Catalog.ts";
import type {
  CatalogIdent,
  EntityRef,
  ValueAtIdent,
  WriteAtIdent,
} from "./idents.ts";

// ── attr / value correlation ───────────────────────────────────────────────

/**
 * Attribute slot on the builder. An attr ref (`User.name`) or a catalog
 * ident (`":user/name"`). Unknown idents are not in the union.
 */
export type TxAttr<C extends AnyCatalog> =
  | { readonly ident: CatalogIdent<C> }
  | CatalogIdent<C>;

type IdentOfTxAttr<C extends AnyCatalog, A> = A extends {
  readonly ident: infer I extends string;
}
  ? I
  : A extends CatalogIdent<C>
    ? A
    : never;

/** Value type correlated to a {@link TxAttr}. `never` when the attr is unknown. */
export type TxValue<C extends AnyCatalog, A> =
  IdentOfTxAttr<C, A> extends infer I
    ? [I] extends [never]
      ? never
      : I extends string
        ? ValueAtIdent<C, I>
        : never
    : never;

/** Lookup ref written with an attr ref: `[User.name, "Ada"]`. */
export type AttrRefLookup<C extends AnyCatalog> = {
  [I in CatalogIdent<C>]: readonly [
    { readonly ident: I },
    ValueAtIdent<C, I>,
  ];
}[CatalogIdent<C>];

export type TxEntity<C extends AnyCatalog> =
  | EntityRef<C>
  | Entity<C>
  | AttrRefLookup<C>;

// ── collected ops (what a future impl would send) ──────────────────────────

export type TxOp =
  | readonly [":db/add", unknown, string, unknown]
  | readonly [":db/retract", unknown, string]
  | readonly [":db/retract", unknown, string, unknown]
  | readonly [":db/retractEntity", unknown];

export interface TxSpec {
  readonly ops: readonly TxOp[];
}

// ── entity handle (a bag) ──────────────────────────────────────────────────

/**
 * A tempid / eid / lookup handle. `add` / `retract` take an attr from
 * *any* catalog namespace — that is the bag.
 */
export interface Entity<C extends AnyCatalog = AnyCatalog> {
  readonly _tag: "Entity";
  /** What this handle names: a fresh tempid, an eid, or a lookup ref. */
  readonly eid: EntityRef<C>;

  add<const A extends TxAttr<C>>(
    attr: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  retract<const A extends TxAttr<C>>(
    attr: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  retractEntity(): Effect.Effect<void>;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * Catalog-generic transaction builder. Methods are Effects so the body
 * is a generator (or an Effect.gen callback). `db.transact` is the
 * terminal that would submit.
 */
export interface Tx<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly spec: TxSpec;

  /**
   * Allocate a tempid, or wrap an existing eid / tempid / lookup ref.
   * `tx.entity()` → new handle; `tx.entity(1001)`; `tx.entity("ada")`;
   * `tx.entity([User.name, "Ada"])`.
   */
  entity(): Effect.Effect<Entity<C>>;
  entity(id: TxEntity<C>): Effect.Effect<Entity<C>>;

  /** Assert one datom. Cardinality-many is one call per value. */
  add<const A extends TxAttr<C>>(
    e: TxEntity<C>,
    attr: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  retract<const A extends TxAttr<C>>(
    e: TxEntity<C>,
    attr: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  retractEntity(e: TxEntity<C>): Effect.Effect<void>;
}

/**
 * Error / context extracted from a generator body's yielded Effects.
 * Same inference `Effect.gen` uses.
 */
export type YieldError<Eff> = [Eff] extends [never]
  ? never
  : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>]
    ? E
    : never;

export type YieldContext<Eff> = [Eff] extends [never]
  ? never
  : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>]
    ? R
    : never;

/**
 * Generator body — the happy path:
 * `db.transact(function* (tx) { … })`.
 */
export type TxGenBody<
  C extends AnyCatalog,
  Eff extends Effect.Effect<any, any, any> = Effect.Effect<any, any, any>,
  A = unknown,
> = (tx: Tx<C>) => Generator<Eff, A, never>;

/**
 * Effect-returning callback — kept for composition
 * (`(tx) => Effect.gen(...)` / `Effect.fn`). Not the default.
 */
export type TxEffectBody<
  C extends AnyCatalog,
  E = never,
  R = never,
> = (tx: Tx<C>) => Effect.Effect<unknown, E, R>;

/** @internal An entity handle, as opposed to a raw eid / tempid / lookup. */
export const isEntity = (e: unknown): e is Entity =>
  typeof e === "object" &&
  e !== null &&
  (e as { _tag?: unknown })._tag === "Entity";

const isHandle = isEntity;

const resolveEntity = (e: unknown): unknown => {
  if (isHandle(e)) return e.eid;
  if (Array.isArray(e) && e.length === 2 && isAttrRef(e[0])) {
    return [e[0].ident, e[1]];
  }
  return e;
};

const makeHandle = <C extends AnyCatalog>(
  eid: EntityRef<C>,
  ops: TxOp[],
): Entity<C> => ({
  _tag: "Entity",
  eid,
  add: (attr: unknown, value: unknown) =>
    Effect.sync(() => {
      if (value == null) return;
      ops.push([":db/add", eid, lowerAttr(attr), value]);
    }),
  retract: (attr: unknown, value?: unknown) =>
    Effect.sync(() => {
      if (value === undefined) {
        ops.push([":db/retract", eid, lowerAttr(attr)]);
      } else {
        ops.push([":db/retract", eid, lowerAttr(attr), value]);
      }
    }),
  retractEntity: () =>
    Effect.sync(() => {
      ops.push([":db/retractEntity", eid]);
    }),
});

/**
 * Start a catalog-typed transaction builder. Used by
 * `db.transact(function* (tx) { … })` and by compile-time / runtime
 * fixtures.
 */
export const txBuilder = <C extends AnyCatalog>(catalog: C): Tx<C> => {
  const ops: TxOp[] = [];
  let next = 0;
  const builder: Tx<C> = {
    catalog,
    get spec() {
      return { ops: ops.slice() };
    },
    entity: ((id?: TxEntity<C>) =>
      Effect.sync(() => {
        const resolved =
          id === undefined
            ? (`tmp-${++next}` as EntityRef<C>)
            : (resolveEntity(id) as EntityRef<C>);
        return makeHandle(resolved, ops);
      })) as Tx<C>["entity"],
    add: (e: unknown, attr: unknown, value: unknown) =>
      Effect.sync(() => {
        if (value == null) return;
        ops.push([":db/add", resolveEntity(e), lowerAttr(attr), value]);
      }),
    retract: (e: unknown, attr: unknown, value?: unknown) =>
      Effect.sync(() => {
        if (value === undefined) {
          ops.push([":db/retract", resolveEntity(e), lowerAttr(attr)]);
        } else {
          ops.push([":db/retract", resolveEntity(e), lowerAttr(attr), value]);
        }
      }),
    retractEntity: (e: unknown) =>
      Effect.sync(() => {
        ops.push([":db/retractEntity", resolveEntity(e)]);
      }),
  };
  return builder;
};
