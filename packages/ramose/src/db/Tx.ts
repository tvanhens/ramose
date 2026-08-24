/** Schema-generic transaction builder. `transact(function* (tx) { … })` is hatch-only. */

import * as Effect from "effect/Effect";
import { isAttrRef, lowerAttr } from "./attrRef.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnySchema } from "./Schema.ts";
import type {
  CatalogIdent,
  EntityRef,
  LookupRef,
  UpsertField,
  ValueAtIdent,
  WriteAtEntity,
  WriteAtIdent,
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

/**
 * Entity of `C` when the catalog is known; any entity against the open
 * `AnySchema` bound (same `string extends keyof` test as operations).
 */
export type TxKnownEntity<C extends AnySchema> = string extends keyof C["entities"]
  ? AnyEntity
  : C["entities"][keyof C["entities"]];

/** Ref forms `put` accepts in addition to {@link WriteAtIdent}'s decoded type. */
type PutRef<C extends AnySchema, H = TxHandle<C>> = H | string | LookupRef<C>;

type PutScalar<
  C extends AnySchema,
  N extends AnyEntity,
  K extends string,
  H = TxHandle<C>,
> =
  | ValueAtIdent<C, `:${N["ns"]}/${K}`>
  | (N["fields"][K] extends { readonly valueType: "ref" } ? PutRef<C, H> : never);

/**
 * `put` attrs: {@link WriteAtEntity} (array for many, omit `undefined`)
 * plus handle / tempid / lookup on ref fields. `H` is the handle
 * admitted in ref slots — `TxHandle` on the builder, widened to
 * `TxHandle | OpHandle` on the promise `Op`.
 */
export type PutAttrs<C extends AnySchema, N extends AnyEntity, H = TxHandle<C>> = {
  [K in keyof WriteAtEntity<C, N> & string]?:
    | WriteAtEntity<C, N>[K]
    | (N["fields"][K] extends { readonly valueType: "ref"; readonly cardinality: "many" }
        ? ReadonlyArray<PutScalar<C, N, K, H>>
        : N["fields"][K] extends { readonly valueType: "ref" }
          ? PutRef<C, H>
          : never);
};

// ── collected ops (what a future impl would send) ──────────────────────────

/** Map form: `{ ":db/id"?: e, ":user/name": "Ada", ":user/friends": [ref, …] }`. */
export type TxMap = Readonly<Record<string, unknown>>;

export type TxOp =
  | readonly [":db/add", unknown, string, unknown]
  | readonly [":db/retract", unknown, string]
  | readonly [":db/retract", unknown, string, unknown]
  | readonly [":db/retractEntity", unknown]
  | TxMap;

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

  /**
   * Entity-level write. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * tempid (create); a subject updates that entity.
   */
  put<N extends TxKnownEntity<C>>(
    entity: N,
    attrs: PutAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;
  put<N extends TxKnownEntity<C>>(
    entity: N,
    id: TxEntity<C>,
    attrs: PutAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;

  /**
   * Ensure a row exists for a `unique: "upsert"` value. Returns a handle
   * whose tempid unifies with the existing entity when the value is
   * already present. A lookup ref that misses is still a hard rejection —
   * use this instead of `entity([attr, value])` for "get or create".
   */
  upsert<const A extends UpsertField<C>>(
    field: A,
    value: TxValue<C, A>,
  ): Effect.Effect<TxHandle<C>>;
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

const isIdentLookup = (value: unknown): value is readonly [string, unknown] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  value[0][0] === ":";

/** Lower handles and field-ref lookups so map form is engine-ready. */
const lowerWriteValue = (value: unknown): unknown => {
  if (isTxHandle(value)) return resolveEntity(value);
  if (Array.isArray(value) && value.length === 2 && isAttrRef(value[0])) {
    return [value[0].ident, lowerWriteValue(value[1])];
  }
  if (Array.isArray(value) && !isIdentLookup(value)) {
    return value.map(lowerWriteValue);
  }
  return value;
};

const fieldIdent = (entity: unknown, key: string): string => {
  if (typeof entity === "object" && entity !== null && "fields" in entity) {
    const fields = (entity as { fields?: Record<string, { ident?: unknown }> })
      .fields;
    const ident = fields?.[key]?.ident;
    if (typeof ident === "string") return ident;
  }
  const ns =
    typeof entity === "object" &&
    entity !== null &&
    "ns" in entity &&
    typeof (entity as { ns: unknown }).ns === "string"
      ? (entity as { ns: string }).ns
      : "";
  return ns.length > 0 ? `:${ns}/${key}` : key;
};

const lowerPutMap = (
  entity: unknown,
  eid: unknown,
  attrs: Record<string, unknown>,
): TxMap => {
  const map: Record<string, unknown> = { ":db/id": eid };
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    map[fieldIdent(entity, key)] = lowerWriteValue(value);
  }
  return map;
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
    put: ((entity: unknown, a: unknown, b?: unknown) =>
      Effect.sync(() => {
        const attrs = (b !== undefined ? b : a) as Record<string, unknown>;
        const id = b !== undefined ? a : undefined;
        const eid =
          id === undefined
            ? (`tmp-${++next}` as EntityRef<C>)
            : (resolveEntity(id) as EntityRef<C>);
        ops.push(lowerPutMap(entity, eid, attrs ?? {}));
        return makeHandle(eid, ops);
      })) as Tx<C>["put"],
    upsert: ((field: unknown, value: unknown) =>
      Effect.sync(() => {
        const eid = `tmp-${++next}` as EntityRef<C>;
        ops.push({
          ":db/id": eid,
          [lowerAttr(field)]: lowerWriteValue(value),
        });
        return makeHandle(eid, ops);
      })) as Tx<C>["upsert"],
  };
  return builder;
};
