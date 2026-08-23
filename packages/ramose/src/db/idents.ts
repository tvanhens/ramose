/** Ident derivation (`:ns/attr`) and value-type lookup against a catalog. */

import type { ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";

export type Ident<Ns extends string, Attr extends string> = `:${Ns}/${Attr}`;

/**
 * Every ident in a catalog, as a union of string literals.
 * `CatalogIdent<typeof Movies>` → `":user/name" | ":movie/title" | …`
 */
export type CatalogIdent<C extends AnySchema> = {
  [K in keyof C["entities"]]: {
    [A in keyof C["entities"][K]["fields"] & string]: Ident<
      C["entities"][K]["ns"],
      A
    >;
  }[keyof C["entities"][K]["fields"] & string];
}[keyof C["entities"]];

/**
 * The attribute at ident `I`. `never` when the ident is not in the catalog
 * — that is what turns an unknown attr into a type error.
 */
export type AttrAtIdent<C extends AnySchema, I extends string> = {
  [K in keyof C["entities"]]: {
    [A in keyof C["entities"][K]["fields"] & string]: Ident<
      C["entities"][K]["ns"],
      A
    > extends I
      ? C["entities"][K]["fields"][A]
      : never;
  }[keyof C["entities"][K]["fields"] & string];
}[keyof C["entities"]];

export type ValueAtIdent<C extends AnySchema, I extends string> = ValueOf<
  AttrAtIdent<C, I>
>;

export type CardAtIdent<C extends AnySchema, I extends string> =
  AttrAtIdent<C, I>["cardinality"];

/**
 * Write value for an ident: a single decoded Schema type, or a readonly
 * array of them when the attribute is cardinality-many.
 *
 * List-form `:db/add` always takes one value (one datom), even for many.
 */
export type WriteAtIdent<C extends AnySchema, I extends string> =
  CardAtIdent<C, I> extends "many"
    ? ReadonlyArray<ValueAtIdent<C, I>>
    : ValueAtIdent<C, I>;

export type ReadAtIdent<C extends AnySchema, I extends string> =
  WriteAtIdent<C, I>;

/**
 * `[attr, value]` on a unique attribute — the other way to name an entity.
 *
 * Both spellings of the head are the same lookup: the attr ref you already
 * have (`[User.name, "Ada"]`) or its ident (`[":user/name", "Ada"]`). The
 * wire form is the ident either way (`lowerSubject` in `Db.ts`,
 * `resolveEntity` in `Tx.ts`).
 */
export type LookupRef<C extends AnySchema> = {
  [I in CatalogIdent<C>]: AttrAtIdent<C, I>["unique"] extends undefined
    ? never
    :
        | readonly [I, ValueAtIdent<C, I>]
        | readonly [{ readonly ident: I }, ValueAtIdent<C, I>];
}[CatalogIdent<C>];

/** eid | tempid/ident string | typed lookup ref. */
export type EntityRef<C extends AnySchema> = number | string | LookupRef<C>;
