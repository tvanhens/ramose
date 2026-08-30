export interface Var {
  kind: "var";
  name: string;
}
export interface Const {
  kind: "const";
  value: unknown;
}
export interface Blank {
  kind: "blank";
}
export type Term = Var | Const | Blank;

export type ClauseOrigin = "caller" | "rule";

export interface PatternClause {
  kind: "pattern";
  src?: string;
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
  join?: string[];
  clauses: Clause[];
  origin?: ClauseOrigin;
}
export interface OrClause {
  kind: "or";
  join?: string[];
  branches: Clause[][];
  origin?: ClauseOrigin;
}
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
  args: Term[];
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

export interface OrderSpec {
  var: string;
  dir: "asc" | "desc";
  empty?: "first" | "last";
}

export interface RuleDef {
  name: string;
  args: string[];
  clauses: Clause[];
}

export interface Query {
  find: FindSpec;
  keys?: string[];
  with: string[];
  in: InputSpec[];
  where: Clause[];
  rules?: RuleDef[];
  having?: Clause[];
  order?: OrderSpec[];
  after?: unknown[];
  offset?: number;
  limit?: number;
}

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

export interface PullElemCmp {
  path: string[];
  reverse?: boolean[];
  op: PullElemOp;
  value?: unknown;
}
export interface PullElemQuant {
  path: string[];
  reverse?: boolean[];
  pred: PullElemPred;
}

export type PullElemPred =
  | PullElemCmp
  | { and: PullElemPred[] }
  | { or: PullElemPred[] }
  | { not: PullElemPred }
  | { every: PullElemQuant }
  | { some: PullElemQuant };

export interface PullElemOrder {
  path: string[];
  reverse?: boolean[];
  dir: "asc" | "desc";
  empty?: "first" | "last";
}

export interface PullAttrSpec {
  kind: "attr";
  attr: string;
  reverse: boolean;
  as?: string;
  limit?: number | null;
  offset?: number;
  where?: PullElemPred[];
  order?: PullElemOrder[];
  default?: unknown;
  sub?: PullPattern;
  recursion?: number | "...";
}
export interface PullWildcard {
  kind: "wildcard";
}
export type PullSpec = PullAttrSpec | PullWildcard;
export type PullPattern = PullSpec[];

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
