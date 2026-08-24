/** Schema-generic transaction builder. `transact(function* (tx) { … })` is hatch-only. */

import * as Effect from "effect/Effect";
import { isAttrRef, lowerAttr } from "./attrRef.ts";
import type { Eid } from "./Eid.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnySchema } from "./Schema.ts";
import type {
  CatalogIdent,
  EntityRef,
  LookupRef,
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

/** Unbranded id — a bare `number` or `.ids()` `{ id }`, not `Eid<Other>`. */
type UnbrandedId = number & { readonly _ns?: never };

type OnIdent<N extends AnyEntity> = `:${N["ns"]}/${string}`;

/** Target entity of a `Ref(User)` field; `never` for `Ref.self` / untargeted. */
type FieldTarget<F> = F extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyEntity
    ? Exclude<T, undefined>
    : never
  : never;

/** Targeted ref → that entity; `Ref.self` / untargeted → the enclosing entity. */
type RefSlotTarget<N extends AnyEntity, K extends string> =
  [FieldTarget<N["fields"][K]>] extends [never]
    ? N
    : FieldTarget<N["fields"][K]>;

/**
 * Ref forms `put` accepts. No bare `string` — that would mint a dangling
 * record. `{ id }` is the `.ids()` row; `{ eid, class }` is `op.principal`.
 */
type PutRef<
  C extends AnySchema,
  H = TxHandle<C>,
  Target extends AnyEntity | never = never,
> =
  | H
  | LookupRef<C>
  | { readonly id: number }
  | { readonly eid: number | null; readonly class: string }
  | ([Target] extends [never]
      ? UnbrandedId
      : Eid<Target> | UnbrandedId);

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
 * 3-arg `put` subject, narrowed to entity `N` the way `db.run` narrows
 * its entity. A branded cell of the wrong entity is rejected.
 */
export type PutSubject<
  C extends AnySchema,
  N extends AnyEntity,
  H = TxHandle<C>,
> =
  | Eid<N>
  | { readonly id: Eid<N> }
  | UnbrandedId
  | string
  | Extract<
      LookupRef<C>,
      | readonly [OnIdent<N>, unknown]
      | readonly [{ readonly ident: OnIdent<N> }, unknown]
    >
  | H;

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

const isIdRow = (v: unknown): v is { readonly id: number } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  "id" in v &&
  typeof (v as { id: unknown }).id === "number";

/** `op.principal` — `{ eid, class }`, not a handle (handles have `_tag`). */
const isPrincipal = (
  v: unknown,
): v is { readonly eid: number | null; readonly class: string } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  "eid" in v &&
  "class" in v &&
  typeof (v as { class: unknown }).class === "string" &&
  ((v as { eid: unknown }).eid === null ||
    typeof (v as { eid: unknown }).eid === "number");

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

const resolveEntity = (e: unknown): unknown => {
  if (isTxHandle(e)) return e.eid;
  if (isIdRow(e)) return e.id;
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

/**
 * Lower handles, `{ id }` rows, `op.principal`, and field-ref lookups so
 * map form is engine-ready. A principal with a null eid is omitted.
 */
const lowerWriteValue = (value: unknown): unknown => {
  if (isTxHandle(value)) return resolveEntity(value);
  if (isIdRow(value)) return value.id;
  if (isPrincipal(value)) return value.eid === null ? undefined : value.eid;
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
        const { map, extras } = lowerPut(entity, eid, attrs ?? {});
        ops.push(map);
        ops.push(...extras);
        return makeHandle(eid, ops);
      })) as Tx<C>["put"],
  };
  return builder;
};
