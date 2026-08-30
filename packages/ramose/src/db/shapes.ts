import { lowerAttr } from "./attrRef.ts";
import type { AnyField, Cardinality } from "./Field.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyComposer } from "./Composer.ts";
import type { AttrIdent, FocusIdents } from "./query/focus.ts";
import { lowerElemFilter, type ElemFilterFragment } from "./query/elemFilter.ts";
import type { EidCell, Var } from "./query/kernel.ts";
import {
  type Again,
  type AgainAsField,
  type AgainMissingId,
  type AgainNsMismatch,
  type AgainTargetNs,
  type AllRow,
  type AllShape,
  type HasIdField,
  type IdCell,
  type IsAgainSelectField,
  type IsAgainTerm,
  type PullDefault,
  type PullNestedConstraints,
  type RecurDepth,
  type ShapeNs,
  type Unroll,
  assertAgainDepth,
  assertAgainInShape,
  assertNotAgain,
  inspectPullField,
  assertDirectField,
  isAgain,
  isAllShape,
  isPullDefault,
  isPullNested,
  isPullOptional,
  nested,
  optional,
  pullDefault,
} from "./Pull.ts";

export type PathCarrier = {
  readonly ident: string;
  readonly cardinality?: Cardinality | undefined;
  readonly __path?: readonly string[];
  readonly __cards?: readonly Cardinality[];
  readonly __revs?: readonly boolean[];
  readonly __reverse?: boolean;
};

export const pathOf = (attr: PathCarrier): readonly string[] =>
  attr.__path ?? [attr.ident];

export const cardsOf = (attr: PathCarrier): readonly Cardinality[] =>
  attr.__cards ?? [attr.cardinality ?? "one"];

export const revsOf = (attr: PathCarrier): readonly boolean[] =>
  attr.__revs ?? pathOf(attr).map(() => false);

export type AttrValue<A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

/** What names an entity in a value position: a raw eid, or an `Eid` row cell. */
export type EidLike = number | { readonly id: number };

type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;

type IsDefaultable<A> = IsMany<A> extends true
  ? false
  : A extends { readonly valueType: "ref" }
    ? false
    : true;

const isRefNav = (attr: PathCarrier): boolean =>
  (attr as { valueType?: unknown }).valueType === "ref";

type RefSelect<A> = {
  <const D extends RecurDepth>(shape: Again<D>, opts?: SelectOpts<A>): SelectNested<A, Again<D>>;
  <const N extends AnyEntity>(shape: AllShape<N>, opts?: SelectOpts<A>): SelectNested<A, AllShape<N>>;
  <const S extends Shape>(shape: S & ValidShape<S>, opts?: SelectOpts<A>): SelectNested<A, S>;
};

type SelectOpts<A> = [IsManyRef<A>] extends [true] ? NestedOpts<A> : never;

export type OrderEmpty = "first" | "last";
export type OrderDir = "asc" | "desc";

export type ShapeField =
  | AnyField
  | PathCarrier
  | Again
  | { readonly _tag: "optional"; readonly field: unknown }
  | { readonly _tag: "default"; readonly field: unknown; readonly value: unknown }
  | { readonly _tag: "nested"; readonly attr: unknown; readonly pattern: unknown }
  | {
      readonly _tag: "select";
      readonly attr: unknown;
      readonly shape: Shape | AllShape | Again;
    }
  | { readonly _tag: "collection"; readonly attr: unknown };

export type Shape = { readonly [key: string]: ShapeField };

export type ValidShape<S> = {
  readonly [K in keyof S]: IsAgainTerm<S[K]> extends true
    ? AgainAsField<K & string>
    : IsAgainSelectField<S[K]> extends true
      ? AgainSelectField<S[K], S, K & string>
      : S[K];
};

type ShapeAttrOf<F> = F extends { readonly _tag: "optional" | "default"; readonly field: infer I }
  ? ShapeAttrOf<I>
  : F extends { readonly _tag: "select" | "nested" | "collection"; readonly attr: infer A }
    ? A
    : F;

type IsReverseField<A> = A extends { readonly __reverse: true } ? true : false;

export type FocusShape<N extends AnyComposer, S> = {
  readonly [K in keyof S]: [IsReverseField<ShapeAttrOf<S[K]>>] extends [true]
    ? S[K]
    : [AttrIdent<ShapeAttrOf<S[K]>>] extends [FocusIdents<N>]
      ? S[K]
      : `select field "${K & string}" is not an attribute of the focus entity`;
};

export type FocusSelect<N extends AnyComposer, S> = S extends AllShape<infer M>
  ? [M] extends [N]
    ? S
    : `all(...) is not the focus entity`
  : S & ValidShape<S> & FocusShape<N, S>;

type AgainSelectField<F, S, K extends string> = HasIdField<S> extends true
  ? AgainNsField<F, S, K>
  : AgainMissingId;

type AgainNsField<F, S, K extends string> = AgainTargetNs<F> extends ShapeNs<S>
  ? F
  : AgainNsMismatch<K, ShapeNs<S> & string>;

type IsManyRef<A> = IsMany<A> extends true
  ? A extends { readonly valueType: "ref" }
    ? true
    : false
  : false;

export type NestedOrderKey = PathCarrier & {
  readonly cardinality?: "one";
};

export type NestedElemPred<A> = A extends { readonly valueType: "ref" }
  ? (focus: Var<EidCell>) => Iterable<unknown>
  : (v: Var<AttrValue<A>>) => Iterable<unknown>;

export interface NestedOrderSpec {
  readonly key: NestedOrderKey;
  readonly dir?: OrderDir;
  readonly empty?: OrderEmpty;
}

export type NestedOrderBy =
  | NestedOrderKey
  | NestedOrderSpec
  | readonly (NestedOrderKey | NestedOrderSpec)[];

/**
 * Pull-phase constraints on a nested collection, as one record — the typed
 * twin of the wire's own `{where, order, offset, limit}` map on a
 * `PullAttrSpec`. Deliberately a record, not a chain or a pipe: the engine
 * evaluates the four slots in a fixed order (`where` → `orderBy` → `offset`
 * → `limit`) whatever the source spelling, so the syntax carries no sequence
 * to mislead with. Evaluated *inside* the pull, after the outer `:order` /
 * `:offset` / `:limit` slice — constraints page the collection, never the
 * rows: an element-less collection is `[]`, not a dropped parent, so the
 * outer `limit` still counts rows the client keeps.
 *
 * ```ts
 * replies: Comment.replies.select(Ramose.again(4), {
 *   where: [is(Comment.deleted, false)],
 *   orderBy: { key: Comment.createdAt, dir: "asc" },
 *   limit: 20,
 * }),
 * ```
 *
 * `where` entries are ANDed filter fragments over the element (see
 * {@link NestedElemPred}); a card-many scalar takes the same record through
 * {@link values}, minus `orderBy` (its elements are values, with no
 * attributes to sort by).
 */
export interface NestedOpts<A = PathCarrier> {
  readonly where?: readonly NestedElemPred<A>[];
  readonly orderBy?: A extends { readonly valueType: "ref" }
    ? NestedOrderBy
    : never;
  readonly limit?: number;
  readonly offset?: number;
}

export type AttrNav<A extends PathCarrier> = A & {
  readonly optional: ReturnType<typeof optional<A>>;
  readonly orDefault: IsDefaultable<A> extends true
    ? (value: AttrValue<A>) => PullDefault<A>
    : never;
  readonly select: A extends { readonly valueType: "ref" }
    ? RefSelect<A>
    : never;
};

/** A card-many **scalar** collection with pull-phase constraints — the field
 * {@link values} builds. Inert: the constraints are already lowered. */
export interface ValuesField<A = PathCarrier> {
  readonly _tag: "collection";
  readonly attr: A;
  readonly constraints: PullNestedConstraints;
}

const nestedCount = (n: unknown, what: string): number => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error(`ramose/query: nested ${what} takes a non-negative integer, got ${String(n)}`);
  }
  return n;
};

const lowerElemOrder = (
  key: PathCarrier,
  dir: OrderDir,
  empty: OrderEmpty | undefined,
): { path: string[]; reverse?: boolean[]; dir: OrderDir; empty?: OrderEmpty } => {
  const path = pathOf(key);
  if (cardsOf(key).includes("many")) {
    throw new Error(
      `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  const revs = revsOf(key);
  return {
    path: [...path],
    ...(revs.some(Boolean) ? { reverse: [...revs] } : {}),
    dir,
    ...(empty !== undefined ? { empty } : {}),
  };
};

const isOrderSpec = (k: NestedOrderKey | NestedOrderSpec): k is NestedOrderSpec =>
  typeof k === "object" && k !== null && !("ident" in k) && "key" in k;

const lowerNestedOpts = (attr: PathCarrier, opts: NestedOpts<never>): PullNestedConstraints => {
  for (const key of Object.keys(opts)) {
    if (key !== "where" && key !== "orderBy" && key !== "limit" && key !== "offset") {
      throw new Error(
        `ramose/query: unknown select option "${key}" — a nested collection takes { where, orderBy, limit, offset }`,
      );
    }
  }
  let where: PullNestedConstraints["where"];
  if (opts.where !== undefined) {
    where = lowerElemFilter(opts.where as readonly ElemFilterFragment[], attr);
  }
  let order: PullNestedConstraints["order"];
  if (opts.orderBy !== undefined) {
    if (!isRefNav(attr)) {
      throw new Error(
        `ramose/query: orderBy on ${pathOf(attr).join(" → ")} — a scalar collection's elements are its values; only a reference collection has attributes to sort by`,
      );
    }
    const keys = Array.isArray(opts.orderBy)
      ? (opts.orderBy as readonly (NestedOrderKey | NestedOrderSpec)[])
      : [opts.orderBy as NestedOrderKey | NestedOrderSpec];
    order = keys.map((k) =>
      isOrderSpec(k)
        ? lowerElemOrder(k.key, k.dir ?? "asc", k.empty)
        : lowerElemOrder(k, "asc", undefined),
    );
  }
  const limit = opts.limit !== undefined ? nestedCount(opts.limit, "limit") : undefined;
  const offset = opts.offset !== undefined ? nestedCount(opts.offset, "offset") : undefined;
  return {
    ...(where !== undefined && { where }),
    ...(order !== undefined && { order }),
    ...(limit !== undefined && { limit }),
    ...(offset !== undefined && { offset }),
  };
};

const assertManyForOpts = (attr: PathCarrier, spelling: string): void => {
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ramose/query: ${spelling} on ${pathOf(attr).join(" → ")} — the options record filters and pages the elements of a cardinality-many collection; constrain rows in the query itself`,
    );
  }
};

/**
 * A card-many **scalar** collection with pull-phase constraints — the map
 * form's spelling for a hop that has no shape to `.select` through, because
 * its elements are the values themselves. `where` fragments are handed the
 * value var directly; `orderBy` does not apply.
 *
 * ```ts
 * aTags: Ramose.values(User.tags, { where: [(v) => Q.startsWith(v, "a")] }),
 * ```
 */
export const values = <A extends PathCarrier>(
  attr: A,
  opts?: Omit<NestedOpts<A>, "orderBy">,
): ValuesField<A> => {
  if (typeof attr !== "object" || attr === null || typeof attr.ident !== "string") {
    throw new Error("ramose/query: values(...) takes a card-many scalar attribute");
  }
  if (isRefNav(attr)) {
    throw new Error(
      `ramose/query: values(${pathOf(attr).join(" → ")}) — a reference collection has a shape to select; write .select({ … }, { where, orderBy, limit, offset })`,
    );
  }
  assertManyForOpts(attr, "values(...)");
  return {
    _tag: "collection",
    attr,
    constraints: opts === undefined ? {} : lowerNestedOpts(attr, opts as NestedOpts<never>),
  };
};

export interface SelectNested<A = unknown, S = unknown> {
  readonly _tag: "select";
  readonly attr: A;
  readonly shape: S;
  readonly constraints?: PullNestedConstraints;
  readonly optional: {
    readonly _tag: "optional";
    readonly field: SelectNested<A, S>;
  };
}

export const makeSelectNested = (
  attr: PathCarrier,
  shape: Shape | AllShape | Again,
  constraints?: PullNestedConstraints,
): SelectNested<PathCarrier, Shape | AllShape | Again> => {
  if (isAgain(shape)) {
    assertAgainDepth(shape.depth);
    if (!isRefNav(attr)) {
      throw new Error(
        "ramose/query: again is only legal on a reference — write ref.select(Ramose.again(n))",
      );
    }
    const cards = cardsOf(attr);
    if (cards[cards.length - 1] === "many" && constraints?.limit === undefined) {
      throw new Error(
        `ramose/query: ${pathOf(attr).join(" → ")} is a card-many again edge — pass a width in the select options, .select(Ramose.again(${shape.depth}), { limit: n }); the engine default of 1000 is not a tree budget`,
      );
    }
  }
  const nestedSelect: SelectNested<PathCarrier, Shape | AllShape | Again> = {
    _tag: "select",
    attr,
    shape,
    ...(constraints !== undefined ? { constraints } : {}),
    get optional() {
      return { _tag: "optional" as const, field: nestedSelect };
    },
  };
  return nestedSelect;
};

export const attachAttrNav = <A extends PathCarrier>(attr: A): AttrNav<A> => {
  const api = {
    select(this: PathCarrier, shape: Shape | AllShape | Again, opts?: NestedOpts<never>) {
      if (!isRefNav(this)) {
        throw new Error(
          `ramose/query: ${pathOf(this).join(" → ")}.select(...) — only a reference has a nested shape to select`,
        );
      }
      if (opts !== undefined) assertManyForOpts(this, "select options");
      return makeSelectNested(
        this,
        shape,
        opts === undefined ? undefined : lowerNestedOpts(this, opts),
      );
    },
    orDefault(this: PathCarrier, value: unknown) {
      return pullDefault(this, value);
    },
  };

  return new Proxy(attr, {
    get(target, prop, receiver) {
      if (prop === "optional") return optional(receiver);
      if (typeof prop === "string" && prop in api) {
        const v = (api as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as Function).bind(receiver) : v;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AttrNav<A>;
};

export const isSelectNested = (x: unknown): x is SelectNested =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "select";

const assertNotAll = (shape: unknown, key?: string): void => {
  if (!isAllShape(shape)) return;
  throw new Error(
    key === undefined
      ? "ramose/query: all(N) is a shape — write `select(Ramose.all(N))` on the query itself, not as the contents of a field map"
      : `ramose/query: select field "${key}": all(N) is a shape, not a field — write \`ref.select(Ramose.all(N))\``,
  );
};

export const shapeToPullMap = (shape: Shape): Record<string, unknown> => {
  assertNotAll(shape);
  assertNotAgain(shape);
  const fields = shape as Record<string, unknown>;
  assertAgainInShape(fields);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    assertNotAll(field, key);
    assertNotAgain(field, key);
    out[key] = shapeFieldToPull(field);
  }
  return out;
};

const shapeFieldToPull = (field: unknown): unknown => {
  if (isPullOptional(field)) {
    return optional(shapeFieldToPull(field.field));
  }
  if (isPullDefault(field)) {
    return pullDefault(shapeFieldToPull(field.field), field.value);
  }
  if (isSelectNested(field)) {
    if (isAllShape(field.shape) || isAgain(field.shape)) return field;
    return nested(
      field.attr as { readonly valueType: "ref" },
      shapeToPullMap(field.shape as Shape),
      field.constraints,
    );
  }
  if (isPullNested(field)) {
    return field;
  }
  return field;
};

export type SelectResult<S> = {
  readonly [K in keyof S]: SelectFieldResult<S[K], S>;
};

type NestedSelectResult<A, S, Enclosing = unknown> = [S] extends [
  { readonly _tag: "again"; readonly depth: infer D extends number },
]
  ? A extends { readonly cardinality: "many" }
    ? readonly Unroll<Enclosing, D>[]
    : Unroll<Enclosing, D>
  : [S] extends [
        { readonly _tag: "all"; readonly ns: infer N extends AnyEntity },
      ]
    ? A extends { readonly cardinality: "many" }
      ? readonly AllRow<N>[]
      : AllRow<N>
    : A extends { readonly cardinality: "many" }
      ? readonly SelectResult<S & object>[]
      : SelectResult<S & object>;

type SchemaType<S> = S extends { readonly Type: infer T }
  ? T
  : S extends { readonly schema: { readonly Type: infer T } }
    ? T
    : never;

type SelectFieldResult<F, Enclosing = unknown> = F extends {
  readonly _tag: "default";
  readonly field: infer Inner;
}
  ?
    SelectFieldResult<Inner, Enclosing>
  : F extends {
        readonly _tag: "optional";
        readonly field: infer Inner;
      }
  ? SelectFieldResult<Inner, Enclosing> | undefined
  : F extends {
      readonly _tag: "select";
      readonly attr: infer A;
      readonly shape: infer S;
    }
    ? NestedSelectResult<A, S, Enclosing>
    : F extends {
          readonly _tag: "nested";
          readonly attr: infer A;
          readonly pattern: infer P;
        }
      ? NestedSelectResult<A, P, Enclosing>
      :
        F extends {
            readonly _tag: "collection";
            readonly attr: infer A;
          }
        ? readonly SchemaType<A>[]
        : F extends {
            readonly schema: infer S;
            readonly cardinality: infer Card;
          }
        ? F extends { readonly ident: ":db/id" }
          ?
            IdCell<F>
          : Card extends "many"
            ? readonly SchemaType<F>[]
            : SchemaType<F>
        : F extends { readonly ident: ":db/id" }
          ? IdCell<F>
          : never;

let fresh = 0;
const gensym = (prefix: string) => `?${prefix}${fresh++}`;

export const resetGensym = () => {
  fresh = 0;
};

const ID = ":db/id";

const hopClauses = (
  root: string,
  path: readonly string[],
  revs: readonly boolean[],
  value: unknown,
): unknown[] => {
  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push(revs[i] ? [next, path[i], e] : [e, path[i], next]);
    e = next;
  }
  const last = path.length - 1;
  return [
    ...clauses,
    revs[last] ? [value, path[last], e] : [e, path[last], value],
  ];
};

export const lowerOrderPath = (
  root: string,
  path: readonly string[],
  revs: readonly boolean[],
): { readonly var: string; readonly clauses: unknown[] } => {
  if (path.length === 1 && path[0] === ID) return { var: root, clauses: [] };
  const bound = gensym("o");
  return {
    var: bound,
    clauses: [
      [
        "or-join",
        [root, bound],
        ["and", ...hopClauses(root, path, revs, bound)],
        [
          "and",
          ["not", ...hopClauses(root, path, revs, "_")],
          [["ground", [null]], [bound, "..."]],
        ],
      ],
    ],
  };
};

export const requiredClauses = (e: string, pattern: unknown): unknown[] => {
  if (Array.isArray(pattern) || isAllShape(pattern) || isAgain(pattern)) return [];
  const out: unknown[] = [];
  for (const [key, field] of Object.entries(fieldsOf(pattern))) {
    const info = inspectPullField(field);
    assertDirectField(key, info.attr, info.nestedPattern !== undefined);
    if (info.optional || info.many || info.hasDefault) continue;
    const ident = lowerAttr(info.attr);
    if (ident === ID) continue;
    if (info.nestedPattern === undefined || isAgain(info.nestedPattern)) {
      out.push(info.reverse ? [gensym("r"), ident, e] : [e, ident, "_"]);
      continue;
    }
    const target = gensym("r");
    const sub = requiredClauses(target, info.nestedPattern);
    if (info.reverse) {
      out.push([target, ident, e], ...sub);
      continue;
    }
    out.push([e, ident, sub.length > 0 ? target : "_"], ...sub);
  }
  return out;
};

const fieldsOf = (pattern: unknown): Record<string, unknown> =>
  typeof pattern === "object" && pattern !== null && !Array.isArray(pattern)
    ? (pattern as Record<string, unknown>)
    : {};
