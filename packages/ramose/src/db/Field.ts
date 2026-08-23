/** Typed field: value Schema, cardinality, and options. */

import type * as Schema from "effect/Schema";
import {
  tryInferDbValueType,
  type DbValueType,
  type InferDbValueType,
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

export interface Field<
  S extends Schema.Top = Schema.Top,
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
  Schema.Top,
  Cardinality,
  Uniqueness | undefined,
  DbValueType | undefined,
  boolean
>;

/**
 * Declare a field. File it under an entity key to stamp `:entity/name`.
 *
 * **Write the options inline.** `cardinality`, `unique` and `owned`
 * reach the field's *type* — and so reach `.reverse`'s cardinality, the
 * navigable path, and every row type — only through the `const O` inference on
 * the literal. An options object typed as {@link FieldOptions} first
 * (`const opts: FieldOptions = { owned: true }`) has already widened
 * those to their optional declared types, and the field infers the
 * defaults (`"one"` / `undefined` / `false`) while the runtime value still
 * carries what you wrote. Pass the literal at the call site, or `as const` it.
 */
export const Field: {
  <S extends Schema.Top>(
    schema: S,
  ): Field<S, "one", undefined, InferDbValueType<S>, false>;
  <S extends Schema.Top, const O extends FieldOptions>(
    schema: S,
    options: O,
  ): Field<S, CardOf<O>, UniqueOf<O>, ValueTypeOf<S, O>, OwnedOf<O>>;
} = ((schema: Schema.Top, options?: FieldOptions) => ({
  _tag: "Field" as const,
  schema,
  cardinality: options?.cardinality ?? "one",
  unique: options?.unique,
  index: options?.index ?? options?.unique !== undefined,
  owned: options?.owned ?? false,
  doc: options?.doc,
  valueType: tryInferDbValueType(schema, options?.valueType),
})) as typeof Field;

export type ValueOf<A extends AnyField> = Schema.Schema.Type<A["schema"]>;
