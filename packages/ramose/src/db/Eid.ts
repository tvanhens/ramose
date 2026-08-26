/**
 * An entity id, as data.
 *
 * One shape: a branded number. Valid as a React key, a write subject, and a
 * `db.pull` subject with no cast. The brand is a phantom — the value stays
 * a plain number.
 *
 * `Eid<N>` over a **namespace** is the cell `select({ id: N.id })` yields.
 * A `User` id is not a `Todo` id, and a bare `number` is not a cell.
 *
 * `Eid<C>` over a **catalog** is the union of `Eid<N>` for every namespace
 * in `C` (same as {@link SchemaEid}). Transaction eids and
 * `principal().eid` use this.
 */

import type { AnySchema } from "./Schema.ts";
import type { AnyEntity, AnyQueryRoot } from "./Entity.ts";

/**
 * Namespace-branded cell: the raw id the peer answered, typed as belonging
 * to `N`. Required `_ns` — an optional brand would let any bare `number`
 * pass for a cell.
 */
export type NamespaceEid<N extends AnyQueryRoot> = number & {
  readonly _ns: N;
};

/** Traits reachable from `C`'s entities, walking `traits` transitively. */
type NestedTraits<T> = T extends { readonly _tag: "Trait" }
  ? T | (T extends { readonly traits: readonly (infer Inner)[] } ? NestedTraits<Inner> : never)
  : never;

export type CatalogTrait<C extends AnySchema> = {
  [K in keyof C["entities"]]: C["entities"][K] extends {
    readonly traits: readonly (infer T)[];
  }
    ? NestedTraits<T>
    : never;
}[keyof C["entities"]];

/** Entity and trait roots a catalog's rows can name. */
export type CatalogQueryRoot<C extends AnySchema> =
  | (C["entities"][keyof C["entities"]] & AnyEntity)
  | CatalogTrait<C>;

type SchemaEidOf<N> = N extends AnyQueryRoot ? NamespaceEid<N> : never;

/**
 * The namespace-branded cells a catalog's rows can carry: `Eid<N>` for every
 * entity and reachable trait in `C`. A `select({ id: N.id })` cell is a
 * `db.pull` subject with no cast; another catalog's cells stay out.
 */
export type SchemaEid<C extends AnySchema> = SchemaEidOf<CatalogQueryRoot<C>>;

export type Eid<S extends AnySchema | AnyQueryRoot = AnyEntity> = [S] extends [
  AnyQueryRoot,
]
  ? NamespaceEid<S>
  : SchemaEid<Extract<S, AnySchema>>;

/** @internal Query rows and reports brand raw ids with this. */
export const makeEid = <S extends AnySchema | AnyQueryRoot>(id: number): Eid<S> =>
  id as Eid<S>;
