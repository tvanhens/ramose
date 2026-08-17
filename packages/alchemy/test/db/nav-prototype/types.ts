/**
 * Typing prototype for issue #18 / docs/QUERY.md §9.
 *
 * Not part of `@ripple/alchemy/db`. Encodings measured in the companion
 * fixtures / docs/QUERY_TYPING.md:
 *
 * - **inferred + depth cap** (`StampedMap` with a hop budget) — keeps
 *   `Namespace(...)` inference without an annotation; caps self-ref unrolling.
 * - **interface-deferred** — self-ref target is a named interface (annotation
 *   on the cycle member), Prisma-style.
 *
 * Pure uncapped `RefAttr<StampedMap<…>>` substitute is documented as FAIL
 * (TS2615 circular mapped type) — see `inferred-uncapped.ts`.
 */

import type * as Schema from "effect/Schema";

declare const SelfRef: unique symbol;
declare const NsBrand: unique symbol;

export type Cardinality = "one" | "many";

export interface AttrOptions {
  readonly cardinality?: Cardinality;
}

export interface Attr<
  S extends Schema.Top = Schema.Top,
  Card extends Cardinality = Cardinality,
> {
  readonly _tag: "Attr";
  readonly schema: S;
  readonly cardinality: Card;
  readonly valueType: string;
}

export interface RefAttr<
  TargetAttrs extends object = object,
  Card extends Cardinality = Cardinality,
> {
  readonly _tag: "Attr";
  readonly schema: Schema.Top;
  readonly cardinality: Card;
  readonly valueType: ":db.type/ref";
  readonly _target?: TargetAttrs;
}

/** Sentinel target for `Ref.self` before Namespace substitutes. */
export type SelfMarker = { readonly [SelfRef]: true };

export type AnyAttr = Attr | RefAttr;

export type Stamped<
  Ns extends string,
  Name extends string,
  A extends AnyAttr,
> = A & {
  /**
   * Attribute key inside the namespace. Named `attrName` (not `name`) so it
   * does not shadow navigable target attrs — `Todo.owner.name` must mean
   * `User.name`, not the string `"owner"` (QUERY.md §2 / §9).
   */
  readonly attrName: Name;
  readonly ident: `:${Ns}/${Name}`;
};

/**
 * One navigation hop. `SelfMarker` targets stay unsubstituted (caller
 * still resolving); otherwise intersect the target attr map.
 */
export type Nav<A> = [A] extends [RefAttr<infer Target, infer _Card>]
  ? [Target] extends [SelfMarker]
    ? A
    : A & Target
  : A;

type CardOf<O> = [O] extends [{ readonly cardinality: infer C }]
  ? C extends Cardinality
    ? C
    : "one"
  : "one";

/** Decrement hop budget. `0` stops self-ref expansion. */
type Pred = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];
type Dec<D extends number> = Pred[D];

/**
 * Stamp + substitute `Ref.self`.
 *
 * Default encoding uses a **depth budget** so self-ref unrolling is
 * well-founded even if a future TS release re-tightens circular mapped
 * types (we previously hit TS2615 on an earlier encoding). An uncapped
 * variant also typechecks on TypeScript 5.9.3 — see `inferred-uncapped.ts`.
 */
export type StampedMap<
  Ns extends string,
  Attrs extends object,
  D extends number = 6,
> = {
  readonly [K in keyof Attrs]: Attrs[K] extends AnyAttr
    ? Nav<Stamped<Ns, K & string, SubstSelf<Ns, Attrs, Attrs[K], D>>>
    : never;
};

type SubstSelf<
  Ns extends string,
  Attrs extends object,
  A,
  D extends number,
> = [A] extends [RefAttr<SelfMarker, infer Card>]
  ? [Dec<D>] extends [never]
    ? RefAttr<SelfMarker, Card>
    : RefAttr<StampedMap<Ns, Attrs, Dec<D> & number>, Card>
  : A;

export type NamespaceType<
  Name extends string = string,
  Attrs extends object = object,
> = {
  readonly _tag: "Namespace";
  readonly ns: Name;
  readonly attributes: StampedMap<Name, Attrs>;
} & StampedMap<Name, Attrs>;

/** Namespace-branded eid with a *required* unique-symbol key. */
export interface Eid<N extends { readonly ns: string }> {
  readonly id: number;
  readonly [NsBrand]: N["ns"];
}

// ── constructors ───────────────────────────────────────────────────────────

/** Targeted ref schema. Wrap with {@link Attr} to set cardinality. */
export const Ref = Object.assign(
  <const N extends { readonly attributes: object }>(
    target: () => N,
  ): RefAttr<N["attributes"], "one"> =>
    ({
      _tag: "Attr",
      schema: null as unknown as Schema.Top,
      cardinality: "one",
      valueType: ":db.type/ref",
      ...{ _resolve: target },
    }) as RefAttr<N["attributes"], "one">,
  {
    self: {
      _tag: "Attr" as const,
      schema: null as unknown as Schema.Top,
      cardinality: "one" as const,
      valueType: ":db.type/ref" as const,
      ...{ _self: true as const },
    } as RefAttr<SelfMarker, "one">,
  },
);

/**
 * Attribute declaration — mirrors `Ripple.Attr(schema, opts?)` /
 * `Ripple.Attr(Ripple.Ref(() => N), opts?)` from QUERY.md.
 */
export const Attr: {
  <S extends Schema.Top>(schema: S): Attr<S, "one">;
  <S extends Schema.Top, const O extends AttrOptions>(
    schema: S,
    options: O,
  ): Attr<S, CardOf<O>>;
  <T extends object>(ref: RefAttr<T, "one">): RefAttr<T, "one">;
  <T extends object, const O extends AttrOptions>(
    ref: RefAttr<T, "one">,
    options: O,
  ): RefAttr<T, CardOf<O>>;
} = ((
  schemaOrRef: Schema.Top | RefAttr,
  options?: AttrOptions,
): AnyAttr => {
  if (
    typeof schemaOrRef === "object" &&
    schemaOrRef !== null &&
    (schemaOrRef as RefAttr).valueType === ":db.type/ref"
  ) {
    return {
      ...(schemaOrRef as RefAttr),
      cardinality: (options?.cardinality ??
        (schemaOrRef as RefAttr).cardinality ??
        "one") as Cardinality,
    };
  }
  return {
    _tag: "Attr",
    schema: schemaOrRef as Schema.Top,
    cardinality: (options?.cardinality ?? "one") as Cardinality,
    valueType: "scalar",
  };
}) as typeof Attr;

const isSelfRef = (a: AnyAttr): boolean =>
  (a as { _self?: boolean })._self === true;

export const Namespace = <
  const Name extends string,
  const Attrs extends Record<string, AnyAttr>,
>(
  name: Name,
  attributes: Attrs,
): NamespaceType<Name, Attrs> => {
  const stamped: Record<string, unknown> = {};

  const ns = {
    _tag: "Namespace" as const,
    ns: name,
    get attributes() {
      return stamped;
    },
  } as NamespaceType<Name, Attrs>;

  for (const key of Object.keys(attributes)) {
    const raw = attributes[key]!;
    const attr = {
      ...raw,
      attrName: key,
      ident: `:${name}/${key}`,
    };

    if (isSelfRef(raw) || (raw as RefAttr).valueType === ":db.type/ref") {
      stamped[key] = new Proxy(attr, {
        get(target, prop, receiver) {
          if (typeof prop === "symbol" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          if (isSelfRef(raw)) return stamped[prop as string];
          const resolve = (raw as { _resolve?: () => NamespaceType })._resolve;
          if (resolve) {
            const targetNs = resolve();
            return (targetNs.attributes as Record<string, unknown>)[
              prop as string
            ];
          }
          return undefined;
        },
      });
    } else {
      stamped[key] = attr;
    }

    Object.defineProperty(ns, key, {
      enumerable: true,
      configurable: true,
      get: () => stamped[key],
    });
  }

  return ns;
};

export type IdentOf<P> = P extends { readonly ident: infer I } ? I : never;
export type AttrNameOf<P> = P extends { readonly attrName: infer N } ? N : never;
