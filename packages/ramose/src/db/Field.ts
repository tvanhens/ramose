/** Typed field: value Schema, cardinality, and options. */

import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";
import {
  Bytes,
  Instant,
  Long,
  Ref as refSchema,
  Uuid,
  enumSchema,
  rememberValueType,
  tryInferDbValueType,
  type DbValueType,
  type InferDbValueType,
  type SelfMarker,
  type TargetedRef,
} from "./valueTypes.ts";

export type Cardinality = "one" | "many";
export type Uniqueness = "upsert" | "strict";

export interface FieldOptions {
  readonly cardinality?: Cardinality;
  readonly unique?: Uniqueness;
  readonly index?: boolean;
  readonly owned?: boolean;
  readonly doc?: string;
  /** Override inferred `:db.type/*`. Required for custom Schemas. Public spelling is `"string"`, not `":db.type/string"`. */
  readonly valueType?: DbValueType;
}

type CardOf<O> = [O] extends [{ readonly cardinality: infer C }]
  ? C extends Cardinality
    ? C
    : "one"
  : "one";

type UniqueOf<O> = [O] extends [{ readonly unique: infer U }]
  ? U extends Uniqueness
    ? U
    : undefined
  : undefined;

type ValueTypeOf<S, O> = [O] extends [{ readonly valueType: infer V }]
  ? V extends DbValueType
    ? V
    : InferDbValueType<S>
  : InferDbValueType<S>;

/**
 * Ownership, as a *type*: an owned ref owns what it points at, so its
 * backlink answers one entity, and `field.reverse` has to know that before the
 * query runs. Anything but a literal `true` is `false` — including the plain
 * `boolean` an un-narrowed {@link AnyField} carries, which is what makes a
 * generic backlink the many-valued one.
 */
type OwnedOf<O> = [O] extends [{ readonly owned: infer B }]
  ? B extends true
    ? true
    : false
  : false;

/** Options when the value Schema cannot infer `:db.type/*` on its own. */
type OptionsFor<S, O extends FieldOptions> = InferDbValueType<S> extends DbValueType
  ? O
  : O & { readonly valueType: DbValueType };

export interface Field<
  S extends SchemaNS.Top = SchemaNS.Top,
  Card extends Cardinality = Cardinality,
  Unique extends Uniqueness | undefined = Uniqueness | undefined,
  VT extends DbValueType | undefined = DbValueType | undefined,
  Owned extends boolean = boolean,
> {
  readonly _tag: "Field";
  readonly schema: S;
  readonly cardinality: Card;
  readonly unique: Unique;
  readonly index: boolean;
  readonly owned: Owned;
  readonly doc: string | undefined;
  readonly valueType: VT;
}

export type AnyField = Field<
  SchemaNS.Top,
  Cardinality,
  Uniqueness | undefined,
  DbValueType | undefined,
  boolean
>;

export const isField = (value: unknown): value is AnyField =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Field" &&
  "schema" in value;

const makeField = (schema: SchemaNS.Top, options?: FieldOptions): AnyField => ({
  _tag: "Field" as const,
  schema,
  cardinality: options?.cardinality ?? "one",
  unique: options?.unique,
  index: options?.index ?? options?.unique !== undefined,
  owned: options?.owned ?? false,
  doc: options?.doc,
  valueType: tryInferDbValueType(schema, options?.valueType),
});

const fieldSchema = (input: AnyField | SchemaNS.Top): SchemaNS.Top =>
  isField(input) ? input.schema : input;

const mergeFieldOptions = (
  input: AnyField | SchemaNS.Top,
  extra: FieldOptions,
): FieldOptions => {
  if (!isField(input)) return extra;
  return {
    cardinality: extra.cardinality ?? input.cardinality,
    unique: extra.unique ?? input.unique,
    index: extra.index ?? (extra.unique !== undefined ? true : input.index),
    owned: extra.owned ?? input.owned,
    doc: extra.doc ?? input.doc,
    valueType: extra.valueType ?? input.valueType,
  };
};

type ManyOpts = Omit<FieldOptions, "cardinality">;
type UniqueOpts = Omit<FieldOptions, "unique">;

type FieldMany = {
  <S extends SchemaNS.Top>(
    schema: InferDbValueType<S> extends DbValueType ? S : never,
  ): Field<S, "many", undefined, InferDbValueType<S>, false>;
  <S extends SchemaNS.Top, const O extends ManyOpts>(
    schema: S,
    options: OptionsFor<S, O>,
  ): Field<S, "many", UniqueOf<O>, ValueTypeOf<S, O>, OwnedOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean>(
    field: Field<S, C, U, VT, Own>,
  ): Field<S, "many", U, VT, Own>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, const O extends ManyOpts>(
    field: Field<S, C, U, VT, Own>,
    options: O,
  ): Field<S, "many", UniqueOf<O> extends undefined ? U : UniqueOf<O>, VT, Own>;
};

type FieldUnique = {
  <S extends SchemaNS.Top, const U extends Uniqueness>(
    schema: InferDbValueType<S> extends DbValueType ? S : never,
    uniqueness: U,
  ): Field<S, "one", U, InferDbValueType<S>, false>;
  <S extends SchemaNS.Top, const U extends Uniqueness, const O extends UniqueOpts>(
    schema: S,
    uniqueness: U,
    options: OptionsFor<S, O>,
  ): Field<S, CardOf<O>, U, ValueTypeOf<S, O>, OwnedOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, const U extends Uniqueness>(
    field: Field<S, C, _U, VT, Own>,
    uniqueness: U,
  ): Field<S, C, U, VT, Own>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, const U extends Uniqueness, const O extends UniqueOpts>(
    field: Field<S, C, _U, VT, Own>,
    uniqueness: U,
    options: O,
  ): Field<S, [O] extends [{ readonly cardinality: infer C2 extends Cardinality }] ? C2 : C, U, VT, Own>;
};

/**
 * Declare a field. File it under an entity key to stamp `:entity/name`.
 *
 * Prefer the value shorthands (`string()`, `boolean()`, `Ref(User)`, …)
 * for app schemas. `Field(schema)` is the advanced form: a raw Effect
 * Schema, with `valueType` required when inference cannot name
 * `:db.type/*`.
 *
 * **Write the options inline.** `cardinality`, `unique` and `owned`
 * reach the field's *type* — and so reach `.reverse`'s cardinality, the
 * navigable path, and every row type — only through the `const O` inference on
 * the literal. An options object typed as {@link FieldOptions} first
 * (`const opts: FieldOptions = { owned: true }`) has already widened
 * those to their optional declared types, and the field infers the
 * defaults (`"one"` / `undefined` / `false`) while the runtime value still
 * carries what you wrote. Pass the literal at the call site, or `as const` it.
 *
 * `Field.many` / `Field.unique` compose with a shorthand or a raw Schema
 * so those keys do not depend on the options-bag inference alone.
 */
export const Field: {
  <S extends SchemaNS.Top>(
    schema: InferDbValueType<S> extends DbValueType ? S : never,
  ): Field<S, "one", undefined, InferDbValueType<S>, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: S,
    options: OptionsFor<S, O>,
  ): Field<S, CardOf<O>, UniqueOf<O>, ValueTypeOf<S, O>, OwnedOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean>(
    field: Field<S, C, U, VT, Own>,
  ): Field<S, C, U, VT, Own>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own>,
    options: O,
  ): Field<
    S,
    CardOf<O> extends "one" ? ([O] extends [{ readonly cardinality: Cardinality }] ? CardOf<O> : C) : CardOf<O>,
    UniqueOf<O> extends undefined ? U : UniqueOf<O>,
    VT,
    OwnedOf<O> extends true ? true : Own
  >;
  readonly many: FieldMany;
  readonly unique: FieldUnique;
} = Object.assign(
  ((input: SchemaNS.Top | AnyField, options?: FieldOptions) =>
    isField(input)
      ? makeField(input.schema, mergeFieldOptions(input, options ?? {}))
      : makeField(input, options)) as {
    <S extends SchemaNS.Top>(
      schema: InferDbValueType<S> extends DbValueType ? S : never,
    ): Field<S, "one", undefined, InferDbValueType<S>, false>;
    <S extends SchemaNS.Top, const O extends FieldOptions>(
      schema: S,
      options: OptionsFor<S, O>,
    ): Field<S, CardOf<O>, UniqueOf<O>, ValueTypeOf<S, O>, OwnedOf<O>>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean>(
      field: Field<S, C, U, VT, Own>,
    ): Field<S, C, U, VT, Own>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, const O extends FieldOptions>(
      field: Field<S, C, U, VT, Own>,
      options: O,
    ): Field<
      S,
      CardOf<O> extends "one" ? ([O] extends [{ readonly cardinality: Cardinality }] ? CardOf<O> : C) : CardOf<O>,
      UniqueOf<O> extends undefined ? U : UniqueOf<O>,
      VT,
      OwnedOf<O> extends true ? true : Own
    >;
  },
  {
    many: ((input: AnyField | SchemaNS.Top, options?: ManyOpts) =>
      makeField(fieldSchema(input), {
        ...mergeFieldOptions(input, options ?? {}),
        cardinality: "many",
      })) as FieldMany,
    unique: ((
      input: AnyField | SchemaNS.Top,
      uniqueness: Uniqueness,
      options?: UniqueOpts,
    ) =>
      makeField(fieldSchema(input), {
        ...mergeFieldOptions(input, options ?? {}),
        unique: uniqueness,
        index: options?.index ?? true,
      })) as FieldUnique,
  },
);

export type ValueOf<A extends AnyField> = SchemaNS.Schema.Type<A["schema"]>;

type Shorthand<S extends SchemaNS.Top, VT extends DbValueType> = {
  (): Field<S, "one", undefined, VT, false>;
  <const O extends FieldOptions>(
    options: O,
  ): Field<S, CardOf<O>, UniqueOf<O>, VT, OwnedOf<O>>;
};

const shorthand =
  <S extends SchemaNS.Top, VT extends DbValueType>(
    schema: S,
  ): Shorthand<S, VT> =>
  ((options?: FieldOptions) =>
    makeField(schema, options)) as Shorthand<S, VT>;

/** Text. Stored as `:db.type/string`. */
export const string: Shorthand<typeof Schema.String, "string"> = shorthand(
  Schema.String,
);

/** True / false. Stored as `:db.type/boolean`. */
export const boolean: Shorthand<typeof Schema.Boolean, "boolean"> = shorthand(
  Schema.Boolean,
);

/** Whole number. Stored as `:db.type/long` (plain `float()` / `Schema.Number` is double). */
export const int: Shorthand<typeof Long, "long"> = shorthand(Long);

/** Floating-point number. Stored as `:db.type/double`. */
export const float: Shorthand<typeof Schema.Number, "double"> = shorthand(
  Schema.Number,
);

/** Point in time. You pass and receive a `Date`. Stored as `:db.type/instant`. */
export const timestamp: Shorthand<typeof Instant, "instant"> = shorthand(
  Instant,
);

/** Canonical UUID string. Stored as `:db.type/uuid`. */
export const uuid: Shorthand<typeof Uuid, "uuid"> = shorthand(Uuid);

/** Binary data. Stored as `:db.type/bytes`. */
export const bytes: Shorthand<typeof Bytes, "bytes"> = shorthand(Bytes);

type EnumField<L extends readonly [string, ...string[]]> = Field<
  ReturnType<typeof enumSchema<L>>,
  "one",
  undefined,
  "string",
  false
>;

type EnumFieldOpts<
  L extends readonly [string, ...string[]],
  O extends FieldOptions,
> = Field<
  ReturnType<typeof enumSchema<L>>,
  CardOf<O>,
  UniqueOf<O>,
  "string",
  OwnedOf<O>
>;

/**
 * Closed string set. Stored as `:db.type/string`. `Enum(["low", "med"])`
 * types the field as `"low" | "med"`.
 */
export const Enum: {
  <const L extends readonly [string, ...string[]]>(values: L): EnumField<L>;
  <const L extends readonly [string, ...string[]], const O extends FieldOptions>(
    values: L,
    options: O,
  ): EnumFieldOpts<L, O>;
} = ((values: readonly [string, ...string[]], options?: FieldOptions) =>
  makeField(enumSchema(values), options)) as typeof Enum;

type EntityLike = { readonly fields: object; readonly ns: string };

type RefShorthand = {
  <const N extends EntityLike>(
    target: N | (() => N),
  ): Field<TargetedRef<N["fields"], N["ns"]>, "one", undefined, "ref", false>;
  <const N extends EntityLike, const O extends FieldOptions>(
    target: N | (() => N),
    options: O,
  ): Field<TargetedRef<N["fields"], N["ns"]>, CardOf<O>, UniqueOf<O>, "ref", OwnedOf<O>>;
  readonly self: Field<
    TargetedRef<SelfMarker>,
    "one",
    undefined,
    "ref",
    false
  >;
};

/**
 * Targeted reference. Prefer `Ref(User)`; use `Ref(() => Other)` only
 * when the target is declared later. `Ref.self` is a self-ref.
 * The bare `Ref` (passed to {@link Field}) is an untargeted ref.
 */
export const Ref: RefShorthand = Object.assign(
  ((
    target: EntityLike | (() => EntityLike),
    options?: FieldOptions,
  ) => makeField(refSchema(target as EntityLike & (() => EntityLike)), options)) as RefShorthand,
  {
    self: makeField(refSchema.self) as Field<
      TargetedRef<SelfMarker>,
      "one",
      undefined,
      "ref",
      false
    >,
  },
);
rememberValueType(Ref, "ref");
