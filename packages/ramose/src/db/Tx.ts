/** Schema-generic transaction builder. `transact(function* (tx) { … })` is hatch-only. */

import * as Effect from "effect/Effect";
import { isAttrRef, lowerAttr } from "./attrRef.ts";
import type { AnySchema } from "./Schema.ts";
import type {
  CatalogIdent,
  EntityRef,
  ValueAtIdent,
} from "./idents.ts";

// ── field / value correlation ──────────────────────────────────────────────

/**
 * Field slot on the builder. A field ref (`User.name`) or a schema
 * ident (`":user/name"`). Unknown idents are not in the union.
 */
export type TxField<C extends AnySchema> =
  | { readonly ident: CatalogIdent<C> }
  | CatalogIdent<C>;

type IdentOfTxField<C extends AnySchema, A> = A extends {
  readonly ident: infer I extends string;
}
  ? I
  : A extends CatalogIdent<C>
    ? A
    : never;

/** Value type correlated to a {@link TxField}. `never` when the field is unknown. */
export type TxValue<C extends AnySchema, A> =
  IdentOfTxField<C, A> extends infer I
    ? [I] extends [never]
      ? never
      : I extends string
        ? ValueAtIdent<C, I>
        : never
    : never;

/** Lookup ref written with a field ref: `[User.name, "Ada"]`. */
export type FieldRefLookup<C extends AnySchema> = {
  [I in CatalogIdent<C>]: readonly [
    { readonly ident: I },
    ValueAtIdent<C, I>,
  ];
}[CatalogIdent<C>];

export type TxEntity<C extends AnySchema> =
  | EntityRef<C>
  | TxHandle<C>
  | FieldRefLookup<C>;

// ── collected ops (what a future impl would send) ──────────────────────────

export type TxOp =
  | readonly [":db/add", unknown, string, unknown]
  | readonly [":db/retract", unknown, string]
  | readonly [":db/retract", unknown, string, unknown]
  | readonly [":db/retractEntity", unknown];

export interface TxSpec {
  readonly ops: readonly TxOp[];
}

// ── instance handle (a bag) ────────────────────────────────────────────────

/**
 * A tempid / eid / lookup handle. `set` / `remove` take a field from
 * *any* schema entity — that is the bag.
 *
 * Not the public `Entity` (the record type). This name is hatch-only.
 */
export interface TxHandle<C extends AnySchema = AnySchema> {
  readonly _tag: "TxHandle";
  /** What this handle names: a fresh tempid, an eid, or a lookup ref. */
  readonly eid: EntityRef<C>;

  set<const A extends TxField<C>>(
    field: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  remove<const A extends TxField<C>>(
    field: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  delete(): Effect.Effect<void>;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * Schema-generic transaction builder. Methods are Effects so the body
 * is a generator (or an Effect.gen callback). `db.effect.transact` is the
 * terminal that would submit.
 */
export interface Tx<C extends AnySchema = AnySchema> {
  readonly schema: C;
  readonly spec: TxSpec;

  /**
   * Allocate a tempid, or wrap an existing eid / tempid / lookup ref.
   * `tx.entity()` → new handle; `tx.entity(1001)`; `tx.entity("ada")`;
   * `tx.entity([User.name, "Ada"])`.
   */
  entity(): Effect.Effect<TxHandle<C>>;
  entity(id: TxEntity<C>): Effect.Effect<TxHandle<C>>;

  /** Assert one datom. Cardinality-many is one call per value. */
  set<const A extends TxField<C>>(
    e: TxEntity<C>,
    field: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  remove<const A extends TxField<C>>(
    e: TxEntity<C>,
    field: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  delete(e: TxEntity<C>): Effect.Effect<void>;
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
 * `db.effect.transact(function* (tx) { … })`.
 */
export type TxGenBody<
  C extends AnySchema,
  Eff extends Effect.Effect<any, any, any> = Effect.Effect<any, any, any>,
  A = unknown,
> = (tx: Tx<C>) => Generator<Eff, A, never>;

/**
 * Effect-returning callback — kept for composition
 * (`(tx) => Effect.gen(...)` / `Effect.fn`). Not the default.
 */
export type TxEffectBody<
  C extends AnySchema,
  E = never,
  R = never,
> = (tx: Tx<C>) => Effect.Effect<unknown, E, R>;

/** @internal An instance handle, as opposed to a raw eid / tempid / lookup. */
export const isTxHandle = (e: unknown): e is TxHandle =>
  typeof e === "object" &&
  e !== null &&
  (e as { _tag?: unknown })._tag === "TxHandle";

const resolveEntity = (e: unknown): unknown => {
  if (isTxHandle(e)) return e.eid;
  if (Array.isArray(e) && e.length === 2 && isAttrRef(e[0])) {
    return [e[0].ident, e[1]];
  }
  return e;
};

const makeHandle = <C extends AnySchema>(
  eid: EntityRef<C>,
  ops: TxOp[],
): TxHandle<C> => ({
  _tag: "TxHandle",
  eid,
  set: (field: unknown, value: unknown) =>
    Effect.sync(() => {
      ops.push([":db/add", eid, lowerAttr(field), value]);
    }),
  remove: (field: unknown, value?: unknown) =>
    Effect.sync(() => {
      if (value === undefined) {
        ops.push([":db/retract", eid, lowerAttr(field)]);
      } else {
        ops.push([":db/retract", eid, lowerAttr(field), value]);
      }
    }),
  delete: () =>
    Effect.sync(() => {
      ops.push([":db/retractEntity", eid]);
    }),
});

/**
 * Start a schema-typed transaction builder. Used by
 * `db.effect.transact(function* (tx) { … })` and by compile-time / runtime
 * fixtures.
 */
export const txBuilder = <C extends AnySchema>(schema: C): Tx<C> => {
  const ops: TxOp[] = [];
  let next = 0;
  const builder: Tx<C> = {
    schema,
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
    set: (e: unknown, field: unknown, value: unknown) =>
      Effect.sync(() => {
        ops.push([":db/add", resolveEntity(e), lowerAttr(field), value]);
      }),
    remove: (e: unknown, field: unknown, value?: unknown) =>
      Effect.sync(() => {
        if (value === undefined) {
          ops.push([":db/retract", resolveEntity(e), lowerAttr(field)]);
        } else {
          ops.push([":db/retract", resolveEntity(e), lowerAttr(field), value]);
        }
      }),
    delete: (e: unknown) =>
      Effect.sync(() => {
        ops.push([":db/retractEntity", resolveEntity(e)]);
      }),
  };
  return builder;
};
