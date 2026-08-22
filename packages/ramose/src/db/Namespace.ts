/** Named group of attributes. `User.name` is the stamped attr ref (`:user/name`). */

import type { AnyAttribute, Cardinality } from "./Attribute.ts";
import {
  attachAttrNav,
  cardsOf,
  pathOf,
  revsOf,
  type AttrNav,
  type PathCarrier,
} from "./shapes.ts";

export type AttributeMap = Record<string, AnyAttribute>;

/**
 * Stamp an attribute with `name` / `ident` and the pull-shaping methods
 * (`.optional`, `.orDefault`, `.select`). Constraints live in the query
 * language (`Q`, the pipeable stdlib) — an attr ref is data, not a builder.
 */
export type StampedAttribute<
  Ns extends string,
  Name extends string,
  A extends AnyAttribute,
> = AttrNav<
  A & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
  } & PathCarrier
>;

/**
 * The backlink `attr.reverse` denotes: from the ref's **target**, the entities
 * of the ref's *owning* namespace that point at you. It is a shape node, not
 * a datom: select a shape through it (`Issue.creator.reverse.select({ … })`).
 *
 * `Card` is the backlink's own cardinality — see {@link ReverseNav} and
 * {@link ComponentReverseNav}.
 */
type BacklinkNav<
  Ns extends string,
  A extends AnyAttribute,
  Name extends string,
  Card extends "one" | "many",
> = AttrNav<
  Omit<A, "cardinality" | "valueType" | "schema"> & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
    readonly cardinality: Card;
    readonly valueType: ":db.type/ref";
  } & PathCarrier
>;

/**
 * The ordinary backlink: cardinality-many, because any number of entities may
 * point at one. Its shape is an array.
 */
export type ReverseNav<
  Ns extends string,
  A extends AnyAttribute,
  Name extends string,
> = BacklinkNav<Ns, A, Name, "many">;

/**
 * The backlink of a `:db/isComponent` ref: cardinality-**one**. A component is
 * owned by the entity that refers to it, so at most one entity points at it,
 * and the peer answers such a backlink with a single value rather than a
 * collection (`cardMany = !attr.isComponent` in the pull engine). Its
 * `.reverse.select({ … })` reads as one nested object — `.optional` when the
 * component may have no owner.
 */
export type ComponentReverseNav<
  Ns extends string,
  A extends AnyAttribute,
  Name extends string,
> = BacklinkNav<Ns, A, Name, "one">;

/** One stamped attribute: a ref also exposes its backlink. */
export type NavStamp<
  Ns extends string,
  A extends AnyAttribute,
  Name extends string,
> = A["valueType"] extends ":db.type/ref"
  ? StampedAttribute<Ns, Name, A> & {
      /**
       * A component ref's backlink is single-valued; every other one is a
       * collection. An attribute whose componenthood is not known statically
       * (a plain `boolean`, as {@link AnyAttribute} carries) takes the
       * many-valued reading — the one that holds for any ref.
       */
      readonly reverse: [A["isComponent"]] extends [true]
        ? ComponentReverseNav<Ns, A, Name>
        : ReverseNav<Ns, A, Name>;
    }
  : StampedAttribute<Ns, Name, A>;

export type StampedMap<Ns extends string, Attrs extends AttributeMap> = {
  readonly [K in keyof Attrs]: NavStamp<Ns, Attrs[K], K & string>;
};

/** Stamped attributes plus `ns` / `attributes`. `User.name` is the attr ref. */
export type Namespace<
  Name extends string = string,
  Attrs extends AttributeMap = AttributeMap,
> = {
  readonly _tag: "Namespace";
  readonly ns: Name;
  readonly attributes: StampedMap<Name, Attrs>;
  /**
   * Pseudo-attribute `:db/id`, usable in `select` shapes and as an `EidOf`
   * declaration. Typed as a stamped attr so it is a valid shape field, and
   * as a number so comparisons over it take the id they compare against.
   * The `_ns` phantom is the namespace itself: it is what brands the
   * `select({ id: N.id })` row cell as `Eid<N>` (see `IdCell` in Pull.ts).
   */
  readonly id: AttrNav<
    AnyAttribute & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: ":db.type/ref";
      readonly cardinality: "one";
      /** Phantom: the namespace whose `:db/id` this is. Never at runtime. */
      readonly _ns?: Namespace<Name, Attrs>;
    } & PathCarrier
  >;
} & StampedMap<Name, Attrs>;

export type AnyNamespace = {
  readonly _tag: "Namespace";
  readonly ns: string;
  readonly attributes: StampedMap<string, AttributeMap>;
};

/**
 * `attr.reverse` — the same ref hop, read backwards: a shape node for
 * backlink selects. The hop's cardinality is the backlink's: many for an
 * ordinary ref (any number of entities may point at one), **one** for a
 * `:db/isComponent` ref — the component is owned by its referrer, so at most
 * one entity points at it, and the peer answers that backlink with a single
 * value.
 */
const reverseNode = (from: PathCarrier): unknown => {
  const card: Cardinality =
    (from as { isComponent?: boolean }).isComponent === true ? "one" : "many";
  const path = pathOf(from);
  const cards = [...cardsOf(from)];
  const revs = [...revsOf(from)];
  cards[cards.length - 1] = card;
  revs[revs.length - 1] = true;

  return attachAttrNav({
    ...(from as object),
    ident: from.ident,
    cardinality: card,
    __path: path,
    __cards: cards,
    __revs: revs,
    __reverse: true,
  } satisfies PathCarrier as PathCarrier);
};

const stampOne = (
  ns: string,
  key: string,
  a: AnyAttribute,
): StampedAttribute<string, string, AnyAttribute> => {
  const base = {
    ...a,
    attrName: key,
    ident: `:${ns}/${key}` as const,
  };

  const navigable = attachAttrNav(base as PathCarrier);
  if (a.valueType !== ":db.type/ref") {
    return navigable as StampedAttribute<string, string, AnyAttribute>;
  }

  return new Proxy(navigable, {
    get(target, prop, receiver) {
      if (prop === "reverse") return reverseNode(receiver as PathCarrier);
      return Reflect.get(target, prop, receiver);
    },
  }) as StampedAttribute<string, string, AnyAttribute>;
};

const stamp = <Name extends string, Attrs extends AttributeMap>(
  name: Name,
  attributes: Attrs,
): StampedMap<Name, Attrs> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    out[key] = stampOne(name, key, attributes[key]!);
  }
  return out as unknown as StampedMap<Name, Attrs>;
};

/** Group attributes under one ident prefix. */
export const Namespace = <
  const Name extends string,
  Attrs extends AttributeMap,
>(
  name: Name,
  attributes: Attrs,
): Namespace<Name, Attrs> => {
  const stamped = stamp(name, attributes);
  const idAttr = attachAttrNav({
    _tag: "Attribute" as const,
    schema: null as never,
    cardinality: "one" as const,
    unique: undefined,
    index: false,
    isComponent: false,
    doc: undefined,
    valueType: ":db.type/ref" as const,
    attrName: "id" as const,
    ident: ":db/id" as const,
  });
  return {
    _tag: "Namespace" as const,
    ns: name,
    attributes: stamped,
    id: idAttr,
    ...stamped,
  } as Namespace<Name, Attrs>;
};

export type AttrOf<
  N extends AnyNamespace,
  K extends keyof N["attributes"],
> = N["attributes"][K];

export type IdentOf<
  N extends AnyNamespace,
  K extends keyof N["attributes"] & string,
> = `:${N["ns"]}/${K}`;
