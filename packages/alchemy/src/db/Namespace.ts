/** Named group of attributes. `User.name` is the stamped attr ref (`:user/name`). */

import type { AnyAttribute } from "./Attribute.ts";
import {
  attachAttrNav,
  cardsOf,
  withPath,
  type AttrNav,
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
  ? ResolveRefTarget<A> extends infer T
    ? [T] extends [never]
      ? StampedAttribute<Ns, Name, A>
      : [T] extends ["self"]
        ? [Dec<D>] extends [never]
          ? StampedAttribute<Ns, Name, A>
          : StampedAttribute<Ns, Name, A> &
              StampedMap<Ns, Attrs, Dec<D> & number>
        : StampedAttribute<Ns, Name, A> & T
    : StampedAttribute<Ns, Name, A>
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
  "__path",
  "__cards",
]);

const stampOne = (
  ns: string,
  key: string,
  a: AnyAttribute,
  resolveTarget: (prop: string) => unknown,
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
      if (OWN_ATTR_KEYS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const child = resolveTarget(prop);
      if (child === undefined) return undefined;
      const childAttr = child as PathCarrier;
      // Extend the *receiver's* path, not the target's: two hops in
      // (`Todo.owner.boss`), `target` is the bare `User.boss` stamp while
      // `receiver` is the `withPath` proxy that still remembers `:todo/owner`.
      const from = receiver as PathCarrier;
      return withPath(
        childAttr,
        [...pathOfSafe(from), childAttr.ident!],
        [...cardsOf(from), childAttr.cardinality ?? "one"],
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
    out[key] = stampOne(name, key, a, (prop) => resolveTarget(key, prop));
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
