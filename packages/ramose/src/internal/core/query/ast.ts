/**
 * Datalog query AST. The engine is AST-first: `parseQuery` turns EDN strings
 * or JS-form objects into this shape, and callers may build it directly.
 */

export interface Var {
  kind: "var";
  name: string; // includes leading '?'
}
export interface Const {
  kind: "const";
  value: unknown;
}
export interface Blank {
  kind: "blank";
}
export type Term = Var | Const | Blank;

/**
 * Who introduced a clause into the plan. Ordinary Datalog rule expansion
 * may stamp `"rule"`. This is not an authorization boundary — the query
 * engine binds every clause against the physical db it was given (CUR-1).
 */
export type ClauseOrigin = "caller" | "rule";

export interface PatternClause {
  kind: "pattern";
  src?: string; // "$" or "$name"
  e: Term;
  a: Term;
  v: Term;
  tx?: Term;
  op?: Term;
  origin?: ClauseOrigin;
}
export interface PredClause {
  kind: "pred";
  fn: string;
  args: Term[];
  origin?: ClauseOrigin;
}
export interface FnClause {
  kind: "fn";
  fn: string;
  args: Term[];
  binding: Binding;
  origin?: ClauseOrigin;
}
export interface NotClause {
  kind: "not";
  /** for not-join: explicit join vars */
  join?: string[];
  clauses: Clause[];
  origin?: ClauseOrigin;
}
export interface OrClause {
  kind: "or";
  /** for or-join: explicit join vars */
  join?: string[];
  branches: Clause[][];
  origin?: ClauseOrigin;
}
/**
 * Invocation of a named rule from `:rules`: `["memberOf", "?u", "?g"]` in a
 * `:where` (or inside another rule's body). Args line up positionally with
 * the rule head's variables; a constant arg constrains that head position, a
 * blank leaves it free and unexported.
 */
export interface RuleCallClause {
  kind: "rule-call";
  name: string;
  args: Term[];
  origin?: ClauseOrigin;
}
export type Clause =
  | PatternClause
  | PredClause
  | FnClause
  | NotClause
  | OrClause
  | RuleCallClause;

export type Binding =
  | { kind: "scalar"; var: string }
  | { kind: "tuple"; vars: (string | null)[] }
  | { kind: "coll"; var: string }
  | { kind: "rel"; vars: (string | null)[] };

export interface AggregateElem {
  kind: "agg";
  fn: string;
  /** constant args come first, the variable last (Datomic style: (sum ?x), (max 3 ?x)) */
  args: Term[];
  /**
   * Name of this cell in `:having` (and anywhere else that must name an
   * aggregate distinctly from the variable it summarizes). Written
   * `(as (count ?e) ?n)`. Absent, the cell is the summarized variable —
   * the same rule `:order` uses — which collides when two aggregates
   * share that variable, or when it is also a group key.
   */
  as?: string;
}
export interface PullElem {
  kind: "pull";
  var: string;
  pattern: PullPattern | Var;
}
export type FindElem = Var | AggregateElem | PullElem;

export type FindSpec =
  | { kind: "rel"; elems: FindElem[] }
  | { kind: "tuple"; elems: FindElem[] }
  | { kind: "coll"; elem: FindElem }
  | { kind: "scalar"; elem: FindElem };

export type InputSpec = { kind: "src"; name: string } | Binding;

/**
 * One sort key. Ordering is by a *bound variable* — a variable the :where
 * clauses bind, not necessarily one in :find — so multi-hop sorts lower to
 * ordinary joins (`[?e :todo/owner ?o] [?o :user/name ?n]`, order by `?n`).
 *
 * `empty` places rows whose value is null/undefined and defaults to "last"
 * in *both* directions; it is not flipped by `dir`.
 */
export interface OrderSpec {
  var: string;
  dir: "asc" | "desc";
  empty?: "first" | "last";
}

/**
 * One definition of a named rule: `[[name ?a ?b] clause…]`. Several
 * definitions under the same name are disjunctive branches (Datomic rule
 * semantics) and must agree on arity. A rule body may invoke rules —
 * including its own name — so recursion (and mutual recursion) is expressed
 * directly; the engine expands it under the query's memory budget.
 */
export interface RuleDef {
  name: string;
  /** Head variables, in call-argument order (leading '?' included). */
  args: string[];
  clauses: Clause[];
}

export interface Query {
  find: FindSpec;
  keys?: string[];
  with: string[];
  in: InputSpec[];
  where: Clause[];
  /** Named rules callable from :where (and from each other). */
  rules?: RuleDef[];
  /**
   * Post-group filter. After aggregates are computed, each group is one
   * `:find` tuple. `:having` keeps the groups whose cells satisfy every
   * clause — on the server, before `:order` / `:offset` / `:limit`.
   * Variables name `:find` cells: a variable element by its name, an
   * aggregate by `as` (`(as (count ?e) ?n)` → `?n`), or by the variable
   * it summarizes when `as` is omitted and that name is unique.
   * Clauses are predicates (and `not` / `or` of them) over those cells,
   * not data patterns and not function bindings.
   */
  having?: Clause[];
  /** sort keys, applied before :offset/:limit and before pulls are resolved */
  order?: OrderSpec[];
  /**
   * Keyset cursor: one value per `:order` key. Keeps only the rows *strictly
   * after* this position in the sort order — applied before :offset/:limit,
   * so `:limit` counts rows past the cursor. Exact only when the order is
   * total (make the last key a tie-breaker no two rows share, e.g. the
   * entity id); rows that compare equal to the cursor are dropped.
   * Requires `:order`; not supported with aggregates.
   */
  after?: unknown[];
  /** rows to drop from the front of the (ordered) result */
  offset?: number;
  /** maximum rows to return, after :offset */
  limit?: number;
}

// --- pull -------------------------------------------------------------------

/**
 * Comparison operators a nested pull `:where` understands. The names are the
 * engine's builtin predicate names (`PREDICATES` in builtins.ts) so the same
 * client lowering serves both places:
 *
 *   `=` `!=` `<` `<=` `>` `>=`  — compare the element's value(s) to `value`
 *   `in`                        — `value` is an array; membership by identity
 *   `starts-with?` `ends-with?` `includes?`  — string tests, `value` is the needle
 *   `re-find?` `re-matches?`    — `value` is a regex *source string* (no flags)
 *   `exists` `missing`          — the path has (no) value at all; `value` unused
 *
 * Every operator except `exists`/`missing` is existential over the values the
 * path reaches: it holds when *some* value satisfies it, and never holds when
 * the path reaches nothing (so `!=` means "has a value, and it differs").
 */
export const PULL_ELEM_OPS = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "starts-with?",
  "ends-with?",
  "includes?",
  "re-find?",
  "re-matches?",
  "exists",
  "missing",
] as const;
export type PullElemOp = (typeof PULL_ELEM_OPS)[number];

/**
 * One comparison inside a nested collection's `:where`.
 *
 * `path` is a chain of attribute idents walked from the *element* — the target
 * entity of a forward ref, the referring entity of a reverse (backlink) hop,
 * or the value itself for a cardinality-many scalar, where `path: []` compares
 * that value. `reverse[i]` walks hop `i` backwards (`[?next :a ?e]`), and the
 * reverse ident spelling (`:user/_friends`) is accepted too. `:db/id` at the
 * end of a path is the entity id itself. A hop that reaches several values
 * fans out: the predicate holds if *some* reachable value satisfies it.
 */
export interface PullElemCmp {
  path: string[];
  /** parallel to `path`; a hop walked backwards. Absent ⇒ all forward. */
  reverse?: boolean[];
  op: PullElemOp;
  /** the comparison operand; an array for `in`, unused by `exists`/`missing` */
  value?: unknown;
}
/**
 * A quantifier over the elements one path reaches from the current element.
 *
 * `pred` is evaluated with each reached value as the element in its turn — a
 * ref hop reaches entities (so `pred` may walk on from them), a scalar hop
 * reaches values (so `pred` compares them with `path: []`). It is how a nested
 * `:where` says something other than the existential a bare {@link PullElemCmp}
 * already is.
 */
export interface PullElemQuant {
  path: string[];
  /** parallel to `path`; a hop walked backwards. Absent ⇒ all forward. */
  reverse?: boolean[];
  pred: PullElemPred;
}

/**
 * Predicates over one element of a nested collection. Combinators nest.
 *
 * `{every: …}` holds when **no** reached element fails `pred` — vacuously true
 * when the path reaches nothing at all, the same rule the query's own `every`
 * quantifier follows. `{some: …}` holds when at least one does; it is the
 * explicit form of the existential a plain comparison already is, and exists
 * so that a negation *underneath* one (`∃x ¬P`) can be said at all.
 */
export type PullElemPred =
  | PullElemCmp
  | { and: PullElemPred[] }
  | { or: PullElemPred[] }
  | { not: PullElemPred }
  | { every: PullElemQuant }
  | { some: PullElemQuant };

/**
 * One sort key for a nested collection. `path`/`reverse` walk from the element
 * exactly as {@link PullElemCmp} does (`path: []` sorts a scalar collection by
 * its own values); a path that reaches several values sorts by the first in
 * index order, and one that reaches none is placed by `empty` (default
 * "last", in both directions) — the same rule the outer `:order` uses.
 */
export interface PullElemOrder {
  path: string[];
  reverse?: boolean[];
  dir: "asc" | "desc";
  empty?: "first" | "last";
}

export interface PullAttrSpec {
  kind: "attr";
  attr: string; // ident, e.g. ":user/name" (reverse: ":user/_friends")
  reverse: boolean;
  as?: string;
  /**
   * Max elements of a cardinality-many collection, applied *after* `where`,
   * `order` and `offset`. `null` is unlimited; absent means the pull default.
   */
  limit?: number | null;
  /** elements to drop from the front of the filtered, ordered collection */
  offset?: number;
  /** per-element predicates, ANDed; a collection that filters to nothing is
   * omitted (or `default`), it never drops the parent row */
  where?: PullElemPred[];
  /** sort keys for the collection, applied after `where` */
  order?: PullElemOrder[];
  default?: unknown;
  sub?: PullPattern;
  /** recursion depth for {:attr ...} with '...' or a number */
  recursion?: number | "...";
}
export interface PullWildcard {
  kind: "wildcard";
}
export type PullSpec = PullAttrSpec | PullWildcard;
export type PullPattern = PullSpec[];

/** Stamp `origin` through a clause tree (rule expansion inherits the call's origin). */
export function stampOrigin(c: Clause, origin: ClauseOrigin): Clause {
  switch (c.kind) {
    case "not":
      return { ...c, origin, clauses: c.clauses.map((x) => stampOrigin(x, origin)) };
    case "or":
      return { ...c, origin, branches: c.branches.map((b) => b.map((x) => stampOrigin(x, origin))) };
    default:
      return c.origin === origin ? c : { ...c, origin };
  }
}

export function isVar(t: Term): t is Var {
  return t.kind === "var";
}
export function v(name: string): Var {
  return { kind: "var", name };
}
export function c(value: unknown): Const {
  return { kind: "const", value };
}
export const blank: Blank = { kind: "blank" };
