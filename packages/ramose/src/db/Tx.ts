/** Schema-generic transaction builder. `transact(function* (tx) { … })` is hatch-only. */

import * as Effect from "effect/Effect";
import { lowerAttr } from "./attrRef.ts";
import { lowerEntityArg, lowerWriteValue, tempid, type Tempid } from "./entityArg.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnySchema } from "./Schema.ts";
import type {
  AttrAtIdent,
  CatalogIdent,
  EntityRef,
  FieldTargetEntity,
  LookupRef,
  RefWriteValue,
  UnbrandedId,
  ValueAtIdent,
  WriteAtEntity,
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

/**
 * Value type correlated to a {@link TxField}. A ref field takes
 * {@link RefWriteValue} of its declared target — a Label eid is not an
 * `Issue.creator`. `never` when the field is unknown. `H` is the handle
 * admitted in ref slots (`TxHandle` on the builder, widened on `Op`).
 */
export type TxValue<C extends AnySchema, A, H = TxHandle<C>> =
  IdentOfTxField<C, A> extends infer I
    ? [I] extends [never]
      ? never
      : I extends string
        ? AttrAtIdent<C, I>["valueType"] extends "ref"
          ? RefWriteValue<C, I, H>
          : ValueAtIdent<C, I>
        : never
    : never;

/** Lookup ref written with a field ref: `[User.name, "Ada"]`. */
export type FieldRefLookup<C extends AnySchema> = {
  [I in CatalogIdent<C>]: readonly [
    { readonly ident: I },
    ValueAtIdent<C, I>,
  ];
}[CatalogIdent<C>];

export type TxEntity<C extends AnySchema> = EntityRef<
  C,
  C["entities"][keyof C["entities"]] & AnyEntity,
  TxHandle<C>
>;

/**
 * Entity of `C` when the catalog is known; any entity against the open
 * `AnySchema` bound (same `string extends keyof` test as operations).
 */
export type TxKnownEntity<C extends AnySchema> = string extends keyof C["entities"]
  ? AnyEntity
  : C["entities"][keyof C["entities"]];

/** Targeted ref → that entity; `Ref.self` / untargeted → the enclosing entity. */
type RefSlotTarget<N extends AnyEntity, K extends string> =
  [FieldTargetEntity<N["fields"][K]>] extends [never]
    ? N
    : FieldTargetEntity<N["fields"][K]>;

/**
 * Ref forms `put` accepts. Same {@link EntityRef} vocabulary as `set` /
 * `db.run` — no bare `string`. `{ eid, class }` is `op.principal`.
 */
type PutRef<
  C extends AnySchema,
  H = TxHandle<C>,
  Target extends AnyEntity = AnyEntity,
> =
  | EntityRef<C, Target, H>
  | { readonly eid: number | null; readonly class: string };

type PutScalar<
  C extends AnySchema,
  N extends AnyEntity,
  K extends string,
  H = TxHandle<C>,
> =
  | (N["fields"][K] extends { readonly valueType: "ref" }
      ? PutRef<C, H, RefSlotTarget<N, K>>
      : ValueAtIdent<C, `:${N["ns"]}/${K}`>);

/**
 * `put` attrs: {@link WriteAtEntity} (array for many, omit `undefined`)
 * plus handle / lookup / `{ id }` / principal on ref fields. `H` is the
 * handle admitted in ref slots — `TxHandle` on the builder, widened to
 * `TxHandle | OpHandle` on the promise `Op`.
 */
export type PutAttrs<C extends AnySchema, N extends AnyEntity, H = TxHandle<C>> = {
  [K in keyof WriteAtEntity<C, N> & string]?:
    | (N["fields"][K] extends { readonly valueType: "ref" }
        ? N["fields"][K]["cardinality"] extends "many"
          ? ReadonlyArray<PutScalar<C, N, K, H>>
          : PutScalar<C, N, K, H>
        : WriteAtEntity<C, N>[K]);
};

/**
 * 3-arg `put` subject, narrowed to entity `N` — the same
 * {@link EntityRef} vocabulary as `db.run`. A branded cell of the
 * wrong entity is rejected. No bare `string`.
 */
export type PutSubject<
  C extends AnySchema,
  N extends AnyEntity,
  H = TxHandle<C>,
> = EntityRef<C, N, H>;

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
  /**
   * What this handle names: a fresh tempid, an eid, or a lookup ref.
   * Not catalog-branded — the handle does not know a namespace — so it
   * is the unbranded-number / tempid / lookup hatch, valid in any ref slot.
   */
  readonly eid: UnbrandedId | Tempid | LookupRef<C>;

  set<const A extends TxField<C>>(
    field: A,
    value: TxValue<C, A, TxHandle<C>>,
  ): Effect.Effect<void>;

  remove<const A extends TxField<C>>(
    field: A,
    value?: TxValue<C, A, TxHandle<C>>,
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
   * `tx.entity()` → new handle; `tx.entity(1001)`;
   * `tx.entity(tx.tempid("ada"))`; `tx.entity([User.name, "Ada"])`.
   */
  entity(): Effect.Effect<TxHandle<C>>;
  entity(id: TxEntity<C>): Effect.Effect<TxHandle<C>>;

  /** Brand a string as a named tempid. Not a bare `string`. */
  tempid(name: string): Tempid;

  /** Assert one datom. Cardinality-many is one call per value. */
  set<const A extends TxField<C>>(
    e: TxEntity<C>,
    field: A,
    value: TxValue<C, A, TxHandle<C>>,
  ): Effect.Effect<void>;

  remove<const A extends TxField<C>>(
    e: TxEntity<C>,
    field: A,
    value?: TxValue<C, A, TxHandle<C>>,
  ): Effect.Effect<void>;

  delete(e: TxEntity<C>): Effect.Effect<void>;

  /**
   * Entity-level write. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * new record. A subject names the record: an existing id, or a new
   * id if that number has never been used (same as `set` — not
   * "update only").
   *
   * ### Upserts
   *
   * Including a `unique: "upsert"` field in the map makes `put`
   * ensure-this-row-exists: the engine unifies the new record with the
   * existing row. `put(User, { sub, name })` is insert-or-update;
   * `put(User, { sub })` is enough when you only have the key. A lookup
   * that misses is still a hard rejection — put with the unique field
   * is the path that creates when missing.
   *
   * A two-element array whose first value is an ident (`":…"`) is a
   * lookup on a ref field. On a cardinality-many scalar field, that
   * shape is expanded to one value per element so `tags: [":a", "b"]`
   * writes two strings.
   */
  put<N extends TxKnownEntity<C>>(
    entity: N,
    attrs: PutAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;
  put<N extends TxKnownEntity<C>>(
    entity: N,
    id: PutSubject<C, N>,
    attrs: PutAttrs<C, N>,
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

const fieldMeta = (
  entity: unknown,
  key: string,
): { readonly cardinality?: unknown; readonly valueType?: unknown } | undefined => {
  if (typeof entity !== "object" || entity === null || !("fields" in entity)) {
    return undefined;
  }
  const fields = (
    entity as {
      fields?: Record<
        string,
        { readonly cardinality?: unknown; readonly valueType?: unknown }
      >;
    }
  ).fields;
  return fields?.[key];
};

const isCardManyScalarField = (entity: unknown, key: string): boolean => {
  const field = fieldMeta(entity, key);
  return field?.cardinality === "many" && field?.valueType !== "ref";
};

const resolveEntity = (e: unknown): unknown => lowerEntityArg(e);

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

const lowerPut = (
  entity: unknown,
  eid: unknown,
  attrs: Record<string, unknown>,
): { readonly map: TxMap; readonly extras: TxOp[] } => {
  const map: Record<string, unknown> = { ":db/id": eid };
  const extras: TxOp[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const ident = fieldIdent(entity, key);
    if (isCardManyScalarField(entity, key) && Array.isArray(value)) {
      for (const item of value) {
        const lowered = lowerWriteValue(item);
        if (lowered === undefined) continue;
        extras.push([":db/add", eid, ident, lowered]);
      }
      continue;
    }
    const lowered = lowerWriteValue(value);
    if (lowered === undefined) continue;
    map[ident] = lowered;
  }
  return { map, extras };
};

const makeHandle = <C extends AnySchema>(
  eid: UnbrandedId | Tempid | LookupRef<C>,
  ops: TxOp[],
): TxHandle<C> => ({
  _tag: "TxHandle",
  eid,
  set: (field: unknown, value: unknown) =>
    Effect.sync(() => {
      ops.push([":db/add", eid, lowerAttr(field), lowerWriteValue(value)]);
    }),
  remove: (field: unknown, value?: unknown) =>
    Effect.sync(() => {
      if (value === undefined) {
        ops.push([":db/retract", eid, lowerAttr(field)]);
      } else {
        ops.push([":db/retract", eid, lowerAttr(field), lowerWriteValue(value)]);
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
            ? (`tmp-${++next}` as Tempid)
            : (resolveEntity(id) as UnbrandedId | Tempid | LookupRef<C>);
        return makeHandle(resolved, ops);
      })) as Tx<C>["entity"],
    tempid,
    set: (e: unknown, field: unknown, value: unknown) =>
      Effect.sync(() => {
        ops.push([
          ":db/add",
          resolveEntity(e),
          lowerAttr(field),
          lowerWriteValue(value),
        ]);
      }),
    remove: (e: unknown, field: unknown, value?: unknown) =>
      Effect.sync(() => {
        if (value === undefined) {
          ops.push([":db/retract", resolveEntity(e), lowerAttr(field)]);
        } else {
          ops.push([
            ":db/retract",
            resolveEntity(e),
            lowerAttr(field),
            lowerWriteValue(value),
          ]);
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
            ? (`tmp-${++next}` as Tempid)
            : (resolveEntity(id) as UnbrandedId | Tempid | LookupRef<C>);
        const { map, extras } = lowerPut(entity, eid, attrs ?? {});
        ops.push(map);
        ops.push(...extras);
        return makeHandle(eid, ops);
      })) as Tx<C>["put"],
  };
  return builder;
};
