/**
 * Navigational query values — the read surface from docs/QUERY.md.
 *
 * `Ripple.query(Todo).where(...).select(...).orderBy(...).limit(n)` builds a
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
} from "@ripple/core/query/ast.ts";
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

/** A closed predicate over a path of attribute idents from the query root. */
export interface Predicate {
  readonly _tag: "Predicate";
  readonly op: PredTag;
  /** Idents from the root entity, e.g. `[":todo/owner", ":user/name"]`. */
  readonly path: readonly string[];
  /** Which hops are walked backwards (`.reverse`) — parallel to `path`. */
  readonly revs?: readonly boolean[];
  readonly value?: unknown;
}

/** How a quantified predicate reads the elements of a cardinality-many hop. */
export type Quantifier = "some" | "every" | "none";

/**
 * `attr.some(pred)` / `.every(pred)` / `.none(pred)` on a cardinality-many
 * ref: `pred` is rooted at the hop's *target*, and the quantifier says how
 * many elements must satisfy it.
 *
 * `every` and `none` are vacuously true when the hop has no elements at all —
 * "no element fails" and "no element matches" are both true of nothing.
 */
export interface Quantified {
  readonly _tag: "Quantified";
  readonly quant: Quantifier;
  /** Idents from the root entity down to (and including) the many hop. */
  readonly path: readonly string[];
  readonly cards: readonly Cardinality[];
  readonly revs: readonly boolean[];
  /** Rooted at the element the path ends on, not at the query root. */
  readonly pred: WhereNode;
}

/**
 * Disjunction of where-nodes. Nestable: a branch is itself a predicate, an
 * `Or` or a `Not`, and every branch is scoped to the query root entity, so
 * the join variables a branch invents stay inside it.
 */
export interface Or {
  readonly _tag: "Or";
  readonly preds: readonly WhereNode[];
}

/** Negation of a where-node, scoped to the query root entity. */
export interface Not {
  readonly _tag: "Not";
  readonly pred: WhereNode;
}

/** What `.where(...)` takes: a predicate or a combinator over predicates. */
export type WhereNode = Predicate | Or | Not | Quantified;

/**
 * `Ripple.or(a, b, …)` — a row matches when **any** branch does. Lowers to
 * `or-join` on the root entity variable, so branches need not bind the same
 * variables. `or()` with no branches matches nothing.
 */
export const or = (...preds: readonly WhereNode[]): Or => ({
  _tag: "Or",
  preds: [...preds],
});

/**
 * `Ripple.not(pred)` — a row matches when `pred` does **not**. Lowers to
 * `not-join` on the root entity variable, so `not(or(…))` and
 * `not(Todo.due.missing())` nest the way they read.
 */
export const not = (pred: WhereNode): Not => ({ _tag: "Not", pred });

export const isOr = (x: unknown): x is Or =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Or";

export const isNot = (x: unknown): x is Not =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Not";

export const isQuantified = (x: unknown): x is Quantified =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Quantified";

export type ShapeField =
  | AnyAttribute
  | PathCarrier
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

/**
 * `S`, with every multi-hop field replaced by {@link MultiHopField}. Used as
 * `shape: S & ValidShape<S>`: the intersection still infers `S` from the
 * argument, and a hopped field has nowhere to go.
 */
export type ValidShape<S> = {
  readonly [K in keyof S]: IsHopped<S[K]> extends true
    ? MultiHopField<K & string>
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
  /** Parallel to `path`; a reversed hop is many, so this is always all-false. */
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
 * `some` / `every` / `none` quantify over the entities a hop reaches, so they
 * are defined exactly on cardinality-many refs — including the many hop a
 * `.reverse` backlink always is.
 *
 * A cardinality-many *scalar* has no target to root an inner predicate at,
 * and does not need one: a bare predicate on it (`Todo.tags.eq("x")`) already
 * means "some value matches".
 */
type IsManyRef<A> = A extends {
  readonly cardinality: "many";
  readonly valueType: ":db.type/ref";
}
  ? true
  : false;

/** Predicate / shape methods attached to every stamped attr. */
export type AttrNav<A extends PathCarrier> = A & {
  readonly eq: (value: AttrValue<A>) => Predicate;
  readonly ne: (value: AttrValue<A>) => Predicate;
  readonly lt: (value: AttrValue<A>) => Predicate;
  readonly lte: (value: AttrValue<A>) => Predicate;
  readonly gt: (value: AttrValue<A>) => Predicate;
  readonly gte: (value: AttrValue<A>) => Predicate;
  readonly in: (values: readonly InValue<A>[]) => Predicate;
  readonly startsWith: (prefix: string) => Predicate;
  readonly endsWith: (suffix: string) => Predicate;
  readonly includes: (needle: string) => Predicate;
  readonly matches: (re: RegExp | string) => Predicate;
  readonly exists: () => Predicate;
  readonly missing: () => Predicate;
  /** Ref-only: the entity this ref points at. */
  readonly is: A extends { readonly valueType: ":db.type/ref" }
    ? (ref: EidLike) => Predicate
    : never;
  /** Card-many ref only: at least one element satisfies `pred`. */
  readonly some: IsManyRef<A> extends true
    ? (pred: WhereNode) => Quantified
    : never;
  /** Card-many ref only: no element fails `pred` (vacuously true when empty). */
  readonly every: IsManyRef<A> extends true
    ? (pred: WhereNode) => Quantified
    : never;
  /** Card-many ref only: no element satisfies `pred` (true when empty). */
  readonly none: IsManyRef<A> extends true
    ? (pred: WhereNode) => Quantified
    : never;
  /**
   * Card-many ref / backlink only: filter this collection, per element, on
   * the peer. The predicates are rooted at the **element** and lower to the
   * nested pull's `:where` — never to the query's own, so the outer `.limit`
   * still counts rows and a collection that filters to nothing is `[]`.
   */
  readonly where: IsManyRef<A> extends true
    ? (...preds: readonly WhereNode[]) => CollectionNav<A>
    : never;
  /** Card-many ref / backlink only: sort this collection by a card-one key. */
  readonly orderBy: IsManyRef<A> extends true
    ? (
        key: NestedOrderKey,
        dir?: OrderDir,
        opts?: { readonly empty?: OrderEmpty },
      ) => CollectionNav<A>
    : never;
  /** Card-many ref / backlink only: keep at most `n` elements. */
  readonly limit: IsManyRef<A> extends true
    ? (n: number) => CollectionNav<A>
    : never;
  /** Card-many ref / backlink only: drop `n` elements from the front. */
  readonly offset: IsManyRef<A> extends true
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
      `ripple/query: matches(/${re.source}/${re.flags}) — the peer compiles the pattern with no flags, so \`${re.flags}\` cannot be lowered. Express it in the pattern instead (e.g. \`[aA]da\` for case-insensitivity).`,
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
    `ripple/query: is(...) takes an entity id or an Eid, got ${String(ref)}`,
  );
};

/**
 * Build a quantified node, rejecting the two shapes that cannot mean anything:
 * a card-one hop (there is nothing to quantify over) and a scalar hop (there
 * is no entity for `pred` to be rooted at).
 */
const quantified = (
  quant: Quantifier,
  attr: PathCarrier,
  pred: WhereNode,
): Quantified => {
  const path = pathOf(attr);
  const cards = cardsOf(attr);
  if (cards[cards.length - 1] !== "many") {
    throw new Error(
      `ripple/query: ${quant}(...) on ${path.join(" → ")} — only a cardinality-many attribute has elements to quantify over`,
    );
  }
  if ((attr as { valueType?: unknown }).valueType !== ":db.type/ref") {
    throw new Error(
      `ripple/query: ${quant}(...) on ${path.join(" → ")} — the inner predicate is rooted at the hop's target, so the hop must be a ref. A predicate on a cardinality-many scalar already means "some value matches".`,
    );
  }
  return {
    _tag: "Quantified",
    quant,
    path,
    cards,
    revs: revsOf(attr),
    pred,
  };
};

// ── nested collections: pull-phase where / order / offset / limit ──────────

/**
 * A card-many ref or backlink nav with pull-phase constraints attached:
 *
 * ```ts
 * Todo.owner.reverse.where(Todo.done.eq(false)).orderBy(Todo.due).limit(5)
 *   .select({ title: Todo.title })
 * ```
 *
 * The constraints lower to the `PullAttrSpec` fields of *this* collection
 * (`:where` / `:order` / `:offset` / `:limit`) and are evaluated inside the
 * pull, after the outer `:order` / `:offset` / `:limit` slice — they filter the
 * collection, never the rows. An element-less collection is `[]`, not a
 * dropped parent, so the outer `:limit` still counts rows the client keeps.
 */
export interface CollectionNav<A extends PathCarrier = PathCarrier> {
  readonly _tag: "collection";
  readonly attr: A;
  /** Already lowered — each call lowers its argument eagerly. */
  readonly constraints: PullNestedConstraints;
  where(...preds: readonly WhereNode[]): CollectionNav<A>;
  orderBy(
    key: NestedOrderKey,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): CollectionNav<A>;
  limit(n: number): CollectionNav<A>;
  offset(n: number): CollectionNav<A>;
  select<const S extends Shape>(shape: S & ValidShape<S>): SelectNested<A, S>;
}

/**
 * A sort key for a nested collection: a path rooted at the element, and
 * card-one — a many attribute's sort key would be a set, not a value, and is
 * rejected here at the type level (the outer `orderBy` rejects it when the
 * query is built).
 */
export type NestedOrderKey = PathCarrier & {
  readonly cardinality?: "one";
};

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
 * The namespace of the element a nested `where` / `orderBy` is rooted at: the
 * *referring* entity of a backlink (so, the ref's own namespace), or the
 * target of a forward ref. `undefined` for an untargeted ref — then paths go
 * unchecked rather than wrongly rejected.
 */
const elementNs = (attr: PathCarrier): string | undefined => {
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
 * A nested path starts at the element, so its first forward hop must be an
 * attribute of the element's namespace. (A first hop that is itself a backlink
 * is rooted at the referring namespace, and says nothing about the element.)
 */
const checkElementRoot = (
  elemNs: string | undefined,
  path: readonly string[],
  revs: readonly boolean[],
  what: string,
  collection: readonly string[],
): void => {
  const first = path[0];
  if (elemNs === undefined || first === undefined) return;
  if (first === ID || revs[0] === true) return;
  const ns = nsOfIdent(first);
  if (ns !== undefined && ns !== elemNs) {
    throw new Error(
      `ripple/query: nested ${what}(${path.join(" → ")}) on ${collection.join(" → ")} is rooted at the collection's element, which is a :${elemNs}/… entity — ${first} is not one of its attributes`,
    );
  }
};

/**
 * Lower a where-node into a per-element pull predicate.
 *
 * `prefix` is the hop chain of the `some(...)`s we are inside. Fan-out along a
 * path is existential, so a prefix distributes over a comparison and over `or`
 * (`∃x (P ∨ Q)` is `(∃x P) ∨ (∃x Q)`) — but not over a negation, which is why
 * `not` / `none` under a `some` are rejected instead of quietly meaning
 * something else. `every` has no pull-phase spelling at all.
 */
const lowerElemNode = (
  node: WhereNode,
  prefix: readonly string[],
  prefixRevs: readonly boolean[],
  elemNs: string | undefined,
  collection: readonly string[],
): PullElemPred => {
  if (isOr(node)) {
    return {
      or: node.preds.map((p) =>
        lowerElemNode(p, prefix, prefixRevs, elemNs, collection),
      ),
    };
  }
  if (isNot(node)) {
    if (prefix.length > 0) {
      throw new Error(
        `ripple/query: not(...) inside some(...) is not expressible in a nested where on ${collection.join(" → ")} — "some element whose hop does not …" needs an element cursor the pull phase does not have`,
      );
    }
    return { not: lowerElemNode(node.pred, [], [], elemNs, collection) };
  }
  if (isQuantified(node)) {
    checkElementRoot(elemNs, node.path, node.revs, "where", collection);
    if (node.quant === "some") {
      // an existential hop is exactly a longer path: fan-out is existential
      return lowerElemNode(
        node.pred,
        [...prefix, ...node.path],
        [...prefixRevs, ...node.revs],
        undefined,
        collection,
      );
    }
    if (node.quant === "none") {
      if (prefix.length > 0) {
        throw new Error(
          `ripple/query: none(...) inside some(...) is not expressible in a nested where on ${collection.join(" → ")}`,
        );
      }
      // no element matches = not(some element matches)
      return {
        not: lowerElemNode(
          node.pred,
          [...node.path],
          [...node.revs],
          undefined,
          collection,
        ),
      };
    }
    throw new Error(
      `ripple/query: every(...) is not expressible in a nested where on ${collection.join(" → ")} — it is not the negation of an existential (an element with no value at all fails it), and the pull phase has no element cursor. Use some(...) / none(...) here, or put the every(...) in the query's own .where`,
    );
  }
  return lowerElemCmp(node, prefix, prefixRevs, elemNs, collection);
};

const lowerElemCmp = (
  p: Predicate,
  prefix: readonly string[],
  prefixRevs: readonly boolean[],
  elemNs: string | undefined,
  collection: readonly string[],
): PullElemCmp => {
  const revs = p.revs ?? p.path.map(() => false);
  checkElementRoot(elemNs, p.path, revs, "where", collection);
  const op = PULL_OPS[p.op];
  if (op === undefined) {
    throw new Error(
      `ripple/query: ${p.op} has no nested-where spelling on ${collection.join(" → ")}`,
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
  elemNs: string | undefined,
  collection: readonly string[],
): PullElemOrder => {
  const path = pathOf(key);
  if (cardsOf(key).includes("many")) {
    throw new Error(
      `ripple/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  const revs = revsOf(key);
  checkElementRoot(elemNs, path, revs, "orderBy", collection);
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
  const elemNs = elementNs(attr);
  const collection = pathOf(attr);
  const self: CollectionNav<A> = {
    _tag: "collection",
    attr,
    constraints,
    where: (...preds) =>
      collectionNav(attr, {
        ...constraints,
        where: [
          ...(constraints.where ?? []),
          ...preds.map((p) => lowerElemNode(p, [], [], elemNs, collection)),
        ],
      }),
    orderBy: (key, dir = "asc", opts) =>
      collectionNav(attr, {
        ...constraints,
        order: [
          ...(constraints.order ?? []),
          lowerElemOrder(key, dir, opts?.empty, elemNs, collection),
        ],
      }),
    limit: (n) => collectionNav(attr, { ...constraints, limit: n }),
    offset: (n) => collectionNav(attr, { ...constraints, offset: n }),
    select: (shape) =>
      makeSelectNested(attr, shape, constraints) as SelectNested<
        A,
        typeof shape
      >,
  };
  return self;
};

/**
 * Start constraining a collection. Only a cardinality-many **ref** has
 * elements to filter and order: a card-one ref reaches one entity (constrain
 * it in the query's own `.where`), and a card-many *scalar* has no element to
 * root a predicate at.
 */
const collectionOf = (attr: PathCarrier, method: string): CollectionNav => {
  const cards = cardsOf(attr);
  const isRef = (attr as { valueType?: unknown }).valueType === ":db.type/ref";
  if (cards[cards.length - 1] !== "many" || !isRef) {
    throw new Error(
      `ripple/query: ${method}(...) on ${pathOf(attr).join(" → ")} — nested where / orderBy / limit / offset constrain a cardinality-many ref collection or a backlink, which is what has elements to filter`,
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
          `ripple/query: in(...) takes an array of values, got ${String(values)}`,
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
  orderBy(
    attr: PathCarrier,
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
 * const boardQuery = Ripple.query(Issue).select({ id: Issue.id, ... });
 * type BoardRow = Ripple.Row<typeof boardQuery>;   // one row
 * type BoardRows = Ripple.Rows<typeof boardQuery>; // the readonly array
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
    where: (...preds) =>
      builder(ns, { ...spec, where: [...spec.where, ...preds] }),
    select: (shape) =>
      builder(ns, { ...spec, shape }) as unknown as NavQueryBuilder<
        N,
        readonly SelectResult<typeof shape>[]
      >,
    orderBy: (attr, dir = "asc", opts) => {
      const path = pathOf(attr);
      if (cardsOf(attr).includes("many")) {
        throw new Error(
          `ripple/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
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
 * `db.q(Ripple.query(Todo).where(...).select(...))` works without `.build()`.
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
const lowerWhere = (root: string, node: WhereNode): unknown[] => {
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

const lowerPredicate = (root: string, p: Predicate): unknown[] => {
  const { path, op, value } = p;
  if (path.length === 0) return [];
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
 * `:db/id` is the entity variable, not a datom: `eq` unifies it with the
 * constant so the planner starts there, and the ordering predicates compare
 * it as the number it is. Every entity has one, so `exists` costs no clause.
 */
const lowerIdPredicate = (
  root: string,
  path: readonly string[],
  revs: readonly boolean[],
  p: Predicate,
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
        `ripple/query: ${p.op} is not defined on :db/id — an entity id is a number`,
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
