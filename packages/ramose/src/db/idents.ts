import type { Eid } from "./Eid.ts";
import type { AnyEntity } from "./Entity.ts";
import type { Tempid } from "./entityArg.ts";
import type { ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";
import type { AnyTrait } from "./Trait.ts";

export type Ident<Ns extends string, Attr extends string> = `:${Ns}/${Attr}`;

export type IdentOfFieldIn<F, Ns extends string, A extends string> = F extends {
  readonly ident: infer I extends string;
}
  ? string extends I
    ? Ident<Ns, A>
    : I
  : Ident<Ns, A>;

export type CatalogIdent<C extends AnySchema> = {
  [K in keyof C["entities"]]: {
    [A in keyof C["entities"][K]["fields"] & string]: IdentOfFieldIn<
      C["entities"][K]["fields"][A],
      C["entities"][K]["ns"],
      A
    >;
  }[keyof C["entities"][K]["fields"] & string];
}[keyof C["entities"]];

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

export type WriteAtIdent<C extends AnySchema, I extends string> =
  CardAtIdent<C, I> extends "many"
    ? ReadonlyArray<ValueAtIdent<C, I>>
    : ValueAtIdent<C, I>;

export type ReadAtIdent<C extends AnySchema, I extends string> =
  WriteAtIdent<C, I>;

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

export type CatalogEntity<C extends AnySchema> = C["entities"][keyof C["entities"]] &
  AnyEntity;

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
  N extends AnyEntity = CatalogEntity<C>,
  H = never,
> =
  | Eid<N>
  | { readonly id: Eid<N> }
  | Tempid
  | LookupRefFor<C, N>
  | UnbrandedId
  | H;

export type FieldTargetEntity<F> = F extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyEntity
    ? Exclude<T, undefined>
    : never
  : never;

type DeclaredRefTarget<F> = F extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined>
  : unknown;

type TraitClosure<T> = T extends AnyTrait
  ? T | TraitClosure<T["traits"][number]>
  : never;

type EntityComposes<N extends AnyEntity, T extends AnyTrait> = T extends TraitClosure<
  N extends { readonly traits: readonly AnyTrait[] } ? N["traits"][number] : never
>
  ? true
  : false;

export type TraitComposer<C extends AnySchema, T extends AnyTrait> = {
  [K in keyof C["entities"]]: C["entities"][K] extends infer N extends AnyEntity
    ? EntityComposes<N, T> extends true
      ? N
      : never
    : never;
}[keyof C["entities"]];

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

export type RefWriteTarget<C extends AnySchema, I extends string> = [
  DeclaredRefTarget<AttrAtIdent<C, I>>,
] extends [AnyEntity]
  ? Extract<DeclaredRefTarget<AttrAtIdent<C, I>>, AnyEntity>
  : [DeclaredRefTarget<AttrAtIdent<C, I>>] extends [AnyTrait]
    ? TraitComposer<C, Extract<DeclaredRefTarget<AttrAtIdent<C, I>>, AnyTrait>>
    : EntityOfIdent<C, I>;

export type RefWriteValue<
  C extends AnySchema,
  I extends string,
  H = never,
> = EntityRef<C, RefWriteTarget<C, I>, H>;
