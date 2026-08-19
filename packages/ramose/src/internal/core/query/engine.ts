/**
 * Datalog planner + executor.
 *
 * Planning is *seek-driven*: each data pattern picks an index from its bound
 * components (E → EAVT, A → AEVT, A+V → AVET (indexed) / VAET (ref)), clauses
 * are ordered greedily by estimated cardinality, and joins are either
 * index-nested-loop (one seek per distinct join tuple) or streaming hash
 * joins (one scan, probe the relation), chosen by a cost estimate. There is
 * no scan-and-filter fallback except for patterns with no bound E/A at all.
 *
 * Relations are `{ vars, rows }` with rows as arrays aligned to `vars`.
 */

import { type Datom, Index, type IndexId, type Prefix, ValueTag, inferTag } from "../datom.ts";
import { Db, coerceValue, datomJsValue } from "../db.ts";
import { TX_BASE, txEid } from "../schema.ts";
import {
  type Binding,
  type Clause,
  type FindElem,
  type NotClause,
  type OrClause,
  type PatternClause,
  type PullPattern,
  type Query,
  type Term,
} from "./ast.ts";
import { AGGREGATES, FUNCTIONS, PREDICATES, type QueryFn, sortKeys, sortRows, vkey } from "./builtins.ts";
import { parseQuery } from "./parse.ts";
import { pullMany } from "./pull.ts";

export class QueryError extends Error {
  readonly code: string = "query/error";
}

/**
 * Raised when a query would materialise more intermediate state than the
 * budget allows. Tagged (`code`) so peers can map it to a clear 4xx instead
 * of dying with an OOM inside the 128 MB Worker limit.
 */
export class QueryBudgetError extends QueryError {
  override readonly code = "query/budget-exceeded";
  constructor(
    readonly clause: string,
    readonly cells: number,
    readonly limit: number,
  ) {
    super(`query aborted: intermediate relation for ${clause} would exceed the memory budget (${cells.toLocaleString()} cells > ${limit.toLocaleString()} cells; ~${Math.round(limit / CELLS_PER_MB)} MB)`);
  }
}

/**
 * Memory budget for intermediate relations, in *cells* (row slots: rows ×
 * columns). A cell is one array slot (8 B) plus its share of the row array
 * header, i.e. roughly 16–32 B including the value; we plan on ~32 B/cell.
 * The default keeps the peak relation around 48 MB — well inside a 128 MB
 * Worker with room for segments, novelty and the response.
 */
export const CELLS_PER_MB = (1024 * 1024) / 32;
export const DEFAULT_QUERY_MAX_CELLS = 48 * CELLS_PER_MB; // 1,572,864 cells

/**
 * Row-count / intermediate-size budget shared by every relation a query
 * builds. Checked *while* rows are produced (hot loops compare against a
 * precomputed row limit), so an over-budget query aborts early with
 * {@link QueryBudgetError} rather than after the memory is already gone.
 */
export class QueryBudget {
  peakCells = 0;
  constructor(readonly maxCells: number) {}
  /** Rows a relation of `width` columns may hold. */
  rowLimit(width: number): number {
    return Math.max(1, Math.floor(this.maxCells / Math.max(1, width)));
  }
  /** Record a materialised relation; throws if it is over budget. */
  charge(clause: string, rows: number, width: number): void {
    const cells = rows * Math.max(1, width);
    if (cells > this.peakCells) this.peakCells = cells;
    if (cells > this.maxCells) throw new QueryBudgetError(clause, cells, this.maxCells);
  }
  exceeded(clause: string, rows: number, width: number): QueryBudgetError {
    return new QueryBudgetError(clause, rows * Math.max(1, width), this.maxCells);
  }
}

export interface QueryOptions {
  /** extra predicates/functions callable from :where */
  functions?: Record<string, QueryFn>;
  /**
   * Memory guard: abort (QueryBudgetError) if any intermediate relation would
   * exceed this many cells (rows × columns). Default {@link DEFAULT_QUERY_MAX_CELLS}.
   */
  maxCells?: number;
  /** @deprecated use maxCells; kept as a plain row cap for compatibility */
  maxRows?: number;
  /** collect planner/executor statistics */
  stats?: QueryStats;
}

export interface QueryStats {
  clauses: { clause: string; strategy: string; index?: string; rowsIn: number; rowsOut: number; seeks: number; scanned: number; ms: number }[];
  /** budget usage: peak intermediate cells vs the limit */
  budget?: { maxCells: number; peakCells: number };
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export interface Rel {
  vars: string[];
  rows: unknown[][];
}

const EMPTY: Rel = { vars: [], rows: [[]] };

function idx(rel: Rel): Map<string, number> {
  const m = new Map<string, number>();
  rel.vars.forEach((v, i) => m.set(v, i));
  return m;
}

function project(rel: Rel, vars: string[], distinct = true): Rel {
  const ix = idx(rel);
  const cols = vars.map((v) => {
    const i = ix.get(v);
    if (i === undefined) throw new QueryError(`variable ${v} is not bound`);
    return i;
  });
  const rows: unknown[][] = [];
  const seen = distinct ? new TupleSet(cols.length) : undefined;
  const w = cols.length;
  for (const r of rel.rows) {
    const out: unknown[] = new Array(w);
    for (let i = 0; i < w; i++) out[i] = r[cols[i]];
    if (seen && !seen.add(out)) continue;
    rows.push(out);
  }
  return { vars, rows };
}

/** Prefix that no raw string value can produce (used to tag non-primitive keys). */
const TAGGED = "\u0000#";

/**
 * Primitive-friendly key: numbers/strings/booleans as-is (native Map keys),
 * bigint / tagged values unwrapped, everything else via vkey (tagged).
 */
function primKey(v: unknown): unknown {
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (t === "bigint") return Number(v);
  if (v !== null && t === "object" && "vt" in (v as any) && "v" in (v as any)) return primKey((v as any).v);
  return TAGGED + vkey(v);
}

/**
 * Set of tuples keyed level-by-level with native Map keys — no per-tuple
 * string building. `add` returns true if the tuple was not present.
 */
class TupleSet {
  private root = new Map<unknown, unknown>();
  private single = false; // width-0 sentinel
  constructor(readonly width: number) {}
  add(vals: unknown[]): boolean {
    const w = this.width;
    if (w === 0) {
      if (this.single) return false;
      return (this.single = true);
    }
    if (w === 1) {
      const k = primKey(vals[0]);
      if (this.root.has(k)) return false;
      this.root.set(k, true);
      return true;
    }
    let m = this.root;
    for (let i = 0; i < w - 2; i++) {
      const k = primKey(vals[i]);
      let next = m.get(k) as Map<unknown, unknown> | undefined;
      if (next === undefined) m.set(k, (next = new Map()));
      m = next;
    }
    // Last two levels: the penultimate key maps to a single last-key (common:
    // one tuple per prefix), a small array (linear scan), or a Set once the
    // list grows past SMALL.
    const k1 = primKey(vals[w - 2]);
    const k2 = primKey(vals[w - 1]);
    const cur = m.get(k1);
    if (cur === undefined) {
      m.set(k1, k2);
      return true;
    }
    if (Array.isArray(cur)) {
      if (cur.indexOf(k2) >= 0) return false;
      if (cur.length < TupleSet.SMALL) cur.push(k2);
      else {
        const set = new Set(cur);
        set.add(k2);
        m.set(k1, set);
      }
      return true;
    }
    if (cur instanceof Set) {
      if (cur.has(k2)) return false;
      cur.add(k2);
      return true;
    }
    if (cur === k2) return false;
    m.set(k1, [cur, k2]);
    return true;
  }
  private static readonly SMALL = 8;
}

/** Hash-join two relations on their shared variables (cross product if none). */
function hashJoin(a: Rel, b: Rel, budget?: QueryBudget, clause = "join"): Rel {
  const shared = a.vars.filter((v) => b.vars.includes(v));
  const bOnly = b.vars.filter((v) => !a.vars.includes(v));
  const vars = a.vars.concat(bOnly);
  const limit = budget ? budget.rowLimit(vars.length) : Infinity;
  if (shared.length === 0) {
    // cross product: the size is known up front — refuse before allocating
    if (a.rows.length * b.rows.length > limit) throw budget!.exceeded(clause, a.rows.length * b.rows.length, vars.length);
    const rows: unknown[][] = [];
    for (const ra of a.rows) for (const rb of b.rows) rows.push(ra.concat(rb));
    return { vars, rows };
  }
  const ia = idx(a), ib = idx(b);
  const sa = shared.map((v) => ia.get(v)!), sb = shared.map((v) => ib.get(v)!);
  const ob = bOnly.map((v) => ib.get(v)!);
  const table = new Map<string, unknown[][]>();
  for (const rb of b.rows) {
    const k = sb.map((c) => vkey(rb[c])).join(" ");
    let l = table.get(k);
    if (!l) table.set(k, (l = []));
    l.push(rb);
  }
  const rows: unknown[][] = [];
  for (const ra of a.rows) {
    const k = sa.map((c) => vkey(ra[c])).join(" ");
    const l = table.get(k);
    if (!l) continue;
    for (const rb of l) {
      rows.push(ra.concat(ob.map((c) => rb[c])));
      if (rows.length > limit) throw budget!.exceeded(clause, rows.length, vars.length);
    }
  }
  return { vars, rows };
}

function clauseVars(c: Clause, into = new Set<string>()): Set<string> {
  const t = (x: Term | undefined) => {
    if (x && x.kind === "var") into.add(x.name);
  };
  switch (c.kind) {
    case "pattern":
      t(c.e); t(c.a); t(c.v); t(c.tx); t(c.op);
      break;
    case "pred":
      c.args.forEach(t);
      break;
    case "fn":
      c.args.forEach(t);
      bindingVars(c.binding).forEach((v) => into.add(v));
      break;
    case "not":
      c.clauses.forEach((x) => clauseVars(x, into));
      break;
    case "or":
      c.branches.forEach((b) => b.forEach((x) => clauseVars(x, into)));
      break;
  }
  return into;
}
function bindingVars(b: Binding): string[] {
  switch (b.kind) {
    case "scalar":
    case "coll":
      return [b.var];
    case "tuple":
    case "rel":
      return b.vars.filter((v): v is string => v !== null);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class Executor {
  private readonly fns: Record<string, QueryFn>;
  private readonly maxRows: number;
  private readonly stats: QueryStats | undefined;
  readonly budget: QueryBudget;

  constructor(readonly db: Db, opts: QueryOptions) {
    this.fns = { ...opts.functions };
    this.maxRows = opts.maxRows ?? Infinity;
    this.budget = new QueryBudget(opts.maxCells ?? DEFAULT_QUERY_MAX_CELLS);
    this.stats = opts.stats;
    if (this.stats) this.stats.budget = { maxCells: this.budget.maxCells, peakCells: 0 };
  }

  /** Account a materialised relation against the budget (throws QueryBudgetError). */
  private guard(rel: Rel, clause = "relation"): Rel {
    this.budget.charge(clause, rel.rows.length, rel.vars.length);
    if (this.stats?.budget) this.stats.budget.peakCells = this.budget.peakCells;
    if (rel.rows.length > this.maxRows) throw new QueryBudgetError(clause, rel.rows.length * Math.max(1, rel.vars.length), this.maxRows * Math.max(1, rel.vars.length));
    return rel;
  }

  // ---- constants resolution -------------------------------------------------

  private async resolveEntityConst(v: unknown): Promise<number | undefined> {
    if (typeof v === "number") return v;
    if (typeof v === "string") return this.db.schema.entid(v);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") return this.db.entid(v as [string, unknown]);
    if (v && typeof v === "object" && (v as any).vt === ValueTag.Ref) return (v as any).v as number;
    throw new QueryError(`bad entity constant ${JSON.stringify(v)}`);
  }
  private resolveAttrConst(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const a = this.db.attr(v);
      if (a) return a.id;
      const e = this.db.schema.entid(v);
      if (e !== undefined) return e;
      throw new QueryError(`unknown attribute ${v}`);
    }
    throw new QueryError(`bad attribute constant ${JSON.stringify(v)}`);
  }

  // ---- planning ---------------------------------------------------------------

  /** Estimated rows produced by a clause given the bound variable set. */
  private async cost(c: Clause, bound: Set<string>): Promise<number> {
    switch (c.kind) {
      case "pred":
        return c.args.every((a) => a.kind !== "var" || bound.has(a.name)) ? -1 : Infinity;
      case "fn":
        return c.args.every((a) => a.kind !== "var" || bound.has(a.name)) ? 0 : Infinity;
      case "not": {
        // prefer running once every variable it mentions is bound; never before a pattern that could bind them
        const need = c.join ?? [...clauseVars(c)];
        return need.every((v) => bound.has(v)) ? 50 : 1e12;
      }
      case "or": {
        const vs = c.join ?? [...clauseVars(c)];
        return vs.some((v) => bound.has(v)) ? 100 : 1e12;
      }
      case "pattern": {
        const has = (t: Term | undefined) => !!t && (t.kind === "const" || (t.kind === "var" && bound.has(t.name)));
        const eB = has(c.e), aB = has(c.a), vB = has(c.v);
        if (eB) return aB ? 1 : 8;
        if (aB) {
          if (c.a.kind !== "const") return vB ? 16 : 1000; // attribute bound at runtime only
          let aid: number;
          try {
            aid = this.resolveAttrConst(c.a.value);
          } catch {
            return 0; // unknown attribute → empty
          }
          const attr = this.db.attr(aid);
          if (vB) {
            if (attr && (attr.unique || attr.index)) {
              if (c.v.kind === "const") {
                try {
                  const tv = coerceValue(attr.valueType, c.v.value);
                  return await this.db.estimate(Index.AVET, { a: aid, vt: tv.vt, v: tv.v });
                } catch {
                  return 0;
                }
              }
              return attr.unique ? 1 : 4;
            }
            if (attr && attr.valueType === ValueTag.Ref) {
              if (c.v.kind === "const") {
                const e = typeof c.v.value === "number" ? c.v.value : await this.resolveEntityConst(c.v.value).catch(() => undefined);
                if (e === undefined) return 0;
                return await this.db.estimate(Index.VAET, { vt: ValueTag.Ref, v: e, a: aid });
              }
              return 4;
            }
            // unindexed attribute with bound value: scan the attribute
            return await this.db.estimate(Index.AEVT, { a: aid });
          }
          return await this.db.estimate(Index.AEVT, { a: aid });
        }
        // nothing bound: full scan
        return (await this.db.estimate(Index.EAVT, {})) + 1e9;
      }
    }
  }

  /** Greedy ordering by estimated selectivity. */
  async plan(clauses: Clause[], bound: Set<string>): Promise<Clause[]> {
    const remaining = clauses.slice();
    const order: Clause[] = [];
    const b = new Set(bound);
    while (remaining.length) {
      let best = -1, bestCost = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const cost = await this.cost(remaining[i], b);
        if (cost < bestCost || (cost === bestCost && best === -1)) {
          best = i;
          bestCost = cost;
        }
      }
      if (best === -1) {
        // nothing ready: only preds/fns/nots with unbound vars remain
        const c = remaining[0];
        throw new QueryError(`insufficient bindings for clause ${describe(c)}: unbound variables ${[...clauseVars(c)].filter((v) => !b.has(v)).join(", ")}`);
      }
      const c = remaining.splice(best, 1)[0];
      order.push(c);
      for (const v of clauseVars(c)) b.add(v);
    }
    return order;
  }

  // ---- execution ----------------------------------------------------------------

  async execClauses(rel: Rel, clauses: Clause[]): Promise<Rel> {
    const ordered = await this.plan(clauses, new Set(rel.vars));
    for (const c of ordered) rel = await this.exec(rel, c);
    return rel;
  }

  async exec(rel: Rel, c: Clause): Promise<Rel> {
    switch (c.kind) {
      case "pattern":
        return this.execPattern(rel, c);
      case "pred":
        return this.execPred(rel, c.fn, c.args);
      case "fn":
        return this.execFn(rel, c.fn, c.args, c.binding);
      case "not":
        return this.execNot(rel, c);
      case "or":
        return this.execOr(rel, c);
    }
  }

  private fn(name: string, pred: boolean): QueryFn {
    const f = this.fns[name] ?? (pred ? PREDICATES[name] ?? FUNCTIONS[name] : FUNCTIONS[name] ?? PREDICATES[name]);
    if (!f) throw new QueryError(`unknown ${pred ? "predicate" : "function"} ${name}`);
    return f;
  }

  private argGetter(rel: Rel, args: Term[]): (row: unknown[]) => unknown[] {
    const ix = idx(rel);
    const getters = args.map((a) => {
      if (a.kind === "var") {
        const i = ix.get(a.name);
        if (i === undefined) throw new QueryError(`variable ${a.name} is not bound`);
        return (r: unknown[]) => r[i];
      }
      if (a.kind === "const") {
        const v = a.value;
        // "$" source symbol → the db itself
        return () => v;
      }
      return () => undefined;
    });
    return (row) => getters.map((g) => g(row));
  }

  private async execPred(rel: Rel, name: string, args: Term[]): Promise<Rel> {
    // special-cased predicates that need the db
    if (name === "missing?") {
      const [src, eT, aT] = args[0]?.kind === "const" && typeof args[0].value === "string" && (args[0].value as string).startsWith("$") ? args : [null, ...args];
      void src;
      const get = this.argGetter(rel, [eT, aT] as Term[]);
      const rows: unknown[][] = [];
      for (const r of rel.rows) {
        const [e, a] = get(r);
        const aid = this.resolveAttrConst(a);
        const d = await this.db.first(Index.EAVT, { e: e as number, a: aid });
        if (!d) rows.push(r);
      }
      return { vars: rel.vars, rows };
    }
    const f = this.fn(name, true);
    const get = this.argGetter(rel, args);
    const rows: unknown[][] = [];
    for (const r of rel.rows) if (f(...get(r))) rows.push(r);
    return { vars: rel.vars, rows };
  }

  private async execFn(rel: Rel, name: string, args: Term[], binding: Binding): Promise<Rel> {
    let compute: (row: unknown[]) => unknown | Promise<unknown>;
    if (name === "get-else") {
      const [, eT, aT, dT] = args.length === 4 ? args : [null, ...args];
      const get = this.argGetter(rel, [eT, aT, dT] as Term[]);
      compute = async (r) => {
        const [e, a, dflt] = get(r);
        const aid = this.resolveAttrConst(a);
        const d = await this.db.first(Index.EAVT, { e: e as number, a: aid });
        return d ? datomJsValue(d) : dflt;
      };
    } else if (name === "get-some") {
      const [, eT, ...aTs] = args[0]?.kind === "const" && typeof args[0].value === "string" && (args[0].value as string).startsWith("$") ? args : [null, ...args];
      const get = this.argGetter(rel, [eT, ...aTs] as Term[]);
      compute = async (r) => {
        const [e, ...as] = get(r);
        for (const a of as) {
          const aid = this.resolveAttrConst(a);
          const d = await this.db.first(Index.EAVT, { e: e as number, a: aid });
          if (d) return [aid, datomJsValue(d)];
        }
        return null;
      };
    } else if (name === "q") {
      // nested query: [(q <query> $ ?arg...) binding]
      const get = this.argGetter(rel, args.slice(1));
      const qform = args[0].kind === "const" ? (args[0].value as Query | string | object) : undefined;
      if (qform === undefined) throw new QueryError("q: first argument must be a constant query");
      compute = async (r) => {
        const ins = get(r).map((x) => (typeof x === "string" && x === "$" ? this.db : x));
        return query(this.db, qform, ins);
      };
    } else {
      const f = this.fn(name, false);
      const get = this.argGetter(rel, args);
      compute = (r) => f(...get(r).map((x) => (x === "$" ? this.db : x)));
    }
    const ix = idx(rel);
    const bvars = bindingVars(binding);
    const newVars = bvars.filter((v) => !ix.has(v));
    const vars = rel.vars.concat(newVars);
    const rows: unknown[][] = [];
    const fnLimit = this.budget.rowLimit(vars.length);
    const bindRow = (base: unknown[], vals: Map<string, unknown>) => {
      // check consistency with already-bound vars, then extend
      for (const [v, val] of vals) {
        const i = ix.get(v);
        if (i !== undefined && vkey(base[i]) !== vkey(val)) return;
      }
      rows.push(base.concat(newVars.map((v) => vals.get(v))));
      if (rows.length > fnLimit) throw this.budget.exceeded(`(${name} ...)`, rows.length, vars.length);
    };
    for (const r of rel.rows) {
      const result = await compute(r);
      switch (binding.kind) {
        case "scalar":
          if (result === undefined || result === null) break;
          bindRow(r, new Map([[binding.var, result]]));
          break;
        case "coll":
          if (result === undefined || result === null) break;
          for (const x of result as Iterable<unknown>) bindRow(r, new Map([[binding.var, x]]));
          break;
        case "tuple": {
          if (result === undefined || result === null) break;
          const arr = result as unknown[];
          const m = new Map<string, unknown>();
          binding.vars.forEach((v, i) => v && m.set(v, arr[i]));
          bindRow(r, m);
          break;
        }
        case "rel": {
          if (result === undefined || result === null) break;
          for (const tuple of result as unknown[][]) {
            const m = new Map<string, unknown>();
            binding.vars.forEach((v, i) => v && m.set(v, tuple[i]));
            bindRow(r, m);
          }
          break;
        }
      }
    }
    return this.guard({ vars, rows });
  }

  private async execNot(rel: Rel, c: NotClause): Promise<Rel> {
    if (rel.rows.length === 0) return rel;
    const inner = clauseVars(c);
    const join = c.join ?? [...inner].filter((v) => rel.vars.includes(v));
    for (const v of join) if (!rel.vars.includes(v)) throw new QueryError(`not-join variable ${v} is not bound`);
    const seed = project(rel, join);
    const sub = await this.execClauses(seed, c.clauses);
    const matched = new Set<string>();
    const six = idx(sub);
    const cols = join.map((v) => six.get(v)!);
    for (const r of sub.rows) matched.add(cols.map((ci) => vkey(r[ci])).join(" "));
    const rix = idx(rel);
    const rcols = join.map((v) => rix.get(v)!);
    const rows = rel.rows.filter((r) => !matched.has(rcols.map((ci) => vkey(r[ci])).join(" ")));
    return { vars: rel.vars, rows };
  }

  private async execOr(rel: Rel, c: OrClause): Promise<Rel> {
    // exported vars: explicit (or-join) or the vars common to all branches
    let exported: string[];
    if (c.join) exported = c.join;
    else {
      const sets = c.branches.map((b) => {
        const s = new Set<string>();
        b.forEach((x) => clauseVars(x, s));
        return s;
      });
      exported = [...sets[0]].filter((v) => sets.every((s) => s.has(v)));
      const all = new Set<string>();
      sets.forEach((s) => s.forEach((v) => all.add(v)));
      if (all.size !== exported.length) {
        throw new QueryError(`all clauses in 'or' must use the same variables (use or-join to scope): ${[...all].filter((v) => !exported.includes(v)).join(", ")}`);
      }
    }
    // an empty input still binds what the branches export: a later clause
    // (or :order) may name those variables
    if (rel.rows.length === 0) return { vars: [...rel.vars, ...exported.filter((v) => !rel.vars.includes(v))], rows: [] };
    const shared = exported.filter((v) => rel.vars.includes(v));
    const seed = shared.length ? project(rel, shared) : EMPTY;
    const seen = new Set<string>();
    const rows: unknown[][] = [];
    for (const branch of c.branches) {
      const sub = await this.execClauses(seed, branch);
      const six = idx(sub);
      const cols = exported.map((v) => {
        const i = six.get(v);
        if (i === undefined) throw new QueryError(`or branch does not bind ${v}`);
        return i;
      });
      for (const r of sub.rows) {
        const out = cols.map((ci) => r[ci]);
        const k = out.map(vkey).join(" ");
        if (!seen.has(k)) {
          seen.add(k);
          rows.push(out);
        }
      }
    }
    return this.guard(hashJoin(rel, { vars: exported, rows }, this.budget, "or-join"), "or-join");
  }

  // ---- data patterns --------------------------------------------------------------

  private async execPattern(rel: Rel, c: PatternClause): Promise<Rel> {
    const t0 = performance.now();
    const ix = idx(rel);
    const stat = { clause: describe(c), strategy: "", index: undefined as string | undefined, rowsIn: rel.rows.length, rowsOut: 0, seeks: 0, scanned: 0, ms: 0 };
    const finish = (r: Rel): Rel => {
      stat.rowsOut = r.rows.length;
      stat.ms = performance.now() - t0;
      this.stats?.clauses.push(stat);
      return this.guard(r, stat.clause);
    };

    // Component descriptors
    type Comp = { kind: "const"; value: unknown } | { kind: "bound"; col: number } | { kind: "free"; name: string } | { kind: "blank" };
    const comp = (t: Term | undefined): Comp => {
      if (!t || t.kind === "blank") return { kind: "blank" };
      if (t.kind === "const") return { kind: "const", value: t.value };
      const col = ix.get(t.name);
      return col === undefined ? { kind: "free", name: t.name } : { kind: "bound", col };
    };
    const E = comp(c.e), A = comp(c.a), V = comp(c.v), TX = comp(c.tx), OP = comp(c.op);

    // New variables bound by this clause (in order e, a, v, tx, op; repeated free vars unify)
    const newVars: string[] = [];
    const slot: Record<string, number> = {};
    for (const [k, cm] of [["e", E], ["a", A], ["v", V], ["tx", TX], ["op", OP]] as const) {
      if (cm.kind === "free") {
        if (!(cm.name in slot)) {
          slot[cm.name] = newVars.length;
          newVars.push(cm.name);
        }
        (slot as any)["#" + k] = slot[cm.name];
      }
    }
    const vars = rel.vars.concat(newVars);
    if (rel.rows.length === 0) return finish({ vars, rows: [] });

    // Resolve constants
    let eConst: number | undefined, aConst: number | undefined, txConst: number | undefined, opConst: boolean | undefined;
    if (E.kind === "const") {
      eConst = await this.resolveEntityConst(E.value);
      if (eConst === undefined) return finish({ vars, rows: [] });
    }
    if (A.kind === "const") aConst = this.resolveAttrConst(A.value);
    if (TX.kind === "const") {
      const x = TX.value as number;
      txConst = typeof x === "number" ? (x < TX_BASE ? txEid(x) : x) : undefined;
      if (txConst === undefined) return finish({ vars, rows: [] });
    }
    if (OP.kind === "const") opConst = !!OP.value;
    const vConst = V.kind === "const" ? (V.value && typeof V.value === "object" && "vt" in (V.value as any) ? V.value : V.value) : undefined;

    // Join columns (bound vars) → distinct tuples
    const joinCols: number[] = [];
    for (const cm of [E, A, V, TX, OP]) if (cm.kind === "bound" && !joinCols.includes(cm.col)) joinCols.push(cm.col);

    // Residual check for a datom given the concrete bound values
    const isHistory = this.db.isHistory;
    const rowMatches = (d: Datom, e: number | undefined, a: number | undefined, vk: string | undefined, tx: number | undefined, op: boolean | undefined): boolean => {
      if (e !== undefined && d.e !== e) return false;
      if (a !== undefined && d.a !== a) return false;
      if (vk !== undefined && vkey(datomJsValue(d)) !== vk) return false;
      if (tx !== undefined && txEid(d.t) !== tx) return false;
      if (op !== undefined && d.op !== op) return false;
      return true;
    };
    // Extract new-var values from a datom (with unification of repeated vars).
    // Slots are precomputed; the common no-repeat case allocates one array.
    const sE = (slot as any)["#e"] ?? -1, sA = (slot as any)["#a"] ?? -1, sV = (slot as any)["#v"] ?? -1,
      sTX = (slot as any)["#tx"] ?? -1, sOP = (slot as any)["#op"] ?? -1;
    const nNew = newVars.length;
    const nSlots = (sE >= 0 ? 1 : 0) + (sA >= 0 ? 1 : 0) + (sV >= 0 ? 1 : 0) + (sTX >= 0 ? 1 : 0) + (sOP >= 0 ? 1 : 0);
    const hasRepeat = nSlots !== nNew;
    const extract = (d: Datom): unknown[] | undefined => {
      const out: unknown[] = new Array(nNew);
      if (!hasRepeat) {
        if (sE >= 0) out[sE] = d.e;
        if (sA >= 0) out[sA] = d.a;
        if (sV >= 0) out[sV] = datomJsValue(d);
        if (sTX >= 0) out[sTX] = txEid(d.t);
        if (sOP >= 0) out[sOP] = d.op;
        return out;
      }
      const set = (s: number, val: unknown): boolean => {
        if (s < 0) return true;
        if (out[s] === undefined) {
          out[s] = val;
          return true;
        }
        return sameValue(out[s], val);
      };
      if (!set(sE, d.e)) return undefined;
      if (!set(sA, d.a)) return undefined;
      if (!set(sV, datomJsValue(d))) return undefined;
      if (!set(sTX, txEid(d.t))) return undefined;
      if (!set(sOP, d.op)) return undefined;
      return out;
    };

    // Append `base ⨝ d` rows to `rows`: one array per output row, filled directly.
    const nBase = rel.vars.length;
    const rowLimit = this.budget.rowLimit(vars.length);
    const overBudget = () => this.budget.exceeded(stat.clause, rows.length, vars.length);
    const emit = (base: unknown[][], d: Datom): void => {
      let ex: unknown[] | undefined;
      if (hasRepeat) {
        ex = extract(d);
        if (ex === undefined) return;
      }
      if (rows.length + base.length > rowLimit) throw overBudget();
      for (let m = 0; m < base.length; m++) {
        const b = base[m];
        const row: unknown[] = new Array(nBase + nNew);
        for (let j = 0; j < nBase; j++) row[j] = b[j];
        if (ex !== undefined) {
          for (let j = 0; j < nNew; j++) row[nBase + j] = ex[j];
        } else {
          if (sE >= 0) row[nBase + sE] = d.e;
          if (sA >= 0) row[nBase + sA] = d.a;
          if (sV >= 0) row[nBase + sV] = datomJsValue(d);
          if (sTX >= 0) row[nBase + sTX] = txEid(d.t);
          if (sOP >= 0) row[nBase + sOP] = d.op;
        }
        rows.push(row);
      }
    };

    // Choose index + prefix from concrete (e, a, v) availability.
    const choose = (e: number | undefined, a: number | undefined, v: unknown, hasV: boolean): { index: IndexId; prefix: Prefix; vFilter: boolean } | null => {
      if (e !== undefined) {
        const p: Prefix = { e };
        if (a !== undefined) {
          (p as any).a = a;
          if (hasV) {
            const attr = this.db.attr(a);
            const tv = attr ? tryCoerce(attr.valueType, v) : tryInfer(v);
            if (tv === null) return null;
            (p as any).vt = tv.vt;
            (p as any).v = tv.v;
            return { index: Index.EAVT, prefix: p, vFilter: false };
          }
        }
        return { index: Index.EAVT, prefix: p, vFilter: hasV };
      }
      if (a !== undefined) {
        const attr = this.db.attr(a);
        if (hasV) {
          if (attr && (attr.index || attr.unique)) {
            const tv = tryCoerce(attr.valueType, v);
            if (tv === null) return null;
            return { index: Index.AVET, prefix: { a, vt: tv.vt, v: tv.v }, vFilter: false };
          }
          if (attr && attr.valueType === ValueTag.Ref) {
            const tv = tryCoerce(ValueTag.Ref, v);
            if (tv === null) return null;
            return { index: Index.VAET, prefix: { vt: tv.vt, v: tv.v, a }, vFilter: false };
          }
          return { index: Index.AEVT, prefix: { a }, vFilter: true };
        }
        return { index: Index.AEVT, prefix: { a }, vFilter: false };
      }
      // no E, no A → full scan (v/tx filtered)
      return { index: Index.EAVT, prefix: {}, vFilter: hasV };
    };

    const rows: unknown[][] = [];

    // ---- Case 1: no join columns → single scan, cross with rel (usually rel = [[]])
    if (joinCols.length === 0) {
      const hasV = V.kind === "const";
      const ch = choose(eConst, aConst, vConst, hasV);
      stat.strategy = "scan";
      if (ch === null) return finish({ vars, rows: [] });
      stat.index = ["eavt", "aevt", "avet", "vaet"][ch.index];
      const vk = ch.vFilter ? vkey(vConst) : undefined;
      const txF = txConst, opF = opConst;
      const needCheck = vk !== undefined || txF !== undefined || (opF !== undefined && (isHistory || opF === false));
      stat.seeks = 1;
      const extracted: unknown[][] = [];
      // hot loop kept in a sync closure (JIT-friendlier than inline in the async frame)
      const consume = (arr: Datom[]): void => {
        for (let i = 0; i < arr.length; i++) {
          const d = arr[i];
          if (needCheck && !rowMatches(d, undefined, undefined, vk, txF, opF)) continue;
          const ex = extract(d);
          if (ex) {
            extracted.push(ex);
            if (extracted.length > rowLimit) throw this.budget.exceeded(stat.clause, extracted.length, vars.length);
          }
        }
      };
      for await (const arr of this.db.datoms(ch.index, ch.prefix)) {
        stat.scanned += arr.length;
        consume(arr);
      }
      if (rel.rows.length === 1 && rel.vars.length === 0) return finish({ vars, rows: extracted });
      // cross product with the incoming relation: size known up front
      if (rel.rows.length * extracted.length > rowLimit) throw this.budget.exceeded(stat.clause, rel.rows.length * extracted.length, vars.length);
      for (const r of rel.rows) for (const ex of extracted) rows.push(r.concat(ex));
      return finish({ vars, rows });
    }

    // ---- Case 2: join columns present. Decide nested-loop seeks vs hash join.
    // Group rows by join tuple (primitive-keyed for the single-column case).
    type Group = { vals: unknown[]; rows: unknown[][] };
    const groups = new GroupIndex<Group>(joinCols.length);
    const groupList: Group[] = [];
    if (joinCols.length === 1) {
      const jc = joinCols[0];
      for (const r of rel.rows) {
        const v = r[jc];
        let g = groups.get1(v);
        if (!g) {
          groups.set1(v, (g = { vals: [v], rows: [r] }));
          groupList.push(g);
        } else g.rows.push(r);
      }
    } else {
      for (const r of rel.rows) {
        const vals = joinCols.map((ci) => r[ci]);
        let g = groups.getN(vals);
        if (!g) {
          groups.setN(vals, (g = { vals, rows: [] }));
          groupList.push(g);
        }
        g.rows.push(r);
      }
    }
    const nDistinct = groupList.length;

    // Constant-only prefix (for a hash-join scan)
    const hasVConst = V.kind === "const";
    const constChoice = choose(eConst, aConst, vConst, hasVConst);
    let scanEstimate = Infinity;
    if (constChoice !== null && (eConst !== undefined || aConst !== undefined)) {
      scanEstimate = await this.db.estimate(constChoice.index, constChoice.prefix);
    } else if (constChoice !== null && E.kind !== "bound" && A.kind !== "bound") {
      // no e/a available at all, even from bound vars: must scan
      scanEstimate = await this.db.estimate(Index.EAVT, {});
    }
    const SEEK_COST = 16; // one seek ≈ scanning this many datoms
    const useHash = scanEstimate < nDistinct * SEEK_COST;

    const colOf = (cm: Comp) => (cm.kind === "bound" ? joinCols.indexOf(cm.col) : -1);
    const eCol = colOf(E), aCol = colOf(A), vCol = colOf(V), txCol = colOf(TX), opCol = colOf(OP);

    if (useHash && constChoice !== null) {
      // ---- streaming hash join: scan once with constant prefix, probe groups
      stat.strategy = "hash-join";
      stat.index = ["eavt", "aevt", "avet", "vaet"][constChoice.index];
      stat.seeks = 1;
      const vkConst = constChoice.vFilter ? vkey(vConst) : undefined;
      // Which datom components feed each join column (a variable bound in
      // several positions, e.g. [?a :p/boss ?a], must agree in all of them).
      const compsFor: number[][] = joinCols.map(() => []);
      if (eCol >= 0) compsFor[eCol].push(0);
      if (aCol >= 0) compsFor[aCol].push(1);
      if (vCol >= 0) compsFor[vCol].push(2);
      if (txCol >= 0) compsFor[txCol].push(3);
      if (opCol >= 0) compsFor[opCol].push(4);
      const compValue = (d: Datom, c: number): unknown =>
        c === 0 ? d.e : c === 1 ? d.a : c === 2 ? datomJsValue(d) : c === 3 ? txEid(d.t) : d.op;
      const colValue = (d: Datom, comps: number[]): unknown => {
        const v = compValue(d, comps[0]);
        for (let k = 1; k < comps.length; k++) if (!sameValue(v, compValue(d, comps[k]))) return NO_MATCH;
        return v;
      };
      const single = joinCols.length === 1 ? compsFor[0] : undefined;
      const probe: unknown[] = new Array(joinCols.length);
      // hot loop kept in a sync closure (JIT-friendlier than inline in the async frame)
      const consume = (arr: Datom[]): void => {
        for (let i = 0; i < arr.length; i++) {
          const d = arr[i];
          if (vkConst !== undefined && vkey(datomJsValue(d)) !== vkConst) continue;
          if (txConst !== undefined && txEid(d.t) !== txConst) continue;
          if (opConst !== undefined && d.op !== opConst) continue;
          let g: Group | undefined;
          if (single !== undefined) {
            const v = colValue(d, single);
            if (v === NO_MATCH) continue;
            g = groups.get1(v);
          } else {
            let ok = true;
            for (let c = 0; c < joinCols.length; c++) {
              const v = colValue(d, compsFor[c]);
              if (v === NO_MATCH) {
                ok = false;
                break;
              }
              probe[c] = v;
            }
            if (!ok) continue;
            g = groups.getN(probe);
          }
          if (!g) continue;
          emit(g.rows, d);
        }
      };
      for await (const arr of this.db.datoms(constChoice.index, constChoice.prefix)) {
        stat.scanned += arr.length;
        consume(arr);
      }
      return finish({ vars, rows });
    }

    // ---- index nested loop: one seek per distinct join tuple, batched per
    // (index, prefix shape) so a single cursor serves all seeks in key order.
    stat.strategy = "seek-join";
    type Residual = { e?: number; a?: number; vk?: string; tx?: number; op?: boolean };
    type Batch = { prefixes: Prefix[]; groups: Group[]; residual: (Residual | null)[] };
    const batches = new Map<number, Batch>(); // key: index*16 + prefix-shape bits
    for (const g of groupList) {
      const e = eCol >= 0 ? (g.vals[eCol] as number) : eConst;
      const a = aCol >= 0 ? (g.vals[aCol] as number) : aConst;
      const hasV = vCol >= 0 || hasVConst;
      const v = vCol >= 0 ? g.vals[vCol] : vConst;
      const tx = txCol >= 0 ? (g.vals[txCol] as number) : txConst;
      const op = opCol >= 0 ? (g.vals[opCol] as boolean) : opConst;
      if (eCol >= 0 && typeof e !== "number") continue; // bound e is not an entity id
      if (aCol >= 0 && typeof a !== "number") continue;
      const ch = choose(e, a, v, hasV);
      if (ch === null) continue;
      stat.index ??= ["eavt", "aevt", "avet", "vaet"][ch.index];
      stat.seeks++;
      const p = ch.prefix;
      const shape = ch.index * 16 + (p.e !== undefined ? 8 : 0) + (p.a !== undefined ? 4 : 0) + (p.vt !== undefined ? 2 : 0) + (p.t !== undefined ? 1 : 0);
      let b = batches.get(shape);
      if (!b) batches.set(shape, (b = { prefixes: [], groups: [], residual: [] }));
      b.prefixes.push(p);
      b.groups.push(g);
      const rE = p.e === undefined ? e : undefined;
      const rA = p.a === undefined ? a : undefined;
      const rVk = ch.vFilter ? vkey(v) : undefined;
      const needOp = op !== undefined && (isHistory || op === false);
      b.residual.push(
        rE !== undefined || rA !== undefined || rVk !== undefined || tx !== undefined || needOp
          ? { e: rE, a: rA, vk: rVk, tx, op: needOp ? op : undefined }
          : null,
      );
    }
    // hot loop kept in a sync closure (JIT-friendlier than inline in the async frame)
    const consume = (b: Batch, results: Datom[][]): void => {
      for (let ri = 0; ri < results.length; ri++) {
        const ds = results[ri];
        stat.scanned += ds.length;
        if (ds.length === 0) continue;
        const res = b.residual[ri];
        const gr = b.groups[ri].rows;
        const needCheck = res !== null;
        for (let k = 0; k < ds.length; k++) {
          const d = ds[k];
          if (needCheck && !rowMatches(d, res!.e, res!.a, res!.vk, res!.tx, res!.op)) continue;
          emit(gr, d);
        }
      }
    };
    for (const [shape, b] of batches) {
      const index = (shape >> 4) as IndexId;
      consume(b, await this.db.seekMany(index, b.prefixes));
    }
    return finish({ vars, rows });
  }
}

const NO_MATCH: unique symbol = Symbol("no-match");

/** Value equality as used for unification (numbers/strings/bools by ===, others by vkey). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ta = typeof a;
  if ((ta === "number" || ta === "string" || ta === "boolean") && typeof b === ta) return false;
  return vkey(a) === vkey(b);
}

/**
 * Hash index keyed by join-column values. Primitive keys (number / string /
 * boolean) are stored natively — no string building per probe; everything
 * else (Date, bytes, tagged values, tuples) goes through `vkey`.
 */
class GroupIndex<G> {
  private prim = new Map<unknown, G>(); // single-column: primKey(v) → group
  private other: Map<string, G> | undefined; // multi-column: joined vkeys → group
  constructor(readonly width: number) {}
  get1(v: unknown): G | undefined {
    return this.prim.get(primKey(v));
  }
  set1(v: unknown, g: G): void {
    this.prim.set(primKey(v), g);
  }
  getN(vals: unknown[]): G | undefined {
    return this.other?.get(vals.map(vkey).join("\0"));
  }
  setN(vals: unknown[], g: G): void {
    (this.other ??= new Map()).set(vals.map(vkey).join("\0"), g);
  }
}

function tryCoerce(vt: ValueTag, v: unknown): { vt: ValueTag; v: any } | null {
  try {
    return coerceValue(vt, v);
  } catch {
    return null;
  }
}
function tryInfer(v: unknown): { vt: ValueTag; v: any } | null {
  try {
    return inferTag(v);
  } catch {
    return null;
  }
}

function describe(c: Clause): string {
  switch (c.kind) {
    case "pattern":
      return `[${[c.e, c.a, c.v, c.tx, c.op].filter(Boolean).map(termStr).join(" ")}]`;
    case "pred":
      return `[(${c.fn} ${c.args.map(termStr).join(" ")})]`;
    case "fn":
      return `[(${c.fn} ${c.args.map(termStr).join(" ")}) ...]`;
    case "not":
      return `(not ...)`;
    case "or":
      return `(or ...)`;
  }
}
function termStr(t: Term | undefined): string {
  if (!t) return "";
  if (t.kind === "var") return t.name;
  if (t.kind === "blank") return "_";
  return typeof t.value === "string" ? t.value : JSON.stringify(t.value);
}

// ---------------------------------------------------------------------------
// Query entry point
// ---------------------------------------------------------------------------

/**
 * Run a query. `inputs` correspond to the `:in` spec (default `$`). The db is
 * either the first `$` input or the `db` argument (used when :in has no `$`).
 */
export async function query(db: Db, q: Query | string | object, inputs: unknown[] = [], opts: QueryOptions = {}): Promise<any> {
  const ast = isQueryAst(q) ? (q as Query) : parseQuery(q);
  // bind inputs
  let dbIn: Db = db;
  let rel: Rel = { vars: [], rows: [[]] };
  const inputBudget = new QueryBudget(opts.maxCells ?? DEFAULT_QUERY_MAX_CELLS);
  const scalarInputs: { var: string; value: unknown }[] = [];
  if (inputs.length !== ast.in.length) {
    // allow omitting a leading $ input when only the db is implied
    if (!(ast.in.length === inputs.length + 1 && ast.in[0].kind === "src")) {
      throw new QueryError(`query expects ${ast.in.length} inputs, got ${inputs.length}`);
    }
    inputs = [db, ...inputs];
  }
  ast.in.forEach((spec, i) => {
    const val = inputs[i];
    switch (spec.kind) {
      case "src":
        if (spec.name === "$") {
          if (!(val instanceof Db)) throw new QueryError("input $ must be a Db");
          dbIn = val;
        }
        break;
      case "scalar":
        scalarInputs.push({ var: spec.var, value: val });
        break;
      case "coll":
        rel = hashJoin(rel, { vars: [spec.var], rows: [...(val as Iterable<unknown>)].map((x) => [x]) }, inputBudget, "inputs");
        break;
      case "tuple": {
        const vs = spec.vars.filter((v): v is string => v !== null);
        const row = spec.vars.map((v, j) => (v ? (val as unknown[])[j] : undefined)).filter((_, j) => spec.vars[j] !== null);
        rel = hashJoin(rel, { vars: vs, rows: [row] }, inputBudget, "inputs");
        break;
      }
      case "rel": {
        const vs = spec.vars.filter((v): v is string => v !== null);
        const rows = [...(val as Iterable<unknown[]>)].map((tuple) => spec.vars.map((v, j) => (v ? tuple[j] : undefined)).filter((_, j) => spec.vars[j] !== null));
        rel = hashJoin(rel, { vars: vs, rows }, inputBudget, "inputs");
        break;
      }
    }
  });
  if (scalarInputs.length) {
    rel = hashJoin(rel, { vars: scalarInputs.map((s) => s.var), rows: [scalarInputs.map((s) => s.value)] }, inputBudget, "inputs");
  }
  const ex = new Executor(dbIn, opts);
  rel = await ex.execClauses(rel, ast.where);
  return shapeResult(dbIn, ast, rel);
}

function isQueryAst(q: unknown): boolean {
  return typeof q === "object" && q !== null && "find" in (q as any) && typeof (q as any).find === "object" && "kind" in (q as any).find;
}

/**
 * Project / aggregate the result relation, then order → offset → limit, then
 * resolve pulls — so a `:limit` only pulls the rows that survive it.
 */
async function shapeResult(db: Db, ast: Query, rel: Rel): Promise<any> {
  const elems: FindElem[] =
    ast.find.kind === "rel" || ast.find.kind === "tuple" ? ast.find.elems : [ast.find.elem];
  const ix = idx(rel);
  const varOf = (e: FindElem): string => {
    if (e.kind === "var") return e.name;
    if (e.kind === "pull") return e.var;
    const last = e.args[e.args.length - 1];
    if (!last || last.kind !== "var") throw new QueryError(`aggregate ${e.fn} needs a variable argument`);
    return last.name;
  };
  for (const e of elems) {
    if (!ix.has(varOf(e))) throw new QueryError(`find variable ${varOf(e)} is not bound in :where`);
  }
  const hasAgg = elems.some((e) => e.kind === "agg");
  let tuples: unknown[][];
  if (!hasAgg) {
    // set semantics over the find vars (+ :with)
    const vars = elems.map(varOf);
    const withVars = ast.with.filter((v) => !vars.includes(v));
    if (ast.order) {
      // Sort the joined relation, not the projection: :order may name any
      // bound variable. `project` keeps each distinct tuple's first row, so a
      // tuple lands at its best-ranked binding.
      sortRows(
        rel.rows,
        sortKeys(ast.order, (o) => {
          const i = ix.get(o.var);
          if (i === undefined) throw new QueryError(`order variable ${o.var} is not bound in :where`);
          return i;
        }),
      );
    }
    const proj = project(rel, vars.concat(withVars), true);
    tuples = withVars.length ? proj.rows.map((r) => r.slice(0, vars.length)) : proj.rows;
  } else {
    // group by non-aggregate elems (+ :with vars), aggregate the rest
    const groupVars = elems.filter((e) => e.kind !== "agg").map(varOf);
    const allVars = [...new Set(elems.map(varOf).concat(ast.with))];
    const base = project(rel, allVars, true); // Datomic: aggregate over the set of distinct tuples
    const bix = idx(base);
    const gcols = groupVars.map((v) => bix.get(v)!);
    const groups = new Map<string, unknown[][]>();
    for (const r of base.rows) {
      const k = gcols.map((c) => vkey(r[c])).join(" ");
      let l = groups.get(k);
      if (!l) groups.set(k, (l = []));
      l.push(r);
    }
    tuples = [];
    for (const rowsIn of groups.values()) {
      const out: unknown[] = [];
      for (const e of elems) {
        if (e.kind === "agg") {
          const f = AGGREGATES[e.fn];
          if (!f) throw new QueryError(`unknown aggregate ${e.fn}`);
          const col = bix.get(varOf(e))!;
          const consts = e.args.slice(0, -1).map((a) => (a.kind === "const" ? a.value : undefined));
          out.push(f(rowsIn.map((r) => r[col]), ...consts));
        } else {
          out.push(rowsIn[0][bix.get(varOf(e))!]);
        }
      }
      tuples.push(out);
    }
    if (ast.order) {
      // Aggregated rows only carry the :find elements, so that is all :order
      // can name (by the element's variable — `(count ?x)` orders on ?x).
      const cols = new Map(elems.map((e, i) => [varOf(e), i]));
      sortRows(
        tuples,
        sortKeys(ast.order, (o) => {
          const i = cols.get(o.var);
          if (i === undefined) throw new QueryError(`order variable ${o.var} must be in :find when the query aggregates`);
          return i;
        }),
      );
    }
  }
  if (ast.offset !== undefined || ast.limit !== undefined) {
    const from = ast.offset ?? 0;
    tuples = tuples.slice(from, ast.limit === undefined ? undefined : from + ast.limit);
  }
  // pulls
  for (let i = 0; i < elems.length; i++) {
    const e = elems[i];
    if (e.kind !== "pull") continue;
    const pattern = e.pattern as PullPattern;
    if (!Array.isArray(pattern)) throw new QueryError("pull pattern variables (:in) are not supported yet");
    const eids = tuples.map((t) => t[i] as number);
    const pulled = await pullMany(db, eids, pattern);
    tuples.forEach((t, j) => (t[i] = pulled[j]));
  }
  switch (ast.find.kind) {
    case "rel":
      if (ast.keys) {
        const keys = ast.keys;
        return tuples.map((t) => Object.fromEntries(keys.map((k, i) => [k, t[i]])));
      }
      return tuples;
    case "tuple":
      return tuples.length ? tuples[0] : null;
    case "coll":
      return tuples.map((t) => t[0]);
    case "scalar":
      return tuples.length ? tuples[0][0] : null;
  }
}
