/**
 * One side of a `:ns/attr` ident — entity names and field keys.
 * Letter, then up to 63 letters / digits / `_` / `-` (64 characters total).
 */
export const IDENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Whether `name` is a valid entity name or field key ({@link IDENT_NAME_RE}). */
export const isIdentName = (name: string): boolean => IDENT_NAME_RE.test(name);

/**
 * Keys `Entity()` / `Trait()` stamp onto the record-type object. A user
 * field of the same name would overwrite metadata (`id` → every
 * `select({ id: N.id })` reads a string; `ns` → `install()` emits
 * `:[object Object]/id`; `traits` → composition is lost).
 */
export const RESERVED_FIELD_KEYS = [
  "id",
  "ns",
  "fields",
  "_tag",
  "traits",
] as const;

export type ReservedFieldKey = (typeof RESERVED_FIELD_KEYS)[number];

const RESERVED = new Set<string>(RESERVED_FIELD_KEYS);

/** Whether `name` is {@link Entity} metadata and cannot be a field key. */
export const isReservedFieldKey = (name: string): name is ReservedFieldKey =>
  RESERVED.has(name);

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Lower =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type Upper =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";
type Letter = Lower | Upper;
type IdentChar = Letter | Digit | "_" | "-";

type IsIdentRest<S extends string> = S extends ""
  ? true
  : S extends `${IdentChar}${infer Rest}`
    ? IsIdentRest<Rest>
    : false;

export type IsIdentName<S extends string> = string extends S
  ? true
  : S extends `${Letter}${infer Rest}`
    ? IsIdentRest<Rest>
    : false;

type NameError<S, Msg extends string> = S & {
  readonly [K in Msg]: true;
};

const IDENT_NAME_MSG =
  "invalid name — must match IDENT_NAME_RE" as const;
const RESERVED_FIELD_MSG =
  "reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata" as const;
const TRAIT_COLLISION_MSG = "conflicting flattened field names" as const;
const SCHEMA_KEY_MSG =
  "Schema key must equal the Entity name" as const;
const DUPLICATE_ENTITY_MSG = "duplicate entity name" as const;

export type ValidIdentName<S extends string> =
  IsIdentName<S> extends true ? S : NameError<S, typeof IDENT_NAME_MSG>;

type ReservedIn<F> = Extract<keyof F, ReservedFieldKey>;
type BadNamedIn<F> = {
  [K in keyof F]: K extends string
    ? K extends ReservedFieldKey
      ? never
      : IsIdentName<K> extends true
        ? never
        : K
    : never;
}[keyof F];

export type ValidFieldMap<F> = [ReservedIn<F>] extends [never]
  ? [BadNamedIn<F>] extends [never]
    ? F
    : NameError<F, typeof IDENT_NAME_MSG>
  : NameError<F, typeof RESERVED_FIELD_MSG>;

type NsOf<E> = E extends { readonly ns: infer N extends string } ? N : never;

type KeyMatchesNs<K extends string, N extends string> = string extends N
  ? true
  : string extends K
    ? true
    : [K] extends [N]
      ? [N] extends [K]
        ? true
        : false
      : false;

export type ValidEntityMap<Es extends Record<string, { readonly ns: string }>> =
  {
    [K in keyof Es]: K extends string
      ? KeyMatchesNs<K, Es[K]["ns"]> extends true
        ? Es[K]
        : NameError<Es[K], typeof SCHEMA_KEY_MSG>
      : Es[K];
  };

type NsTuple<Es extends readonly { readonly ns: string }[]> = {
  [I in keyof Es]: NsOf<Es[I]>;
};

type HasDuplicate<
  T extends readonly unknown[],
  Seen extends PropertyKey = never,
> = T extends readonly [infer H, ...infer R]
  ? string extends H
    ? HasDuplicate<R, Seen>
    : H extends Seen
      ? true
      : H extends PropertyKey
        ? HasDuplicate<R, Seen | H>
        : HasDuplicate<R, Seen>
  : false;

export type ValidEntityList<Es extends readonly { readonly ns: string }[]> =
  HasDuplicate<NsTuple<Es>> extends true
    ? NameError<Es, typeof DUPLICATE_ENTITY_MSG>
    : Es;

export type EntitiesFromArray<
  Es extends readonly { readonly ns: string }[],
> = {
  [E in Es[number] as E["ns"] & string]: E;
};

type Overlap<A, B> = keyof A & keyof B;

export type ValidMerge<
  A extends Record<string, unknown>,
  B extends Record<string, unknown>,
> = string extends keyof A
  ? B
  : string extends keyof B
    ? B
    : [Overlap<A, B>] extends [never]
      ? B
      : NameError<B, typeof DUPLICATE_ENTITY_MSG>;

export const invalidIdentName = (
  kind: "entity" | "field" | "trait" | "operation",
  name: string,
): Error =>
  new Error(
    `ramose/schema: invalid ${kind} name ${JSON.stringify(name)} — must match ${IDENT_NAME_RE}`,
  );

export const reservedFieldName = (name: string): Error =>
  new Error(
    `ramose/schema: field name ${JSON.stringify(name)} is reserved — id, ns, fields, _tag, and traits are Entity / Trait metadata`,
  );

type FieldIdent<F> = F extends { readonly ident: infer I extends string }
  ? I
  : never;

type FieldCollision<K extends string> = {
  readonly [P in `conflicting flattened field ${K}`]: true;
};

type MergeFieldMaps<A, B> = [keyof A & keyof B] extends [never]
  ? A & B
  : {
      [K in keyof A | keyof B]: K extends keyof A
        ? K extends keyof B
          ? FieldIdent<A[K]> extends FieldIdent<B[K]>
            ? FieldIdent<B[K]> extends FieldIdent<A[K]>
              ? A[K]
              : FieldCollision<K & string>
            : FieldCollision<K & string>
          : A[K]
        : K extends keyof B
          ? B[K]
          : never;
    };

type NestedTraits<H> = H extends {
  readonly traits: infer T extends readonly unknown[];
}
  ? T
  : [];

export type FlattenedTraitFields<Traits extends readonly unknown[]> =
  Traits extends readonly [infer H, ...infer R]
    ? H extends { readonly fields: infer F extends object }
      ? MergeFieldMaps<
          MergeFieldMaps<F, FlattenedTraitFields<NestedTraits<H>>>,
          FlattenedTraitFields<R>
        >
      : FlattenedTraitFields<R>
    : {};

type CollisionBrandKey<T> = {
  [K in keyof T]: T[K] extends {
    readonly [P in `conflicting flattened field ${string}`]: true;
  }
    ? K
    : never;
}[keyof T];

type HasFieldCollision<T> = [CollisionBrandKey<T>] extends [never]
  ? false
  : true;

export type ValidTraitCompose<
  Fields,
  Traits extends readonly unknown[],
> = HasFieldCollision<
  MergeFieldMaps<Fields, FlattenedTraitFields<Traits>>
> extends true
  ? { readonly traits?: NameError<Traits, typeof TRAIT_COLLISION_MSG> }
  : unknown;

export const schemaKeyMismatch = (key: string, ns: string): Error =>
  new Error(
    `ramose/schema: Schema key ${JSON.stringify(key)} does not match Entity name ${JSON.stringify(ns)}`,
  );

export const duplicateEntityName = (ns: string): Error =>
  new Error(`ramose/schema: duplicate entity name ${JSON.stringify(ns)}`);

export const conflictingIdent = (ident: string): Error =>
  new Error(`ramose/schema: conflicting ident ${JSON.stringify(ident)}`);
