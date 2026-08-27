/** Schema-generic transaction builder. Internal — operation bodies see {@link Op}. */

import * as Effect from "effect/Effect";
import { lowerAttr } from "./attrRef.ts";
import { composerIdent } from "./compose.ts";
import { fieldOwnerIdent } from "../internal/core/membership.ts";
import { RAMOSE_TYPE_IDENT } from "../internal/core/schema.ts";
import { asLookupRef, lowerEntityArg, lowerWriteValue, tempid, type Tempid } from "./entityArg.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyField, ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import { TxRejected } from "./Errors.ts";
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
  IdentOfFieldIn,
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
      : ValueAtIdent<C, IdentOfFieldIn<N["fields"][K], N["ns"], K>>);

type PutFieldValue<
  C extends AnySchema,
  N extends AnyEntity,
  K extends string,
  H = TxHandle<C>,
> = N["fields"][K] extends { readonly valueType: "ref" }
  ? N["fields"][K]["cardinality"] extends "many"
    ? ReadonlyArray<PutScalar<C, N, K, H>>
    : PutScalar<C, N, K, H>
  : WriteAtEntity<C, N>[K];

/**
 * Partial attrs — every key optional. Used by `put(Entity, subject, {…})`
 * and `update`. Cardinality-many is an array; `undefined` is omitted.
 */
export type PutAttrs<C extends AnySchema, N extends AnyEntity, H = TxHandle<C>> = {
  [K in keyof WriteAtEntity<C, N> & string]?: PutFieldValue<C, N, K, H> | undefined;
};

type FieldIsOptional<F> = F extends { readonly cardinality: "many" }
  ? true
  : F extends { readonly isOptional: true }
    ? true
    : F extends { readonly default: unknown }
      ? true
      : undefined extends ValueOf<F extends AnyField ? F : never>
        ? true
        : false;

type RequiredPutKeys<N extends AnyEntity> = {
  [K in keyof N["fields"] & string]: FieldIsOptional<N["fields"][K]> extends true
    ? never
    : K;
}[keyof N["fields"] & string];

type OptionalPutKeys<N extends AnyEntity> = Exclude<
  keyof N["fields"] & string,
  RequiredPutKeys<N>
>;

/**
 * `put(Entity, {…})` create form: required card-one keys required,
 * optional / card-many omitted. Key-only `put(User, { sub })` is a
 * compile error — that is `update`.
 */
export type PutCreateAttrs<
  C extends AnySchema,
  N extends AnyEntity,
  H = TxHandle<C>,
> = {
  [K in RequiredPutKeys<N>]: PutFieldValue<C, N, K, H>;
} & {
  [K in OptionalPutKeys<N>]?: PutFieldValue<C, N, K, H> | undefined;
};

type UpsertKeys<N extends AnyEntity> = {
  [K in keyof N["fields"] & string]: N["fields"][K] extends {
    readonly unique: "upsert";
  }
    ? K
    : never;
}[keyof N["fields"] & string];

type RequireAtLeastOne<T, Keys extends keyof T> = {
  [K in Keys]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[Keys];

/**
 * `update(Entity, {…})` map form: at least one `unique: "upsert"` field.
 * An entity with no upsert key cannot use this form.
 */
export type UpdateMapAttrs<
  C extends AnySchema,
  N extends AnyEntity,
  H = TxHandle<C>,
> = [UpsertKeys<N>] extends [never]
  ? { readonly "update map form needs a unique: \"upsert\" field": never }
  : RequireAtLeastOne<PutAttrs<C, N, H>, UpsertKeys<N> & keyof PutAttrs<C, N, H>>;

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
  | readonly [":db/update", unknown, string, unknown]
  | readonly [":db/update", unknown]
  | readonly [":db/retract", unknown, string]
  | readonly [":db/retract", unknown, string, unknown]
  | readonly [":db/retractEntity", unknown]
  | TxMap;

export interface TxSpec {
  readonly ops: readonly TxOp[];
}

/** @internal Collected ops and catalog — not on the public builder shape. */
export const TX_INTERNALS: unique symbol = Symbol.for("ramose.tx.internals");

export interface TxInternals<C extends AnySchema = AnySchema> {
  readonly schema: C;
  readonly ops: () => readonly TxOp[];
}

const internalsOf = (tx: object): TxInternals => {
  const inner = (tx as Record<symbol, TxInternals | undefined>)[TX_INTERNALS];
  if (inner === undefined) {
    throw new Error("ramose: tx internals are not available");
  }
  return inner;
};

/** @internal Ops the builder has collected. */
export const txOps = (tx: object): readonly TxOp[] => internalsOf(tx).ops();

/** @internal Catalog the builder was created with. */
export const txSchema = <C extends AnySchema>(tx: Tx<C>): C =>
  internalsOf(tx).schema as C;

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

  readonly delete: Effect.Effect<void>;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * Schema-generic transaction builder. Methods are Effects so the hatch
 * and the op handle can share one lowering. Collected ops live under
 * {@link TX_INTERNALS}, not on this shape.
 */
export interface Tx<C extends AnySchema = AnySchema> {
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
   * Make this row so. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * new record and the map must carry every required field. A numeric
   * subject names an existing record — a missing id is
   * `TxRejected` `tx/missing-entity` (same as {@link Tx.update}; naming
   * never creates). A tempid / handle subject is a create.
   *
   * Including a `unique: "upsert"` field unifies with the existing row
   * — insert-or-update, still with full required data on create.
   * Partial writes to an existing row are {@link Tx.update}.
   *
   * A two-element array whose first value is an ident (`":…"`) is a
   * lookup on a ref field. On a cardinality-many scalar field, that
   * shape is expanded to one value per element so `tags: [":a", "b"]`
   * writes two strings.
   */
  put<N extends TxKnownEntity<C>>(
    entity: N,
    attrs: PutCreateAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;
  put<N extends TxKnownEntity<C>>(
    entity: N,
    id: PutSubject<C, N>,
    attrs: PutAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;

  /**
   * Change what's there. Partial; never creates. Address by subject
   * (eid / handle / branded cell / lookup) or by a map that contains
   * at least one `unique: "upsert"` field. Missing row →
   * `TxRejected` `tx/missing-entity`. Wrong-entity subject →
   * `tx/wrong-entity`.
   */
  update<N extends TxKnownEntity<C>>(
    entity: N,
    attrs: UpdateMapAttrs<C, N>,
  ): Effect.Effect<TxHandle<C>>;
  update<N extends TxKnownEntity<C>>(
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

/** Card-many array to fan out as one op per item. A lookup ref is one value. */
const isCardManyWrite = (entity: unknown, key: string, value: unknown): boolean => {
  const field = fieldMeta(entity, key);
  if (field?.cardinality !== "many" || !Array.isArray(value)) return false;
  return field.valueType !== "ref" || asLookupRef(value) === undefined;
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
  // Typed put declares the composer. The transactor consumes this as a
  // create hint and writes the engine-owned stamps itself (ID-2).
  const ns =
    typeof entity === "object" &&
    entity !== null &&
    "ns" in entity &&
    typeof (entity as { ns: unknown }).ns === "string"
      ? (entity as { ns: string }).ns
      : "";
  if (ns.length > 0) map[":ramose/type"] = composerIdent(ns);
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

const upsertIdents = (
  entity: unknown,
  attrs: Record<string, unknown>,
): readonly [string, unknown][] => {
  if (typeof entity !== "object" || entity === null || !("fields" in entity)) {
    return [];
  }
  const fields = (
    entity as {
      fields?: Record<
        string,
        { readonly unique?: unknown; readonly ident?: unknown }
      >;
    }
  ).fields;
  if (fields === undefined) return [];
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const field = fields[key];
    if (field?.unique !== "upsert") continue;
    const ident = typeof field.ident === "string" ? field.ident : fieldIdent(entity, key);
    const lowered = lowerWriteValue(value);
    if (lowered === undefined) continue;
    out.push([ident, lowered]);
  }
  return out;
};

const lowerUpdate = (
  entity: unknown,
  eid: unknown,
  attrs: Record<string, unknown>,
): TxOp[] => {
  const ops: TxOp[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const ident = fieldIdent(entity, key);
    if (isCardManyWrite(entity, key, value)) {
      for (const item of value as readonly unknown[]) {
        const lowered = lowerWriteValue(item);
        if (lowered === undefined) continue;
        ops.push([":db/update", eid, ident, lowered]);
      }
      continue;
    }
    const lowered = lowerWriteValue(value);
    if (lowered === undefined) continue;
    ops.push([":db/update", eid, ident, lowered]);
  }
  return ops;
};

const declareType = (ops: TxOp[], eid: unknown, fieldIdent: string): void => {
  const owner = fieldOwnerIdent(fieldIdent);
  if (owner === undefined) return;
  if (
    ops.some(
      (op) =>
        Array.isArray(op) &&
        op[0] === ":db/add" &&
        op[1] === eid &&
        op[2] === RAMOSE_TYPE_IDENT &&
        op[3] === owner,
    )
  ) {
    return;
  }
  ops.push([":db/add", eid, RAMOSE_TYPE_IDENT, owner]);
};

const makeHandle = <C extends AnySchema>(
  eid: UnbrandedId | Tempid | LookupRef<C>,
  ops: TxOp[],
): TxHandle<C> => ({
  _tag: "TxHandle",
  eid,
  set: (field: unknown, value: unknown) =>
    Effect.sync(() => {
      const ident = lowerAttr(field);
      declareType(ops, eid, ident);
      ops.push([":db/add", eid, ident, lowerWriteValue(value)]);
    }),
  remove: (field: unknown, value?: unknown) =>
    Effect.sync(() => {
      if (value === undefined) {
        ops.push([":db/retract", eid, lowerAttr(field)]);
      } else {
        ops.push([":db/retract", eid, lowerAttr(field), lowerWriteValue(value)]);
      }
    }),
  delete: Effect.sync(() => {
    ops.push([":db/retractEntity", eid]);
  }),
});

/**
 * Start a schema-typed transaction builder. Used by {@link buildOp} and
 * by compile-time / runtime fixtures. Not a public write path.
 */
export const txBuilder = <C extends AnySchema>(schema: C): Tx<C> => {
  const ops: TxOp[] = [];
  let next = 0;
  const builder: Tx<C> = {
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
        const eid = resolveEntity(e);
        const ident = lowerAttr(field);
        declareType(ops, eid, ident);
        ops.push([":db/add", eid, ident, lowerWriteValue(value)]);
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
    update: ((entity: unknown, a: unknown, b?: unknown) =>
      Effect.sync(() => {
        const attrs = ((b !== undefined ? b : a) ?? {}) as Record<string, unknown>;
        const id = b !== undefined ? a : undefined;
        let eid: UnbrandedId | Tempid | LookupRef<C>;
        if (id !== undefined) {
          eid = resolveEntity(id) as UnbrandedId | Tempid | LookupRef<C>;
        } else {
          const lookups = upsertIdents(entity, attrs);
          if (lookups.length === 0) {
            throw new TxRejected({
              message:
                'update map form needs a unique: "upsert" field',
              code: "tx/invalid",
            });
          }
          eid = lookups[0] as unknown as LookupRef<C>;
        }
        const written = lowerUpdate(entity, eid, attrs);
        if (id === undefined) {
          const lookups = upsertIdents(entity, attrs);
          const ping = lookups[0];
          const rest = written.filter(
            (op) =>
              !(
                ping !== undefined &&
                op[2] === ping[0] &&
                Object.is(op[3], ping[1])
              ),
          );
          if (rest.length === 0 && ping !== undefined) {
            // Existence ping: re-assert the addressing unique value.
            ops.push([":db/update", eid, ping[0], ping[1]]);
          } else {
            ops.push(...rest);
          }
        } else if (written.length === 0) {
          const ping =
            upsertIdents(entity, attrs)[0] ?? asLookupRef(eid);
          if (ping !== undefined) {
            ops.push([":db/update", eid, ping[0], ping[1]]);
          } else {
            // Subject-form existence ping when no unique value is in hand.
            ops.push([":db/update", eid]);
          }
        } else {
          ops.push(...written);
        }
        return makeHandle(eid, ops);
      })) as Tx<C>["update"],
  };
  (builder as Tx<C> & Record<typeof TX_INTERNALS, TxInternals<C>>)[TX_INTERNALS] =
    {
      schema,
      ops: () => ops.slice(),
    };
  return builder;
};
