/** Composition of namespaces; the typed client's type parameter. */

import type { AnyNamespace, Namespace } from "./Namespace.ts";

export type NamespaceMap = Record<string, AnyNamespace>;

export interface Catalog<Ns extends NamespaceMap = NamespaceMap> {
  readonly _tag: "Catalog";
  readonly namespaces: Ns;
}

/** @internal The public spelling is {@link Catalog.Any}. */
export type AnyCatalog = Catalog<NamespaceMap>;

/** Compose namespaces into a catalog. Address attrs via `User.name`. */
export const Catalog = <const Ns extends NamespaceMap>(
  namespaces: Ns,
): Catalog<Ns> => ({
  _tag: "Catalog",
  namespaces,
});

export declare namespace Catalog {
  /** Any catalog — the bound for catalog-generic helpers. */
  export type Any = Catalog<NamespaceMap>;
}

/** Concatenate catalogs. Later keys win on collision. */
export const merge = <const A extends NamespaceMap, const B extends NamespaceMap>(
  left: Catalog<A>,
  right: Catalog<B>,
): Catalog<A & B> => ({
  _tag: "Catalog",
  namespaces: { ...left.namespaces, ...right.namespaces },
});

export type NamespaceOf<
  C extends AnyCatalog,
  K extends keyof C["namespaces"],
> = C["namespaces"][K];

