/**
 * Navigational query values — the read surface from docs/QUERY.md.
 *
 * `Ramose.query(Todo).where(...).select(...).orderBy(...).limit(n)` builds a
 * {@link NavQuery} value. `db.q` / `db.live` run it. Datalog is the IR: we
 * lower to `{ find: [["pull", "?e", pattern]], where, order, limit, offset }`
 * so the peer does pull-in-query (no client N+1) and sorts and pages the row
 * set itself — the client never sees the rows a page dropped.
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
import type { AnyNamespace } from "./Namespace.ts";
import {
  assertDirectField,
  inspectPullField,
  isPullNested,
  isPullOptional,
  lowerPullPattern,
  nested,
  optional,
  reshapePullResult,
  type PullNestedConstraints,
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

/** A closed predicate over a path of attribute idents from the query root. */
export interface Predicate<E = never> {
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
  readonly value?: unknown;
  /**
   * Set by `attr.each`: the ident of the attribute whose element the empty
   * path denotes. Checked when the predicate is placed, so an element cursor
   * cannot escape into a scope where it means nothing.
   */
  readonly each?: string;
  /** Phantom — see {@link EachOf}. Never present at runtime. */
  readonly _elem?: E;
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
export interface Quantified {
  readonly _tag: "Quantified";
  readonly quant: Quantifier;
  /** Idents from the root entity down to (and including) the many hop. */
  readonly path: readonly string[];
  readonly cards: readonly Cardinality[];
  readonly revs: readonly boolean[];
  /** Rooted at the element the path ends on, not at the query root. */
  readonly pred: AnyWhereNode;
}

/**
 * Disjunction of where-nodes. Nestable: a branch is itself a predicate, an
 * `Or` or a `Not`, and every branch is scoped to the query root entity, so
 * the join variables a branch invents stay inside it.
 */
export interface Or<E = never> {
  readonly _tag: "Or";
  readonly preds: readonly WhereNode<E>[];
}

/** Negation of a where-node, scoped to the query root entity. */
export interface Not<E = never> {
  readonly _tag: "Not";
  readonly pred: WhereNode<E>;
}

/**
 * What `.where(...)` takes: a predicate or a combinator over predicates. `E`
 * is the element scope its `attr.each` predicates need (see {@link EachOf});
 * a node that names no element is scopeless, and fits anywhere.
 */
export type WhereNode<E = never> = Predicate<E> | Or<E> | Not<E> | Quantified;

/** A where-node in any element scope — what the lowerer walks. */
export type AnyWhereNode = WhereNode<unknown>;

/**
 * `Ramose.or(a, b, …)` — a row matches when **any** branch does. Lowers to
 * `or-join` on the root entity variable, so branches need not bind the same
 * variables. `or()` with no branches matches nothing.
 */
export const or = <E = never>(...preds: readonly WhereNode<E>[]): Or<E> => ({
  _tag: "Or",
  preds: [...preds],
});

/**
 * `Ramose.not(pred)` — a row matches when `pred` does **not**. Lowers to
 * `not-join` on the root entity variable, so `not(or(…))` and
 * `not(Todo.due.missing())` nest the way they read.
 */
export const not = <E = never>(pred: WhereNode<E>): Not<E> => ({
  _tag: "Not",
  pred,
});

export const isOr = (x: unknown): x is Or<unknown> =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Or";

export const isNot = (x: unknown): x is Not<unknown> =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Not";

export const isQuantified = (x: unknown): x is Quantified =>
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
  | { readonly _tag: "optional"; readonly field: unknown }
  | { readonly _tag: "nested"; readonly attr: unknown; readonly pattern: unknown }
  | { readonly _tag: "select"; readonly attr: unknown; readonly shape: Shape };

export type Shape = { readonly [key: string]: ShapeField };

/**
 * Is this field a path that walked a ref before naming its attribute? True
 * through `.optional` and through a nested `.select`, which carry the field
 * they wrap.
 */
type IsHopped<F> = F extends {
  readonly _tag: "optional";
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

/** Is this field an element cursor (`attr.each`), through `.optional` too? */
type IsElement<F> = F extends {
  readonly _tag: "optional";
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
  readonly [K in keyof S]: IsHopped<S[K]> extends true
    ? MultiHopField<K & string>
    : IsElement<S[K]> extends true
      ? ElementField<K & string>
      : S[K];
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
   * Parallel to `path`, and in practice always all-false: `.orderBy` rejects a
   * key that crosses a cardinality-many hop (the sort key would be a set), and
   * `.reverse` is always many — any number of entities may point at one. It
   * still travels with the path, so lowering reads the two together and a
   * future single-valued backlink needs no new plumbing.
   */
  readonly revs?: readonly boolean[];
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

export interface NavQuerySpec {
  readonly ns: string;
  /** Attribute idents that define membership in `ns` (for bare scope). */
  readonly nsIdents: readonly string[];
  readonly where: readonly WhereNode[];
  readonly shape: Shape | undefined;
  readonly orderBy: readonly OrderBy[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/**
 * A navigational query value. Phantom `R` is the **rows array** the query
 * resolves to (`readonly SelectResult<S>[]` after `.select`, `readonly Eid[]`
 * without) — {@link Row} unwraps it to the element.
 */
export interface NavQuery<R = unknown> {
  readonly _tag: "NavQuery";
  readonly spec: NavQuerySpec;
  readonly _result?: R;
}

export const isNavQuery = (x: unknown): x is NavQuery =>
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
   * hop is `[?next :a ?e]` instead of `[?e :a ?next]`, and is always
   * cardinality-many: any number of entities may point at one.
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
 * a select shape takes, so `.optional` and `.select` are re-stamped here —
 * they are declared in terms of `AttrNav`'s own (unmarked) parameter, and an
 * intersection cannot reach inside it. `.reverse` off a hop is left to the
 * runtime check.
 */
type HopAttr<F> = {
  readonly select: F extends { readonly valueType: ":db.type/ref" }
    ? <const S extends Shape>(
        shape: S & ValidShape<S>,
      ) => SelectNested<F & Hop, S>
    : never;
  readonly optional: { readonly _tag: "optional"; readonly field: F & Hop };
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
 * a `.reverse` backlink always is.
 *
 * A cardinality-many *scalar* has elements too: its values. They are named by
 * {@link AttrNav.each}, so `User.tags.every(User.tags.each.startsWith("a"))`
 * says what a bare predicate on a many scalar (already "some value matches")
 * cannot.
 */
type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;

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
 * Predicate / shape methods attached to every stamped attr. `E` is the
 * element scope its predicates belong to: `never` for an ordinary attribute
 * (they fit anywhere), the collection's element for an `attr.each` nav.
 */
export type AttrNav<A extends PathCarrier, E = never> = A & {
  readonly eq: (value: AttrValue<A>) => Predicate<E>;
  readonly ne: (value: AttrValue<A>) => Predicate<E>;
  readonly lt: (value: AttrValue<A>) => Predicate<E>;
  readonly lte: (value: AttrValue<A>) => Predicate<E>;
  readonly gt: (value: AttrValue<A>) => Predicate<E>;
  readonly gte: (value: AttrValue<A>) => Predicate<E>;
  readonly in: (values: readonly InValue<A>[]) => Predicate<E>;
  readonly startsWith: (prefix: string) => Predicate<E>;
  readonly endsWith: (suffix: string) => Predicate<E>;
  readonly includes: (needle: string) => Predicate<E>;
  readonly matches: (re: RegExp | string) => Predicate<E>;
  readonly exists: () => Predicate<E>;
  readonly missing: () => Predicate<E>;
  /** Ref-only: the entity this ref points at. */
  readonly is: A extends { readonly valueType: ":db.type/ref" }
    ? (ref: EidLike) => Predicate<E>
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
    ? (pred: WhereNode<ElemScopeOf<A>>) => Quantified
    : never;
  /** Card-many only: no element fails `pred` (vacuously true when empty). */
  readonly every: IsMany<A> extends true
    ? (pred: WhereNode<ElemScopeOf<A>>) => Quantified
    : never;
  /** Card-many only: no element satisfies `pred` (true when empty). */
  readonly none: IsMany<A> extends true
    ? (pred: WhereNode<ElemScopeOf<A>>) => Quantified
    : never;
  /**
   * Card-many only: filter this collection, per element, on the peer. The
   * predicates are rooted at the **element** (`attr.each` for a scalar) and
   * lower to the nested pull's `:where` — never to the query's own, so the
   * outer `.limit` still counts rows and a collection that filters to nothing
   * is `[]`.
   */
  readonly where: IsMany<A> extends true
    ? (...preds: readonly WhereNode<ElemScopeOf<A>>[]) => CollectionNav<A>
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
  readonly limit: IsMany<A> extends true ? (n: number) => CollectionNav<A> : never;
  /** Card-many only: drop `n` elements from the front. */
  readonly offset: IsMany<A> extends true
    ? (n: number) => CollectionNav<A>
    : never;
  readonly optional: ReturnType<typeof optional<A>>;
  readonly select: A extends { readonly valueType: ":db.type/ref" }
    ? <const S extends Shape>(shape: S & ValidShape<S>) => SelectNested<A, S>
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
const assertNoLooseElem = (node: AnyWhereNode): void => {
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
  /** Already lowered — each call lowers its argument eagerly. */
  readonly constraints: PullNestedConstraints;
  where(
    ...preds: readonly WhereNode<ElemScopeOf<A>>[]
  ): CollectionNav<A>;
  orderBy<K extends NestedOrderKey>(
    key: K & ValidOrderKey<K, AttrIdent<A>>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): CollectionNav<A>;
  limit(n: number): CollectionNav<A>;
  offset(n: number): CollectionNav<A>;
  readonly select: A extends { readonly valueType: ":db.type/ref" }
    ? <const S extends Shape>(shape: S & ValidShape<S>) => SelectNested<A, S>
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
  p: Predicate<unknown>,
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
    select: ((shape: Shape) => {
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
 * elements to filter, order and page: the entities a many ref or a backlink
 * reaches, or the values of a many scalar (named by `attr.each`). A card-one
 * ref reaches one entity — constrain it in the query's own `.where`.
 */
const collectionOf = (attr: PathCarrier, method: string): CollectionNav => {
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ramose/query: ${method}(...) on ${pathOf(attr).join(" → ")} — nested where / orderBy / limit / offset constrain a cardinality-many collection (a many ref, a backlink, or a many scalar), which is what has elements to filter`,
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
  shape: Shape,
  constraints?: PullNestedConstraints,
): SelectNested<PathCarrier, Shape> => {
  const nestedSelect: SelectNested<PathCarrier, Shape> = {
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
      if (!Array.isArray(values)) {
        throw new Error(
          `ramose/query: in(...) takes an array of values, got ${String(values)}`,
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
      return pred("matches", this, regexSource(re));
    },
    is(this: PathCarrier, ref: unknown) {
      return pred("is", this, eidValue(ref));
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
    select(this: PathCarrier, shape: Shape) {
      return makeSelectNested(this, shape);
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

/** Convert a navigational shape into the literate pull map `lowerPullPattern` knows. */
export const shapeToPullMap = (shape: Shape): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = shapeFieldToPull(field);
  }
  return out;
};

const shapeFieldToPull = (field: unknown): unknown => {
  if (isPullOptional(field)) {
    return optional(shapeFieldToPull(field.field));
  }
  if (isSelectNested(field)) {
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
  readonly [K in keyof S]: SelectFieldResult<S[K]>;
};

type SchemaType<S> = S extends { readonly Type: infer T }
  ? T
  : S extends { readonly schema: { readonly Type: infer T } }
    ? T
    : never;

type SelectFieldResult<F> = F extends {
  readonly _tag: "optional";
  readonly field: infer Inner;
}
  ? SelectFieldResult<Inner> | undefined
  : F extends { readonly _tag: "collection"; readonly attr: infer A }
    ? // a constrained card-many scalar: the same array, with fewer values in it
      readonly SchemaType<A>[]
    : F extends {
        readonly _tag: "select";
        readonly attr: infer A;
        readonly shape: infer S;
      }
    ? A extends { readonly cardinality: "many" }
      ? readonly SelectResult<S & object>[]
      : SelectResult<S & object>
    : F extends {
          readonly _tag: "nested";
          readonly attr: infer A;
          readonly pattern: infer P;
        }
      ? A extends { readonly cardinality: "many" }
        ? readonly SelectResult<P & object>[]
        : SelectResult<P & object>
      : F extends {
            readonly schema: infer S;
            readonly cardinality: infer Card;
          }
        ? F extends { readonly ident: ":db/id" }
          ? number
          : Card extends "many"
            ? readonly SchemaType<F>[]
            : SchemaType<F>
        : F extends { readonly ident: ":db/id" }
          ? number
          : never;

/** `R` defaults to the matched entity ids — what a query with no `.select` yields. */
export interface NavQueryBuilder<
  N extends AnyNamespace,
  R = readonly Eid[],
> {
  readonly ns: N;
  readonly spec: NavQuerySpec;

  where(...preds: WhereNode[]): NavQueryBuilder<N, R>;
  /**
   * Each field is a **direct** attribute of the queried namespace (or a
   * nested `.select` through one of its refs). A flattened path —
   * `{ ownerName: Todo.owner.name }` — is rejected: see {@link ValidShape}.
   */
  select<const S extends Shape>(
    shape: S & ValidShape<S>,
  ): NavQueryBuilder<N, readonly SelectResult<S>[]>;
  /**
   * A sort key is a card-one path from the row. An element cursor is not one:
   * `.each` names a value inside a collection, and the collection is the thing
   * a row has — see {@link ValidOrderKey}.
   */
  orderBy<K extends PathCarrier>(
    attr: K & ValidOrderKey<K, never>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): NavQueryBuilder<N, R>;
  limit(n: number): NavQueryBuilder<N, R>;
  offset(n: number): NavQueryBuilder<N, R>;

  /** Freeze into a runnable query value. */
  build(): NavQuery<R>;
}

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
export type Row<Q> = Q extends NavQuery<infer R>
  ? RowOf<R>
  : Q extends NavQueryBuilder<AnyNamespace, infer R>
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

/** The phantom result is the rows array; the row is its element. */
type RowOf<R> = R extends readonly (infer E)[] ? E : never;

const freeze = <R>(spec: NavQuerySpec): NavQuery<R> => ({
  _tag: "NavQuery",
  spec,
});

const builder = <N extends AnyNamespace, R>(
  ns: N,
  spec: NavQuerySpec,
): NavQueryBuilder<N, R> => {
  const self: NavQueryBuilder<N, R> = {
    ns,
    spec,
    where: (...preds) => {
      for (const p of preds) assertNoLooseElem(p);
      return builder(ns, { ...spec, where: [...spec.where, ...preds] });
    },
    select: (shape) =>
      builder(ns, { ...spec, shape }) as unknown as NavQueryBuilder<
        N,
        readonly SelectResult<typeof shape>[]
      >,
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
    offset: (n) => builder(ns, { ...spec, offset: n }),
    build: () => freeze<R>(spec),
  };
  return self;
};

/**
 * Start a navigational query scoped to namespace `N`.
 *
 * Calling `.where` / `.select` / … returns a builder; pass the builder (or
 * `.build()`) to `db.q` / `db.live`. Builders are accepted directly so
 * `db.q(Ramose.query(Todo).where(...).select(...))` works without `.build()`.
 */
export const query = <N extends AnyNamespace>(ns: N): NavQueryBuilder<N> => {
  const nsIdents = Object.values(ns.attributes).map(
    (a) => (a as { ident: string }).ident,
  );
  return builder(ns, {
    ns: ns.ns,
    nsIdents,
    where: [],
    shape: undefined,
    orderBy: [],
    limit: undefined,
    offset: undefined,
  });
};

/** Accept a builder or a frozen {@link NavQuery}. */
export const asNavQuery = <R>(
  q: NavQuery<R> | NavQueryBuilder<AnyNamespace, R>,
): NavQuery<R> =>
  isNavQuery(q) ? q : (q as NavQueryBuilder<AnyNamespace, R>).build();

// ── lower to peer query object ─────────────────────────────────────────────

let fresh = 0;
const gensym = (prefix: string) => `?${prefix}${fresh++}`;

const resetGensym = () => {
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
  readonly order?: readonly OrderClause[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Lower predicates, namespace scope, required fields and sort keys. */
export const lowerNavQuery = (
  q: NavQuery,
): {
  readonly query: LoweredQuery;
  readonly pullMap: Record<string, unknown> | undefined;
} => {
  resetGensym();
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

  const pullMap =
    q.spec.shape !== undefined ? shapeToPullMap(q.spec.shape) : undefined;
  if (pullMap !== undefined) where.push(...requiredClauses(root, pullMap));

  const order: OrderClause[] = [];
  for (const o of q.spec.orderBy) {
    const bound = lowerOrderPath(root, o.path, o.revs ?? o.path.map(() => false));
    where.push(...bound.clauses);
    order.push({ var: bound.var, dir: o.dir, empty: o.empty });
  }

  const find =
    pullMap !== undefined
      ? [["pull", root, lowerPullPattern(pullMap)]]
      : [root];

  return {
    query: {
      find,
      where,
      ...(order.length > 0 ? { order } : {}),
      ...(q.spec.limit !== undefined ? { limit: q.spec.limit } : {}),
      ...(q.spec.offset !== undefined ? { offset: q.spec.offset } : {}),
    },
    pullMap,
  };
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
const lowerOrderPath = (
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
 */
const requiredClauses = (e: string, pattern: unknown): unknown[] => {
  if (Array.isArray(pattern)) return [];
  const out: unknown[] = [];
  for (const [key, field] of Object.entries(fieldsOf(pattern))) {
    const info = inspectPullField(field);
    // a multi-hop field would ask `?e` for the *leaf* ident and drop rows for
    // a datom they were never meant to have — reject it here too, not just in
    // the pull pattern, because this half runs first
    assertDirectField(key, info.attr, info.nestedPattern !== undefined);
    if (info.optional || info.many) continue;
    const ident = lowerAttr(info.attr);
    if (ident === ID) continue;
    if (info.nestedPattern === undefined) {
      out.push([e, ident, "_"]);
      continue;
    }
    const target = gensym("r");
    const sub = requiredClauses(target, info.nestedPattern);
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
const lowerWhere = (root: string, node: AnyWhereNode): unknown[] => {
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
const lowerQuantified = (root: string, node: Quantified): unknown[] => {
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

const lowerPredicate = (root: string, p: Predicate<unknown>): unknown[] => {
  const { path, op, value } = p;
  if (path.length === 0) return lowerElemPredicate(root, p);
  const revs = p.revs ?? path.map(() => false);
  if (path[path.length - 1] === ID) return lowerIdPredicate(root, path, revs, p);

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
const lowerElemPredicate = (root: string, p: Predicate<unknown>): unknown[] => {
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
  p: Predicate<unknown>,
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
  pullMap: Record<string, unknown> | undefined,
): unknown => {
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  // find-pull → [[map], ...]; bare find → [[eid], ...]. Unwrap the one cell.
  const cellOf = (row: unknown): unknown => (Array.isArray(row) ? row[0] : row);
  if (pullMap !== undefined) {
    return rows.map((row) => reshapePullResult(pullMap, cellOf(row)));
  }
  return rows.map((row) => {
    const cell = cellOf(row);
    return typeof cell === "number" ? makeEid(cell) : cell;
  });
};
