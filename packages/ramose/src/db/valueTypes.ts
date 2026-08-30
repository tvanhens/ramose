import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";
import { isComposer } from "./Composer.ts";

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

export type RamoseVt<VT extends DbValueType> = {
  readonly [RamoseVt]: VT;
};

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

type PairableType<S extends Schema.Top, VT extends DbValueType> =
  Exclude<Schema.Schema.Type<S>, null | undefined> extends JsOfVt<VT>
    ? S
    : S & {
        readonly "stored(schema, vt): this Schema's Type does not match the value type": true;
      };

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

export type TargetedRef<
  TargetFields extends object = object,
  Ns extends string = string,
  Target = unknown,
> = Schema.Schema<number> & {
  readonly [RefTarget]?: TargetFields;
  readonly _resolve?: () => { readonly fields: TargetFields; readonly ns: Ns };
  readonly _self?: boolean;
  readonly _target?: Target;
} & RamoseVt<"ref">;

export type SelfMarker = { readonly [SelfRef]: true };

type EntityLike = {
  readonly _tag?: "Entity" | "Trait";
  readonly fields: object;
  readonly ns: string;
};

const resolveRefTarget = <const N extends EntityLike>(
  target: N | (() => N),
): (() => N) => isComposer(target)
  ? () => target as N
  : target as () => N;

type RefFn = {
  <const N extends EntityLike>(
    target: N,
  ): TargetedRef<N["fields"], N["ns"], N>;
  <const N extends EntityLike>(
    target: () => N,
  ): TargetedRef<N["fields"], N["ns"], N>;
  readonly self: TargetedRef<SelfMarker>;
} & RamoseVt<"ref">;

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
):
  | (() => {
      readonly _tag?: "Entity" | "Trait";
      readonly fields: object;
      readonly ns?: string;
    })
  | undefined => {
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
      ...((target as { readonly _tag?: "Entity" | "Trait" })._tag !== undefined
        ? { _tag: (target as { readonly _tag: "Entity" | "Trait" })._tag }
        : {}),
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
