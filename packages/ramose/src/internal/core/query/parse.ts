/**
 * Query / pull-pattern parsing: EDN strings or JS forms → AST.
 *
 * JS form mirrors EDN structurally:
 *   { find: ["?e", ["count", "?x"]], in: ["$", "?name"], where: [["?e", ":user/name", "?name"], [[">", "?x", 5]]] }
 * Strings beginning with '?' are variables, '_' is blank, strings beginning
 * with ':' are keywords (attribute idents / enum values); wrap other strings
 * that happen to look like that in `{ const: "..." }`.
 */

import {
  type Binding,
  type Clause,
  type FindElem,
  type FindSpec,
  type InputSpec,
  type OrderSpec,
  PULL_ELEM_OPS,
  type PullAttrSpec,
  type PullElemCmp,
  type PullElemOp,
  type PullElemOrder,
  type PullElemPred,
  type PullElemQuant,
  type PullPattern,
  type Query,
  type RuleDef,
  type Term,
  blank,
} from "./ast.ts";
import { EdnList, isEdnConstWrapper, printEdn, readEdn, unwrapEdnConst } from "./edn.ts";

export class QueryParseError extends Error {}

function fail(msg: string, form?: unknown): never {
  throw new QueryParseError(form === undefined ? msg : `${msg}: ${printEdn(form)}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isVarName(x: unknown): x is string {
  return typeof x === "string" && x.length > 1 && x[0] === "?";
}
function isSrcName(x: unknown): x is string {
  return typeof x === "string" && x[0] === "$";
}
function isKeyword(x: unknown): x is string {
  return typeof x === "string" && x.length > 1 && x[0] === ":";
}
function isFnName(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && !isVarName(x) && !isKeyword(x) && !isSrcName(x) && x !== "_";
}

/** An expression form: EDN list, or a JS array whose head is a plain symbol. */
function asExpr(x: unknown): unknown[] | undefined {
  if (x instanceof EdnList) return x.items;
  if (Array.isArray(x) && x.length > 0 && isFnName(x[0])) return x;
  return undefined;
}

export function toTerm(x: unknown): Term {
  if (x === "_") return blank;
  if (isVarName(x)) return { kind: "var", name: x };
  if (isEdnConstWrapper(x)) return { kind: "const", value: unwrapEdnConst(x) };
  return { kind: "const", value: x };
}

function toBinding(x: unknown): Binding {
  if (isVarName(x)) return { kind: "scalar", var: x };
  if (Array.isArray(x)) {
    if (x.length === 2 && x[1] === "...") {
      if (!isVarName(x[0])) fail("collection binding needs a variable", x);
      return { kind: "coll", var: x[0] };
    }
    if (x.length === 1 && Array.isArray(x[0])) {
      return { kind: "rel", vars: x[0].map(bindVar) };
    }
    return { kind: "tuple", vars: x.map(bindVar) };
  }
  return fail("bad binding form", x);
}
function bindVar(x: unknown): string | null {
  if (x === "_") return null;
  if (isVarName(x)) return x;
  return fail("bad binding variable", x);
}

// ---------------------------------------------------------------------------
// where clauses
// ---------------------------------------------------------------------------

export function toClause(form: unknown): Clause {
  const expr = asExpr(form);
  if (expr) {
    // bare list at clause position: (not ...) (or ...) (or-join ...) (not-join ...) (and ...)
    return listClause(expr, form);
  }
  if (!Array.isArray(form)) fail("clause must be a vector or list", form);
  const arr = form as unknown[];
  if (arr.length === 0) fail("empty clause");
  const inner = asExpr(arr[0]);
  if (inner) {
    // [(pred ...)] or [(fn ...) binding]
    const head = inner[0];
    if (typeof head !== "string") fail("function/predicate name must be a symbol", form);
    if (head === "not" || head === "or" || head === "or-join" || head === "not-join" || head === "and") {
      return listClause(inner, form);
    }
    const args = inner.slice(1).map(toTerm);
    if (arr.length === 1) return { kind: "pred", fn: head, args };
    if (arr.length === 2) return { kind: "fn", fn: head, args, binding: toBinding(arr[1]) };
    return fail("bad function clause", form);
  }
  // data pattern: [src?] e a v tx? op?
  let i = 0;
  let src: string | undefined;
  if (isSrcName(arr[0])) {
    src = arr[0] as string;
    i = 1;
  }
  const rest = arr.slice(i);
  if (rest.length < 1 || rest.length > 5) fail("data pattern needs 1–5 components", form);
  const t = (k: number): Term => (k < rest.length ? toTerm(rest[k]) : blank);
  const clause: Clause = { kind: "pattern", src, e: t(0), a: t(1), v: t(2) };
  if (rest.length > 3) clause.tx = t(3);
  if (rest.length > 4) clause.op = t(4);
  return clause;
}

function listClause(items: unknown[], form: unknown): Clause {
  const head = items[0];
  switch (head) {
    case "not":
      return { kind: "not", clauses: items.slice(1).map(toClause) };
    case "not-join": {
      const join = items[1];
      if (!Array.isArray(join) || !join.every(isVarName)) fail("not-join needs a vector of variables", form);
      return { kind: "not", join: join as string[], clauses: items.slice(2).map(toClause) };
    }
    case "or":
      return { kind: "or", branches: items.slice(1).map(orBranch) };
    case "or-join": {
      const join = items[1];
      if (!Array.isArray(join)) fail("or-join needs a vector of variables", form);
      // Datomic allows [[?a ?b] ?c] required-var syntax; flatten
      const vars = (join as unknown[]).flatMap((x) => (Array.isArray(x) ? x : [x])) as string[];
      if (!vars.every(isVarName)) fail("or-join needs variables", form);
      return { kind: "or", join: vars, branches: items.slice(2).map(orBranch) };
    }
    case "and":
      return fail("(and ...) is only valid inside (or ...)", form);
    default: {
      // any other symbol head is a rule invocation; parseQuery checks the
      // name against :rules afterwards, so a typo'd combinator still fails
      if (!isFnName(head)) return fail(`bad clause head '${String(head)}'`, form);
      return { kind: "rule-call", name: head as string, args: items.slice(1).map(toTerm) };
    }
  }
}

function orBranch(form: unknown): Clause[] {
  const expr = asExpr(form);
  if (expr && expr[0] === "and") return expr.slice(1).map(toClause);
  return [toClause(form)];
}

// ---------------------------------------------------------------------------
// find / in
// ---------------------------------------------------------------------------

function toFindElem(x: unknown): FindElem {
  if (isVarName(x)) return { kind: "var", name: x };
  const expr = asExpr(x);
  if (expr) {
    const head = expr[0];
    if (head === "pull") {
      if (!isVarName(expr[1])) fail("pull needs a variable", x);
      const pat = expr[2];
      return { kind: "pull", var: expr[1], pattern: isVarName(pat) ? { kind: "var", name: pat } : parsePullPattern(pat) };
    }
    if (head === "as") {
      if (expr.length !== 3) fail("as is (as <aggregate> ?var)", x);
      const inner = toFindElem(expr[1]);
      if (inner.kind !== "agg") fail("as names an aggregate find element", x);
      if (inner.as !== undefined) fail("as does not nest", x);
      if (!isVarName(expr[2])) fail("as needs a variable", x);
      return { ...inner, as: expr[2] };
    }
    if (typeof head !== "string") fail("aggregate name must be a symbol", x);
    return { kind: "agg", fn: head, args: expr.slice(1).map(toTerm) };
  }
  return fail("bad find element", x);
}

function toFindSpec(form: unknown): FindSpec {
  if (!Array.isArray(form) || form.length === 0) fail("find spec must be a non-empty vector", form);
  const f = form as unknown[];
  if (f.length === 2 && f[1] === ".") return { kind: "scalar", elem: toFindElem(f[0]) };
  if (f.length === 1 && Array.isArray(f[0])) {
    const inner = f[0] as unknown[];
    if (asExpr(f[0]) === undefined) {
      if (inner.length === 2 && inner[1] === "...") return { kind: "coll", elem: toFindElem(inner[0]) };
      return { kind: "tuple", elems: inner.map(toFindElem) };
    }
  }
  return { kind: "rel", elems: f.map(toFindElem) };
}

function toInputs(form: unknown): InputSpec[] {
  if (form === undefined) return [{ kind: "src", name: "$" }];
  if (!Array.isArray(form)) fail("in spec must be a vector", form);
  return (form as unknown[]).map((x) => (isSrcName(x) ? { kind: "src", name: x } : toBinding(x)));
}

// ---------------------------------------------------------------------------
// order / limit / offset
// ---------------------------------------------------------------------------

/** Strip a leading ':' so EDN keywords and plain JSON strings both work. */
function bare(x: unknown): unknown {
  return typeof x === "string" && x.startsWith(":") ? x.slice(1) : x;
}

function orderDir(x: unknown, form: unknown): "asc" | "desc" {
  if (x === undefined) return "asc";
  const s = bare(x);
  if (s === "asc" || s === "desc") return s;
  return fail("order direction must be :asc or :desc", form);
}

function orderEmpty(x: unknown, form: unknown): "first" | "last" | undefined {
  if (x === undefined) return undefined;
  const s = bare(x);
  if (s === "first" || s === "last") return s;
  return fail("order empty placement must be :first or :last", form);
}

function mkOrder(name: string, dir: "asc" | "desc", empty: "first" | "last" | undefined): OrderSpec {
  return empty === undefined ? { var: name, dir } : { var: name, dir, empty };
}

/** `?v` | `[?v :desc :last]` | `{:var ?v :dir :desc :empty :last}` */
function toOrderSpec(x: unknown): OrderSpec {
  if (isVarName(x)) return { var: x, dir: "asc" };
  if (Array.isArray(x)) {
    if (!isVarName(x[0])) fail("order needs a variable", x);
    if (x.length > 3) fail("order tuple is [?var dir? empty?]", x);
    return mkOrder(x[0] as string, orderDir(x[1], x), orderEmpty(x[2], x));
  }
  if (typeof x === "object" && x !== null && !(x instanceof EdnList)) {
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) m[String(bare(k))] = v;
    for (const k of Object.keys(m)) if (k !== "var" && k !== "dir" && k !== "empty") fail(`unknown order key :${k}`, x);
    if (!isVarName(m.var)) fail("order needs a variable", x);
    return mkOrder(m.var as string, orderDir(m.dir, x), orderEmpty(m.empty, x));
  }
  return fail("bad order spec", x);
}

function toOrder(form: unknown): OrderSpec[] | undefined {
  if (form === undefined) return undefined;
  if (!Array.isArray(form)) fail("order must be a vector", form);
  const specs = (form as unknown[]).map(toOrderSpec);
  return specs.length ? specs : undefined;
}

function toCount(x: unknown, key: string): number | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) fail(`:${key} must be a non-negative integer`, x);
  return x as number;
}

/** `:after [v0 v1 …]` — one value per `:order` key (`nil`/`null` allowed). */
function toAfter(form: unknown, order: OrderSpec[] | undefined, find: FindSpec): unknown[] | undefined {
  if (form === undefined || form === null) return undefined;
  if (!Array.isArray(form)) fail(":after must be a vector of values, one per :order key", form);
  if (order === undefined) fail(":after needs :order — a cursor is a position in the sort", form);
  if (form.length !== order.length) {
    fail(`:after has ${form.length} values for ${order.length} :order keys`, form);
  }
  const elems = find.kind === "rel" || find.kind === "tuple" ? find.elems : [find.elem];
  if (elems.some((e) => e.kind === "agg")) fail(":after is not supported with aggregates", form);
  return (form as unknown[]).map((x) => (isEdnConstWrapper(x) ? unwrapEdnConst(x) : x));
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

const SECTIONS = [":find", ":in", ":where", ":with", ":keys", ":strs", ":syms", ":rules", ":having", ":order", ":after", ":limit", ":offset"];
/** Sections that take a single value rather than a sequence of forms. */
const SCALAR_SECTIONS = ["after", "limit", "offset", "rules"];
const QUERY_KEYS = new Set(SECTIONS.map((s) => s.slice(1)));

function normalizeMap(form: unknown): Record<string, unknown> {
  if (typeof form === "string") form = readEdn(form);
  if (Array.isArray(form)) {
    // [:find ... :in ... :where ...]
    const out: Record<string, unknown> = {};
    let key: string | undefined;
    for (const x of form as unknown[]) {
      if (isKeyword(x) && SECTIONS.includes(x)) {
        key = x.slice(1);
        out[key] = [];
        continue;
      }
      if (!key) fail("query vector must start with :find", form);
      (out[key] as unknown[]).push(x);
    }
    for (const k of SCALAR_SECTIONS) {
      const vs = out[k] as unknown[] | undefined;
      if (vs === undefined) continue;
      if (vs.length !== 1) fail(`:${k} takes exactly one value`, form);
      out[k] = vs[0];
    }
    return out;
  }
  if (typeof form !== "object" || form === null) fail("query must be a map, vector, or EDN string", form);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form as Record<string, unknown>)) out[k.startsWith(":") ? k.slice(1) : k] = v;
  return out;
}

export function parseQuery(form: unknown): Query {
  const m = normalizeMap(form);
  for (const k of Object.keys(m)) {
    if (!QUERY_KEYS.has(k)) fail(`unknown query key :${k} (expected one of ${SECTIONS.join(" ")})`);
  }
  if (m.find === undefined) fail("query is missing :find");
  const find = toFindSpec(m.find);
  const where = m.where === undefined ? [] : (Array.isArray(m.where) ? m.where.map(toClause) : fail("where must be a vector", m.where));
  const inputs = toInputs(m.in);
  const withVars = m.with === undefined ? [] : (m.with as unknown[]).map((x) => (isVarName(x) ? x : fail("with needs variables", m.with)));
  const keysForm = m.keys ?? m.strs ?? m.syms;
  const keys = keysForm === undefined ? undefined : (keysForm as unknown[]).map(String);
  if (keys && find.kind !== "rel") fail(":keys requires a relation find spec");
  if (keys && find.kind === "rel" && keys.length !== find.elems.length) fail(":keys length must match :find");
  const rules = toRules(m.rules);
  checkRuleCalls(where, rules);
  const having = toHaving(m.having, find);
  const order = toOrder(m.order);
  const after = toAfter(m.after, order, find);
  const limit = toCount(m.limit, "limit");
  const offset = toCount(m.offset, "offset");
  return { find, keys, with: withVars, in: inputs, where, rules, having, order, after, limit, offset };
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/**
 * `:rules [[[name ?a ?b] clause…] …]` — each definition is a head vector
 * followed by body clauses; same-named definitions are disjunctive branches
 * and must agree on arity.
 */
function toRules(form: unknown): RuleDef[] | undefined {
  if (form === undefined) return undefined;
  if (!Array.isArray(form)) fail(":rules must be a vector of rule definitions", form);
  const defs = (form as unknown[]).map(toRuleDef);
  if (defs.length === 0) return undefined;
  const arity = new Map<string, number>();
  for (const d of defs) {
    const seen = arity.get(d.name);
    if (seen !== undefined && seen !== d.args.length) {
      fail(`rule ${d.name} is defined with ${seen} and ${d.args.length} head variables — branches of one rule share a head`);
    }
    arity.set(d.name, d.args.length);
  }
  for (const d of defs) checkRuleCalls(d.clauses, defs);
  return defs;
}

function toRuleDef(form: unknown): RuleDef {
  const items = form instanceof EdnList ? form.items : Array.isArray(form) ? (form as unknown[]) : fail("rule definition must be [[name ?arg…] clause…]", form);
  if (items.length < 2) fail("rule definition needs a head and at least one clause", form);
  const head = items[0] instanceof EdnList ? (items[0] as EdnList).items : Array.isArray(items[0]) ? (items[0] as unknown[]) : fail("rule head must be [name ?arg…]", form);
  const name = head[0];
  if (!isFnName(name)) fail("rule name must be a plain symbol", form);
  const args = head.slice(1);
  if (args.length === 0) fail(`rule ${String(name)} needs at least one head variable`, form);
  if (!args.every(isVarName)) fail(`rule ${String(name)} head takes variables only`, form);
  if (new Set(args).size !== args.length) fail(`rule ${String(name)} repeats a head variable`, form);
  return { name: name as string, args: args as string[], clauses: items.slice(1).map(toClause) };
}

/** Every rule-call must name a declared rule with the declared arity. */
function checkRuleCalls(clauses: Clause[], rules: RuleDef[] | undefined): void {
  const arity = new Map<string, number>();
  for (const d of rules ?? []) arity.set(d.name, d.args.length);
  const walk = (c: Clause): void => {
    switch (c.kind) {
      case "rule-call": {
        const n = arity.get(c.name);
        if (n === undefined) {
          fail(`unknown clause form '${c.name}' — not a builtin and not a rule declared in :rules`);
        }
        if (c.args.length !== n) fail(`rule ${c.name} takes ${n} arguments, got ${c.args.length}`);
        break;
      }
      case "not":
        c.clauses.forEach(walk);
        break;
      case "or":
        c.branches.forEach((b) => b.forEach(walk));
        break;
      default:
        break;
    }
  };
  clauses.forEach(walk);
}

/** `:having` — post-group predicates over `:find` cells, never datoms. */
function toHaving(form: unknown, find: FindSpec): Clause[] | undefined {
  if (form === undefined) return undefined;
  if (!Array.isArray(form)) fail("having must be a vector", form);
  const clauses = (form as unknown[]).map(toClause);
  if (clauses.length === 0) return undefined;
  const elems = find.kind === "rel" || find.kind === "tuple" ? find.elems : [find.elem];
  if (!elems.some((e) => e.kind === "agg")) {
    fail(":having needs aggregates — it filters groups after they are computed", form);
  }
  const walk = (c: Clause): void => {
    switch (c.kind) {
      case "pattern":
        fail(":having filters grouped cells, not datoms — put row filters in :where", form);
        break;
      case "fn":
        fail(":having does not bind functions — compare the group cells", form);
        break;
      case "pred":
        break;
      case "not":
        c.clauses.forEach(walk);
        break;
      case "or":
        c.branches.forEach((b) => b.forEach(walk));
        break;
    }
  };
  clauses.forEach(walk);
  return clauses;
}

// ---------------------------------------------------------------------------
// pull patterns
// ---------------------------------------------------------------------------

export function parsePullPattern(form: unknown): PullPattern {
  if (typeof form === "string") form = readEdn(form);
  if (!Array.isArray(form)) fail("pull pattern must be a vector", form);
  return (form as unknown[]).map(pullSpec);
}

function attrName(x: unknown, form: unknown): { attr: string; reverse: boolean } {
  if (!isKeyword(x)) fail("pull attribute must be a keyword", form);
  const s = x as string;
  const slash = s.lastIndexOf("/");
  const name = slash >= 0 ? s.slice(slash + 1) : s.slice(1);
  if (name.startsWith("_")) {
    const attr = slash >= 0 ? s.slice(0, slash + 1) + name.slice(1) : ":" + name.slice(1);
    return { attr, reverse: true };
  }
  return { attr: s, reverse: false };
}

// --- nested collection :where / :order --------------------------------------

/** Map-ish form with the leading ':' stripped from every key. */
function keyedMap(x: unknown, what: string, form: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x) || x instanceof EdnList) fail(`${what} must be a map`, form);
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) m[String(bare(k))] = v;
  return m;
}

/**
 * A path of attribute idents walked from a collection element, plus which hops
 * run backwards. Reverse spelling (`:user/_friends`) and an explicit `reverse`
 * flag mean the same thing, so a client may use either.
 */
function elemPath(pathForm: unknown, revForm: unknown, form: unknown): { path: string[]; reverse?: boolean[] } {
  if (!Array.isArray(pathForm)) fail("pull path must be a vector of attribute idents", form);
  if (revForm !== undefined && !Array.isArray(revForm)) fail("pull path :reverse must be a vector of booleans", form);
  const revIn = (revForm as unknown[] | undefined) ?? [];
  const path: string[] = [];
  const reverse: boolean[] = [];
  (pathForm as unknown[]).forEach((p, i) => {
    if (!isKeyword(p)) fail("pull path must be a vector of attribute idents", form);
    const { attr, reverse: rev } = p === ":db/id" ? { attr: ":db/id", reverse: false } : attrName(p, form);
    path.push(attr);
    reverse.push(rev || revIn[i] === true);
  });
  return reverse.some(Boolean) ? { path, reverse } : { path };
}

/** A comparison operand: plain data, with `{const: …}` wrappers unwrapped. */
function elemValue(x: unknown): unknown {
  return isEdnConstWrapper(x) ? unwrapEdnConst(x) : x;
}

function elemPreds(x: unknown, form: unknown): PullElemPred[] {
  if (!Array.isArray(x)) fail("pull :where must be a vector of predicates", form);
  return (x as unknown[]).map((p) => elemPred(p, form));
}

/** `{:every {:path […] :pred {…}}}` — a quantifier over what `path` reaches. */
function elemQuant(x: unknown, what: string, form: unknown): PullElemQuant {
  const m = keyedMap(x, `pull :where ${what}`, form);
  if (m.pred === undefined) fail(`pull :where ${what} needs a :pred`, form);
  return { ...elemPath(m.path ?? [], m.reverse, form), pred: elemPred(m.pred, form) };
}

function elemPred(x: unknown, form: unknown): PullElemPred {
  const m = keyedMap(x, "pull :where predicate", form);
  if (m.and !== undefined) return { and: elemPreds(m.and, form) };
  if (m.or !== undefined) return { or: elemPreds(m.or, form) };
  if (m.not !== undefined) return { not: elemPred(m.not, form) };
  if (m.every !== undefined) return { every: elemQuant(m.every, "every", form) };
  if (m.some !== undefined) return { some: elemQuant(m.some, "some", form) };
  const op = bare(m.op);
  if (typeof op !== "string" || !(PULL_ELEM_OPS as readonly string[]).includes(op)) {
    fail(`unknown pull :where op ${String(m.op)} (expected one of ${PULL_ELEM_OPS.join(" ")})`, form);
  }
  const out: PullElemCmp = { ...elemPath(m.path ?? [], m.reverse, form), op: op as PullElemOp };
  if (op === "in") {
    if (!Array.isArray(m.value)) fail("pull :where in takes a vector of values", form);
    out.value = (m.value as unknown[]).map(elemValue);
  } else if (op !== "exists" && op !== "missing") {
    out.value = elemValue(m.value);
  }
  return out;
}

function elemOrders(x: unknown, form: unknown): PullElemOrder[] {
  if (!Array.isArray(x)) fail("pull :order must be a vector of sort keys", form);
  return (x as unknown[]).map((o) => {
    const m = keyedMap(o, "pull :order key", form);
    const empty = orderEmpty(m.empty, form);
    const key: PullElemOrder = { ...elemPath(m.path ?? [], m.reverse, form), dir: orderDir(m.dir, form) };
    if (empty !== undefined) key.empty = empty;
    return key;
  });
}

function pullSpec(x: unknown): PullAttrSpec | { kind: "wildcard" } {
  if (x === "*" || x === ":*") return { kind: "wildcard" };
  // Already-lowered AST specs (alchemy `lowerPullPattern`) pass through.
  if (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    (x as { kind?: unknown }).kind === "attr" &&
    typeof (x as { attr?: unknown }).attr === "string"
  ) {
    const spec = x as PullAttrSpec;
    const out: PullAttrSpec = { ...spec };
    if (spec.sub !== undefined) out.sub = parsePullPattern(spec.sub);
    if (spec.where !== undefined) out.where = elemPreds(spec.where, x);
    if (spec.order !== undefined) out.order = elemOrders(spec.order, x);
    if (spec.offset !== undefined) out.offset = toCount(spec.offset, "offset");
    return out;
  }
  if (isKeyword(x)) return { kind: "attr", ...attrName(x, x) };
  const expr = asExpr(x);
  if (expr) {
    // (attr :as "x" :limit 5 :default 0)  or  (limit :attr 5) / (default :attr 0)
    const head = expr[0];
    if (head === "limit") return { kind: "attr", ...attrName(expr[1], x), limit: expr[2] as number | null };
    if (head === "default") return { kind: "attr", ...attrName(expr[1], x), default: expr[2] };
    const spec: PullAttrSpec = { kind: "attr", ...attrName(head, x) };
    for (let i = 1; i + 1 < expr.length; i += 2) {
      const k = expr[i], v = expr[i + 1];
      if (k === ":as") spec.as = String(v);
      else if (k === ":limit") spec.limit = v as number | null;
      else if (k === ":offset") spec.offset = toCount(v, "offset");
      else if (k === ":where") spec.where = elemPreds(v, x);
      else if (k === ":order") spec.order = elemOrders(v, x);
      else if (k === ":default") spec.default = v;
      else fail(`unknown pull option ${String(k)}`, x);
    }
    return spec;
  }
  if (typeof x === "object" && x !== null && !Array.isArray(x)) {
    const entries = Object.entries(x as Record<string, unknown>);
    if (entries.length !== 1) fail("pull map spec must have exactly one entry", x);
    const [k, sub] = entries[0];
    const spec: PullAttrSpec = { kind: "attr", ...attrName(k, x) };
    if (sub === "...") spec.recursion = "...";
    else if (typeof sub === "number") spec.recursion = sub;
    else spec.sub = parsePullPattern(sub);
    return spec;
  }
  return fail("bad pull spec", x);
}
