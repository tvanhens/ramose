/** Public value-type names (`"string"`) and Effect Schema helpers that lower onto `:db.type/*`. */

import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";

export type DbValueType =
  | "string"
  | "long"
  | "double"
  | "boolean"
  | "ref"
  | "uuid"
  | "instant"
  | "bytes";

export const toWireValueType = (vt: DbValueType): `:db.type/${DbValueType}` =>
  `:db.type/${vt}`;

declare const RamoseVt: unique symbol;
declare const RefTarget: unique symbol;
declare const SelfRef: unique symbol;

/** Type-level brand so `Field(Long)` stamps `valueType` without an option. */
export type RamoseVt<VT extends DbValueType> = {
  readonly [RamoseVt]: VT;
};

/**
 * `:db.type/*` inferred from a value Schema, as a public name. Helper brands
 * win; then the AST tag of the common primitives (`String` / `Number` /
 * `Boolean`). Anything else — literals, unions, structs, refinements — is
 * `undefined` (wrap with {@link stored}, or use {@link enumSchema} /
 * `Enum` for a string-literal set). Mirrors {@link tryInferDbValueType}:
 * unknown shapes do not silently become the wrong value type.
 */
export type InferDbValueType<S> = S extends RamoseVt<infer V>
  ? V
  : S extends { readonly ast: { readonly _tag: infer Tag } }
    ? Tag extends "String"
      ? "string"
      : Tag extends "Number"
        ? "double"
        : Tag extends "Boolean"
          ? "boolean"
          : undefined
    : undefined;

const known = new WeakMap<object, DbValueType>();

const asVt = <S extends Schema.Top, const VT extends DbValueType>(
  schema: S,
  vt: VT,
): S & RamoseVt<VT> => {
  known.set(schema, vt);
  return schema as S & RamoseVt<VT>;
};

/**
 * JS type a value type stores. Pairing is decoded-Type only — not
 * encoded-side AST inference (a refinement over {@link Long} would
 * silently look like `"double"`).
 */
type JsOfVt<VT extends DbValueType> = VT extends "string" | "uuid"
  ? string
  : VT extends "long" | "double" | "ref"
    ? number
    : VT extends "boolean"
      ? boolean
      : VT extends "instant"
        ? Date
        : VT extends "bytes"
          ? Uint8Array
          : never;

/**
 * Type↔vt pairing, as a brand-key error instead of `never`.
 * `Schema.optional(String)` with `"string"` is fine; `Schema.Boolean`
 * with `"string"` is not.
 */
type PairableType<S extends Schema.Top, VT extends DbValueType> =
  Exclude<Schema.Schema.Type<S>, null | undefined> extends JsOfVt<VT>
    ? S
    : S & {
        readonly "stored(schema, vt): this Schema's Type does not match the value type": true;
      };

/**
 * Accept a matching Type↔vt pair; reject a schema already branded
 * with a *different* vt. Re-branding (`stored(Uuid, "string")`)
 * intersects the two `RamoseVt` keys (`"uuid" & "string"` → `never`),
 * which collapses the field to `Field<never, …>` and types its row
 * cell as a ref while runtime still installs the requested vt.
 * Same-vt re-brands (`stored(Uuid, "uuid")`) are a no-op.
 */
type PairableSchema<S extends Schema.Top, VT extends DbValueType> =
  S extends RamoseVt<infer V>
    ? [V, VT] extends [VT, V]
      ? PairableType<S, VT>
      : S & {
          readonly "stored(schema, vt): already branded — pass the unbranded Schema": true;
        }
    : PairableType<S, VT>;

/**
 * Brand a raw Effect Schema with its storage form so {@link Field} can
 * infer `:db.type/*`. The advanced-form hatch — `valueType` is not a
 * field option.
 *
 * ```ts
 * Field(stored(Schema.Literals(["on", "off"]), "string"))
 * Field(stored(Schema.String, "uuid"))
 * ```
 *
 * The pair is checked: `"instant"` needs a `Date`-typed schema,
 * `"string"` / `"uuid"` a string-typed one, and so on. A mismatch
 * (`stored(Schema.Boolean, "string")`) is a type error. An already
 * branded helper (`Uuid`, `Long`, a previous `stored`) may only
 * re-brand with the same vt — pass the unbranded Schema to change it.
 */
export const stored = <S extends Schema.Top, const VT extends DbValueType>(
  schema: PairableSchema<S, VT>,
  vt: VT,
): S & RamoseVt<VT> =>
  asVt(
    // A new object: branding `Schema.String` must not rewrite every string field.
    (schema as S).annotate({ identifier: `ramose/stored/${vt}` }) as S,
    vt,
  );

/**
 * UUID as a canonical string. Lowers to `:db.type/uuid`. The `{ vt: 6, v }`
 * tagged form is wire-internal — the public type is `string`.
 */
export const Uuid = asVt(
  Schema.String.annotate({ identifier: "ramose/uuid" }),
  "uuid",
);
export type Uuid = Schema.Schema.Type<typeof Uuid>;

/** Targeted ref schema — carries the target entity's field map. */
export type TargetedRef<
  TargetFields extends object = object,
  Ns extends string = string,
  Target = unknown,
> = Schema.Schema<number> & {
  readonly [RefTarget]?: TargetFields;
  readonly _resolve?: () => { readonly fields: TargetFields; readonly ns: Ns };
  readonly _self?: boolean;
  /**
   * Phantom: the entity `Ref(User)` was declared against. Brands
   * `{ id: Eid<User> }` on a default fluent row. Never at runtime.
   */
  readonly _target?: Target;
} & RamoseVt<"ref">;

export type SelfMarker = { readonly [SelfRef]: true };

type EntityLike = { readonly fields: object; readonly ns: string };

const resolveRefTarget = <const N extends EntityLike>(
  target: N | (() => N),
): (() => N) => (typeof target === "function" ? target : () => target);

type RefFn = {
  /**
   * Targeted ref. Prefer the entity itself (`Ref(User)`); pass a thunk only
   * when the target is declared later (`Ref(() => Other)`).
   */
  <const N extends EntityLike>(
    target: N | (() => N),
  ): TargetedRef<N["fields"], N["ns"], N>;
  /** Self-ref; `Entity` substitutes the enclosing field map. */
  readonly self: TargetedRef<SelfMarker>;
} & RamoseVt<"ref">;

/**
 * Entity reference. `Ref(User)` (eager) or `Ref(() => User)` (thunk, for
 * cycles) so navigational paths (`Todo.owner.name`) have a target.
 */
/** Untargeted ref — the branded schema `Field(Ref)` / `Field(Ramose.Ref)` uses. */
export const untargetedRef = asVt(
  Schema.Finite.annotate({ identifier: "ramose/ref" }),
  "ref",
);

export const Ref: RefFn = Object.assign(
  <const N extends EntityLike>(
    target: N | (() => N),
  ): TargetedRef<N["fields"], N["ns"], N> =>
    Object.assign(asVt(Schema.Finite.annotate({ identifier: "ramose/ref" }), "ref"), {
      _resolve: resolveRefTarget(target),
    }) as TargetedRef<N["fields"], N["ns"], N>,
  {
    self: Object.assign(
      asVt(
        Schema.Finite.annotate({ identifier: "ramose/ref-self" }),
        "ref",
      ),
      { _self: true as const },
    ) as TargetedRef<SelfMarker>,
  },
) as RefFn;

known.set(Ref, "ref");
known.set(Ref.self, "ref");

/**
 * Stamp a schema object so {@link tryInferDbValueType} sees it. The
 * public hatch is {@link stored}; this remains for non-schema objects
 * (`Field`'s `Ref` function).
 */
export const rememberValueType = (
  schema: object,
  vt: DbValueType,
): void => {
  known.set(schema, vt);
};

export type Ref = number;

export const isSelfRefSchema = (schema: unknown): boolean =>
  (typeof schema === "object" || typeof schema === "function") &&
  schema !== null &&
  (schema as { _self?: boolean })._self === true;

export const refTargetOf = (
  schema: unknown,
): (() => { readonly fields: object; readonly ns?: string }) | undefined => {
  // Effect Schemas are often functions (`typeof` !== "object").
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) {
    return undefined;
  }
  const resolve = (schema as {
    _resolve?: () => { readonly fields?: object; readonly ns?: string };
  })._resolve;
  if (resolve === undefined) return undefined;
  return () => {
    const target = resolve();
    return {
      fields: target.fields ?? {},
      ...(target.ns !== undefined && { ns: target.ns }),
    };
  };
};

/** Integer long. Lowers to `:db.type/long` (plain `Schema.Number` is double). */
export const Long = asVt(
  Schema.Finite.annotate({ identifier: "ramose/long" }),
  "long",
);
export type Long = Schema.Schema.Type<typeof Long>;

/** Instant. Lowers to `:db.type/instant`. */
export const Instant = asVt(
  Schema.Date.annotate({ identifier: "ramose/instant" }),
  "instant",
);
export type Instant = Schema.Schema.Type<typeof Instant>;

/** Byte array. Lowers to `:db.type/bytes`. */
export const Bytes = asVt(
  Schema.Uint8Array.annotate({ identifier: "ramose/bytes" }),
  "bytes",
);
export type Bytes = Schema.Schema.Type<typeof Bytes>;

const enumMembers = new WeakMap<object, readonly [string, ...string[]]>();

/**
 * String-literal union branded as `:db.type/string`. Used by
 * {@link import("./Field.ts").Enum}.
 */
export const enumSchema = <
  const L extends readonly [string, ...string[]],
>(
  values: L,
): Schema.Literals<L> & RamoseVt<"string"> => {
  if (values.length === 0) {
    throw new Error("ramose/schema: Enum([...]) needs at least one value");
  }
  const schema = asVt(Schema.Literals(values), "string");
  enumMembers.set(schema, values);
  return schema;
};

/** Closed-set members attached by {@link enumSchema}, if any. */
export const enumMembersOf = (
  schema: object,
): readonly [string, ...string[]] | undefined => enumMembers.get(schema);

export const tryInferDbValueType = (
  schema: SchemaNS.Top,
  override?: DbValueType,
): DbValueType | undefined => {
  if (override !== undefined) return override;
  const mapped = known.get(schema);
  if (mapped !== undefined) return mapped;
  switch (schema.ast._tag) {
    case "String":
      return "string";
    case "Number":
      return "double";
    case "Boolean":
      return "boolean";
    default:
      return undefined;
  }
};

/**
 * Pick the public value-type name for a value Schema. An explicit
 * override (the field's already-resolved `valueType`) wins; then the
 * helpers above; then the AST tag of the common primitives. Anything
 * else must be wrapped with {@link stored}.
 */
export const inferDbValueType = (
  schema: SchemaNS.Top,
  override?: DbValueType,
): DbValueType => {
  const vt = tryInferDbValueType(schema, override);
  if (vt !== undefined) return vt;
  throw new Error(
    `ramose/schema: cannot infer value type from this Schema (ast._tag=${schema.ast._tag}). Wrap it with stored(schema, vt).`,
  );
};
