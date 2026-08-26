/** Ident derivation (`:ns/attr`) and value-type lookup against a catalog. */

import type { Eid } from "./Eid.ts";
import type { AnyEntity, AnyQueryRoot } from "./Entity.ts";
import type { Tempid } from "./entityArg.ts";
import type { ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import type { AnyTrait } from "./Trait.ts";

export type Ident<Ns extends string, Attr extends string> = `:${Ns}/${Attr}`;

/**
 * Stamped field ident when it is a literal (`:taggable/tag`); reconstruct
 * `:${ns}/${key}` when the ident is a wide `string` so `CatalogIdent<AnySchema>`
 * stays a template literal and does not collapse to `string`.
 */
export type IdentOfFieldIn<F, Ns extends string, A extends string> = F extends {
  readonly ident: infer I extends string;
}
  ? string extends I
    ? Ident<Ns, A>
    : I
  : Ident<Ns, A>;

/**
 * Every ident in a catalog, as a union of string literals.
 * `CatalogIdent<typeof Movies>` → `":user/name" | ":movie/title" | …`
 */
export type CatalogIdent<C extends AnySchema> = {
  [K in keyof C["entities"]]: {
    [A in keyof C["entities"][K]["fields"] & string]: IdentOfFieldIn<
      C["entities"][K]["fields"][A],
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
    [A in keyof C["entities"][K]["fields"] & string]: IdentOfFieldIn<
      C["entities"][K]["fields"][A],
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
 * Map-form `put` takes this shape — an array for many, omitted when
 * `undefined`.
 */
export type WriteAtIdent<C extends AnySchema, I extends string> =
  CardAtIdent<C, I> extends "many"
    ? ReadonlyArray<ValueAtIdent<C, I>>
    : ValueAtIdent<C, I>;

export type ReadAtIdent<C extends AnySchema, I extends string> =
  WriteAtIdent<C, I>;

/**
 * Entity-level write bag for `put`: each key is a field of `N`, typed
 * through {@link WriteAtIdent}. Cardinality-many is an array; a missing
 * or `undefined` key is omitted at runtime (not written as a nil datom).
 */
export type WriteAtEntity<C extends AnySchema, N extends { readonly ns: string; readonly fields: object }> = {
  [K in keyof N["fields"] & string]?:
    | WriteAtIdent<C, IdentOfFieldIn<N["fields"][K], N["ns"], K>>
    | undefined;
};

/**
 * `[attr, value]` on a unique attribute — the other way to name an entity.
 *
 * Both spellings of the head are the same lookup: the attr ref you already
 * have (`[User.name, "Ada"]`) or its ident (`[":user/name", "Ada"]`). The
 * wire form is the ident either way (`lowerEntityArg`).
 */
export type LookupRef<C extends AnySchema> = {
  [I in CatalogIdent<C>]: AttrAtIdent<C, I>["unique"] extends undefined
    ? never
    :
        | readonly [I, ValueAtIdent<C, I>]
        | readonly [{ readonly ident: I }, ValueAtIdent<C, I>];
}[CatalogIdent<C>];

/** Unique lookups whose ident is on `N` — own namespace or a flattened trait. */
export type OnIdent<N extends AnyEntity> =
  | `:${N["ns"]}/${string}`
  | {
      [K in keyof N["fields"] & string]: IdentOfFieldIn<
        N["fields"][K],
        N["ns"],
        K
      >;
    }[keyof N["fields"] & string];

export type LookupRefFor<C extends AnySchema, N extends AnyEntity> = Extract<
  LookupRef<C>,
  | readonly [OnIdent<N>, unknown]
  | readonly [{ readonly ident: OnIdent<N> }, unknown]
>;

/** Namespaces of `C` — the default `N` for a catalog-wide {@link EntityRef}. */
export type CatalogEntity<C extends AnySchema> = C["entities"][keyof C["entities"]] &
  AnyEntity;

/** Unbranded id — a bare `number`, not `Eid<Other>`. Documented mint-by-id hatch. */
export type UnbrandedId = number & { readonly _ns?: never };

/**
 * How an entity is named on the typed surfaces: branded eid, `{ id }` row
 * (`.ids()` / `select({ id })`), nominal tempid, lookup, or the unbranded
 * number hatch. Raw `string` is not in the set — use {@link Tempid}.
 *
 * `H` is the handle admitted beside these forms (`TxHandle` / `OpHandle`).
 */
export type EntityRef<
  C extends AnySchema,
  N extends AnyQueryRoot = CatalogEntity<C>,
  H = never,
> =
  | Eid<N>
  | { readonly id: Eid<N> }
  | Tempid
  | LookupRefFor<C, Extract<N, AnyEntity>>
  | UnbrandedId
  | H;

/** Transitive trait names on a composer (direct + nested). */
export type TransitiveTraitNs<T> = T extends { readonly ns: infer Ns extends string }
  ? Ns | (T extends { readonly traits: readonly (infer Inner)[] } ? TransitiveTraitNs<Inner> : never)
  : never;

/** Trait names an entity composes, walking `traits` transitively. */
export type EntityTraitNs<N> = N extends { readonly traits: readonly (infer T)[] }
  ? TransitiveTraitNs<T>
  : never;

/** Entities in `C` that compose trait `T` (including transitive). */
export type ComposersOfTrait<
  C extends AnySchema,
  T extends { readonly ns: string },
> = {
  [K in keyof C["entities"]]: T["ns"] extends EntityTraitNs<C["entities"][K]>
    ? C["entities"][K] & AnyEntity
    : never;
}[keyof C["entities"]];

/** Target of a `Ref(User)` / `Ref(Taggable)` field; `never` for `Ref.self` / untargeted. */
export type FieldTargetEntity<F> = F extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyQueryRoot
    ? Exclude<T, undefined>
    : never
  : never;

/** The entity that owns ident `I` in `C`. */
export type EntityOfIdent<C extends AnySchema, I extends string> = {
  [K in keyof C["entities"]]: {
    [A in keyof C["entities"][K]["fields"] & string]: IdentOfFieldIn<
      C["entities"][K]["fields"][A],
      C["entities"][K]["ns"],
      A
    > extends I
      ? C["entities"][K] & AnyEntity
      : never;
  }[keyof C["entities"][K]["fields"] & string];
}[keyof C["entities"]];

type RefDeclaredTarget<C extends AnySchema, I extends string> = FieldTargetEntity<
  AttrAtIdent<C, I>
>;

/**
 * Ref write target: `Ref(User)` → `User`; `Ref(Taggable)` → every composer
 * of that trait (plus the trait itself, for `Query.from(Taggable)` rows);
 * `Ref.self` / untargeted → the enclosing entity of the ident.
 */
export type RefWriteTarget<C extends AnySchema, I extends string> = [
  RefDeclaredTarget<C, I>,
] extends [never]
  ? EntityOfIdent<C, I>
  : [RefDeclaredTarget<C, I>] extends [AnyTrait]
    ? ComposersOfTrait<C, Extract<RefDeclaredTarget<C, I>, AnyTrait>> | RefDeclaredTarget<C, I>
    : RefDeclaredTarget<C, I>;

/**
 * Write value for a ref-typed ident: {@link EntityRef} of the declared
 * target. A Label eid is not assignable to `Issue.creator`.
 */
export type RefWriteValue<
  C extends AnySchema,
  I extends string,
  H = never,
> = EntityRef<C, RefWriteTarget<C, I>, H>;
