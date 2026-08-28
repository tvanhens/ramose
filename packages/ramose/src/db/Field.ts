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

/** The only ambient value available to a creation-time default. */
export interface CreationDefaultContext {
  readonly now: Date;
}

/** Canonical data that identifies values captured by a creation default. */
export type CreationDefaultInputs =
  | null
  | string
  | number
  | boolean
  | readonly CreationDefaultInputs[]
  | { readonly [key: string]: CreationDefaultInputs };

export type ImmutableCreationDefaultInputs<T extends CreationDefaultInputs> =
  T extends null | string | number | boolean
    ? T
    : T extends readonly (infer Item extends CreationDefaultInputs)[]
      ? readonly ImmutableCreationDefaultInputs<Item>[]
      : T extends Readonly<Record<string, CreationDefaultInputs>>
        ? { readonly [K in keyof T]: ImmutableCreationDefaultInputs<T[K]> }
        : never;

type CreationDefaultIdentity = {
  readonly inputs: CreationDefaultInputs;
  readonly source: string;
};

const CREATION_DEFAULT_IDENTITY: unique symbol = Symbol.for(
  "ramose.creation-default.identity",
);

/** Synchronous creation-time value computation. `undefined` means missing. */
export type CreationDefault<A> = ((
  context: CreationDefaultContext,
) => A | undefined) & {
  readonly [CREATION_DEFAULT_IDENTITY]?: CreationDefaultIdentity;
};

const snapshotInputs = (
  value: CreationDefaultInputs,
  seen = new WeakSet<object>(),
): CreationDefaultInputs => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("ramose/default: inputs must contain only finite numbers");
    }
    return value;
  }
  if (seen.has(value)) {
    throw new Error("ramose/default: inputs must not contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const snapshot = Object.freeze(
      value.map((item) => snapshotInputs(item, seen)),
    );
    seen.delete(value);
    return snapshot;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("ramose/default: inputs must be canonical JSON data");
  }
  const record = value as Readonly<Record<string, CreationDefaultInputs>>;
  const out: Record<string, CreationDefaultInputs> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) {
      throw new Error("ramose/default: inputs must be canonical JSON data");
    }
    out[key] = snapshotInputs(item, seen);
  }
  seen.delete(value);
  return Object.freeze(out);
};

/**
 * Snapshot every runtime/config input used by a default as immutable canonical
 * data. The evaluator receives that snapshot and should derive its result only
 * from the snapshot and authoritative context.
 */
export const creationDefault = <
  A,
  const Inputs extends CreationDefaultInputs,
>(
  inputs: Inputs,
  get: (
    inputs: ImmutableCreationDefaultInputs<Inputs>,
    context: CreationDefaultContext,
  ) => A | undefined,
): CreationDefault<A> => {
  const snapshot = snapshotInputs(inputs) as ImmutableCreationDefaultInputs<Inputs>;
  const run = (context: CreationDefaultContext): A | undefined =>
    get(snapshot, context);
  Object.defineProperty(run, CREATION_DEFAULT_IDENTITY, {
    value: Object.freeze({
      inputs: snapshot,
      source: Function.prototype.toString.call(get),
    }),
    enumerable: false,
  });
  return Object.freeze(run) as CreationDefault<A>;
};

/** @internal Immutable identity retained on a declared default. */
export const creationDefaultIdentityOf = (
  get: CreationDefault<unknown>,
): CreationDefaultIdentity | undefined =>
  get[CREATION_DEFAULT_IDENTITY];

/**
 * Field options. Cardinality, uniqueness and ownership live on
 * {@link Field.many} / {@link Field.unique} / {@link Field.owned} — annotating
 * a shared bag cannot erase them.
 *
 * `valueType` is not an option: brand the schema with
 * {@link import("./valueTypes.ts").stored}.
 */
export interface FieldOptions<A = unknown> {
  readonly index?: boolean;
  readonly doc?: string;
  /**
   * Omitted at create; `| undefined` on the default row. Card-many is
   * already trivially satisfiable (empty set) and is never a required key.
   *
   * This is one of two sources of {@link Field.isOptional}. The other is
   * the Effect schema AST: `Field(Schema.UndefinedOr(Schema.String))` is
   * silently optional even when this flag is absent. Say `optional: true`
   * explicitly if you mean it — a schema refactor that admits `undefined`
   * flips requiredness without touching this bag. Fail-closed rejection of
   * that inference is #185's doctrine and is not applied here.
   */
  readonly optional?: boolean;
  /**
   * Pure creation-time default. It is resolved only by the authoritative
   * creation boundary; update and the existing branch of an upsert ignore it.
   */
  readonly default?: CreationDefault<A>;
}

type FieldFlags = {
  readonly cardinality?: Cardinality;
  readonly unique?: Uniqueness | undefined;
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

type HasDefaultOf<O> = Named<O, "default">;
type MergeDefault<Def extends boolean, O> = Named<O, "default"> extends true
  ? true
  : Def;
type ValidDefault<O, A> = O extends {
  readonly default: (...args: infer _Args) => infer D;
}
  ? Exclude<D, undefined> extends A
    ? unknown
    : { readonly "default must return the field value type": true }
  : unknown;

type FieldDefaultValue<S extends SchemaNS.Top, Card extends Cardinality> =
  Card extends "many"
    ? readonly SchemaNS.Schema.Type<S>[]
    : SchemaNS.Schema.Type<S>;

type ValidManyConversion<
  Card extends Cardinality,
  Def extends boolean,
  O = undefined,
> = Card extends "many"
  ? unknown
  : Def extends true
    ? O extends { readonly default: CreationDefault<readonly unknown[]> }
      ? unknown
      : {
        readonly "Field.many(defaultedField) requires a new array default": true;
      }
    : unknown;

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
  Def extends boolean = false,
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
   * Presence flag for required-at-transact. True when `{ optional: true }`
   * **or** the Effect schema AST admits `undefined` (see
   * {@link FieldOptions.optional}). Not named `optional` — that getter is
   * the pull-shaping method on a stamped field. A sixth type parameter so
   * `string({ optional: true })` survives `Entity` stamping the way
   * `owned` / `cardinality` do.
   */
  readonly isOptional: Opt;
  /** Present when declared in the field options. */
  readonly default: Def extends true
    ? CreationDefault<FieldDefaultValue<S, Card>>
    : undefined;
}

export type AnyField = Field<
  SchemaNS.Top,
  Cardinality,
  Uniqueness | undefined,
  DbValueType | undefined,
  boolean,
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
  options?: FieldOptions<unknown>,
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
    default: options?.default,
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
  extra?: FieldOptions<unknown>,
): FieldOptions<unknown> => {
  rejectRetiredOptions(extra);
  if (!isField(input)) return extra ?? {};
  const doc = extra?.doc ?? input.doc;
  const defaultValue = extra?.default ?? input.default;
  return {
    index: extra?.index ?? input.index,
    ...(doc !== undefined && { doc }),
    optional: extra?.optional ?? input.isOptional,
    ...(defaultValue !== undefined && { default: defaultValue }),
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
  options?: FieldOptions<unknown>,
  flags?: FieldFlags,
): AnyField =>
  makeField(fieldSchema(input), mergeFieldOptions(input, options), mergeFlags(input, flags));

const applyManyField = (
  input: AnyField | SchemaNS.Top,
  options?: FieldOptions<unknown>,
): AnyField => {
  if (
    isField(input) &&
    input.cardinality !== "many" &&
    input.default !== undefined &&
    options?.default === undefined
  ) {
    throw new Error(
      "ramose/schema: Field.many(defaultedField) requires a new array default",
    );
  }
  return applyField(input, options, { cardinality: "many" });
};

type FieldMany = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, readonly SchemaNS.Schema.Type<S>[]>,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def> & ValidManyConversion<C, Def>,
  ): Field<S, "many", U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, readonly SchemaNS.Schema.Type<S>[]> &
      ValidManyConversion<C, Def, O>,
  ): Field<S, "many", U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
};

type FieldUnique = {
  <S extends SchemaNS.Top, const U extends Uniqueness>(
    schema: InferableSchema<S>,
    uniqueness: U,
  ): Field<S, "one", U, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const U extends Uniqueness, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    uniqueness: U,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", U, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const U extends Uniqueness>(
    field: Field<S, C, _U, VT, Own, Opt, Def>,
    uniqueness: U,
  ): Field<S, C, U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const U extends Uniqueness, const O extends FieldOptions>(
    field: Field<S, C, _U, VT, Own, Opt, Def>,
    uniqueness: U,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
};

type FieldOwned = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
  ): Field<S, C, U, VT, true, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, true, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
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
 *
 * Runtime `isOptional` has a second source: an Effect schema AST that
 * admits `undefined`. `{ optional: true }` is the documented flag;
 * `Field(Schema.UndefinedOr(Schema.String))` is also optional. The
 * inference is not fail-closed here (#185).
 * `Field.unique` always indexes; `Field.unique(string({ index: false }), "upsert")`
 * discards `index: false` (unique implies index).
 */
export const Field: {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
  ): Field<S, C, U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
  readonly many: FieldMany;
  readonly unique: FieldUnique;
  readonly owned: FieldOwned;
} = Object.assign(
  ((input: SchemaNS.Top | AnyField, options?: FieldOptions<unknown>) =>
    applyField(input, options)) as {
    <S extends SchemaNS.Top>(
      schema: InferableSchema<S>,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, false, false>;
    <S extends SchemaNS.Top, const O extends FieldOptions>(
      schema: InferableSchema<S>,
      options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
      field: Field<S, C, U, VT, Own, Opt, Def>,
    ): Field<S, C, U, VT, Own, Opt, Def>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
      field: Field<S, C, U, VT, Own, Opt, Def>,
      options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
    ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
  },
  {
    many: ((input: AnyField | SchemaNS.Top, options?: FieldOptions) =>
      applyManyField(input, options)) as FieldMany,
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
  (): Field<S, "one", undefined, VT, false, false, false>;
  <const O extends FieldOptions>(
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, VT, false, OptionalOf<O>, HasDefaultOf<O>>;
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

/**
 * Floating-point number. Stored as `:db.type/double`.
 *
 * `Finite`, not `Number`: the wire format is JSON, where `Infinity` and `NaN`
 * serialize to `null`, so a non-finite value could never round-trip. Rejecting
 * it at the schema fails loudly instead of silently storing `null`.
 */
export const float: Shorthand<typeof Schema.Finite, "double"> = shorthand(
  Schema.Finite,
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
  false,
  false
> & { readonly members: L };

type EnumFieldOpts<
  L extends readonly [string, ...string[]],
  O extends FieldOptions<L[number]>,
> = Field<
  ReturnType<typeof enumSchema<L>>,
  "one",
  undefined,
  "string",
  false,
  OptionalOf<O>,
  HasDefaultOf<O>
> & { readonly members: L };

/**
 * Closed string set. Stored as `:db.type/string`. `Enum(["low", "med"])`
 * types the field as `"low" | "med"` and carries the members on the
 * field (`Issue.status.members`) so the UI does not restate the list.
 */
export const Enum: {
  <const L extends readonly [string, ...string[]]>(values: L): EnumField<L>;
  <const L extends readonly [string, ...string[]], const O extends FieldOptions<L[number]>>(
    values: L,
    options: O & ValidDefault<O, L[number]>,
  ): EnumFieldOpts<L, O>;
} = ((values: readonly [string, ...string[]], options?: FieldOptions<string>) =>
  makeField(enumSchema(values), options)) as typeof Enum;

type EntityLike = { readonly fields: object; readonly ns: string };

type RefShorthand = {
  <const N extends EntityLike>(
    target: N,
  ): Field<TargetedRef<N["fields"], N["ns"], N>, "one", undefined, "ref", false, false, false>;
  <const N extends EntityLike>(
    target: () => N,
  ): Field<TargetedRef<N["fields"], N["ns"], N>, "one", undefined, "ref", false, false, false>;
  <const N extends EntityLike, const O extends FieldOptions<number>>(
    target: N,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<TargetedRef<N["fields"], N["ns"], N>>>,
  ): Field<
    TargetedRef<N["fields"], N["ns"], N>,
    "one",
    undefined,
    "ref",
    false,
    OptionalOf<O>,
    HasDefaultOf<O>
  >;
  <const N extends EntityLike, const O extends FieldOptions<number>>(
    target: () => N,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<TargetedRef<N["fields"], N["ns"], N>>>,
  ): Field<
    TargetedRef<N["fields"], N["ns"], N>,
    "one",
    undefined,
    "ref",
    false,
    OptionalOf<O>,
    HasDefaultOf<O>
  >;
  readonly self: Field<
    TargetedRef<SelfMarker>,
    "one",
    undefined,
    "ref",
    false,
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
    options?: FieldOptions<number>,
  ) => makeField(refSchema(target as EntityLike & (() => EntityLike)), options)) as RefShorthand,
  untargetedRef,
  {
    self: makeField(refSchema.self) as Field<
      TargetedRef<SelfMarker>,
      "one",
      undefined,
      "ref",
      false,
      false,
      false
    >,
  },
);
rememberValueType(Ref, "ref");
