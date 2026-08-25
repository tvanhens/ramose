/**
 * Attr refs and select shapes — the machinery the query surface's terminals
 * reuse. An attribute reference (`User.name`) carries its ident, schema and
 * cardinality (the types `Q.fact` correlates on); a **shape** is the fields a
 * projection asks for (`select({ … })` / `Q.pull`), with `.optional`,
 * `.orDefault`, nested `ref.select({ … })`, the wildcard (`all(N)`) and
 * recursion (`again(n)`). This module also lowers the row-dropping half of a
 * shape (`requiredClauses`) and binds sort keys without dropping rows
 * (`lowerOrderPath`) — both shared by the kernel query lowering.
 *
 * The navigational query surface that used to live here (predicate methods
 * on attrs, quantifiers, element cursors, `Ramose.query(N)`) is gone: the
 * kernel query language (`Q`, `Query.q`, the pipeable stdlib) is the one
 * constraint language.
 */

import { lowerAttr } from "./attrRef.ts";
import type { AnyField, Cardinality } from "./Field.ts";
import type { AnyEntity } from "./Entity.ts";
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

// ── attr refs ──────────────────────────────────────────────────────────────

/**
 * What a stamped attribute carries at runtime beyond its schema: the ident,
 * and — for a backlink node — the reversal flag. `__path` / `__cards` /
 * `__revs` describe the (single-hop) path a shape field or sort key walks;
 * a plain attribute's path is just its own ident.
 */
export type PathCarrier = {
  readonly ident: string;
  readonly cardinality?: Cardinality;
  readonly __path?: readonly string[];
  /** Cardinality of each hop in `__path` — parallel to it. */
  readonly __cards?: readonly Cardinality[];
  /**
   * Which hops in `__path` are walked backwards — parallel to it. A reversed
   * hop is `[?next :a ?e]` instead of `[?e :a ?next]`. It is cardinality-many
   * (any number of entities may point at one) unless the ref is a
   * `:db/owned` one, whose referrer is unique — that backlink is
   * card-one, and `__cards` says so.
   */
  readonly __revs?: readonly boolean[];
  /** @internal Set on the node `attr.reverse` returns. */
  readonly __reverse?: boolean;
};

export const pathOf = (attr: PathCarrier): readonly string[] =>
  attr.__path ?? [attr.ident];

export const cardsOf = (attr: PathCarrier): readonly Cardinality[] =>
  attr.__cards ?? [attr.cardinality ?? "one"];

/** Reversal flag per hop. A path with no reversed hop reports all `false`. */
export const revsOf = (attr: PathCarrier): readonly boolean[] =>
  attr.__revs ?? pathOf(attr).map(() => false);

/** The value an attr compares against: its Schema's type, `unknown` if untyped. */
export type AttrValue<A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

/** What names an entity in a value position: a raw eid, or an `Eid` row cell. */
export type EidLike = number | { readonly id: number };

type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;

/**
 * Where `.orDefault` is defined: a **card-one scalar**. A card-many attribute
 * has no missing value to stand in for — it is `[]`, which is already an
 * answer — and a ref reaches an entity, whose stand-in would have to be a
 * whole shape, not a value. `:db/id` is a ref here, and is never missing.
 */
type IsDefaultable<A> = IsMany<A> extends true
  ? false
  : A extends { readonly valueType: "ref" }
    ? false
    : true;

/** Does this node end on a ref (a backlink is one, read the other way)? */
const isRefNav = (attr: PathCarrier): boolean =>
  (attr as { valueType?: unknown }).valueType === "ref";

// ── select shapes ──────────────────────────────────────────────────────────

/**
 * `.select` on a ref: a named shape, `all(N)` — the target's wildcard
 * row — or `again(n)`, which re-applies the enclosing shape. A card-many
 * ref (or backlink) also takes its pull-phase constraints here, as one
 * options record — see {@link NestedOpts}.
 */
type RefSelect<A> = {
  <const D extends RecurDepth>(shape: Again<D>, opts?: SelectOpts<A>): SelectNested<A, Again<D>>;
  <const N extends AnyEntity>(shape: AllShape<N>, opts?: SelectOpts<A>): SelectNested<A, AllShape<N>>;
  <const S extends Shape>(shape: S & ValidShape<S>, opts?: SelectOpts<A>): SelectNested<A, S>;
};

/** Where select options are legal: only a card-many collection has elements
 * to filter, order, and page. A card-one ref rejects the record. */
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
  // a filtered card-many *scalar* is the field itself — its elements are
  // values, so there is no shape to select through it
  | { readonly _tag: "collection"; readonly attr: unknown };

export type Shape = { readonly [key: string]: ShapeField };

/**
 * `S`, with every invalid field replaced by the error naming it. Used as
 * `shape: S & ValidShape<S>`: the intersection still infers `S` from the
 * argument, and a rejected field has nowhere to go.
 */
export type ValidShape<S> = {
  readonly [K in keyof S]: IsAgainTerm<S[K]> extends true
    ? AgainAsField<K & string>
    : IsAgainSelectField<S[K]> extends true
      ? AgainSelectField<S[K], S, K & string>
      : S[K];
};

/** The attribute a shape field hangs on, peeling `.optional` / `.orDefault` / `.select`. */
type ShapeAttrOf<F> = F extends { readonly _tag: "optional" | "default"; readonly field: infer I }
  ? ShapeAttrOf<I>
  : F extends { readonly _tag: "select" | "nested" | "collection"; readonly attr: infer A }
    ? A
    : F;

/**
 * `S`, with every field that is not a member of `N`'s stamped field map
 * replaced by an error naming it. Used as `S & FocusShape<N, S>` the same
 * way {@link ValidShape} is — a foreign entity's attribute has nowhere to go.
 */
type IsReverseField<A> = A extends { readonly __reverse: true } ? true : false;

export type FocusShape<N extends AnyEntity, S> = {
  readonly [K in keyof S]: [IsReverseField<ShapeAttrOf<S[K]>>] extends [true]
    ? S[K]
    : [AttrIdent<ShapeAttrOf<S[K]>>] extends [FocusIdents<N>]
      ? S[K]
      : `select field "${K & string}" is not an attribute of the focus entity`;
};

/** A select argument constrained to the focus entity's attributes. */
export type FocusSelect<N extends AnyEntity, S> = S extends AllShape<infer M>
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

/** A card-many **ref** (a many forward ref, or an ordinary backlink):
 * the hop with elements a nested collection can order and page. */
type IsManyRef<A> = IsMany<A> extends true
  ? A extends { readonly valueType: "ref" }
    ? true
    : false
  : false;

/**
 * A sort key for a nested collection: a card-one attribute of the element.
 */
export type NestedOrderKey = PathCarrier & {
  readonly cardinality?: "one";
};

/**
 * One `where` predicate for a nested collection: a filter fragment over the
 * element. A ref collection's element is an entity var — the same fragments
 * the pipe uses (`is`, `has`, `Q.not(…)`, any userland combinator built from
 * the kernel) apply verbatim. A card-many **scalar**'s element is the value
 * itself, so the fragment is handed the value var directly:
 * `values(User.tags, { where: [(v) => Q.startsWith(v, "a")] })`.
 */
export type NestedElemPred<A> = A extends { readonly valueType: "ref" }
  ? (focus: Var<EidCell>) => Iterable<unknown>
  : (v: Var<AttrValue<A>>) => Iterable<unknown>;

/** One sort key with its direction: `{ key: Comment.createdAt, dir: "desc" }`.
 * `dir` defaults to `"asc"`; `empty` places elements the key reaches no
 * value for (default `"last"`, in both directions). */
export interface NestedOrderSpec {
  readonly key: NestedOrderKey;
  readonly dir?: OrderDir;
  readonly empty?: OrderEmpty;
}

/** The `orderBy` option: a bare key (ascending), one keyed record, or an
 * array of either for a multi-key sort. */
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

/**
 * Predicate-free stamp on every attribute reference: the pull-shaping
 * methods. `.optional` / `.orDefault` wrap the receiver; `.select` opens a
 * nested shape on a ref, and a card-many ref's pull-phase constraints ride
 * its options record ({@link NestedOpts}).
 */
export type AttrNav<A extends PathCarrier> = A & {
  readonly optional: ReturnType<typeof optional<A>>;
  /**
   * Card-one scalar only: read a missing datom as `value`. It lowers to the
   * pull's `:default`, so the peer substitutes it — the row is kept without a
   * required clause, nothing is written, and the field's type is the
   * attribute's, not `| undefined`. See {@link IsDefaultable}.
   */
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

/** Lower a {@link NestedOpts} record into the wire's nested constraints.
 * Eager and total, like every shape-side lowering. */
const lowerNestedOpts = (attr: PathCarrier, opts: NestedOpts<never>): PullNestedConstraints => {
  for (const key of Object.keys(opts)) {
    if (key !== "where" && key !== "orderBy" && key !== "limit" && key !== "offset") {
      throw new Error(
        `ramose/query: unknown select option "${key}" — a nested collection takes { where, orderBy, limit, offset }`,
      );
    }
  }
  const out: {
    where?: PullNestedConstraints["where"];
    order?: PullNestedConstraints["order"];
    limit?: number;
    offset?: number;
  } = {};
  if (opts.where !== undefined) {
    out.where = lowerElemFilter(opts.where as readonly ElemFilterFragment[], attr);
  }
  if (opts.orderBy !== undefined) {
    if (!isRefNav(attr)) {
      throw new Error(
        `ramose/query: orderBy on ${pathOf(attr).join(" → ")} — a scalar collection's elements are its values; only a reference collection has attributes to sort by`,
      );
    }
    const keys = Array.isArray(opts.orderBy)
      ? (opts.orderBy as readonly (NestedOrderKey | NestedOrderSpec)[])
      : [opts.orderBy as NestedOrderKey | NestedOrderSpec];
    out.order = keys.map((k) =>
      isOrderSpec(k)
        ? lowerElemOrder(k.key, k.dir ?? "asc", k.empty)
        : lowerElemOrder(k, "asc", undefined),
    );
  }
  if (opts.limit !== undefined) out.limit = nestedCount(opts.limit, "limit");
  if (opts.offset !== undefined) out.offset = nestedCount(opts.offset, "offset");
  return out;
};

/** Select options need a collection: only a card-many hop has elements to
 * filter, order, and page. */
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
  /** Pull-phase constraints (`:where` / `:order` / `:limit` / `:offset`). */
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

/** Stamp an attribute reference with the pull-shaping methods. */
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
    // like `.optional`, it wraps the *receiver* (issue #69)
    orDefault(this: PathCarrier, value: unknown) {
      return pullDefault(this, value);
    },
  };

  return new Proxy(attr, {
    get(target, prop, receiver) {
      // `.optional` wraps the *receiver*, so a reversed node keeps its flags
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

/**
 * `all(N)` is a shape, not a field: there is no attribute to hang a
 * wildcard on. `ref.select(all(N))` is the nested form — a SelectNested,
 * not a bare AllShape — and lowers to the peer's `[*]` on that hop.
 */
const assertNotAll = (shape: unknown, key?: string): void => {
  if (!isAllShape(shape)) return;
  throw new Error(
    key === undefined
      ? "ramose/query: all(N) is a shape — write `select(Ramose.all(N))` on the query itself, not as the contents of a field map"
      : `ramose/query: select field "${key}": all(N) is a shape, not a field — write \`ref.select(Ramose.all(N))\``,
  );
};

/** Convert a select shape into the literate pull map `lowerPullPattern` knows. */
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

// ── the row a shape denotes ────────────────────────────────────────────────

export type SelectResult<S> = {
  readonly [K in keyof S]: SelectFieldResult<S[K], S>;
};

/**
 * A nested `.select`: a named shape, `all(N)`, or `again(n)` — {@link Unroll}
 * of the enclosing shape, an array when the hop is cardinality-many.
 */
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
  ? // the default stands in for the missing datom: the field always reads,
    // so it is the attribute's own type — never `| undefined`
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
      : // a filtered scalar collection reads as the attribute's own array
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
          ? // the cell is the raw id number, branded with `N.id`'s namespace
            IdCell<F>
          : Card extends "many"
            ? readonly SchemaType<F>[]
            : SchemaType<F>
        : F extends { readonly ident: ":db/id" }
          ? IdCell<F>
          : never;

// ── lowering helpers shared with the kernel query surface ──────────────────

let fresh = 0;
const gensym = (prefix: string) => `?${prefix}${fresh++}`;

/** @internal The lowering pass resets for deterministic names. */
export const resetGensym = () => {
  fresh = 0;
};

/** The pseudo-attribute: the entity variable itself, never a datom. */
const ID = ":db/id";

/**
 * `[?e :a ?j] [?j :b <value>]` — the join chain a path of idents walks.
 * A reversed hop is the same datom read the other way: `[?j :a ?e]`.
 */
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

/**
 * Bind a sort variable to the value at `path` **without dropping rows**: one
 * or-join branch walks the path, the other proves it is absent and grounds
 * `null`, which the engine places per the key's `empty`. (`get-else` cannot
 * stand in: a function binding of `null` drops the row.)
 */
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

/**
 * The row-dropping half of `filterPull`, as `where` clauses — so the peer's
 * row set is already the one the client keeps and `:limit` pages it honestly.
 *
 * A required cardinality-one field must be present (a nested one recursively,
 * through the ref); `.optional` and cardinality-many fields never drop the
 * row (a missing many is `[]`), and `:db/id` is always there.
 *
 * The card-one backlink of a component ref is required like any other card-one
 * field, and its clause reads the datom backwards — the entity that must exist
 * is the *owner* pointing at this row.
 *
 * A defaulted field is not required either — the whole point of `.orDefault`
 * is that the entity without the datom is a row, reading as the default. A
 * clause here would drop exactly the rows it exists to keep, and `:limit`
 * would page a set the client never sees.
 */
export const requiredClauses = (e: string, pattern: unknown): unknown[] => {
  // a wildcard has no required field: every key is optional
  if (Array.isArray(pattern) || isAllShape(pattern) || isAgain(pattern)) return [];
  const out: unknown[] = [];
  for (const [key, field] of Object.entries(fieldsOf(pattern))) {
    const info = inspectPullField(field);
    // a multi-hop field would ask `?e` for the *leaf* ident and drop rows for
    // a datom they were never meant to have — reject it here too, not just in
    // the pull pattern, because this half runs first
    assertDirectField(key, info.attr, info.nestedPattern !== undefined);
    if (info.optional || info.many || info.hasDefault) continue;
    const ident = lowerAttr(info.attr);
    if (ident === ID) continue;
    // a backlink reads the datom the other way: the required entity is the one
    // *pointing at* `?e` (a component backlink is card-one, so it gets here)
    if (info.nestedPattern === undefined || isAgain(info.nestedPattern)) {
      out.push(info.reverse ? [gensym("r"), ident, e] : [e, ident, "_"]);
      continue;
    }
    const target = gensym("r");
    const sub = requiredClauses(target, info.nestedPattern);
    if (info.reverse) {
      // the entity position of a clause has to be a variable, never `_`
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
