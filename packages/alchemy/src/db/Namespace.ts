/** Named group of attributes. `User.name` is the stamped attr ref (`:user/name`). */

import type { AnyAttribute } from "./Attribute.ts";
import {
  attachAttrNav,
  cardsOf,
  revsOf,
  withPath,
  type AttrNav,
  type Hopped,
  type PathCarrier,
} from "./NavQuery.ts";
import { optional, type AttrPull } from "./Pull.ts";
import {
  isSelfRefSchema,
  refTargetOf,
  type SelfMarker,
} from "./valueTypes.ts";

export type AttributeMap = Record<string, AnyAttribute>;

type Pred = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];
type Dec<D extends number> = Pred[D];

/**
 * Stamp an attribute with `name` / `ident`, literate pull methods, and
 * navigational query methods (`.eq`, `.select`, …).
 */
export type StampedAttribute<
  Ns extends string,
  Name extends string,
  A extends AnyAttribute,
> = AttrNav<
  A & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
  } & AttrPull<
    A & {
      readonly attrName: Name;
      readonly ident: `:${Ns}/${Name}`;
    }
  > &
    PathCarrier
>;

/**
 * The backlink `attr.reverse` denotes: from the ref's **target**, the entities
 * of the ref's *owning* namespace that point at you.
 *
 * It is a path node, not a datom: no `schema` (a backlink has no scalar value
 * — select a shape through it), always cardinality-many (any number of
 * entities may point at one), and it exposes the owning namespace's attrs so
 * the path can keep walking. The depth budget makes `X.reverse.y.reverse…`
 * well-founded, exactly as it does for self-refs.
 */
export type ReverseNav<
  Ns extends string,
  Attrs extends AttributeMap,
  A extends AnyAttribute,
  Name extends string,
  D extends number,
> = AttrNav<
  Omit<A, "cardinality" | "valueType" | "schema"> & {
    readonly attrName: Name;
    readonly ident: `:${Ns}/${Name}`;
    readonly cardinality: "many";
    readonly valueType: ":db.type/ref";
  } & PathCarrier
> &
  ([Dec<D>] extends [never]
    ? unknown
    : Hopped<StampedMap<Ns, Attrs, Dec<D> & number>>);

/**
 * One navigation hop: a targeted ref exposes its target's stamped attrs.
 * Self-refs use a depth budget so the mapped type stays well-founded.
 */
export type NavStamp<
  Ns extends string,
  Attrs extends AttributeMap,
  A extends AnyAttribute,
  Name extends string,
  D extends number = 6,
> = A["valueType"] extends ":db.type/ref"
  ? ForwardStamp<Ns, Attrs, A, Name, D> & {
      readonly reverse: ReverseNav<Ns, Attrs, A, Name, D>;
    }
  : StampedAttribute<Ns, Name, A>;

type ForwardStamp<
  Ns extends string,
  Attrs extends AttributeMap,
  A extends AnyAttribute,
  Name extends string,
  D extends number,
> = ResolveRefTarget<A> extends infer T
  ? [T] extends [never]
    ? StampedAttribute<Ns, Name, A>
    : [T] extends ["self"]
      ? [Dec<D>] extends [never]
        ? StampedAttribute<Ns, Name, A>
        : StampedAttribute<Ns, Name, A> &
            Hopped<StampedMap<Ns, Attrs, Dec<D> & number>>
      : StampedAttribute<Ns, Name, A> & Hopped<T>
  : StampedAttribute<Ns, Name, A>;

/**
 * Pull the target attr map out of a ref attribute's schema brands: the
 * namespace `Ref(() => N)` names, or `"self"` for `Ref.self` (typed as
 * `TargetedRef<SelfMarker>`, so the marker is what its target resolves to).
 */
type ResolveRefTarget<A> = A extends {
  readonly schema: {
    readonly _resolve?: () => { readonly attributes: infer T };
  };
}
  ? unknown extends T
    ? never
    : [T] extends [SelfMarker]
      ? "self"
      : T
  : never;

export type StampedMap<
  Ns extends string,
  Attrs extends AttributeMap,
  D extends number = 6,
> = {
  readonly [K in keyof Attrs]: NavStamp<
    Ns,
    Attrs,
    Attrs[K],
    K & string,
    D
  >;
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
   * Pseudo-attribute `:db/id`, usable in `where` / `select` / `orderBy`.
   * Typed as a stamped attr so it is a valid {@link ShapeField}, and as a
   * number so `Todo.id.eq(42)` / `.lt(n)` take the id they compare against.
   */
  readonly id: AttrNav<
    AnyAttribute & {
      readonly schema: { readonly Type: number };
      readonly attrName: "id";
      readonly ident: ":db/id";
      readonly valueType: ":db.type/ref";
      readonly cardinality: "one";
    } & PathCarrier
  >;
} & StampedMap<Name, Attrs>;

export type AnyNamespace = {
  readonly _tag: "Namespace";
  readonly ns: string;
  readonly attributes: StampedMap<string, AttributeMap>;
};

const OWN_ATTR_KEYS = new Set([
  "attrName",
  "ident",
  "_tag",
  "schema",
  "cardinality",
  "unique",
  "index",
  "isComponent",
  "doc",
  "valueType",
  "optional",
  "select",
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "startsWith",
  "endsWith",
  "includes",
  "matches",
  "exists",
  "missing",
  "is",
  "each",
  "some",
  "every",
  "none",
  "where",
  "orderBy",
  "limit",
  "offset",
  "__path",
  "__cards",
  "__revs",
  "__reverse",
  "__each",
]);

/**
 * `attr.reverse` — the same ref hop, walked backwards. The path keeps its
 * prefix (so a reverse part-way along a path works), the last hop flips to
 * reversed and to cardinality-many, and navigation continues into the ref's
 * *owning* namespace rather than its target.
 */
const reverseNode = (
  from: PathCarrier,
  ownMap: Record<string, unknown>,
): unknown => {
  if ((from as { isComponent?: boolean }).isComponent === true) {
    throw new Error(
      `ripple/query: ${from.ident} is a component ref, whose backlink is single-valued — \`.reverse\` only models the many-valued case`,
    );
  }
  const path = pathOfSafe(from);
  const cards = [...cardsOf(from)];
  const revs = [...revsOf(from)];
  cards[cards.length - 1] = "many";
  revs[revs.length - 1] = true;

  const node = attachAttrNav({
    ...(from as object),
    ident: from.ident,
    cardinality: "many" as const,
    __path: path,
    __cards: cards,
    __revs: revs,
    __reverse: true,
  } satisfies PathCarrier as PathCarrier);

  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || OWN_ATTR_KEYS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const child = ownMap[prop] as PathCarrier | undefined;
      if (child === undefined) return undefined;
      return withPath(
        child,
        [...path, child.ident],
        [...cards, child.cardinality ?? "one"],
        [...revs, false],
      );
    },
  });
};

const stampOne = (
  ns: string,
  key: string,
  a: AnyAttribute,
  resolveTarget: (prop: string) => unknown,
  ownMap: () => Record<string, unknown>,
): StampedAttribute<string, string, AnyAttribute> => {
  const base = {
    ...a,
    attrName: key,
    ident: `:${ns}/${key}` as const,
  };
  const withPull = {
    ...base,
    optional: optional(base),
  };

  const isRef = a.valueType === ":db.type/ref";
  if (!isRef) {
    return attachAttrNav(withPull as PathCarrier) as StampedAttribute<
      string,
      string,
      AnyAttribute
    >;
  }

  const navigable = attachAttrNav(withPull as PathCarrier);
  return new Proxy(navigable, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      // the backlink is rooted at this ref's *owning* namespace, so it is
      // resolved before the target-attribute lookup below
      if (prop === "reverse") {
        return reverseNode(receiver as PathCarrier, ownMap());
      }
      if (OWN_ATTR_KEYS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const child = resolveTarget(prop);
      if (child === undefined) return undefined;
      const childAttr = child as PathCarrier;
      // Extend the *receiver's* path, not the target's: two hops in
      // (`Todo.owner.boss`), `target` is the bare `User.boss` stamp while
      // `receiver` is the `withPath` proxy that still remembers `:todo/owner`.
      // The reversal flags travel with the path: a forward hop taken after a
      // `.reverse` (`Todo.owner.reverse.owner`) must keep the earlier hop
      // backwards, and only append its own `false`.
      const from = receiver as PathCarrier;
      return withPath(
        childAttr,
        [...pathOfSafe(from), childAttr.ident!],
        [...cardsOf(from), childAttr.cardinality ?? "one"],
        [...revsOf(from), false],
      );
    },
  }) as StampedAttribute<string, string, AnyAttribute>;
};

const pathOfSafe = (attr: PathCarrier): readonly string[] =>
  attr.__path ?? (attr.ident !== undefined ? [attr.ident] : []);

const stamp = <Name extends string, Attrs extends AttributeMap>(
  name: Name,
  attributes: Attrs,
): StampedMap<Name, Attrs> => {
  const out: Record<string, unknown> = {};

  const resolveTarget = (fromKey: string, prop: string): unknown => {
    const raw = attributes[fromKey];
    if (!raw || raw.valueType !== ":db.type/ref") return undefined;
    if (isSelfRefSchema(raw.schema)) return out[prop];
    const resolve = refTargetOf(raw.schema);
    if (!resolve) return undefined;
    const targetNs = resolve();
    return (targetNs.attributes as Record<string, unknown>)[prop];
  };

  for (const key of Object.keys(attributes)) {
    const a = attributes[key]!;
    out[key] = stampOne(
      name,
      key,
      a,
      (prop) => resolveTarget(key, prop),
      () => out,
    );
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
