/** The eight `:db.type/*` idents and Effect Schema helpers that lower onto them. */

import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";

export type DbValueType =
  | ":db.type/string"
  | ":db.type/long"
  | ":db.type/double"
  | ":db.type/boolean"
  | ":db.type/ref"
  | ":db.type/uuid"
  | ":db.type/instant"
  | ":db.type/bytes";

declare const RamoseVt: unique symbol;
declare const RefTarget: unique symbol;
declare const SelfRef: unique symbol;

/** Type-level brand so `Attr(Long)` stamps `valueType` without an option. */
export type RamoseVt<VT extends DbValueType> = {
  readonly [RamoseVt]: VT;
};

/**
 * `:db.type/*` inferred from a value Schema. Helper brands win; then
 * decoded `string` / `number` / `boolean` → string / double / boolean.
 * Anything else is `undefined` (pass `valueType` on `Attr`).
 */
export type InferDbValueType<S> = S extends RamoseVt<infer V>
  ? V
  : S extends { readonly Type: infer T }
    ? [T] extends [string]
      ? ":db.type/string"
      : [T] extends [number]
        ? ":db.type/double"
        : [T] extends [boolean]
          ? ":db.type/boolean"
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

/** Uuid as the engine currently reads it: `{ vt: 6, v: "…" }`, not a string. */
export const Uuid = asVt(
  Schema.Struct({
    vt: Schema.Literal(6),
    v: Schema.String,
  }),
  ":db.type/uuid",
);
export type Uuid = Schema.Schema.Type<typeof Uuid>;

/** Write-side uuid: a canonical string. Lowers to `:db.type/uuid`. */
export const UuidString = asVt(
  Schema.String.annotate({ identifier: "ramose/uuid-string" }),
  ":db.type/uuid",
);
export type UuidString = Schema.Schema.Type<typeof UuidString>;

/** Untargeted entity reference (eid). Prefer {@link Ref} with a target. */
const RefUntargeted = asVt(
  Schema.Number.annotate({ identifier: "ramose/ref" }),
  ":db.type/ref",
);

export type SelfMarker = { readonly [SelfRef]: true };

/** Targeted ref schema — carries the target namespace's attribute map. */
export type TargetedRef<TargetAttrs extends object = object> =
  typeof RefUntargeted & {
    readonly [RefTarget]?: TargetAttrs;
    readonly _resolve?: () => { readonly attributes: TargetAttrs };
    readonly _self?: boolean;
  };

type RefFn = {
  /** Untargeted ref (legacy). Prefer `Ref(() => User)` / `Ref.self`. */
  (schema?: undefined): typeof RefUntargeted;
  /** Targeted ref: `Attr(Ref(() => User))`. */
  <const N extends { readonly attributes: object }>(
    target: () => N,
  ): TargetedRef<N["attributes"]>;
  /** Self-ref; `Namespace` substitutes the enclosing attr map. */
  readonly self: TargetedRef<SelfMarker>;
} & typeof RefUntargeted &
  RamoseVt<":db.type/ref">;

/**
 * Entity reference. Use `Ref(() => User)` or `Ref.self` so navigational
 * paths (`Todo.owner.name`) have a target. Bare `Ref` remains an untargeted
 * branded schema for back-compat.
 */
export const Ref: RefFn = Object.assign(
  <const N extends { readonly attributes: object }>(
    target?: () => N,
  ): TargetedRef<N["attributes"]> | typeof RefUntargeted => {
    if (target === undefined) return RefUntargeted;
    const schema = asVt(
      Schema.Number.annotate({ identifier: "ramose/ref" }),
      ":db.type/ref",
    );
    return Object.assign(schema, {
      _resolve: target,
    }) as TargetedRef<N["attributes"]>;
  },
  RefUntargeted,
  {
    self: Object.assign(
      asVt(
        Schema.Number.annotate({ identifier: "ramose/ref-self" }),
        ":db.type/ref",
      ),
      { _self: true as const },
    ) as TargetedRef<SelfMarker>,
  },
) as RefFn;

// `Attr(Ref)` passes the callable; WeakMap brands must key the function too.
known.set(Ref, ":db.type/ref");
known.set(Ref.self, ":db.type/ref");

export type Ref = Schema.Schema.Type<typeof RefUntargeted>;

export const isSelfRefSchema = (schema: unknown): boolean =>
  (typeof schema === "object" || typeof schema === "function") &&
  schema !== null &&
  (schema as { _self?: boolean })._self === true;

export const refTargetOf = (
  schema: unknown,
): (() => { readonly attributes: object }) | undefined => {
  // Effect Schemas are often functions (`typeof` !== "object").
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) {
    return undefined;
  }
  return (schema as { _resolve?: () => { readonly attributes: object } })
    ._resolve;
};

/** Integer long. Lowers to `:db.type/long` (plain `Schema.Number` is double). */
export const Long = asVt(
  Schema.Number.annotate({ identifier: "ramose/long" }),
  ":db.type/long",
);
export type Long = Schema.Schema.Type<typeof Long>;

/** Instant. Lowers to `:db.type/instant`. */
export const Instant = asVt(
  Schema.Date.annotate({ identifier: "ramose/instant" }),
  ":db.type/instant",
);
export type Instant = Schema.Schema.Type<typeof Instant>;

/** Byte array. Lowers to `:db.type/bytes`. */
export const Bytes = asVt(
  Schema.Uint8Array.annotate({ identifier: "ramose/bytes" }),
  ":db.type/bytes",
);
export type Bytes = Schema.Schema.Type<typeof Bytes>;

export const tryInferDbValueType = (
  schema: SchemaNS.Top,
  override?: DbValueType,
): DbValueType | undefined => {
  if (override !== undefined) return override;
  const mapped = known.get(schema);
  if (mapped !== undefined) return mapped;
  switch (schema.ast._tag) {
    case "String":
      return ":db.type/string";
    case "Number":
      return ":db.type/double";
    case "Boolean":
      return ":db.type/boolean";
    default:
      return undefined;
  }
};

/**
 * Pick the `:db.type/*` ident for a value Schema. Explicit
 * `options.valueType` on the attribute wins; then the helpers above; then
 * the AST tag of the common primitives. Anything else must set `valueType`.
 */
export const inferDbValueType = (
  schema: SchemaNS.Top,
  override?: DbValueType,
): DbValueType => {
  const vt = tryInferDbValueType(schema, override);
  if (vt !== undefined) return vt;
  throw new Error(
    `ramose/schema: cannot infer :db.type/* from this Schema (ast._tag=${schema.ast._tag}). Pass valueType on the attribute.`,
  );
};
