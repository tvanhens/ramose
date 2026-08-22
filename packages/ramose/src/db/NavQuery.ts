/**
 * Navigational query values — the read surface. Shipped language is on the
 * website query pages; remaining work lives on GitHub issue #18.
 *
 * `Ramose.query(Todo).where(...).select(...).orderBy(...).limit(n)` builds a
 * {@link NavQuery} value. `db.q` / `db.live` run it. Datalog is the IR: we
 * lower to `{ find: [["pull", "?e", pattern]], where, order, limit, offset }`
 * so the peer does pull-in-query (no client N+1) and sorts and pages the row
 * set itself — the client never sees the rows a page dropped. `.one()` /
 * `.oneOrFail()` are the same page, asked for one (or two) rows and unwrapped.
 * `.count()` / `.aggregate` / `.groupBy` lower to the engine's existing
 * aggregate find elems; `.having` is a post-group filter on those cells
 * (a new `:having` section — aggregates are not bound until after grouping);
 * `.after(cursor)` is a keyset seek on the sort keys.
 *
 * Everything that changes the row count is lowered: `.orderBy` binds a sort
 * variable, and a required (non-`.optional`) selected field becomes a `where`
 * clause, so `:limit 20` really is twenty rows the client keeps.
 */

import type {
  PullElemCmp,
  PullElemOp,
  PullElemOrder,
  PullElemPred,
} from "../internal/core/query/ast.ts";
import { lowerAttr } from "./attrRef.ts";
import type { AnyAttribute, Cardinality } from "./Attribute.ts";
import { type Eid, makeEid } from "./Eid.ts";
import { NotOne, ParamError } from "./Errors.ts";
import type { AnyNamespace } from "./Namespace.ts";
import {
  bindParams,
  isParam,
  normalizeBound,
  type AnyParam,
  type AnyParamSet,
  type BindingsOfSet,
  type Param,
  type ParamBinder,
  type ParamIn,
  type ScopeOf,
} from "./Params.ts";
import {
  type Again,
  type AgainAsField,
  type AgainMissingId,
  type AgainNsMismatch,
  type AgainTargetNs,
  type AllRow,
  type AllShape,
  type HasAgainSelect,
  type HasIdField,
  type IdCell,
  type IsAgainSelectField,
  type IsAgainTerm,
  type PullDefault,
  type PullNestedConstraints,
  type RecurDepth,
  type ShapeNs,
  type TopLevelAgain,
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
  lowerPullPattern,
  nested,
  optional,
  pullDefault,
  reshapePullResult,
} from "./Pull.ts";
import { isSelfRefSchema, refTargetOf } from "./valueTypes.ts";

// ── markers ────────────────────────────────────────────────────────────────

export type PredTag =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "startsWith"
  | "endsWith"
  | "includes"
  | "matches"
  | "in"
  | "is"
  | "exists"
  | "missing";

/**
 * The scope one `attr.each` predicate needs to be inside of: the element of
 * the attribute named by `I`. It rides along as a phantom on {@link Predicate}
 * so a `.each` predicate is a type error anywhere but inside that attribute's
 * `every` / `none` / `some` / `where` / `orderBy` — the only places where
 * "the value itself" denotes anything.
 */
export type EachOf<I extends string> = { readonly __each: I };

/**
 * A closed predicate over a path of attribute idents from the query root.
 * `PS` is the bindings record of the params set its value hole (if any)
 * belongs to — `never` for a literal — so `.where` can reject a predicate
 * whose hole the query is not scoped to.
 */
export interface Predicate<E = never, PS = never> {
  readonly _tag: "Predicate";
  readonly op: PredTag;
  /**
   * Idents from the root entity, e.g. `[":todo/owner", ":user/name"]`. Empty
   * for an `attr.each` predicate: the element *is* the value, so there is no
   * hop to walk (see {@link each}).
   */
  readonly path: readonly string[];
  /** Which hops are walked backwards (`.reverse`) — parallel to `path`. */
  readonly revs?: readonly boolean[];
  /** The comparison operand — a literal, or a {@link Param} hole for one. */
  readonly value?: unknown;
  /**
   * Set by `attr.each`: the ident of the attribute whose element the empty
   * path denotes. Checked when the predicate is placed, so an element cursor
   * cannot escape into a scope where it means nothing.
   */
  readonly each?: string;
  /**
   * Set by a `.having` cell: the group-key or aggregate alias this
   * comparison names. A predicate with `cell` belongs in `.having`, not
   * `.where` — it names a group, not a matched row.
   */
  readonly cell?: string;
  /** Phantom — see {@link EachOf}. Never present at runtime. */
  readonly _elem?: E;
  /** Phantom — the params scope of this node's holes. Never at runtime. */
  readonly _pscope?: PS;
}

/** How a quantified predicate reads the elements of a cardinality-many hop. */
export type Quantifier = "some" | "every" | "none";

/**
 * `attr.some(pred)` / `.every(pred)` / `.none(pred)` on a cardinality-many
 * attribute: `pred` is rooted at the hop's *element* — the ref's target, or
 * the value itself (`attr.each`) for a cardinality-many scalar — and the
 * quantifier says how many elements must satisfy it.
 *
 * `every` and `none` are vacuously true when the hop has no elements at all —
 * "no element fails" and "no element matches" are both true of nothing.
 *
 * The element scope is discharged here, so a `Quantified` is unbranded: it may
 * stand anywhere a where-node may.
 */
export interface Quantified<PS = never> {
  readonly _tag: "Quantified";
  readonly quant: Quantifier;
  /** Idents from the root entity down to (and including) the many hop. */
  readonly path: readonly string[];
  readonly cards: readonly Cardinality[];
  readonly revs: readonly boolean[];
  /** Rooted at the element the path ends on, not at the query root. */
  readonly pred: AnyWhereNode;
  /** Phantom — the params scope of the inner node's holes. Never at runtime. */
  readonly _pscope?: PS;
}

/**
 * Disjunction of where-nodes. Nestable: a branch is itself a predicate, an
 * `Or` or a `Not` — never a `When`, whose off state (`[]`, always true)
 * would make a branch vacuous — and every branch is scoped to the query root
 * entity, so the join variables a branch invents stay inside it.
 */
export interface Or<E = never, PS = never> {
  readonly _tag: "Or";
  readonly preds: readonly WhereNode<E, PS>[];
}

/** Negation of a where-node, scoped to the query root entity. */
export interface Not<E = never, PS = never> {
  readonly _tag: "Not";
  readonly pred: WhereNode<E, PS>;
}

/**
 * What a combinator takes: a predicate or a combinator over predicates. `E`
 * is the element scope its `attr.each` predicates need (see {@link EachOf});
 * a node that names no element is scopeless, and fits anywhere. `PS` is the
 * params scope of the holes it references — `never` when it has none.
 *
 * `When` is deliberately not here: it is a top-level where-node only, so
 * `when` inside `or` / `not` (and inside `when` itself) is a type error.
 */
export type WhereNode<E = never, PS = never> =
  | Predicate<E, PS>
  | Or<E, PS>
  | Not<E, PS>
  | Quantified<PS>;

/** A where-node in any element scope — what the lowerer walks. */
export type AnyWhereNode = WhereNode<unknown, any>;

/**
 * `Ramose.when(gate, ...clauses)` — clauses that are part of the query only
 * while the gate is on. The gate is a `Param<boolean>` (on when bound `true`)
 * or a `Ramose.optional` param (on when bound at all — and inside the body
 * that param is bound, so referencing it there is always legal). Never a JS
 * predicate: the spec stays pure data.
 *
 * Gate on, the clauses lower exactly as if written inline; gate off, they
 * lower to nothing. A gate changes which **rows**, never the row's shape.
 */
export interface When<PS = never> {
  readonly _tag: "When";
  readonly gate: AnyParam;
  readonly clauses: readonly WhereNode<never, unknown>[];
  /** Phantom — the params scope of the gate and clauses. Never at runtime. */
  readonly _pscope?: PS;
}

export const isWhen = (x: unknown): x is When<unknown> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "When";

/** The error a `when` with an ungateable param resolves to. */
type ValidGate<G> = G extends Param<any, any, true>
  ? unknown
  : G extends Param<boolean, any, false>
    ? unknown
    : `Ramose.when's gate is a Param<boolean> or a Ramose.optional param — a required non-boolean param has no off state`;

export const when: <G extends AnyParam, PS = never>(
  gate: G & ValidGate<G>,
  ...clauses: readonly WhereNode<never, PS>[]
) => When<ScopeOf<G> | PS> = ((
  gate: unknown,
  ...clauses: readonly AnyWhereNode[]
) => {
  if (!isParam(gate)) {
    throw new Error(
      "ramose/query: Ramose.when's gate must be a param (a Param<boolean>, or a Ramose.optional param that gates on being bound) — a JS value or predicate would fork the query object, which is the thing `when` exists to avoid",
    );
  }
  for (const c of clauses) {
    if (isWhen(c)) {
      throw new Error(
        "ramose/query: Ramose.when(...) does not nest — flatten the clauses into one when, or gate them separately",
      );
    }
    assertNoLooseElem(c);
  }
  return { _tag: "When", gate, clauses: [...clauses] };
}) as never;

/** The runtime half of keeping `when` out of `or` / `not`. */
const noWhenInside = (node: unknown, where: string): void => {
  if (isWhen(node)) {
    throw new Error(
      `ramose/query: Ramose.when(...) cannot appear inside ${where} — an off gate lowers to no clauses, which under \`or\` would make the branch vacuously true. Lift the when to the query's own .where(...)`,
    );
  }
};

/**
 * `Ramose.or(a, b, …)` — a row matches when **any** branch does. Lowers to
 * `or-join` on the root entity variable, so branches need not bind the same
 * variables. `or()` with no branches matches nothing.
 */
export const or = <E = never, PS = never>(
  ...preds: readonly WhereNode<E, PS>[]
): Or<E, PS> => {
  for (const p of preds) noWhenInside(p, "or(...)");
  return { _tag: "Or", preds: [...preds] };
};

/**
 * `Ramose.not(pred)` — a row matches when `pred` does **not**. Lowers to
 * `not-join` on the root entity variable, so `not(or(…))` and
 * `not(Todo.due.missing())` nest the way they read.
 */
export const not = <E = never, PS = never>(
  pred: WhereNode<E, PS>,
): Not<E, PS> => {
  noWhenInside(pred, "not(...)");
  return { _tag: "Not", pred };
};

export const isOr = (x: unknown): x is Or<unknown, any> =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Or";

export const isNot = (x: unknown): x is Not<unknown, any> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Not";

export const isQuantified = (x: unknown): x is Quantified<any> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Quantified";

/**
 * A constrained cardinality-many **scalar** as a select field. It carries no
 * `.select` — there is no shape to ask a string for — so the collection nav
 * *is* the field, and `select: never` is what tells it apart from a ref
 * collection, which still needs its `.select({ … })`.
 */
export interface ScalarCollectionField {
  readonly _tag: "collection";
  readonly select: never;
}

export type ShapeField =
  | AnyAttribute
  | PathCarrier
  | ScalarCollectionField
  | Again
  | { readonly _tag: "optional"; readonly field: unknown }
  | { readonly _tag: "default"; readonly field: unknown; readonly value: unknown }
  | { readonly _tag: "nested"; readonly attr: unknown; readonly pattern: unknown }
  | {
      readonly _tag: "select";
      readonly attr: unknown;
      readonly shape: Shape | AllShape | Again;
    };

export type Shape = { readonly [key: string]: ShapeField };

/**
 * Is this field a path that walked a ref before naming its attribute? True
 * through `.optional` / `.orDefault` and through a nested `.select`, which
 * carry the field they wrap.
 */
type IsHopped<F> = F extends {
  readonly _tag: "optional" | "default";
  readonly field: infer Inner;
}
  ? IsHopped<Inner>
  : F extends { readonly _tag: "select" | "nested"; readonly attr: infer A }
    ? [A] extends [Hop]
      ? true
      : false
    : [F] extends [Hop]
      ? true
      : false;

/**
 * The error a multi-hop select field resolves to. It is a string, so the
 * attribute the caller passed is not assignable to it and the call is a type
 * error that names the offending key — the runtime message
 * (`assertDirectField`) spells the nested select to write instead.
 */
type MultiHopField<K extends string> =
  `select field "${K}" is a multi-hop path: a select field must be a direct attribute of the queried namespace — use a nested select, e.g. { owner: Todo.owner.select({ name: User.name }) }`;

/** Is this field an element cursor (`attr.each`), through the markers too? */
type IsElement<F> = F extends {
  readonly _tag: "optional" | "default";
  readonly field: infer Inner;
}
  ? IsElement<Inner>
  : F extends { readonly __each: string }
    ? true
    : false;

/**
 * The error an element cursor used as a select field resolves to. `.each` is
 * one value of a collection, in scope only inside that collection's own
 * quantifiers and constraints — the *field* is the collection.
 */
type ElementField<K extends string> =
  `select field "${K}" is an element cursor: \`.each\` names one value of a card-many attribute, and is only meaningful inside its own every / none / some / where / orderBy — select the attribute itself, e.g. { tags: User.tags }`;

/**
 * `S`, with every multi-hop field replaced by {@link MultiHopField} and every
 * element cursor by {@link ElementField}. Used as `shape: S & ValidShape<S>`:
 * the intersection still infers `S` from the argument, and a rejected field
 * has nowhere to go.
 */
export type ValidShape<S> = {
  readonly [K in keyof S]: IsAgainTerm<S[K]> extends true
    ? AgainAsField<K & string>
    : IsHopped<S[K]> extends true
      ? MultiHopField<K & string>
      : IsElement<S[K]> extends true
        ? ElementField<K & string>
        : IsAgainSelectField<S[K]> extends true
          ? AgainSelectField<S[K], S, K & string>
          : S[K];
};

type AgainSelectField<F, S, K extends string> = HasIdField<S> extends true
  ? AgainNsField<F, S, K>
  : AgainMissingId;

type AgainNsField<F, S, K extends string> = AgainTargetNs<F> extends ShapeNs<S>
  ? F
  : AgainNsMismatch<K, ShapeNs<S> & string>;

/**
 * `.select` on a ref: a named shape, `all(N)` — the target's wildcard
 * row — or `again(n)`, which re-applies the enclosing shape.
 */
type RefSelect<A> = {
  <const D extends RecurDepth>(shape: Again<D>): SelectNested<A, Again<D>>;
  <const N extends AnyNamespace>(shape: AllShape<N>): SelectNested<A, AllShape<N>>;
  <const S extends Shape>(shape: S & ValidShape<S>): SelectNested<A, S>;
};

export type OrderEmpty = "first" | "last";
export type OrderDir = "asc" | "desc";

/**
 * One sort key, as a path of idents from the query root. Lowering binds it to
 * an order variable the peer sorts on; `empty` places rows whose path has no
 * value, in both directions, and defaults to `"last"`.
 *
 * Multi-hop paths keep such rows: the order variable is bound through an
 * `or-join` whose second branch grounds `null` when the path is absent.
 */
export interface OrderBy {
  readonly path: readonly string[];
  /**
   * Parallel to `path`. `.orderBy` rejects a key that crosses a
   * cardinality-many hop (the sort key would be a set), so the only reversed
   * hop that can appear here is the card-one one: the backlink of a
   * `:db/isComponent` ref, which reaches at most one entity. Lowering reads
   * the two together and flips that hop's datom.
   */
  readonly revs?: readonly boolean[];
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

/** A top-level where entry: an ordinary node, or a param-gated {@link When}. */
export type TopWhereNode = WhereNode<never, unknown> | When<unknown>;

// ── keyset paging ───────────────────────────────────────────────────────────

/**
 * Where a page ended — feed it to `.after` to get the next one. Opaque: the
 * `keys` are the last row's sort-key values (the entity-id tie-breaker
 * included), and they mean something only to the query that minted them —
 * `.after` rejects a cursor whose shape does not fit. Keep it in memory
 * between pages; it is not designed to survive serialization (a `Date` key
 * that round-trips as a string would sort as one).
 */
export interface Cursor {
  readonly _tag: "Cursor";
  /** @internal One value per lowered `:order` key, the tie-breaker last. */
  readonly keys: readonly unknown[];
}

export const isCursor = (x: unknown): x is Cursor =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Cursor" &&
  Array.isArray((x as { keys?: unknown }).keys);

/**
 * What a cursor-paged query resolves to: the page's rows, and the cursor of
 * its last row — `null` when there is no next page (the page came back empty,
 * or shorter than its `.limit`). Without a `.limit`, a full sweep always ends
 * on one empty page: the peer cannot know the last row is the last.
 */
export interface Page<Row = unknown> {
  readonly rows: readonly Row[];
  readonly cursor: Cursor | null;
}

// ── aggregates ──────────────────────────────────────────────────────────────

/** The engine aggregate names the nav surface lowers to. */
export type AggName = "count" | "count-distinct" | "sum" | "avg" | "min" | "max";

/**
 * One field of an `.aggregate` shape: which function, over which card-one
 * path — `count()` takes none, it counts the rows themselves. Phantom `Out`
 * is the cell's type: `number` for the counts and `sum`, `| null` for
 * `avg` / `min` / `max`, whose value over no rows is no value.
 */
export interface Agg<Out = unknown> {
  readonly _tag: "Agg";
  readonly fn: AggName;
  /** The aggregated path; absent for `count()`. */
  readonly attr?: PathCarrier;
  /** Phantom — never present at runtime. */
  readonly _out?: Out;
}

/** An `.aggregate` shape: each field an {@link Agg}, keyed by its alias. */
export type AggShape = { readonly [key: string]: Agg<unknown> };

/** The row an `.aggregate` shape answers with: one cell per aggregate. */
export type AggRow<S> = {
  readonly [K in keyof S]: S[K] extends Agg<infer O> ? O : never;
};

/** A `.groupBy` shape: each key a card-one path, keyed by its alias. */
export type GroupShape = { readonly [key: string]: PathCarrier };

/**
 * The error an element cursor resolves to as a group key or an aggregate
 * argument: `.each` names one value inside a collection, and a row has the
 * collection — see {@link EachOf}.
 */
type ElementAggKey =
  `an element cursor is not an aggregate key: \`.each\` names one value of a card-many attribute — aggregate or group by a cardinality-one path instead`;

/** Rejects `attr.each` where a card-one path is needed; `unknown` otherwise. */
export type ValidAggKey<K> = K extends { readonly __each: string }
  ? ElementAggKey
  : unknown;

/** `S`, with every element-cursor key replaced by the error naming it. */
export type ValidGroupShape<S> = {
  readonly [K in keyof S]: S[K] extends { readonly __each: string }
    ? ElementAggKey
    : S[K];
};

/**
 * The error a non-numeric `sum` / `avg` argument resolves to: adding strings
 * or dates means nothing, so the attribute has to be a number-valued one.
 */
type NumericAggKey<A, F extends string> = [AttrValue<A>] extends [number]
  ? unknown
  : `${F} takes a number-valued attribute`;

/**
 * A group-key cell, as the row carries it: `:db/id` is the branded raw id
 * (the same cell `select({ id: N.id })` yields), a ref key is the target
 * entity as an {@link Eid} — catalog-unbranded, the way a bare query's rows
 * are, since a query is scoped to a namespace and not a catalog — and a
 * scalar key is its value.
 */
type GroupKeyCell<F> = F extends { readonly ident: ":db/id" }
  ? IdCell<F>
  : F extends { readonly valueType: ":db.type/ref" }
    ? Eid
    : AttrValue<F>;

/** The row a grouped query answers with: the group keys, then the aggregates. */
export type GroupedRow<G, S> = {
  readonly [K in keyof G | keyof S]: K extends keyof S
    ? S[K] extends Agg<infer O>
      ? O
      : never
    : K extends keyof G
      ? GroupKeyCell<G[K]>
      : never;
};

/**
 * One group cell as a predicate handle: the same comparisons `.where`
 * hangs on an attribute, over this grouped row's value for `T`.
 * `is` is the ref-key form (`Eid`); string tests exist when the cell is
 * a string. A JS boolean over the result is not a cell.
 */
export type HavingNav<T> = {
  readonly eq: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly ne: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly lt: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly lte: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly gt: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly gte: PredMethod<T extends { readonly id: number } ? EidLike : T, never>;
  readonly in: PredMethod<
    readonly (T extends { readonly id: number } ? EidLike : T)[],
    never
  >;
  readonly exists: () => Predicate;
  readonly missing: () => Predicate;
  readonly startsWith: string extends T ? PredMethod<string, never> : never;
  readonly endsWith: string extends T ? PredMethod<string, never> : never;
  readonly includes: string extends T ? PredMethod<string, never> : never;
  readonly matches: string extends T ? PredMethod<RegExp | string, never> : never;
  readonly is: T extends { readonly id: number } ? PredMethod<EidLike, never> : never;
};

type HavingCellType<G, S, K> = K extends keyof S
  ? S[K] extends Agg<infer O>
    ? O
    : never
  : K extends keyof G
    ? GroupKeyCell<G[K]>
    : never;

/** The cells `.having` names: group-key aliases and aggregate aliases. */
export type HavingCells<G, S> = {
  readonly [K in keyof G | keyof S]: HavingNav<HavingCellType<G, S, K>>;
};

/** @internal A group key, lowered: alias, path, and how its cell reads. */
export interface GroupKeySpec {
  readonly alias: string;
  readonly path: readonly string[];
  readonly revs: readonly boolean[];
  /** `ref` wraps the raw id in an `Eid`; `id` and `value` pass through. */
  readonly cell: "ref" | "id" | "value";
}

/** @internal One aggregate field, lowered: alias, engine fn, path if any. */
export interface AggFieldSpec {
  readonly alias: string;
  readonly fn: AggName;
  readonly path?: readonly string[];
  readonly revs?: readonly boolean[];
}

/**
 * The path an aggregate summarizes or a group is keyed by: card-one from the
 * row — a many hop is a set per row, and a set is not one value. (This is
 * `.orderBy`'s rule, for the same reason.)
 */
const aggPath = (what: string, attr: PathCarrier): PathCarrier => {
  const path = pathOf(attr);
  if (attr.__each !== undefined) {
    throw new Error(`ramose/query: ${eachScopeHint(attr.__each)}`);
  }
  if (cardsOf(attr).includes("many")) {
    throw new Error(
      `ramose/query: ${what}(${path.join(" → ")}) crosses a cardinality-many attribute — an aggregate summarizes one value per row, and a many hop is a set of them`,
    );
  }
  return attr;
};

const agg = <Out>(fn: AggName, what: string, attr: PathCarrier): Agg<Out> => ({
  _tag: "Agg",
  fn,
  attr: aggPath(what, attr),
});

/** `Ramose.count()` — how many rows the query matches. */
export const count = (): Agg<number> => ({ _tag: "Agg", fn: "count" });

/** `Ramose.countDistinct(attr)` — how many distinct values the path has. */
export const countDistinct = <K extends PathCarrier>(
  attr: K & ValidAggKey<K>,
): Agg<number> => agg("count-distinct", "countDistinct", attr as PathCarrier);

/** `Ramose.sum(attr)` — the sum of a number attribute, `0` over no rows. */
export const sum = <K extends PathCarrier>(
  attr: K & ValidAggKey<K> & NumericAggKey<K, "sum">,
): Agg<number> => agg("sum", "sum", attr as PathCarrier);

/** `Ramose.avg(attr)` — the mean of a number attribute, `null` over no rows. */
export const avg = <K extends PathCarrier>(
  attr: K & ValidAggKey<K> & NumericAggKey<K, "avg">,
): Agg<number | null> => agg("avg", "avg", attr as PathCarrier);

/** `Ramose.min(attr)` — the least value the path has, `null` over no rows. */
export const min = <K extends PathCarrier>(
  attr: K & ValidAggKey<K>,
): Agg<AttrValue<K> | null> => agg("min", "min", attr as PathCarrier);

/** `Ramose.max(attr)` — the greatest value the path has, `null` over no rows. */
export const max = <K extends PathCarrier>(
  attr: K & ValidAggKey<K>,
): Agg<AttrValue<K> | null> => agg("max", "max", attr as PathCarrier);

export interface NavQuerySpec {
  readonly ns: string;
  /** Attribute idents that define membership in `ns` (for bare scope). */
  readonly nsIdents: readonly string[];
  readonly where: readonly TopWhereNode[];
  /** A selected shape, the wildcard (`all(N)`), or neither — bare ids. */
  readonly shape: Shape | AllShape | undefined;
  readonly orderBy: readonly OrderBy[];
  readonly limit: number | AnyParam | undefined;
  readonly offset: number | AnyParam | undefined;
  /**
   * `.one()` / `.oneOrFail()` — unwrap the page to a single row. Lowering
   * forces `:limit 1` or `:limit 2` so the peer never sends a whole page
   * for the client to discard.
   */
  readonly take: "one" | "oneOrFail" | undefined;
  /** The params set `Ramose.query(N, P)` scoped this query to, if any. */
  readonly params: AnyParamSet | undefined;
  /** Group keys, set by `.groupBy` — only ever together with `aggregate`. */
  readonly groupBy: readonly GroupKeySpec[] | undefined;
  /** Aggregate fields, set by `.aggregate` and the scalar sugars. */
  readonly aggregate: readonly AggFieldSpec[] | undefined;
  /**
   * Post-group predicates, set by `.having`. Evaluated on the server
   * against the grouped row's cells; groups that fail never become rows.
   */
  readonly having: readonly TopWhereNode[] | undefined;
  /** `.count()` & friends: unwrap the one aggregate row to its one cell. */
  readonly aggScalar: boolean;
  /** Keyset paging: `null` is the first page, `undefined` — not paged. */
  readonly after: Cursor | null | undefined;
}

/**
 * A navigational query value. Phantom `R` is what the query resolves to:
 * a **rows array** by default (`readonly SelectResult<S>[]` after `.select`,
 * `readonly Eid[]` without), one row or `null` after `.one()`, one row after
 * `.oneOrFail()`. {@link Row} names the element either way. Phantom `P` is
 * the bindings record its params resolve against — `never` for a query with
 * none — and is what makes `db.q(q, { … })` typed.
 */
export interface NavQuery<R = unknown, P = never> {
  readonly _tag: "NavQuery";
  readonly spec: NavQuerySpec;
  readonly _result?: R;
  /** Phantom — the bindings record. Never present at runtime. */
  readonly _params?: P;
}

export const isNavQuery = (x: unknown): x is NavQuery<unknown, any> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "NavQuery";

// ── path / predicate helpers (stamped onto attrs by Namespace) ─────────────

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
   * `:db/isComponent` one, whose referrer is unique — that backlink is
   * card-one, and `__cards` says so.
   */
  readonly __revs?: readonly boolean[];
  /** @internal Set on the node `attr.reverse` returns. */
  readonly __reverse?: boolean;
  /**
   * @internal Set on the node `attr.each` returns: the ident of the attribute
   * whose element this is. The node's `__path` is empty — the element is the
   * value itself, not something reached from it.
   */
  readonly __each?: string;
};

/**
 * The type-level twin of a non-empty `__path`: every attribute reached
 * *through* a ref hop (`Todo.owner.name`, `Book.author.reverse.title`) is
 * stamped with it, so `.select` can reject a flattened multi-hop field — the
 * pull would ask the queried entity for the leaf ident, which is not one of
 * its attributes. Nothing reads it at runtime; {@link pathOf} does that.
 */
export type Hop = { readonly __hop: true };

/** Stamp a hop's target map: reaching any of its attrs costs a hop. */
export type Hopped<M> = { readonly [K in keyof M]: HopAttr<M[K]> };

/**
 * One attribute of a hop's target. The mark has to survive the field wrappers
 * a select shape takes, so `.optional`, `.orDefault` and `.select` are
 * re-stamped here — they are declared in terms of `AttrNav`'s own (unmarked)
 * parameter, and an intersection cannot reach inside it. `.reverse` off a hop
 * is left to the runtime check.
 */
type HopAttr<F> = {
  readonly select: F extends { readonly valueType: ":db.type/ref" }
    ? RefSelect<F & Hop>
    : never;
  readonly optional: { readonly _tag: "optional"; readonly field: F & Hop };
  readonly orDefault: IsDefaultable<F> extends true
    ? (value: AttrValue<F>) => PullDefault<F & Hop>
    : never;
} & F &
  Hop;

export const pathOf = (attr: PathCarrier): readonly string[] =>
  attr.__path ?? [attr.ident];

export const cardsOf = (attr: PathCarrier): readonly Cardinality[] =>
  attr.__cards ?? [attr.cardinality ?? "one"];

/** Reversal flag per hop. A path with no reversed hop reports all `false`. */
export const revsOf = (attr: PathCarrier): readonly boolean[] =>
  attr.__revs ?? pathOf(attr).map(() => false);

const pred = (
  op: PredTag,
  attr: PathCarrier,
  value?: unknown,
): Predicate => ({
  _tag: "Predicate",
  op,
  path: pathOf(attr),
  revs: revsOf(attr),
  ...(attr.__each !== undefined ? { each: attr.__each } : {}),
  value,
});

/** The value an attr compares against: its Schema's type, `unknown` if untyped. */
export type AttrValue<A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

/** What names an entity in a predicate: a raw eid, or an {@link Eid} row cell. */
export type EidLike = number | { readonly id: number };

/**
 * The element type of `in(...)`. A ref (including the `:db/id`
 * pseudo-attribute) takes entities; anything else takes its Schema's type.
 */
export type InValue<A> = A extends { readonly valueType: ":db.type/ref" }
  ? EidLike
  : AttrValue<A>;

/**
 * `some` / `every` / `none` quantify over the elements a hop reaches, so they
 * are defined exactly on cardinality-many attributes — including the many hop
 * an ordinary `.reverse` backlink is. The backlink of a component ref is
 * card-one (one owner), so it has no elements and they are `never` there.
 *
 * A cardinality-many *scalar* has elements too: its values. They are named by
 * {@link AttrNav.each}, so `User.tags.every(User.tags.each.startsWith("a"))`
 * says what a bare predicate on a many scalar (already "some value matches")
 * cannot.
 */
type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;

/**
 * Where `.orDefault` is defined: a **card-one scalar**. A card-many attribute
 * has no missing value to stand in for — it is `[]`, which is already an
 * answer — and a ref reaches an entity, whose stand-in would have to be a
 * whole shape, not a value. `:db/id` is a ref here, and is never missing.
 */
type IsDefaultable<A> = IsMany<A> extends true
  ? false
  : A extends { readonly valueType: ":db.type/ref" }
    ? false
    : true;

/** The attribute a nav ends on, as its ident — the identity of its element. */
type AttrIdent<A> = A extends { readonly ident: infer I extends string }
  ? I
  : string;

/** What an `attr.each` predicate is written against, inside `attr`'s scope. */
type ElemScopeOf<A> = EachOf<AttrIdent<A>>;

/**
 * `attr.each` — one element of a cardinality-many attribute, as a nav of its
 * own. It keeps the attribute's value schema, so the predicates stay typed
 * (`User.tags.each.startsWith("a")`, `User.scores.each.gt(3)`), and its path
 * is empty: the element *is* the value, not something reached from it.
 *
 * Its predicates carry {@link EachOf}, so they only fit where that element is
 * in scope — `attr.every` / `.none` / `.some` / `.where` / `.orderBy`.
 */
export type ElementNav<A extends PathCarrier> = AttrNav<
  Omit<A, "cardinality"> & {
    readonly cardinality: "one";
    readonly __each: AttrIdent<A>;
  },
  ElemScopeOf<A>
>;

/**
 * A predicate method over values of `T`: takes the literal, or a
 * {@link Param} hole for one, and carries the hole's params scope onto the
 * predicate so `.where` can check it against the query's set.
 */
export type PredMethod<T, E> = <const V extends T | ParamIn<T>>(
  value: V,
) => Predicate<E, ScopeOf<V>>;

/**
 * Predicate / shape methods attached to every stamped attr. `E` is the
 * element scope its predicates belong to: `never` for an ordinary attribute
 * (they fit anywhere), the collection's element for an `attr.each` nav.
 * Every value position also takes a `Ramose.params` hole.
 */
export type AttrNav<A extends PathCarrier, E = never> = A & {
  readonly eq: PredMethod<AttrValue<A>, E>;
  readonly ne: PredMethod<AttrValue<A>, E>;
  readonly lt: PredMethod<AttrValue<A>, E>;
  readonly lte: PredMethod<AttrValue<A>, E>;
  readonly gt: PredMethod<AttrValue<A>, E>;
  readonly gte: PredMethod<AttrValue<A>, E>;
  /** The whole list may be one hole (`in(P.ids)`); its elements may not. */
  readonly in: PredMethod<readonly InValue<A>[], E>;
  readonly startsWith: PredMethod<string, E>;
  readonly endsWith: PredMethod<string, E>;
  readonly includes: PredMethod<string, E>;
  readonly matches: PredMethod<RegExp | string, E>;
  readonly exists: () => Predicate<E>;
  readonly missing: () => Predicate<E>;
  /** Ref-only: the entity this ref points at. */
  readonly is: A extends { readonly valueType: ":db.type/ref" }
    ? PredMethod<EidLike, E>
    : never;
  /**
   * Card-many only: one element of this collection — the ref's target is an
   * entity you navigate from, a scalar's element is the value itself, which
   * is what this names. Card-one attributes have no elements, so it is
   * `never` there.
   */
  readonly each: IsMany<A> extends true ? ElementNav<A> : never;
  /** Card-many only: at least one element satisfies `pred`. */
  readonly some: IsMany<A> extends true
    ? <PS = never>(pred: WhereNode<ElemScopeOf<A>, PS>) => Quantified<PS>
    : never;
  /** Card-many only: no element fails `pred` (vacuously true when empty). */
  readonly every: IsMany<A> extends true
    ? <PS = never>(pred: WhereNode<ElemScopeOf<A>, PS>) => Quantified<PS>
    : never;
  /** Card-many only: no element satisfies `pred` (true when empty). */
  readonly none: IsMany<A> extends true
    ? <PS = never>(pred: WhereNode<ElemScopeOf<A>, PS>) => Quantified<PS>
    : never;
  /**
   * Card-many only: filter this collection, per element, on the peer. The
   * predicates are rooted at the **element** (`attr.each` for a scalar) and
   * lower to the nested pull's `:where` — never to the query's own, so the
   * outer `.limit` still counts rows and a collection that filters to nothing
   * is `[]`. Params are welcome; `Ramose.when` is not (its gate belongs on
   * the query's own `.where`).
   */
  readonly where: IsMany<A> extends true
    ? <PS = never>(
        ...preds: readonly WhereNode<ElemScopeOf<A>, PS>[]
      ) => CollectionNav<A>
    : never;
  /** Card-many only: sort this collection by a card-one key, or by `.each`. */
  readonly orderBy: IsMany<A> extends true
    ? <K extends NestedOrderKey>(
        key: K & ValidOrderKey<K, AttrIdent<A>>,
        dir?: OrderDir,
        opts?: { readonly empty?: OrderEmpty },
      ) => CollectionNav<A>
    : never;
  /** Card-many only: keep at most `n` elements. */
  readonly limit: IsMany<A> extends true
    ? (n: number | ParamIn<number>) => CollectionNav<A>
    : never;
  /** Card-many only: drop `n` elements from the front. */
  readonly offset: IsMany<A> extends true
    ? (n: number | ParamIn<number>) => CollectionNav<A>
    : never;
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
  readonly select: A extends { readonly valueType: ":db.type/ref" }
    ? RefSelect<A>
    : never;
};

/**
 * The peer compiles a `matches` pattern with `new RegExp(source)` — no flags,
 * because the pattern travels as a string and the engine's `re-find?` takes
 * one argument. A flagged `RegExp` is rejected here rather than lowered to
 * something that quietly means something else.
 */
const regexSource = (re: RegExp | string): string => {
  if (typeof re === "string") return re;
  if (re.flags !== "") {
    throw new Error(
      `ramose/query: matches(/${re.source}/${re.flags}) — the peer compiles the pattern with no flags, so \`${re.flags}\` cannot be lowered. Express it in the pattern instead (e.g. \`[aA]da\` for case-insensitivity).`,
    );
  }
  return re.source;
};

/** `Eid` row cells and raw ids are the same entity to a predicate. */
const eidValue = (ref: unknown): number => {
  if (typeof ref === "number") return ref;
  if (
    typeof ref === "object" &&
    ref !== null &&
    typeof (ref as { id?: unknown }).id === "number"
  ) {
    return (ref as { id: number }).id;
  }
  throw new Error(
    `ramose/query: is(...) takes an entity id or an Eid, got ${String(ref)}`,
  );
};

/** Does this nav end on a ref (a backlink is one, read the other way)? */
const isRefNav = (attr: PathCarrier): boolean =>
  (attr as { valueType?: unknown }).valueType === ":db.type/ref";

/** `:user/tags` → `User.tags` — the attribute as the caller writes it. */
const spellIdent = (ident: string): string => {
  const m = /^:([^/]+)\/(.+)$/.exec(ident);
  if (m === null) return ident;
  return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)}.${m[2]}`;
};

/** Where an element cursor is in scope, for the message that says it is not. */
const eachScopeHint = (ident: string): string =>
  `${spellIdent(ident)}.each is only meaningful inside ${spellIdent(ident)}.every / .none / .some / .where / .orderBy — it names one element of that collection, and nothing else has one`;

/**
 * `attr.each` — the element of a cardinality-many attribute, as a nav whose
 * path is empty: the element *is* the value. It keeps the attribute's schema
 * (so the predicates stay typed) and remembers which attribute it belongs to,
 * which is what {@link checkElemScope} checks when the predicate is placed.
 */
const eachNode = (attr: PathCarrier): PathCarrier => {
  const path = pathOf(attr);
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ramose/query: ${path.join(" → ")}.each — only a cardinality-many attribute has elements; a cardinality-one attribute is its value already`,
    );
  }
  return attachAttrNav({
    ...(attr as object),
    ident: attr.ident,
    cardinality: "one" as const,
    __path: [],
    __cards: [],
    __revs: [],
    __each: path[path.length - 1]!,
  } satisfies PathCarrier as PathCarrier);
};

/**
 * Walk a where-node that is about to be placed in `ident`'s element scope.
 *
 * An `attr.each` predicate for another attribute means nothing here, and a
 * scalar collection's element is a value, so *only* `.each` predicates can
 * constrain it — a path would have to be walked from a string. A nested
 * quantifier is left alone: it checked its own scope when it was built.
 */
const checkElemScope = (
  node: AnyWhereNode,
  ident: string,
  scalar: boolean,
  where: string,
): void => {
  if (isWhen(node)) throw new Error(nestedWhenError(where));
  if (isOr(node)) {
    for (const p of node.preds) checkElemScope(p, ident, scalar, where);
    return;
  }
  if (isNot(node)) {
    checkElemScope(node.pred, ident, scalar, where);
    return;
  }
  if (isQuantified(node)) {
    if (scalar) throw new Error(elemOnlyError(ident, where));
    return;
  }
  if (node.each !== undefined && node.each !== ident) {
    throw new Error(`ramose/query: in ${where}: ${eachScopeHint(node.each)}`);
  }
  if (scalar && node.each === undefined) throw new Error(elemOnlyError(ident, where));
};

const elemOnlyError = (ident: string, where: string): string =>
  `ramose/query: in ${where}: the elements of a cardinality-many scalar are values, not entities — write the inner predicate against the element, e.g. ${spellIdent(ident)}.each.eq(…)`;

const nestedWhenError = (where: string): string =>
  `ramose/query: in ${where}: Ramose.when(...) is not supported inside a collection constraint or quantifier — params are; put the gated clause on the query's own .where(...)`;

/**
 * Build a quantified node, rejecting the shape that cannot mean anything: a
 * card-one hop, which has no elements to quantify over. A cardinality-many
 * scalar quantifies over its values, named by `attr.each`.
 */
const quantified = (
  quant: Quantifier,
  attr: PathCarrier,
  pred: AnyWhereNode,
): Quantified => {
  const path = pathOf(attr);
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ramose/query: ${quant}(...) on ${path.join(" → ")} — only a cardinality-many attribute has elements to quantify over`,
    );
  }
  const ident = path[path.length - 1]!;
  checkElemScope(
    pred,
    ident,
    !isRefNav(attr),
    `${quant}(...) on ${path.join(" → ")}`,
  );
  return {
    _tag: "Quantified",
    quant,
    path,
    cards,
    revs: revsOf(attr),
    pred,
  };
};

/**
 * An element cursor that never reached a scope: `User.tags.each` in the
 * query's own `.where`, where there is no collection and so no element. The
 * type says so too (see {@link EachOf}); this is the runtime half.
 *
 * A quantifier is not walked into — it discharged its element scope when it
 * was built.
 */
const assertNoLooseElem = (node: AnyWhereNode | When<unknown>): void => {
  if (isWhen(node)) {
    for (const c of node.clauses) assertNoLooseElem(c);
    return;
  }
  if (isQuantified(node)) return;
  if (isOr(node)) {
    for (const p of node.preds) assertNoLooseElem(p);
    return;
  }
  if (isNot(node)) {
    assertNoLooseElem(node.pred);
    return;
  }
  if (node.each !== undefined) {
    throw new Error(`ramose/query: ${eachScopeHint(node.each)}`);
  }
};

// ── nested collections: pull-phase where / order / offset / limit ──────────

/**
 * A cardinality-many nav with pull-phase constraints attached:
 *
 * ```ts
 * Todo.owner.reverse.where(Todo.done.eq(false)).orderBy(Todo.due).limit(5)
 *   .select({ title: Todo.title })
 * User.tags.where(User.tags.each.startsWith("a")).orderBy(User.tags.each).limit(3)
 * ```
 *
 * The constraints lower to the `PullAttrSpec` fields of *this* collection
 * (`:where` / `:order` / `:offset` / `:limit`) and are evaluated inside the
 * pull, after the outer `:order` / `:offset` / `:limit` slice — they filter the
 * collection, never the rows. An element-less collection is `[]`, not a
 * dropped parent, so the outer `:limit` still counts rows the client keeps.
 *
 * A ref collection still needs its `.select({ … })`; a **scalar** one is the
 * field itself — a string has no shape — so `select` is `never` there and the
 * nav goes straight into `.select({ tags: … })`.
 */
export interface CollectionNav<A extends PathCarrier = PathCarrier> {
  readonly _tag: "collection";
  readonly attr: A;
  /**
   * Already lowered — each call lowers its argument eagerly. A params hole
   * survives the eager lowering as a leaf of the `PullElemPred` tree, and is
   * substituted with the rest of the query (see `substitutePullPattern`).
   */
  readonly constraints: PullNestedConstraints;
  where<PS = never>(
    ...preds: readonly WhereNode<ElemScopeOf<A>, PS>[]
  ): CollectionNav<A>;
  orderBy<K extends NestedOrderKey>(
    key: K & ValidOrderKey<K, AttrIdent<A>>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): CollectionNav<A>;
  limit(n: number | ParamIn<number>): CollectionNav<A>;
  offset(n: number | ParamIn<number>): CollectionNav<A>;
  readonly select: A extends { readonly valueType: ":db.type/ref" }
    ? RefSelect<A>
    : never;
}

/**
 * A sort key for a nested collection: a card-one path rooted at the element —
 * a many attribute's sort key would be a set, not a value, and is rejected
 * here at the type level (the outer `orderBy` rejects it when the query is
 * built) — or the element itself, `attr.each`.
 */
export type NestedOrderKey = PathCarrier & {
  readonly cardinality?: "one";
};

/**
 * `K`, unless it is an element cursor for some *other* collection: `.each`
 * sorts the collection it belongs to, and nothing else. A plain path carries
 * no `__each` at all, so it passes straight through.
 */
export type ValidOrderKey<K, I extends string> = K extends {
  readonly __each: infer J;
}
  ? [J] extends [I]
    ? K
    : `orderBy key is ${J & string}.each — an element cursor sorts its own collection, and this is not it`
  : K;

/** `PredTag` → the engine's builtin predicate name inside a pull `:where`. */
const PULL_OPS: Record<PredTag, PullElemOp> = {
  eq: "=",
  is: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  in: "in",
  startsWith: "starts-with?",
  endsWith: "ends-with?",
  includes: "includes?",
  matches: "re-find?",
  exists: "exists",
  missing: "missing",
};

const nsOfIdent = (ident: string): string | undefined =>
  /^:([^/]+)\//.exec(ident)?.[1];

/**
 * What a nested `where` / `orderBy` is written against: one element of the
 * collection being constrained.
 */
interface ElemScope {
  /**
   * The element's namespace: the *referring* entity of a backlink (so, the
   * ref's own namespace), or the target of a forward ref. `undefined` for an
   * untargeted ref — then paths go unchecked rather than wrongly rejected —
   * and for a scalar, which is no entity at all.
   */
  readonly ns: string | undefined;
  /** The element is the value itself: only `attr.each` can constrain it. */
  readonly scalar: boolean;
  /** The attribute whose element this is — what `.each` must name. */
  readonly ident: string;
  /** The collection's path, for the message when something does not fit. */
  readonly collection: readonly string[];
}

const elemScope = (attr: PathCarrier): ElemScope => {
  const path = pathOf(attr);
  const ident = path[path.length - 1] ?? "";
  const scalar = !isRefNav(attr);
  return { ns: elementNs(attr), scalar, ident, collection: path };
};

const elementNs = (attr: PathCarrier): string | undefined => {
  if (!isRefNav(attr)) return undefined;
  const path = pathOf(attr);
  const last = path[path.length - 1];
  if (last === undefined) return undefined;
  const revs = revsOf(attr);
  if (revs[revs.length - 1] === true) return nsOfIdent(last);
  const schema = (attr as { schema?: unknown }).schema;
  if (isSelfRefSchema(schema)) return nsOfIdent(last);
  const ns = (refTargetOf(schema)?.() as { ns?: unknown } | undefined)?.ns;
  return typeof ns === "string" ? ns : undefined;
};

/**
 * A nested path starts at the element, so it has to be one the element can
 * carry: a scalar element has no attributes at all (only `.each` names it),
 * and an entity element's first forward hop must be one of its namespace's.
 * (A first hop that is itself a backlink is rooted at the referring
 * namespace, and says nothing about the element.)
 */
const checkElementRoot = (
  scope: ElemScope | undefined,
  path: readonly string[],
  revs: readonly boolean[],
  each: string | undefined,
  what: string,
): void => {
  if (scope === undefined) return;
  const collection = scope.collection.join(" → ");
  if (each !== undefined) {
    if (each !== scope.ident) {
      throw new Error(
        `ramose/query: in nested ${what} on ${collection}: ${eachScopeHint(each)}`,
      );
    }
    return;
  }
  if (scope.scalar) {
    throw new Error(
      `ramose/query: nested ${what}(${path.join(" → ")}) on ${collection} is rooted at the collection's element, which is a value, not an entity — name it with ${spellIdent(scope.ident)}.each`,
    );
  }
  const first = path[0];
  if (scope.ns === undefined || first === undefined) return;
  if (first === ID || revs[0] === true) return;
  const ns = nsOfIdent(first);
  if (ns !== undefined && ns !== scope.ns) {
    throw new Error(
      `ramose/query: nested ${what}(${path.join(" → ")}) on ${collection} is rooted at the collection's element, which is a :${scope.ns}/… entity — ${first} is not one of its attributes`,
    );
  }
};

/**
 * The hop chain of the `some(...)`s a node is inside, as a pull-phase
 * quantifier. Fan-out along a path is existential, so a prefix distributes
 * over a comparison and over `or` (`∃x (P ∨ Q)` is `(∃x P) ∨ (∃x Q)`) and
 * folds into their path — but it does *not* distribute over a negation or an
 * `every`, so those wrap the prefix in an explicit `{some: …}` instead: the
 * engine walks it element by element, which is exactly what `∃x ¬P` needs.
 */
const withPrefix = (
  prefix: readonly string[],
  prefixRevs: readonly boolean[],
  pred: PullElemPred,
): PullElemPred =>
  prefix.length === 0
    ? pred
    : {
        some: {
          path: [...prefix],
          ...(prefixRevs.some(Boolean) ? { reverse: [...prefixRevs] } : {}),
          pred,
        },
      };

/**
 * Lower a where-node into a per-element pull predicate. `scope` is the
 * element the node is written against, and is `undefined` once we are inside
 * a folded `some(...)` — the hop's own build already checked what it reaches.
 */
const lowerElemNode = (
  node: AnyWhereNode,
  prefix: readonly string[],
  prefixRevs: readonly boolean[],
  scope: ElemScope | undefined,
  collection: readonly string[],
): PullElemPred => {
  if (isWhen(node)) {
    throw new Error(nestedWhenError(`where(...) on ${collection.join(" → ")}`));
  }
  if (isOr(node)) {
    return {
      or: node.preds.map((p) =>
        lowerElemNode(p, prefix, prefixRevs, scope, collection),
      ),
    };
  }
  if (isNot(node)) {
    return withPrefix(prefix, prefixRevs, {
      not: lowerElemNode(node.pred, [], [], scope, collection),
    });
  }
  if (isQuantified(node)) {
    checkElementRoot(scope, node.path, node.revs, undefined, "where");
    const hop = {
      path: [...node.path],
      ...(node.revs.some(Boolean) ? { reverse: [...node.revs] } : {}),
    };
    switch (node.quant) {
      case "some":
        // an existential hop is exactly a longer path: fan-out is existential
        return lowerElemNode(
          node.pred,
          [...prefix, ...node.path],
          [...prefixRevs, ...node.revs],
          undefined,
          collection,
        );
      case "none":
        // no element matches = not(some element matches), and a `some` is a
        // longer path again, so the negation is all that is left to say
        return withPrefix(prefix, prefixRevs, {
          not: lowerElemNode(
            node.pred,
            [...node.path],
            [...node.revs],
            undefined,
            collection,
          ),
        });
      case "every":
        // no *reached* element fails, evaluated per element by the engine —
        // vacuously true of a hop that reaches nothing, like the query's own
        return withPrefix(prefix, prefixRevs, {
          every: {
            ...hop,
            pred: lowerElemNode(node.pred, [], [], undefined, collection),
          },
        });
    }
  }
  return lowerElemCmp(node, prefix, prefixRevs, scope, collection);
};

const lowerElemCmp = (
  p: Predicate<unknown, any>,
  prefix: readonly string[],
  prefixRevs: readonly boolean[],
  scope: ElemScope | undefined,
  collection: readonly string[],
): PullElemCmp => {
  const revs = p.revs ?? p.path.map(() => false);
  checkElementRoot(scope, p.path, revs, p.each, "where");
  const op = PULL_OPS[p.op];
  if (op === undefined) {
    throw new Error(
      `ramose/query: ${p.op} has no nested-where spelling on ${collection.join(" → ")}`,
    );
  }
  const reverse = [...prefixRevs, ...revs];
  return {
    path: [...prefix, ...p.path],
    ...(reverse.some(Boolean) ? { reverse } : {}),
    op,
    ...(p.op === "exists" || p.op === "missing" ? {} : { value: p.value }),
  };
};

const lowerElemOrder = (
  key: PathCarrier,
  dir: OrderDir,
  empty: OrderEmpty | undefined,
  scope: ElemScope | undefined,
): PullElemOrder => {
  const path = pathOf(key);
  if (cardsOf(key).includes("many")) {
    throw new Error(
      `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  const revs = revsOf(key);
  checkElementRoot(scope, path, revs, key.__each, "orderBy");
  return {
    path: [...path],
    ...(revs.some(Boolean) ? { reverse: [...revs] } : {}),
    dir,
    ...(empty !== undefined ? { empty } : {}),
  };
};

const collectionNav = <A extends PathCarrier>(
  attr: A,
  constraints: PullNestedConstraints,
): CollectionNav<A> => {
  const scope = elemScope(attr);
  const collection = scope.collection;
  const self: CollectionNav<A> = {
    _tag: "collection",
    attr,
    constraints,
    where: (...preds) =>
      collectionNav(attr, {
        ...constraints,
        where: [
          ...(constraints.where ?? []),
          ...preds.map((p) => lowerElemNode(p, [], [], scope, collection)),
        ],
      }),
    orderBy: (key, dir = "asc", opts) =>
      collectionNav(attr, {
        ...constraints,
        order: [
          ...(constraints.order ?? []),
          lowerElemOrder(key as PathCarrier, dir, opts?.empty, scope),
        ],
      }),
    limit: (n) => collectionNav(attr, { ...constraints, limit: n }),
    offset: (n) => collectionNav(attr, { ...constraints, offset: n }),
    select: ((shape: Shape | AllShape | Again) => {
      if (!isRefNav(attr)) {
        throw new Error(
          `ramose/query: ${collection.join(" → ")} is a cardinality-many scalar — its elements are values, which have no shape. The constrained collection is the field itself: \`.select({ ${spellIdent(scope.ident).split(".")[1] ?? "values"}: ${spellIdent(scope.ident)}.where(…) })\``,
        );
      }
      return makeSelectNested(attr, shape, constraints);
    }) as CollectionNav<A>["select"],
  };
  return self;
};

/**
 * Start constraining a collection. A cardinality-many attribute is what has
 * elements to filter, order and page: the entities a many ref or a many
 * backlink reaches, or the values of a many scalar (named by `attr.each`). A
 * card-one ref — or a component ref's backlink, which is card-one too —
 * reaches one entity; constrain it in the query's own `.where`.
 */
const collectionOf = (attr: PathCarrier, method: string): CollectionNav => {
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ramose/query: ${method}(...) on ${pathOf(attr).join(" → ")} — nested where / orderBy / limit / offset constrain a cardinality-many collection (a many ref, a many backlink, or a many scalar), which is what has elements to filter`,
    );
  }
  return collectionNav(attr, {});
};

/** Refs compare by id, so an `Eid` in an `in(...)` list is its number. */
const inValue = (v: unknown): unknown =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { id?: unknown }).id === "number" &&
  Object.keys(v).length === 1
    ? (v as { id: number }).id
    : v;

export interface SelectNested<A = unknown, S = unknown> {
  readonly _tag: "select";
  readonly attr: A;
  readonly shape: S;
  /** Pull-phase constraints from a {@link CollectionNav}, already lowered. */
  readonly constraints?: PullNestedConstraints;
  readonly optional: {
    readonly _tag: "optional";
    readonly field: SelectNested<A, S>;
  };
}

const makeSelectNested = (
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
        `ramose/query: ${pathOf(attr).join(" → ")} is a card-many again edge — write .limit(n) before .select(Ramose.again(${shape.depth})); the engine default of 1000 is not a tree budget`,
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

const NAV_METHODS = new Set([
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
  "optional",
  "orDefault",
  "select",
]);

export const attachAttrNav = <A extends PathCarrier>(attr: A): AttrNav<A> => {
  const api = {
    eq(this: PathCarrier, value: unknown) {
      return pred("eq", this, value);
    },
    ne(this: PathCarrier, value: unknown) {
      return pred("ne", this, value);
    },
    lt(this: PathCarrier, value: unknown) {
      return pred("lt", this, value);
    },
    lte(this: PathCarrier, value: unknown) {
      return pred("lte", this, value);
    },
    gt(this: PathCarrier, value: unknown) {
      return pred("gt", this, value);
    },
    gte(this: PathCarrier, value: unknown) {
      return pred("gte", this, value);
    },
    in(this: PathCarrier, values: readonly unknown[]) {
      // a whole-list hole: the array check and per-element normalization
      // run at substitution time, against the bound list
      if (isParam(values)) return pred("in", this, values);
      if (!Array.isArray(values)) {
        throw new Error(
          `ramose/query: in(...) takes an array of values, got ${String(values)}`,
        );
      }
      if (values.some(isParam)) {
        throw new Error(
          "ramose/query: in(...) takes a whole-list hole (in(P.ids)), not per-element ones — make the list itself the param",
        );
      }
      return pred("in", this, values.map(inValue));
    },
    startsWith(this: PathCarrier, prefix: string) {
      return pred("startsWith", this, prefix);
    },
    endsWith(this: PathCarrier, suffix: string) {
      return pred("endsWith", this, suffix);
    },
    includes(this: PathCarrier, needle: string) {
      return pred("includes", this, needle);
    },
    matches(this: PathCarrier, re: RegExp | string) {
      // a literal fails where it was written; a hole defers `regexSource`
      // to substitution time, where it surfaces as a ParamError
      return pred("matches", this, isParam(re) ? re : regexSource(re));
    },
    is(this: PathCarrier, ref: unknown) {
      return pred("is", this, isParam(ref) ? ref : eidValue(ref));
    },
    some(this: PathCarrier, inner: WhereNode) {
      return quantified("some", this, inner);
    },
    every(this: PathCarrier, inner: WhereNode) {
      return quantified("every", this, inner);
    },
    none(this: PathCarrier, inner: WhereNode) {
      return quantified("none", this, inner);
    },
    exists(this: PathCarrier) {
      return pred("exists", this);
    },
    missing(this: PathCarrier) {
      return pred("missing", this);
    },
    where(this: PathCarrier, ...preds: WhereNode[]) {
      return collectionOf(this, "where").where(...preds);
    },
    orderBy(
      this: PathCarrier,
      key: NestedOrderKey,
      dir: OrderDir = "asc",
      opts?: { readonly empty?: OrderEmpty },
    ) {
      return collectionOf(this, "orderBy").orderBy(key, dir, opts);
    },
    limit(this: PathCarrier, n: number) {
      return collectionOf(this, "limit").limit(n);
    },
    offset(this: PathCarrier, n: number) {
      return collectionOf(this, "offset").offset(n);
    },
    select(this: PathCarrier, shape: Shape | AllShape | Again) {
      return makeSelectNested(this, shape);
    },
    // like `.optional`, it wraps the *receiver*, so a path keeps walking
    // through it and the multi-hop it may be is still noticed (issue #69)
    orDefault(this: PathCarrier, value: unknown) {
      return pullDefault(this, value);
    },
  };

  return new Proxy(attr, {
    get(target, prop, receiver) {
      // `.optional` wraps the *receiver*, so a path keeps walking through it:
      // `Todo.owner.name.optional` must still remember `:todo/owner`, or the
      // multi-hop it is goes unnoticed (issue #69).
      if (prop === "optional") return optional(receiver);
      // `.each` is the receiver's element, so it keeps the path that reached
      // the collection and empties it: the element is the value itself
      if (prop === "each") return eachNode(receiver as PathCarrier);
      if (typeof prop === "string" && prop in api) {
        const v = (api as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as Function).bind(receiver) : v;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AttrNav<A>;
};

export const withPath = <A extends PathCarrier>(
  attr: A,
  path: readonly string[],
  cards: readonly Cardinality[],
  revs: readonly boolean[] = path.map(() => false),
): A => {
  if (attr.__path === path) return attr;
  return new Proxy(attr, {
    get(target, prop, receiver) {
      if (prop === "__path") return path;
      if (prop === "__cards") return cards;
      if (prop === "__revs") return revs;
      // a path that continues past a reversed hop is no longer that node
      if (prop === "__reverse") return false;
      const v = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        NAV_METHODS.has(prop) &&
        typeof v === "function"
      ) {
        return (v as Function).bind(receiver);
      }
      return v;
    },
  }) as A;
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
      ? "ramose/query: all(N) is a shape — write `.select(Ramose.all(N))` on the query itself, not as the contents of a field map"
      : `ramose/query: select field "${key}": all(N) is a shape, not a field — write \`ref.select(Ramose.all(N))\``,
  );
};

/** Convert a navigational shape into the literate pull map `lowerPullPattern` knows. */
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
      field.attr as { readonly valueType: ":db.type/ref" },
      shapeToPullMap(field.shape as Shape),
      field.constraints,
    );
  }
  if (isPullNested(field)) {
    return field;
  }
  return field;
};

// ── builder ────────────────────────────────────────────────────────────────

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
        { readonly _tag: "all"; readonly ns: infer N extends AnyNamespace },
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
  : F extends { readonly _tag: "collection"; readonly attr: infer A }
    ? // a constrained card-many scalar: the same array, with fewer values in it
      readonly SchemaType<A>[]
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

/**
 * Re-apply `.one()` / `.oneOrFail()` / `.after` after a later `.select` so
 * `query(N).one().select({…})` keeps the single-row type and
 * `query(N).after(c).select({…})` keeps the page.
 */
type CardOf<R, NewRows extends readonly unknown[]> = R extends Page<unknown>
  ? Page<ElemOf<NewRows>>
  : R extends readonly unknown[]
    ? NewRows
    : null extends R
      ? ElemOf<NewRows> | null
      : ElemOf<NewRows>;

type ElemOf<A> = A extends readonly (infer E)[] ? E : never;

/** The rows-array `R` (or the page's), as the page `.after` answers with. */
type PagedOf<R> = R extends Page<infer E>
  ? Page<E>
  : R extends readonly (infer E)[]
    ? Page<E>
    : never;

/** At most one row — the array element, or `null` when the page is empty. */
type OneOf<R> = R extends readonly (infer E)[] ? E | null : Exclude<R, null> | null;

/** Exactly one row — the array element. Zero or two+ fail at run time. */
type OneOrFailOf<R> = R extends readonly (infer E)[] ? E : Exclude<R, null>;

/** The params scope a where-node's holes belong to, `never` for none. */
type ScopeOfNode<W> = W extends Predicate<any, infer S>
  ? S
  : W extends When<infer S>
    ? S
    : W extends Or<any, infer S>
      ? S
      : W extends Not<any, infer S>
        ? S
        : W extends Quantified<infer S>
          ? S
          : never;

/**
 * One `.where(...)` argument, checked against the query's params scope `P`:
 * a node with no holes always fits; a node whose holes belong to another set
 * resolves to an error string, {@link ValidShape}-style.
 */
type WhereArg<W, P> = (WhereNode<never, unknown> | When<unknown>) &
  ([ScopeOfNode<W>] extends [never]
    ? unknown
    : [ScopeOfNode<W>] extends [P]
      ? unknown
      : `this clause references a param from a set this query is not scoped to — declare the set with Ramose.params and pass it to Ramose.query(N, P)`);

/**
 * `R` defaults to the matched entity ids — what a query with no `.select`
 * yields. `P` is the bindings record of the params set `Ramose.query(N, P)`
 * scoped this query to (`never` without one): every `.where` clause's holes
 * must belong to it, and it is what the terminal binds.
 */
export interface NavQueryBuilder<
  N extends AnyNamespace,
  R = readonly Eid[],
  P = never,
> {
  readonly ns: N;
  readonly spec: NavQuerySpec;

  where<const W extends readonly unknown[]>(
    ...preds: W & { readonly [K in keyof W]: WhereArg<W[K], P> }
  ): NavQueryBuilder<N, R, P>;
  /**
   * `select(Ramose.all(N))` — every attribute the matched entity has, as the
   * peer's wildcard pull. The row is ident-keyed ({@link AllRow}), not the
   * named shape a field map gives. The namespace must be the one the query is
   * scoped to: `query(Todo).select(all(User))` is a type error. Nested under
   * a ref, `Todo.owner.select(all(User))` is the same wildcard on that hop.
   */
  select(
    shape: AllShape<N>,
  ): NavQueryBuilder<N, CardOf<R, readonly AllRow<N>[]>, P>;
  /**
   * Each field is a **direct** attribute of the queried namespace (or a
   * nested `.select` through one of its refs). A flattened path —
   * `{ ownerName: Todo.owner.name }` — is rejected: see {@link ValidShape}.
   * No field is a param, and no `when` gates one: a query's shape never
   * depends on a binding.
   *
   * `again(n)` is folded into this overload (not a third one) so a bad
   * field map still reports on the field. Top-level `again` is
   * {@link TopLevelAgain}.
   */
  select<const S extends Shape | Again>(
    shape: [S] extends [Again] ? S & TopLevelAgain : S & ValidShape<S>,
  ): [S] extends [Again]
    ? NavQueryBuilder<N, never, P>
    : NavQueryBuilder<N, CardOf<R, readonly SelectResult<S>[]>, P>;
  /**
   * A sort key is a card-one path from the row. An element cursor is not one:
   * `.each` names a value inside a collection, and the collection is the thing
   * a row has — see {@link ValidOrderKey}. Not a param position: an order key
   * is structure, and every surveyed system forbids structural holes.
   */
  orderBy<K extends PathCarrier>(
    attr: K & ValidOrderKey<K, never>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): NavQueryBuilder<N, R, P>;
  limit(n: number | Param<number, P>): NavQueryBuilder<N, R, P>;
  offset(n: number | Param<number, P>): NavQueryBuilder<N, R, P>;
  /**
   * At most one row. Lowers to `:limit 1`; the result is that row or `null`,
   * the same absence `db.pull` uses. Extra matches are not fetched.
   */
  one(): NavQueryBuilder<N, OneOf<R>, P>;
  /**
   * Exactly one row. Lowers to `:limit 2` so a second match is witnessed
   * without pulling a page, and fails with {@link NotOne} if the peer
   * answers zero or two.
   */
  oneOrFail(): NavQueryBuilder<N, OneOrFailOf<R>, P>;

  /**
   * Keyset-page a sorted query: the result becomes a {@link Page}, whose
   * `cursor` is where it ended — pass `null` for the first page and the
   * previous page's cursor after that. Needs an `.orderBy` (the cursor is a
   * position in the sort); the entity id rides as a final tie-breaker, so
   * rows that tie on every key still land on exactly one page. The seek is
   * the peer's: `.limit(n)` is n rows *past* the cursor, and unlike
   * `.offset` the walk does not shift when rows are inserted before it.
   */
  after(cursor: Cursor | null): NavQueryBuilder<N, PagedOf<R>, P>;

  /** How many rows the query matches. `0` when none do. */
  count(): NavQuery<number, P>;
  /** How many distinct values a card-one path has over the matched rows. */
  countDistinct<K extends PathCarrier>(attr: K & ValidAggKey<K>): NavQuery<number, P>;
  /** The sum of a number attribute over the matched rows; `0` over none. */
  sum<K extends PathCarrier>(
    attr: K & ValidAggKey<K> & NumericAggKey<K, "sum">,
  ): NavQuery<number, P>;
  /** The mean of a number attribute over the matched rows; `null` over none. */
  avg<K extends PathCarrier>(
    attr: K & ValidAggKey<K> & NumericAggKey<K, "avg">,
  ): NavQuery<number | null, P>;
  /** The least value a card-one path has over the matched rows. */
  min<K extends PathCarrier>(
    attr: K & ValidAggKey<K>,
  ): NavQuery<AttrValue<K> | null, P>;
  /** The greatest value a card-one path has over the matched rows. */
  max<K extends PathCarrier>(
    attr: K & ValidAggKey<K>,
  ): NavQuery<AttrValue<K> | null, P>;
  /**
   * Several aggregates in one round trip: `{ n: count(), total: sum(…) }`.
   * The whole match set is the one group, so the result is exactly one row —
   * a one-element tuple, so `const [totals] = yield* db.q(…)` reads it.
   * A row missing an aggregated attribute contributes nothing to that
   * aggregate but still counts everywhere else, so `count()` next to
   * `sum(Todo.hours)` counts todos without hours too.
   */
  aggregate<const S extends AggShape>(shape: S): NavQuery<readonly [AggRow<S>], P>;
  /**
   * Group the matched rows by one or more card-one paths, then `.aggregate`
   * per group: `groupBy({ owner: Todo.owner }).aggregate({ n: count() })` is
   * one row per owner. A row without a group-key value belongs to no group
   * and is left out — the same join the key's clause is.
   */
  groupBy<const G extends GroupShape>(
    keys: G & ValidGroupShape<G>,
  ): GroupedNavQueryBuilder<N, G, P>;

  /** Freeze into a runnable query value. */
  build(): NavQuery<R, P>;
}

/**
 * What `.groupBy` returns: a query whose rows are groups, waiting for the
 * `.aggregate` that says what to compute per group. Filters, like everything
 * that names the *rows*, come before the `.groupBy`. Filters that name
 * *group cells* (keys + aggregates) are `.having`, after `.aggregate`.
 */
export interface GroupedNavQueryBuilder<N extends AnyNamespace, G, P = never> {
  readonly ns: N;
  readonly spec: NavQuerySpec;
  /** One row per group: the group keys, then the aggregates, by alias. */
  aggregate<const S extends AggShape>(
    shape: S,
  ): GroupedAggQuery<G, S, P>;
}

/**
 * A grouped aggregate: a runnable query whose rows are groups, plus
 * `.having` to keep or drop those groups. Having does not change
 * {@link GroupedRow}; it only drops rows. `cell` is the same aliases the
 * row carries, with the predicate methods `.where` uses on an attribute.
 *
 * Spelling: after `.aggregate`, not before and not an argument — having
 * names aggregate aliases, which do not exist until the shape is written.
 * A callback `(g) => g.n.gt(5)` runs at construction and returns clauses;
 * it is not `if (n > 5)` over the result.
 */
export type GroupedAggQuery<G, S, P = never> = NavQuery<
  readonly GroupedRow<G, S>[],
  P
> & {
  readonly cell: HavingCells<G, S>;
  having(
    build: (
      cell: NoInfer<HavingCells<G, S>>,
    ) =>
      | WhereNode<never, unknown>
      | When<unknown>
      | readonly (WhereNode<never, unknown> | When<unknown>)[],
  ): GroupedAggQuery<G, S, P>;
};

/**
 * The row type a query yields — so an app names it once, from the query,
 * instead of restating the shape by hand:
 *
 * ```ts
 * const boardQuery = Ramose.query(Issue).select({ id: Issue.id, ... });
 * type BoardRow = Ramose.Row<typeof boardQuery>;   // one row
 * type BoardRows = Ramose.Rows<typeof boardQuery>; // the readonly array
 * ```
 *
 * Takes the builder or the frozen {@link NavQuery} — the same inputs `db.q`
 * takes. With no `.select`, the row is the matched entity id.
 */
export type Row<Q> = Q extends NavQuery<infer R, any>
  ? RowOf<R>
  : Q extends NavQueryBuilder<AnyNamespace, infer R, any>
    ? RowOf<R>
    : never;

/**
 * The readonly array of {@link Row}. For a `.select` query this is exactly
 * what `db.q` resolves to. With no `.select` it is `readonly Eid[]`, one
 * shade looser than `db.q`: a catalog-typed db re-brands the ids to
 * `Eid<C>`, which a query — scoped to a namespace, not a catalog — cannot
 * know.
 */
export type Rows<Q> = readonly Row<Q>[];

/**
 * The phantom result is the rows array, a {@link Page} of them, or a single
 * row after `.one` / `.oneOrFail`; the row is the element either way (`null`
 * is absence, not a row).
 */
type RowOf<R> = R extends Page<infer E>
  ? E
  : R extends readonly (infer E)[]
    ? E
    : Exclude<R, null>;

const freeze = <R, P = never>(spec: NavQuerySpec): NavQuery<R, P> => ({
  _tag: "NavQuery",
  spec,
});

/**
 * What an aggregating call must not find on the spec already: an aggregate
 * answers with its own rows (the groups), so the row-shaping and row-paging
 * pieces have nothing to apply to.
 */
const assertAggregable = (spec: NavQuerySpec, what: string): void => {
  if (spec.shape !== undefined) {
    throw new Error(
      `ramose/query: ${what} answers with its own row — there is no .select shape for it to fill`,
    );
  }
  if (spec.orderBy.length > 0) {
    throw new Error(
      `ramose/query: .orderBy sorts the matched rows, and ${what} replaces them with groups — sorting groups is not supported yet (issue #18)`,
    );
  }
  if (spec.take !== undefined) {
    throw new Error(
      `ramose/query: .one() / .oneOrFail() unwrap a page of rows, and ${what} answers with groups — an ungrouped aggregate is already one row`,
    );
  }
  if (spec.limit !== undefined || spec.offset !== undefined) {
    throw new Error(
      `ramose/query: .limit / .offset page the matched rows, and ${what} replaces them with groups — paging groups is not supported yet (issue #18)`,
    );
  }
  if (spec.after !== undefined) {
    throw new Error(
      `ramose/query: .after pages the matched rows, and ${what} replaces them with groups — paging groups is not supported yet (issue #18)`,
    );
  }
};

/** An `.aggregate` shape's fields, checked and lowered in alias order. */
const aggFields = (shape: AggShape): AggFieldSpec[] => {
  const out: AggFieldSpec[] = [];
  for (const [alias, field] of Object.entries(shape)) {
    if (
      typeof field !== "object" ||
      field === null ||
      (field as { _tag?: unknown })._tag !== "Agg"
    ) {
      throw new Error(
        `ramose/query: aggregate field "${alias}" is not an aggregate — use count() / countDistinct(attr) / sum(attr) / avg(attr) / min(attr) / max(attr)`,
      );
    }
    out.push({
      alias,
      fn: field.fn,
      ...(field.attr !== undefined
        ? { path: pathOf(field.attr), revs: revsOf(field.attr) }
        : {}),
    });
  }
  if (out.length === 0) {
    throw new Error("ramose/query: aggregate({}) computes nothing — name at least one aggregate");
  }
  return out;
};

/** A `.groupBy` shape's keys, checked and lowered in alias order. */
const groupKeys = (keys: GroupShape): GroupKeySpec[] => {
  const out: GroupKeySpec[] = [];
  for (const [alias, key] of Object.entries(keys)) {
    const attr = aggPath("groupBy", key);
    const path = pathOf(attr);
    out.push({
      alias,
      path,
      revs: revsOf(attr),
      cell:
        path[path.length - 1] === ID ? "id" : isRefNav(attr) ? "ref" : "value",
    });
  }
  if (out.length === 0) {
    throw new Error(
      "ramose/query: groupBy({}) groups by nothing — for one row over the whole match set, call .aggregate directly",
    );
  }
  return out;
};

const aggregated = <R, P = never>(
  spec: NavQuerySpec,
  what: string,
  fields: readonly AggFieldSpec[],
  scalar: boolean,
): NavQuery<R, P> => {
  assertAggregable(spec, what);
  for (const f of fields) {
    if (spec.groupBy?.some((k) => k.alias === f.alias) === true) {
      throw new Error(
        `ramose/query: "${f.alias}" is both a group key and an aggregate — every cell of the grouped row needs its own name`,
      );
    }
  }
  return freeze<R, P>({ ...spec, aggregate: fields, aggScalar: scalar });
};

const groupedBuilder = <N extends AnyNamespace, G, P = never>(
  ns: N,
  spec: NavQuerySpec,
): GroupedNavQueryBuilder<N, G, P> => ({
  ns,
  spec,
  aggregate: (shape) => groupedAgg<G, typeof shape, P>(spec, aggFields(shape)),
});

const havingPred = (cell: string, op: PredTag, value?: unknown): Predicate => ({
  _tag: "Predicate",
  op,
  path: [],
  cell,
  value,
});

const makeHavingCell = (alias: string, ref: boolean): HavingNav<any> => {
  const cmp = (op: PredTag) => (value: unknown) =>
    havingPred(
      alias,
      op,
      ref && !isParam(value) && (op === "eq" || op === "ne" || op === "is")
        ? eidValue(value)
        : value,
    );
  const cell: HavingNav<any> = {
    eq: cmp("eq"),
    ne: cmp("ne"),
    lt: cmp("lt"),
    lte: cmp("lte"),
    gt: cmp("gt"),
    gte: cmp("gte"),
    in: (values: unknown) => {
      if (isParam(values)) return havingPred(alias, "in", values);
      if (!Array.isArray(values)) {
        throw new Error(
          `ramose/query: in(...) takes an array of values, got ${String(values)}`,
        );
      }
      if (values.some(isParam)) {
        throw new Error(
          "ramose/query: in(...) takes a whole-list hole (in(P.ids)), not per-element ones — make the list itself the param",
        );
      }
      return havingPred(alias, "in", ref ? values.map(inValue) : values);
    },
    exists: () => havingPred(alias, "exists"),
    missing: () => havingPred(alias, "missing"),
    startsWith: cmp("startsWith"),
    endsWith: cmp("endsWith"),
    includes: cmp("includes"),
    matches: (re: unknown) =>
      havingPred(alias, "matches", isParam(re) ? re : regexSource(re as RegExp | string)),
    is: cmp("is"),
  };
  return cell;
};

const makeHavingCells = (
  keys: readonly GroupKeySpec[],
  fields: readonly AggFieldSpec[],
): Record<string, HavingNav<any>> => {
  const cells: Record<string, HavingNav<any>> = {};
  for (const k of keys) cells[k.alias] = makeHavingCell(k.alias, k.cell === "ref");
  for (const f of fields) cells[f.alias] = makeHavingCell(f.alias, false);
  return cells;
};

const assertHavingNode = (node: unknown, where = ".having"): void => {
  if (isWhen(node)) {
    for (const c of node.clauses) assertHavingNode(c, where);
    return;
  }
  if (isOr(node)) {
    for (const p of node.preds) assertHavingNode(p, where);
    return;
  }
  if (isNot(node)) {
    assertHavingNode(node.pred, where);
    return;
  }
  if (isQuantified(node)) {
    throw new Error(
      `ramose/query: ${where} names group cells — some / every / none quantify over a collection, and a cell is one value`,
    );
  }
  if (
    typeof node !== "object" ||
    node === null ||
    (node as { _tag?: unknown })._tag !== "Predicate"
  ) {
    throw new Error(
      `ramose/query: ${where} takes a predicate over group cells, not a JS boolean — write (g) => g.n.gt(5), not if (n > 5)`,
    );
  }
  const p = node as Predicate;
  if (p.cell === undefined) {
    throw new Error(
      "ramose/query: .having names group cells (the aliases in .groupBy / .aggregate) — a row predicate belongs in .where, before .groupBy",
    );
  }
  if (p.each !== undefined) {
    throw new Error(`ramose/query: ${eachScopeHint(p.each)}`);
  }
};

const flattenHaving = (
  args: readonly unknown[],
  cells: Record<string, HavingNav<any>>,
): TopWhereNode[] => {
  const out: TopWhereNode[] = [];
  const push = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) push(x);
      return;
    }
    assertHavingNode(n);
    out.push(n as TopWhereNode);
  };
  for (const a of args) {
    push(typeof a === "function" ? (a as (c: typeof cells) => unknown)(cells) : a);
  }
  return out;
};

const groupedAgg = <G, S, P = never>(
  spec: NavQuerySpec,
  fields: readonly AggFieldSpec[],
): GroupedAggQuery<G, S, P> => {
  assertAggregable(spec, ".aggregate");
  for (const f of fields) {
    if (spec.groupBy?.some((k) => k.alias === f.alias) === true) {
      throw new Error(
        `ramose/query: "${f.alias}" is both a group key and an aggregate — every cell of the grouped row needs its own name`,
      );
    }
  }
  const next: NavQuerySpec = { ...spec, aggregate: fields, aggScalar: false };
  const cells = makeHavingCells(next.groupBy ?? [], fields);
  const q = freeze<readonly GroupedRow<G, S>[], P>(next);
  return {
    ...q,
    cell: cells as HavingCells<G, S>,
    having: ((...args: unknown[]) =>
      groupedAgg(
        { ...next, having: [...(next.having ?? []), ...flattenHaving(args, cells)] },
        fields,
      )) as GroupedAggQuery<G, S, P>["having"],
  };
};

/** The one aggregate the scalar sugars (`.count()`, `.sum(…)`) unwrap to. */
const scalarAgg = <Out, P = never>(
  spec: NavQuerySpec,
  what: string,
  field: Agg<Out>,
): NavQuery<Out, P> =>
  aggregated<Out, P>(
    spec,
    what,
    aggFields({ value: field } as AggShape),
    true,
  );

const builder = <N extends AnyNamespace, R, P = never>(
  ns: N,
  spec: NavQuerySpec,
): NavQueryBuilder<N, R, P> => {
  const noPageTake = (what: string): void => {
    if (spec.after !== undefined) {
      throw new Error(
        `ramose/query: ${what} unwraps a single row, and .after pages many — a paged query keeps its rows`,
      );
    }
  };
  const self: NavQueryBuilder<N, R, P> = {
    ns,
    spec,
    where: (...preds) => {
      for (const p of preds) assertNoLooseElem(p as AnyWhereNode | When);
      return builder(ns, {
        ...spec,
        where: [...spec.where, ...(preds as readonly TopWhereNode[])],
      });
    },
    // both overloads carry the same value: the shape (or the wildcard marker)
    // travels on the spec, and lowering reads which one it is
    select: ((shape: Shape | AllShape | Again) => {
      if (isAgain(shape)) {
        throw new Error(
          "ramose/query: again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))",
        );
      }
      return builder(ns, { ...spec, shape });
    }) as unknown as NavQueryBuilder<N, R, P>["select"],
    orderBy: (attr, dir = "asc", opts) => {
      const path = pathOf(attr);
      if (attr.__each !== undefined) {
        throw new Error(`ramose/query: ${eachScopeHint(attr.__each)}`);
      }
      if (cardsOf(attr).includes("many")) {
        throw new Error(
          `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
        );
      }
      return builder(ns, {
        ...spec,
        orderBy: [
          ...spec.orderBy,
          { path, revs: revsOf(attr), dir, empty: opts?.empty ?? "last" },
        ],
      });
    },
    limit: (n) => builder(ns, { ...spec, limit: n }),
    offset: (n) => {
      if (spec.after !== undefined) {
        throw new Error(
          "ramose/query: .after and .offset both say where the page starts — a cursor already is the offset",
        );
      }
      return builder(ns, { ...spec, offset: n });
    },
    one: () => {
      noPageTake(".one()");
      return builder(ns, { ...spec, take: "one", limit: 1 });
    },
    oneOrFail: () => {
      noPageTake(".oneOrFail()");
      return builder(ns, { ...spec, take: "oneOrFail", limit: 2 });
    },
    after: (cursor) => {
      if (spec.take !== undefined) {
        throw new Error(
          "ramose/query: .one() / .oneOrFail() answer a single row — there is no next page to cursor to",
        );
      }
      if (spec.offset !== undefined) {
        throw new Error(
          "ramose/query: .after and .offset both say where the page starts — a cursor already is the offset",
        );
      }
      if (cursor !== null && !isCursor(cursor)) {
        throw new Error(
          "ramose/query: .after takes the previous page's cursor, or null for the first page",
        );
      }
      return builder(ns, { ...spec, after: cursor });
    },
    count: () => scalarAgg<number, P>(spec, ".count()", count()),
    countDistinct: (attr) =>
      scalarAgg<number, P>(
        spec,
        ".countDistinct(…)",
        countDistinct(attr as PathCarrier),
      ),
    sum: (attr) => scalarAgg<number, P>(spec, ".sum(…)", sum(attr as never)),
    avg: (attr) =>
      scalarAgg<number | null, P>(spec, ".avg(…)", avg(attr as never)),
    min: ((attr: PathCarrier) =>
      scalarAgg(spec, ".min(…)", min(attr))) as NavQueryBuilder<N, R, P>["min"],
    max: ((attr: PathCarrier) =>
      scalarAgg(spec, ".max(…)", max(attr))) as NavQueryBuilder<N, R, P>["max"],
    aggregate: (shape) =>
      aggregated(spec, ".aggregate", aggFields(shape), false),
    groupBy: (keys) => {
      assertAggregable(spec, ".groupBy");
      return groupedBuilder(ns, { ...spec, groupBy: groupKeys(keys) });
    },
    build: () => freeze<R, P>(spec),
  };
  return self;
};

const emptySpec = (ns: AnyNamespace, paramSet: AnyParamSet | undefined): NavQuerySpec => ({
  ns: ns.ns,
  nsIdents: Object.values(ns.attributes).map(
    (a) => (a as { ident: string }).ident,
  ),
  where: [],
  shape: undefined,
  orderBy: [],
  limit: undefined,
  offset: undefined,
  take: undefined,
  params: paramSet,
  groupBy: undefined,
  aggregate: undefined,
  having: undefined,
  aggScalar: false,
  after: undefined,
});

/**
 * Start a navigational query scoped to namespace `N`. Pass a
 * {@link params} set as the second argument to declare value holes — the
 * query object is created once and never forks; bind the holes at the
 * terminal (`db.q(q, { … })`).
 *
 * Calling `.where` / `.select` / `.one` / … returns a builder; pass the
 * builder (or `.build()`) to `db.q` / `db.live`. Builders are accepted
 * directly so `db.q(Ramose.query(Todo).where(...).select(...))` works
 * without `.build()`.
 */
export function query<N extends AnyNamespace>(ns: N): NavQueryBuilder<N>;
export function query<N extends AnyNamespace, const S extends AnyParamSet>(
  ns: N,
  params: S,
): NavQueryBuilder<N, readonly Eid[], BindingsOfSet<S>>;
export function query(
  ns: AnyNamespace,
  paramSet?: AnyParamSet,
): NavQueryBuilder<AnyNamespace> {
  return builder(ns, emptySpec(ns, paramSet));
}

/** Accept a builder or a frozen {@link NavQuery}. */
export const asNavQuery = <R, P = never>(
  q: NavQuery<R, P> | NavQueryBuilder<AnyNamespace, R, P>,
): NavQuery<R, P> =>
  isNavQuery(q) ? q : (q as NavQueryBuilder<AnyNamespace, R, P>).build();

// ── lower to peer query object ─────────────────────────────────────────────

let fresh = 0;
const gensym = (prefix: string) => `?${prefix}${fresh++}`;

/** @internal Both lowerings (nav and kernel) reset for deterministic names. */
export const resetGensym = () => {
  fresh = 0;
};

/** The pseudo-attribute: the entity variable itself, never a datom. */
const ID = ":db/id";

/** One sort key on the wire — `empty` is always explicit. */
interface OrderClause {
  readonly var: string;
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

export interface LoweredQuery {
  readonly find: unknown[];
  readonly where: unknown[];
  /** Aggregating queries carry the root in `:with` — see the lowerer. */
  readonly with?: readonly string[];
  /**
   * Post-group predicates over `:find` cells. The engine's `:having` —
   * groups that fail never become rows, so a later group page would
   * count the kept ones.
   */
  readonly having?: readonly unknown[];
  readonly order?: readonly OrderClause[];
  /** Keyset cursor values, one per `order` key — the engine's `:after`. */
  readonly after?: readonly unknown[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The binder the current `lowerNavQuery` pass substitutes with. Same trick
 * as `gensym`: lowering is synchronous and single-threaded, so threading
 * the binder through every helper is noise.
 */
let currentBinder: ParamBinder = bindParams(undefined, undefined);

/** Resolve a hole (or pass a literal through), then run deferred checks. */
const boundValue = (
  value: unknown,
  op: PredTag,
  use: string,
): unknown => {
  if (!isParam(value)) return value;
  const raw = currentBinder.resolve(value, use);
  switch (op) {
    case "matches":
      return normalizeBound(value, () => regexSource(raw as RegExp | string));
    case "is":
      return normalizeBound(value, () => eidValue(raw));
    case "in":
      return normalizeBound(value, () => {
        if (!Array.isArray(raw)) {
          throw new Error(
            `in(...) takes an array of values, got ${String(raw)}`,
          );
        }
        return raw.map(inValue);
      });
    default:
      return raw;
  }
};

const boundNumber = (
  n: number | AnyParam | undefined,
  use: string,
): number | undefined => {
  if (n === undefined) return undefined;
  if (!isParam(n)) return n;
  const raw = currentBinder.resolve(n, use);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ParamError({
      message: `ramose/params: param "${n.key}" bound to ${String(raw)} is not a number — ${use} takes a number`,
      key: n.key,
    });
  }
  return raw;
};

/**
 * `.one()` asks for one row; `.oneOrFail()` asks for two so a second match
 * is witnessed. A later `.limit(n)` does not widen that — take wins.
 */
const limitOf = (spec: NavQuerySpec): number | undefined =>
  spec.take === "one"
    ? 1
    : spec.take === "oneOrFail"
      ? 2
      : boundNumber(spec.limit, "limit");

/**
 * Unwrap a finalized page for `.one()` / `.oneOrFail()`. The peer already
 * applied the forced `:limit`; this only picks the cell or names the miss.
 * Returns a {@link NotOne} (not thrown) when `.oneOrFail()` sees 0 or 2.
 */
export const takeNavResult = (
  rows: unknown,
  take: NavQuerySpec["take"],
): unknown | NotOne => {
  if (take === undefined) return rows;
  const list = Array.isArray(rows) ? rows : [];
  if (take === "one") return list[0] ?? null;
  if (list.length === 1) return list[0];
  return new NotOne({
    message:
      list.length === 0
        ? "ramose/query: expected exactly one row, found none"
        : "ramose/query: expected exactly one row, found 2",
    found: list.length === 0 ? 0 : 2,
  });
};

/** Lower predicates, namespace scope, required fields and sort keys. */
export const lowerNavQuery = (
  q: NavQuery<any, any>,
  bindings?: Readonly<Record<string, unknown>>,
): {
  readonly query: LoweredQuery;
  /**
   * The pull pattern this query's rows are reshaped against: the literate map
   * a `.select` shape becomes, or the already-lowered `["*"]` of `all(N)`.
   */
  readonly pullMap: Record<string, unknown> | readonly unknown[] | undefined;
} => {
  resetGensym();
  currentBinder = bindParams(q.spec.params, bindings);
  const root = "?e";
  const where: unknown[] = [];

  // Namespace scope: entity has at least one attr in the ns (or-join).
  if (q.spec.nsIdents.length > 0) {
    where.push([
      "or",
      ...q.spec.nsIdents.map((ident) => [root, ident, "_"]),
    ]);
  }

  for (const p of q.spec.where) {
    where.push(...lowerWhere(root, p));
  }

  // Aggregates: `:find` is the group-key variables, then the aggregate
  // calls. The root entity rides in `:with`, so two rows that agree on every
  // aggregated value are still two rows (Datomic aggregates over the set of
  // distinct find+:with tuples). A group key joins — a row without it has no
  // group — while an aggregated path binds through the orderBy or-join, so a
  // row missing *that* attribute still counts everywhere else: the engine
  // reads its `null` as no value.
  if (q.spec.aggregate !== undefined) {
    const find: unknown[] = [];
    const cellVars: Record<string, string> = {};
    const nameCells = (q.spec.having?.length ?? 0) > 0;
    for (const k of q.spec.groupBy ?? []) {
      if (k.path.length === 1 && k.path[0] === ID) {
        find.push(root);
        cellVars[k.alias] = root;
        continue;
      }
      const g = gensym("g");
      where.push(...hopClauses(root, k.path, k.revs, g));
      find.push(g);
      cellVars[k.alias] = g;
    }
    for (const f of q.spec.aggregate) {
      const expr =
        f.path === undefined
          ? (["count", root] as unknown[])
          : (() => {
              const bound = lowerOrderPath(
                root,
                f.path,
                f.revs ?? f.path.map(() => false),
              );
              where.push(...bound.clauses);
              return [f.fn, bound.var] as unknown[];
            })();
      if (nameCells) {
        const as = gensym("h");
        find.push(["as", expr, as]);
        cellVars[f.alias] = as;
      } else {
        find.push(expr);
      }
    }
    const having = (q.spec.having ?? []).flatMap((n) => lowerHaving(n, cellVars));
    return {
      query: {
        find,
        where,
        with: [root],
        ...(having.length > 0 ? { having } : {}),
      },
      pullMap: undefined,
    };
  }

  // the wildcard is the peer's own pattern, so it is already lowered: there is
  // nothing to expand, and nothing in it can drop a row (every key is optional)
  const pullMap =
    q.spec.shape === undefined
      ? undefined
      : isAllShape(q.spec.shape)
        ? (["*"] as readonly unknown[])
        : (substituteLiterate(shapeToPullMap(q.spec.shape)) as Record<
            string,
            unknown
          >);
  if (pullMap !== undefined) where.push(...requiredClauses(root, pullMap));

  const order: OrderClause[] = [];
  for (const o of q.spec.orderBy) {
    const bound = lowerOrderPath(root, o.path, o.revs ?? o.path.map(() => false));
    where.push(...bound.clauses);
    order.push({ var: bound.var, dir: o.dir, empty: o.empty });
  }

  // Keyset paging: a cursor is a position in a *total* order, so the entity
  // id rides as the final tie-breaker (unless a sort key already is it), and
  // every sort-key variable rides in `:find` after the row cell — that is
  // what the client mints the next cursor from.
  const pagedVars: string[] = [];
  if (q.spec.after !== undefined) {
    if (order.length === 0) {
      throw new Error(
        "ramose/query: .after pages a sorted query — add an .orderBy for the cursor to be a position in",
      );
    }
    if (!order.some((o) => o.var === root)) {
      order.push({ var: root, dir: "asc", empty: "last" });
    }
    pagedVars.push(...order.map((o) => o.var));
    if (q.spec.after !== null && q.spec.after.keys.length !== order.length) {
      throw new Error(
        `ramose/query: this cursor does not fit — it carries ${q.spec.after.keys.length} sort-key values and the query orders by ${order.length}; a cursor only continues the query that minted it`,
      );
    }
  }

  const find =
    pullMap !== undefined
      ? [["pull", root, lowerPullPattern(pullMap)], ...pagedVars]
      : [root, ...pagedVars];

  const limit = limitOf(q.spec);
  const offset = boundNumber(q.spec.offset, "offset");
  return {
    query: {
      find,
      where,
      ...(order.length > 0 ? { order } : {}),
      ...(q.spec.after !== undefined && q.spec.after !== null
        ? { after: [...q.spec.after.keys] }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
    pullMap,
  };
};

/**
 * @internal The kernel query surface's entry to the shape machinery: lower
 * a select shape to the literate pull map with `binder` substituting any
 * param holes its nested constraints carry. Restores the previous binder,
 * so a nav lowering in progress is undisturbed.
 */
export const substituteShape = (
  shape: Shape,
  binder: ParamBinder,
): Record<string, unknown> => {
  const prev = currentBinder;
  currentBinder = binder;
  try {
    return substituteLiterate(shapeToPullMap(shape)) as Record<string, unknown>;
  } finally {
    currentBinder = prev;
  }
};

/**
 * Nested collection constraints are lowered eagerly at builder-call time,
 * so a hole lives as a leaf of the already-built `PullElemPred` tree. Walk
 * that tree (and the literate wrappers it hangs off) and substitute.
 */
const substituteLiterate = (field: unknown): unknown => {
  if (field === undefined || field === null || isAllShape(field) || isAgain(field)) {
    return field;
  }
  if (Array.isArray(field)) return field;
  if (isPullOptional(field)) {
    return optional(substituteLiterate(field.field));
  }
  if (isPullDefault(field)) {
    return pullDefault(substituteLiterate(field.field), field.value);
  }
  if (isSelectNested(field)) {
    return makeSelectNested(
      field.attr as PathCarrier,
      substituteLiterate(field.shape) as Shape | AllShape | Again,
      substituteConstraints(field.constraints),
    );
  }
  if (isPullNested(field)) {
    return nested(
      field.attr as { readonly valueType: ":db.type/ref" },
      substituteLiterate(field.pattern) as Record<string, unknown>,
      substituteConstraints(field.constraints),
    );
  }
  if (
    typeof field === "object" &&
    (field as { _tag?: unknown })._tag === "collection"
  ) {
    const col = field as {
      readonly _tag: "collection";
      readonly attr: unknown;
      readonly constraints?: PullNestedConstraints;
    };
    return {
      ...col,
      constraints: substituteConstraints(col.constraints) ?? {},
    };
  }
  if (typeof field === "object" && !("ident" in field) && !("_tag" in field)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field as Record<string, unknown>)) {
      out[k] = substituteLiterate(v);
    }
    return out;
  }
  return field;
};

const substituteConstraints = (
  c: PullNestedConstraints | undefined,
): PullNestedConstraints | undefined => {
  if (c === undefined) return undefined;
  return {
    ...c,
    ...(c.where !== undefined
      ? { where: c.where.map(substituteElemPred) }
      : {}),
    ...(c.limit !== undefined
      ? { limit: boundNumber(c.limit, "nested limit") }
      : {}),
    ...(c.offset !== undefined
      ? { offset: boundNumber(c.offset, "nested offset") }
      : {}),
  };
};

const substituteElemPred = (pred: PullElemPred): PullElemPred => {
  if ("and" in pred) return { and: pred.and.map(substituteElemPred) };
  if ("or" in pred) return { or: pred.or.map(substituteElemPred) };
  if ("not" in pred) return { not: substituteElemPred(pred.not) };
  if ("every" in pred) {
    return {
      every: { ...pred.every, pred: substituteElemPred(pred.every.pred) },
    };
  }
  if ("some" in pred) {
    return { some: { ...pred.some, pred: substituteElemPred(pred.some.pred) } };
  }
  if (pred.value === undefined || !isParam(pred.value)) return pred;
  return { ...pred, value: boundNestedCmp(pred.op, pred.value) };
};

/** A nested comparison's `op` is already the engine name (`=`, `re-find?`, …). */
const boundNestedCmp = (op: PullElemOp, hole: AnyParam): unknown => {
  const raw = currentBinder.resolve(hole, `nested ${op}`);
  if (op === "re-find?") {
    return normalizeBound(hole, () => regexSource(raw as RegExp | string));
  }
  if (op === "in") {
    return normalizeBound(hole, () => {
      if (!Array.isArray(raw)) {
        throw new Error(`in(...) takes an array of values, got ${String(raw)}`);
      }
      return raw.map(inValue);
    });
  }
  if (op === "=") {
    // `is` and `eq` both lower to `=`; unwrap an Eid cell if that's what it is
    if (
      typeof raw === "number" ||
      (typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { id?: unknown }).id === "number")
    ) {
      try {
        return eidValue(raw);
      } catch {
        return raw;
      }
    }
  }
  return raw;
};

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

/**
 * A clause that binds nothing and matches nothing: an empty collection binding
 * yields no rows. `in([])`, `or()` and `not(<always true>)` all mean "no rows",
 * and they mean it on the peer, so a `:limit` still counts kept rows.
 */
const neverClause = (): unknown[] => [["ground", []], [gensym("n"), "..."]];

/**
 * A where-node's clauses. Combinators scope to the root entity variable: an
 * `or` branch and a `not` body may invent join variables freely, because
 * `or-join` / `not-join` export only `?e`.
 */
/**
 * A `.having` node's clauses, against already-bound group cells. Combinators
 * are boolean (`or` / `not` of predicates), not joins — every alias is a
 * cell of this group. `when` splices or drops at lowering time, same as
 * `.where`.
 */
const lowerHaving = (
  node: AnyWhereNode | When<unknown>,
  cells: Readonly<Record<string, string>>,
): unknown[] => {
  if (isWhen(node)) {
    if (!currentBinder.gateOn(node.gate)) return [];
    const out: unknown[] = [];
    for (const c of node.clauses) out.push(...lowerHaving(c, cells));
    return out;
  }
  if (isOr(node)) {
    if (node.preds.length === 0) return [[["=", 1, 0]]];
    // boolean or of already-bound cells — not or-join: there is nothing to join
    return [
      [
        "or",
        ...node.preds.map((p) => ["and", ...lowerHaving(p, cells)]),
      ],
    ];
  }
  if (isNot(node)) {
    const inner = lowerHaving(node.pred, cells);
    if (inner.length === 0) return [[["=", 1, 0]]];
    return [["not", ...inner]];
  }
  if (isQuantified(node)) {
    throw new Error(
      "ramose/query: .having names group cells — some / every / none quantify over a collection, and a cell is one value",
    );
  }
  return lowerHavingPred(node, cells);
};

const lowerHavingPred = (
  p: Predicate<unknown, any>,
  cells: Readonly<Record<string, string>>,
): unknown[] => {
  const alias = p.cell;
  if (alias === undefined || cells[alias] === undefined) {
    throw new Error(
      `ramose/query: .having names group cells (the aliases in .groupBy / .aggregate) — "${alias ?? "?"}" is not one`,
    );
  }
  const v = cells[alias]!;
  const bound = boundValue(p.value, p.op, `${p.op}(...)`);
  // pred clauses only — `:having` rejects function bindings and patterns
  switch (p.op) {
    case "eq":
    case "is":
      return [[[ "=", v, bound ]]];
    case "ne":
      return [[["not=", v, bound]]];
    case "lt":
      return [[[ "<", v, bound ]]];
    case "lte":
      return [[[ "<=", v, bound ]]];
    case "gt":
      return [[[ ">", v, bound ]]];
    case "gte":
      return [[[ ">=", v, bound ]]];
    case "startsWith":
      return [[["starts-with?", v, bound]]];
    case "endsWith":
      return [[["ends-with?", v, bound]]];
    case "includes":
      return [[["includes?", v, bound]]];
    case "matches":
      return [[["re-find?", bound, v]]];
    case "in": {
      const values = bound as readonly unknown[];
      if (values.length === 0) return [[["=", 1, 0]]];
      return [[["in", v, values]]];
    }
    case "exists":
      return [[["some?", v]]];
    case "missing":
      return [[["nil?", v]]];
  }
};

const lowerWhere = (
  root: string,
  node: AnyWhereNode | When<unknown>,
): unknown[] => {
  if (isWhen(node)) {
    // gate on → splice, byte-identical to writing the clauses inline
    if (!currentBinder.gateOn(node.gate)) return [];
    const out: unknown[] = [];
    for (const c of node.clauses) out.push(...lowerWhere(root, c));
    return out;
  }
  if (isOr(node)) {
    if (node.preds.length === 0) return [neverClause()];
    return [
      [
        "or-join",
        [root],
        ...node.preds.map((p) => ["and", ...lowerWhere(root, p)]),
      ],
    ];
  }
  if (isNot(node)) {
    const inner = lowerWhere(root, node.pred);
    // nothing to negate is a predicate that always holds — its negation never does
    if (inner.length === 0) return [neverClause()];
    return [["not-join", [root], ...inner]];
  }
  if (isQuantified(node)) return lowerQuantified(root, node);
  if (node.cell !== undefined) {
    throw new Error(
      "ramose/query: a .having cell belongs in .having, after .aggregate — .where filters the matched rows",
    );
  }
  return lowerPredicate(root, node);
};

/**
 * Quantify over the elements a many hop reaches. The hop chain binds one
 * element variable `?x`; the inner node is lowered against it, so its own join
 * variables are local to the quantifier.
 *
 * - `some`  → the chain plus the inner clauses: a plain existential join.
 * - `none`  → `(not-join [?e] <chain> <inner>)` — no element matches.
 * - `every` → `(not-join [?e] <chain> (not-join [?x] <inner>))` — no element
 *   *fails*. Both negatives are vacuously true when the hop has no elements:
 *   the chain binds nothing, so the outer `not-join` removes no rows.
 */
const lowerQuantified = (root: string, node: Quantified<any>): unknown[] => {
  const x = gensym("x");
  const chain = hopClauses(root, node.path, node.revs, x);
  const inner = lowerWhere(x, node.pred);
  switch (node.quant) {
    case "some":
      return [...chain, ...inner];
    case "none":
      return [["not-join", [root], ...chain, ...inner]];
    case "every":
      // an inner node that constrains nothing is satisfied by every element
      if (inner.length === 0) return [];
      return [["not-join", [root], ...chain, ["not-join", [x], ...inner]]];
  }
};

const lowerPredicate = (root: string, p: Predicate<unknown, any>): unknown[] => {
  const { path, op } = p;
  const value = boundValue(p.value, op, `${op}(...)`);
  if (path.length === 0) return lowerElemPredicate(root, { ...p, value });
  const revs = p.revs ?? path.map(() => false);
  if (path[path.length - 1] === ID) {
    return lowerIdPredicate(root, path, revs, { ...p, value });
  }

  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push(revs[i] ? [next, path[i], e] : [e, path[i], next]);
    e = next;
  }
  const attr = path[path.length - 1]!;
  /** The last hop, oriented: a reversed hop reads the datom the other way. */
  const at = (v: unknown): unknown[] =>
    revs[path.length - 1] ? [v, attr, e] : [e, attr, v];

  switch (op) {
    case "eq":
    case "is":
      clauses.push(at(value));
      break;
    case "in": {
      const values = value as readonly unknown[];
      if (values.length === 0) return [neverClause()];
      const v = gensym("v");
      // `?v` is bound by the pattern, so the collection binding filters it
      // rather than generating: the peer keeps one row per match, not per value
      clauses.push(at(v), [["ground", [...values]], [v, "..."]]);
      break;
    }
    case "ne": {
      const v = gensym("v");
      clauses.push(at(v), [["not=", v, value]]);
      break;
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const v = gensym("v");
      const fn =
        op === "lt"
          ? "<"
          : op === "lte"
            ? "<="
            : op === "gt"
              ? ">"
              : ">=";
      clauses.push(at(v), [[fn, v, value]]);
      break;
    }
    case "startsWith": {
      const v = gensym("v");
      clauses.push(at(v), [["starts-with?", v, value]]);
      break;
    }
    case "endsWith": {
      const v = gensym("v");
      clauses.push(at(v), [["ends-with?", v, value]]);
      break;
    }
    case "includes": {
      const v = gensym("v");
      clauses.push(at(v), [["includes?", v, value]]);
      break;
    }
    case "matches": {
      const v = gensym("v");
      // `re-find?` takes the pattern first, then the string
      clauses.push(at(v), [["re-find?", value, v]]);
      break;
    }
    case "exists":
      clauses.push(at("_"));
      break;
    case "missing":
      clauses.push(["not", at("_")]);
      break;
  }
  return clauses;
};

/**
 * An `attr.each` predicate: the path is empty, so there is nothing to walk —
 * `root` is already the bound element variable a quantifier's hop chain
 * introduced, and the comparison is a ground clause on it.
 *
 * `exists` is free (the chain bound it, so it exists), and `missing` is the
 * clause that matches nothing: a bound element is not an absent one. Inside
 * `every`, that reads correctly as "the collection is empty".
 */
const lowerElemPredicate = (
  root: string,
  p: Predicate<unknown, any>,
): unknown[] => {
  const { op, value } = p;
  switch (op) {
    case "eq":
    case "is":
      return [[["=", root, value]]];
    case "ne":
      return [[["not=", root, value]]];
    case "lt":
      return [[["<", root, value]]];
    case "lte":
      return [[["<=", root, value]]];
    case "gt":
      return [[[">", root, value]]];
    case "gte":
      return [[[">=", root, value]]];
    case "startsWith":
      return [[["starts-with?", root, value]]];
    case "endsWith":
      return [[["ends-with?", root, value]]];
    case "includes":
      return [[["includes?", root, value]]];
    case "matches":
      // `re-find?` takes the pattern first, then the string
      return [[["re-find?", value, root]]];
    case "in": {
      const values = value as readonly unknown[];
      if (values.length === 0) return [neverClause()];
      // `root` is bound, so the collection binding filters it
      return [[["ground", [...values]], [root, "..."]]];
    }
    case "exists":
      return [];
    case "missing":
      return [neverClause()];
  }
};

/**
 * `:db/id` is the entity variable, not a datom: `eq` unifies it with the
 * constant so the planner starts there, and the ordering predicates compare
 * it as the number it is. Every entity has one, so `exists` costs no clause.
 */
const lowerIdPredicate = (
  root: string,
  path: readonly string[],
  revs: readonly boolean[],
  p: Predicate<unknown, any>,
): unknown[] => {
  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push(revs[i] ? [next, path[i], e] : [e, path[i], next]);
    e = next;
  }
  switch (p.op) {
    case "eq":
    case "is":
      clauses.push([["ground", eidValue(p.value)], e]);
      break;
    case "in": {
      const values = (p.value as readonly unknown[]).map(eidValue);
      if (values.length === 0) return [neverClause()];
      clauses.push([["ground", values], [e, "..."]]);
      break;
    }
    case "ne":
      clauses.push([["not=", e, p.value]]);
      break;
    case "lt":
      clauses.push([["<", e, p.value]]);
      break;
    case "lte":
      clauses.push([["<=", e, p.value]]);
      break;
    case "gt":
      clauses.push([[">", e, p.value]]);
      break;
    case "gte":
      clauses.push([[">=", e, p.value]]);
      break;
    case "exists":
      break;
    default:
      throw new Error(
        `ramose/query: ${p.op} is not defined on :db/id — an entity id is a number`,
      );
  }
  return clauses;
};

/**
 * Reshape the peer's rows: pull maps into the selected shape, bare ids into
 * `Eid`s. Order, paging and every row-dropping constraint already happened on
 * the peer (`requiredClauses` put each required field in `:where`), so this
 * changes the shape of a row and never the number of them — a `[null]` cell,
 * unreachable on a well-lowered query, comes back as a `null` row rather than
 * a quietly shorter page.
 */
export const finalizeNavResult = (
  raw: unknown,
  pullMap: Record<string, unknown> | readonly unknown[] | undefined,
): unknown => {
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  // find-pull → [[map], ...]; bare find → [[eid], ...]. Unwrap the one cell.
  // A paged query's rows carry the sort-key cells after the first one; only
  // the first is the row.
  const cellOf = (row: unknown): unknown => (Array.isArray(row) ? row[0] : row);
  if (pullMap !== undefined) {
    return rows.map((row) => reshapePullResult(pullMap, cellOf(row)));
  }
  return rows.map((row) => {
    const cell = cellOf(row);
    return typeof cell === "number" ? makeEid(cell) : cell;
  });
};

/**
 * Wrap a paged query's finalized rows into the {@link Page}: the cursor is
 * the last raw row's sort-key cells (everything after the row cell). `null`
 * when the page is over — it came back empty, or shorter than its `limit`,
 * so there is nothing past it to ask for.
 */
export const finalizeNavPage = (
  raw: unknown,
  rows: unknown,
  limit: number | undefined,
): Page => {
  const tuples: unknown[] = Array.isArray(raw) ? raw : [];
  const list = Array.isArray(rows) ? rows : [];
  const last = tuples[tuples.length - 1];
  return {
    rows: list,
    cursor:
      !Array.isArray(last) || (limit !== undefined && tuples.length < limit)
        ? null
        : { _tag: "Cursor", keys: last.slice(1) },
  };
};

/** Each aggregate's answer over no rows at all: the fn over the empty set. */
const EMPTY_AGG: Record<AggName, unknown> = {
  count: 0,
  "count-distinct": 0,
  sum: 0,
  avg: null,
  min: null,
  max: null,
};

/**
 * Reshape an aggregating query's tuples: group-key cells then aggregate
 * cells, each under its alias. Grouped, the rows are the groups (no rows, no
 * groups); ungrouped, the whole match set is the one group, so the result is
 * exactly one row — over no rows each aggregate answers for the empty set
 * (`count` 0, `sum` 0, `avg` / `min` / `max` `null`) — and the scalar sugars
 * (`.count()` & friends) unwrap it to its one cell.
 */
export const finalizeAggResult = (raw: unknown, spec: NavQuerySpec): unknown => {
  const fields = spec.aggregate ?? [];
  const keys = spec.groupBy ?? [];
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  const toRow = (tuple: unknown): Record<string, unknown> => {
    const cells: unknown[] = Array.isArray(tuple) ? tuple : [];
    const out: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const cell = cells[i];
      out[k.alias] =
        k.cell === "ref" && typeof cell === "number" ? makeEid(cell) : cell;
    });
    fields.forEach((f, j) => {
      out[f.alias] = cells[keys.length + j];
    });
    return out;
  };
  if (keys.length > 0) return rows.map(toRow);
  const row =
    rows.length > 0
      ? toRow(rows[0])
      : Object.fromEntries(fields.map((f) => [f.alias, EMPTY_AGG[f.fn]]));
  if (spec.aggScalar) return row[fields[0]!.alias];
  return [row];
};
