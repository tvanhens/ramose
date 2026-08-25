/** Typed field: value Schema, cardinality, and options. */

import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";
import {
  Bytes,
  Instant,
  Long,
  Ref as refSchema,
  Uuid,
  enumMembersOf,
  enumSchema,
  rememberValueType,
  tryInferDbValueType,
  type DbValueType,
  type InferDbValueType,
  type SelfMarker,
  type TargetedRef,
  untargetedRef,
} from "./valueTypes.ts";

export type Cardinality = "one" | "many";
export type Uniqueness = "upsert" | "strict";

/**
 * Non-type-bearing field options. Cardinality, uniqueness and ownership
 * live on {@link Field.many} / {@link Field.unique} / {@link Field.owned}
 * — annotating a shared bag cannot erase them.
 *
 * `valueType` is not an option: brand the schema with
 * {@link import("./valueTypes.ts").stored}.
 */
export interface FieldOptions {
  readonly index?: boolean;
  readonly doc?: string;
  /**
   * Omitted at create; `| undefined` on the default row. Card-many is
   * already trivially satisfiable (empty set) and is never a required key.
   */
  readonly optional?: boolean;
}

type FieldFlags = {
  readonly cardinality?: Cardinality;
  readonly unique?: Uniqueness;
  readonly owned?: boolean;
};

/** True when `O` names the key (even if the value is `false` / `undefined`). */
type Named<O, K extends string> = [O] extends [{ readonly [P in K]: unknown }]
  ? true
  : false;

type OptionalOf<O> = [O] extends [{ readonly optional: infer B }]
  ? B extends true
    ? true
    : false
  : false;

/** Composition may set `optional` (`false` → `true`); absence keeps the inner field. */
type MergeOptional<Opt extends boolean, O> = Named<O, "optional"> extends true
  ? OptionalOf<O>
  : Opt;

/**
 * Fail-closed argument for `Field(schema)` when inference cannot name
 * `:db.type/*`. The brand key is the instruction — wrap with
 * {@link import("./valueTypes.ts").stored}, or use {@link Enum} for a
 * string-literal set. The demand is at this call, not at `install()`.
 */
type InferableSchema<S extends SchemaNS.Top> = InferDbValueType<S> extends DbValueType
  ? S
  : S & {
      readonly "wrap with stored(schema, vt) — this Schema cannot infer :db.type/*": true;
    };

export interface Field<
  S extends SchemaNS.Top = SchemaNS.Top,
  Card extends Cardinality = Cardinality,
  Unique extends Uniqueness | undefined = Uniqueness | undefined,
  VT extends DbValueType | undefined = DbValueType | undefined,
  Owned extends boolean = boolean,
  Opt extends boolean = false,
> {
  readonly _tag: "Field";
  readonly schema: S;
  readonly cardinality: Card;
  readonly unique: Unique;
  readonly index: boolean;
  readonly owned: Owned;
  readonly doc: string | undefined;
  readonly valueType: VT;
  /**
   * Presence flag for required-at-transact. Not named `optional` — that
   * getter is the pull-shaping method on a stamped field. A sixth type
   * parameter so `string({ optional: true })` survives `Entity` stamping
   * the way `owned` / `cardinality` do.
   */
  readonly isOptional: Opt;
}

export type AnyField = Field<
  SchemaNS.Top,
  Cardinality,
  Uniqueness | undefined,
  DbValueType | undefined,
  boolean,
  boolean
>;

export declare namespace Field {
  /** Any field — the bound for field-generic helpers. */
  export type Any = AnyField;
}

export const isField = (value: unknown): value is AnyField =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Field" &&
  "schema" in value;

const rejectRetiredOptions = (options?: object): void => {
  if (options == null) return;
  if ("valueType" in options) {
    throw new Error(
      "ramose/schema: valueType is not a field option. Brand the schema with stored(schema, vt).",
    );
  }
  if ("cardinality" in options) {
    throw new Error(
      "ramose/schema: cardinality is not a field option. Use Field.many(schema).",
    );
  }
  if ("unique" in options) {
    throw new Error(
      'ramose/schema: unique is not a field option. Use Field.unique(schema, "upsert" | "strict").',
    );
  }
  if ("owned" in options || "isComponent" in options) {
    throw new Error(
      "ramose/schema: owned is not a field option. Use Field.owned(schema).",
    );
  }
};

const makeField = (
  schema: SchemaNS.Top,
  options?: FieldOptions,
  flags?: FieldFlags,
): AnyField => {
  rejectRetiredOptions(options);
  const unique = flags?.unique;
  const field = {
    _tag: "Field" as const,
    schema,
    cardinality: flags?.cardinality ?? "one",
    unique,
    index: options?.index ?? unique !== undefined,
    owned: flags?.owned ?? false,
    doc: options?.doc,
    valueType: tryInferDbValueType(schema),
    isOptional: options?.optional === true || schemaAllowsUndefined(schema),
  };
  const members = enumMembersOf(schema);
  return members !== undefined ? Object.assign(field, { members }) : field;
};

const schemaAllowsUndefined = (schema: { readonly ast?: { readonly _tag?: unknown; readonly types?: readonly { readonly _tag?: unknown }[] } }): boolean => {
  const ast = schema.ast;
  if (ast === undefined) return false;
  if (ast._tag === "Undefined") return true;
  if (ast._tag === "Union" && Array.isArray(ast.types)) {
    return ast.types.some((t) => t._tag === "Undefined" || schemaAllowsUndefined({ ast: t }));
  }
  return false;
};

/** Required-at-transact: card-many is never a required key. */
export const isOptionalField = (field: AnyField): boolean =>
  field.cardinality === "many" || field.isOptional === true;

const fieldSchema = (input: AnyField | SchemaNS.Top): SchemaNS.Top =>
  isField(input) ? input.schema : input;

const mergeFieldOptions = (
  input: AnyField | SchemaNS.Top,
  extra?: FieldOptions,
): FieldOptions => {
  rejectRetiredOptions(extra);
  if (!isField(input)) return extra ?? {};
  return {
    index: extra?.index ?? input.index,
    doc: extra?.doc ?? input.doc,
    optional: extra?.optional ?? input.isOptional,
  };
};

const mergeFlags = (
  input: AnyField | SchemaNS.Top,
  flags?: FieldFlags,
): FieldFlags => {
  if (!isField(input)) return flags ?? {};
  return {
    cardinality: flags?.cardinality ?? input.cardinality,
    unique: flags?.unique ?? input.unique,
    owned: flags?.owned ?? input.owned,
  };
};

const applyField = (
  input: AnyField | SchemaNS.Top,
  options?: FieldOptions,
  flags?: FieldFlags,
): AnyField =>
  makeField(fieldSchema(input), mergeFieldOptions(input, options), mergeFlags(input, flags));

type FieldMany = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, OptionalOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean>(
    field: Field<S, C, U, VT, Own, Opt>,
  ): Field<S, "many", U, VT, Own, Opt>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt>,
    options: O,
  ): Field<S, "many", U, VT, Own, MergeOptional<Opt, O>>;
};

type FieldUnique = {
  <S extends SchemaNS.Top, const U extends Uniqueness>(
    schema: InferableSchema<S>,
    uniqueness: U,
  ): Field<S, "one", U, InferDbValueType<S>, false, false>;
  <S extends SchemaNS.Top, const U extends Uniqueness, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    uniqueness: U,
    options: O,
  ): Field<S, "one", U, InferDbValueType<S>, false, OptionalOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const U extends Uniqueness>(
    field: Field<S, C, _U, VT, Own, Opt>,
    uniqueness: U,
  ): Field<S, C, U, VT, Own, Opt>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const U extends Uniqueness, const O extends FieldOptions>(
    field: Field<S, C, _U, VT, Own, Opt>,
    uniqueness: U,
    options: O,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>>;
};

type FieldOwned = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, OptionalOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean>(
    field: Field<S, C, U, VT, Own, Opt>,
  ): Field<S, C, U, VT, true, Opt>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt>,
    options: O,
  ): Field<S, C, U, VT, true, MergeOptional<Opt, O>>;
};

/**
 * Declare a field. File it under an entity key to stamp `:entity/name`.
 *
 * Prefer the value shorthands (`string()`, `boolean()`, `Ref(User)`, …)
 * for app schemas. `Field(schema)` is the advanced form: a raw Effect
 * Schema. When inference cannot name `:db.type/*`, wrap the schema with
 * {@link import("./valueTypes.ts").stored} — `stored(Schema.Literals(["on", "off"]), "string")`.
 *
 * Cardinality, uniqueness and ownership are the function:
 * `Field.many(schema)`, `Field.unique(schema, "upsert" | "strict")`,
 * `Field.owned(schema)`. They compose with a shorthand or a raw Schema.
 * `"upsert"` unifies with the existing row on a colliding write;
 * `"strict"` rejects the write. Composition cannot change `valueType` —
 * brand the schema with {@link import("./valueTypes.ts").stored}.
 * `Field.unique` always indexes; `Field.unique(string({ index: false }), "upsert")`
 * discards `index: false` (unique implies index).
 */
export const Field: {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean>(
    field: Field<S, C, U, VT, Own, Opt>,
  ): Field<S, C, U, VT, Own, Opt>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt>,
    options: O,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>>;
  readonly many: FieldMany;
  readonly unique: FieldUnique;
  readonly owned: FieldOwned;
} = Object.assign(
  ((input: SchemaNS.Top | AnyField, options?: FieldOptions) =>
    applyField(input, options)) as {
    <S extends SchemaNS.Top>(
      schema: InferableSchema<S>,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, false>;
    <S extends SchemaNS.Top, const O extends FieldOptions>(
      schema: InferableSchema<S>,
      options: O,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean>(
      field: Field<S, C, U, VT, Own, Opt>,
    ): Field<S, C, U, VT, Own, Opt>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, const O extends FieldOptions>(
      field: Field<S, C, U, VT, Own, Opt>,
      options: O,
    ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>>;
  },
  {
    many: ((input: AnyField | SchemaNS.Top, options?: FieldOptions) =>
      applyField(input, options, { cardinality: "many" })) as FieldMany,
    unique: ((
      input: AnyField | SchemaNS.Top,
      uniqueness: Uniqueness,
      options?: FieldOptions,
    ) =>
      applyField(
        input,
        { ...mergeFieldOptions(input, options), index: true },
        { unique: uniqueness },
      )) as FieldUnique,
    owned: ((input: AnyField | SchemaNS.Top, options?: FieldOptions) =>
      applyField(input, options, { owned: true })) as FieldOwned,
  },
);

export type ValueOf<A extends AnyField> = SchemaNS.Schema.Type<A["schema"]>;

type Shorthand<S extends SchemaNS.Top, VT extends DbValueType> = {
  (): Field<S, "one", undefined, VT, false, false>;
  <const O extends FieldOptions>(
    options: O,
  ): Field<S, "one", undefined, VT, false, OptionalOf<O>>;
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
  false,
  false
> & { readonly members: L };

type EnumFieldOpts<
  L extends readonly [string, ...string[]],
  O extends FieldOptions,
> = Field<
  ReturnType<typeof enumSchema<L>>,
  "one",
  undefined,
  "string",
  false,
  OptionalOf<O>
> & { readonly members: L };

/**
 * Closed string set. Stored as `:db.type/string`. `Enum(["low", "med"])`
 * types the field as `"low" | "med"` and carries the members on the
 * field (`Issue.status.members`) so the UI does not restate the list.
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
  ): Field<TargetedRef<N["fields"], N["ns"], N>, "one", undefined, "ref", false, false>;
  <const N extends EntityLike, const O extends FieldOptions>(
    target: N | (() => N),
    options: O,
  ): Field<
    TargetedRef<N["fields"], N["ns"], N>,
    "one",
    undefined,
    "ref",
    false,
    OptionalOf<O>
  >;
  readonly self: Field<
    TargetedRef<SelfMarker>,
    "one",
    undefined,
    "ref",
    false,
    false
  >;
} & typeof untargetedRef;

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
  untargetedRef,
  {
    self: makeField(refSchema.self) as Field<
      TargetedRef<SelfMarker>,
      "one",
      undefined,
      "ref",
      false,
      false
    >,
  },
);
rememberValueType(Ref, "ref");
