/**
 * Rule evaluation. Rules read the *unfiltered* db at the rule basis — a rule
 * must follow `:doc/owner` even when the caller cannot read it. Results are
 * memoized per (expr, e), per (rule, e), and per (op, attr, e) for one request.
 *
 * v2 fragment arms run as one engine query against that unfiltered rule db
 * (never the filtered view). On the read path, a named rule is evaluated
 * once with the focus free — "all `e` visible to `me`" — and the per-datom
 * check is a set-membership lookup. The same query with `?e` bound is the
 * per-entity fallback when the set is too large or blows the cell budget.
 * Query pushdown (#157) conjoins the same rule into the caller's plan; this
 * evaluator stays the enforcement backstop. Pushdown is not required for
 * correctness.
 */

import { COMPARATORS, type Datom, Index, type IndexId, type Prefix, ValueTag, comparePrefix, datom } from "../datom.ts";
import { Db, type DbOptions } from "../db.ts";
import { DEFAULT_QUERY_MAX_CELLS, QueryBudgetError, query } from "../query/engine.ts";
import { parseQuery } from "../query/parse.ts";
import type { Query } from "../query/ast.ts";
import { FIRST_USER_EID } from "../schema.ts";
import { logEvent } from "../telemetry.ts";
import { sortedUnion } from "../tree.ts";
import {
  type CompiledPolicy,
  type PolicyArm,
  type PolicyExpr,
  type PolicyOp,
  type PolicyOperand,
  isRuleArm,
  nsPrefix,
} from "./ast.ts";
import { type Principal, claimValue, holdsClass } from "./principal.ts";

/** Bootstrap `:db/*` attributes: schema and tx metadata are not secret. */
export function isSystemAttrId(a: number): boolean {
  return a < FIRST_USER_EID;
}

export interface PolicyError {
  readonly _tag: "PolicyError";
  readonly reason: "unknown-attr" | "not-a-ref";
  readonly attr: string;
  readonly message: string;
}

/**
 * A fragment rule blew the query memory budget. This is a deploy-time smell
 * (the rule is too expensive), not a deny — the read/write fails as an
 * error so it cannot be mistaken for "not visible".
 */
export class PolicyBudgetError extends QueryBudgetError {
  override readonly code = "policy/budget-exceeded";
  constructor(
    readonly rule: string,
    cause: QueryBudgetError,
  ) {
    super(`policy rule ${rule} (${cause.clause})`, cause.cells, cause.limit, "policy");
  }
}

/** Refs asserted by the tx under check: `${e}|${attrId}` → target eids. */
export type RefOverlay = ReadonlyMap<string, readonly number[]>;

/**
 * Cap on eids a request-scoped visible set may hold. Above this, that rule
 * falls back to per-entity evaluation for the rest of the request — the
 * signal that clause-level pushdown has a workload.
 */
export const DEFAULT_VISIBLE_SET_MAX = 10_000;

export interface PolicyMemoOptions {
  readonly maxCells?: number;
  /** `0` disables set materialization (the #154 per-entity path). */
  readonly visibleSetMax?: number;
}

export type VisibleSetFallbackReason = "size" | "budget";

export interface VisibleSetFallback {
  readonly rule: string;
  readonly reason: VisibleSetFallbackReason;
  readonly size?: number;
}

export type VisibleSetState =
  | { readonly _tag: "set"; readonly eids: ReadonlySet<number> }
  | { readonly _tag: "fallback" };

export class PolicyMemo {
  readonly maxCells: number;
  readonly visibleSetMax: number;
  private readonly exprIds = new WeakMap<object, number>();
  private nextExprId = 1;
  private readonly exprCache = new Map<string, boolean>();
  private readonly ruleCache = new Map<string, boolean>();
  private readonly ruleQueries = new Map<string, Query>();
  private readonly setQueries = new Map<string, Query>();
  private readonly visibleSets = new Map<string, VisibleSetState>();
  private readonly fallbacks: VisibleSetFallback[] = [];
  private readonly opCache = new Map<string, boolean>();
  private readonly errs = new Map<string, PolicyError>();
  private overlayDb: Db | undefined;
  /** Refcount of namespaces whose read rule is in the current query's plan. */
  private readonly nsBackstopSkip = new Map<string, number>();

  constructor(maxCellsOrOpts: number | PolicyMemoOptions = DEFAULT_QUERY_MAX_CELLS) {
    if (typeof maxCellsOrOpts === "object" && maxCellsOrOpts !== null) {
      this.maxCells = maxCellsOrOpts.maxCells ?? DEFAULT_QUERY_MAX_CELLS;
      this.visibleSetMax = maxCellsOrOpts.visibleSetMax ?? DEFAULT_VISIBLE_SET_MAX;
    } else {
      this.maxCells = maxCellsOrOpts ?? DEFAULT_QUERY_MAX_CELLS;
      this.visibleSetMax = DEFAULT_VISIBLE_SET_MAX;
    }
  }

  /** Times this request fell back to per-entity evaluation for a named rule. */
  get visibleSetFallbackCount(): number {
    return this.fallbacks.length;
  }
  get visibleSetFallbacks(): readonly VisibleSetFallback[] {
    return this.fallbacks;
  }
  visibleSet(name: string): VisibleSetState | undefined {
    return this.visibleSets.get(name);
  }

  /**
   * During a pushdown query, skip the namespace-level FilteredDb check for
   * these namespaces (the rule is already in the plan). Attr-level narrowing
   * still runs. Refcounted so nested `q` calls compose.
   */
  enterPushdown(namespaces: readonly string[]): void {
    for (const ns of namespaces) this.nsBackstopSkip.set(ns, (this.nsBackstopSkip.get(ns) ?? 0) + 1);
  }
  exitPushdown(namespaces: readonly string[]): void {
    for (const ns of namespaces) {
      const n = (this.nsBackstopSkip.get(ns) ?? 1) - 1;
      if (n <= 0) this.nsBackstopSkip.delete(ns);
      else this.nsBackstopSkip.set(ns, n);
    }
  }
  skipsNsBackstop(ns: string | undefined): boolean {
    return ns !== undefined && this.nsBackstopSkip.has(ns);
  }

  /** Idents that folded to `false` because they are not in the installed schema. */
  get errors(): readonly PolicyError[] {
    return [...this.errs.values()];
  }

  report(reason: PolicyError["reason"], attr: string, message: string): void {
    if (!this.errs.has(attr)) this.errs.set(attr, { _tag: "PolicyError", reason, attr, message });
  }

  exprId(expr: PolicyExpr): number {
    let id = this.exprIds.get(expr);
    if (id === undefined) this.exprIds.set(expr, (id = this.nextExprId++));
    return id;
  }

  getExpr(key: string): boolean | undefined {
    return this.exprCache.get(key);
  }
  setExpr(key: string, v: boolean): boolean {
    this.exprCache.set(key, v);
    return v;
  }
  getOp(key: string): boolean | undefined {
    return this.opCache.get(key);
  }
  setOp(key: string, v: boolean): boolean {
    this.opCache.set(key, v);
    return v;
  }
  getRule(key: string): boolean | undefined {
    return this.ruleCache.get(key);
  }
  setRule(key: string, v: boolean): boolean {
    this.ruleCache.set(key, v);
    return v;
  }

  /** Parsed existence query for `name`, shared across (e) evaluations. */
  ruleQuery(name: string, rules: readonly unknown[]): Query {
    let q = this.ruleQueries.get(name);
    if (q === undefined) {
      q = parseQuery({
        find: ["?e"],
        in: ["$", "?me", "?e"],
        where: [[name, "?me", "?e"]],
        rules,
        limit: 1,
      });
      this.ruleQueries.set(name, q);
    }
    return q;
  }

  /**
   * Same rule as {@link ruleQuery}, with `?e` free. `limit` is the size
   * threshold plus one so a blow is visible without holding an unbounded set.
   */
  setQuery(name: string, rules: readonly unknown[]): Query {
    let q = this.setQueries.get(name);
    if (q === undefined) {
      q = parseQuery({
        find: ["?e"],
        in: ["$", "?me"],
        where: [[name, "?me", "?e"]],
        rules,
        limit: this.visibleSetMax + 1,
      });
      this.setQueries.set(name, q);
    }
    return q;
  }

  recordVisibleSet(name: string, eids: ReadonlySet<number>): void {
    this.visibleSets.set(name, { _tag: "set", eids });
  }

  recordVisibleSetFallback(name: string, reason: VisibleSetFallbackReason, size?: number): void {
    this.visibleSets.set(name, { _tag: "fallback" });
    this.fallbacks.push(size === undefined ? { rule: name, reason } : { rule: name, reason, size });
    logEvent(
      "core",
      "policy.visible-set-fallback",
      {
        rule: name,
        reason,
        ...(size !== undefined ? { size } : {}),
        threshold: this.visibleSetMax,
        count: this.fallbacks.length,
      },
      "info",
    );
  }

  /** One overlay view per memo — create arms share the same in-tx refs. */
  overlayView(db: Db, overlay: RefOverlay): Db {
    return (this.overlayDb ??= withRefOverlay(db, overlay));
  }
}

export interface EvalCtx {
  /** unfiltered rule view at the current basis */
  readonly db: Db;
  readonly principal: Principal;
  /** the entity being judged */
  readonly e: number;
  readonly memo: PolicyMemo;
  /** only set while checking `create` arms */
  readonly overlay?: RefOverlay;
  /** override the memo's query-cell budget for this evaluation */
  readonly maxCells?: number;
}

function resolveOperand(op: PolicyOperand, p: Principal): unknown {
  switch (op._tag) {
    case "principal":
      return p.eid;
    case "claim":
      return claimValue(p, op.path);
    case "lit":
      return op.value;
  }
}

/** The value a preset attribute gets on create, or undefined if unresolvable. */
export function presetValue(op: PolicyOperand, p: Principal): unknown {
  const v = resolveOperand(op, p);
  return v === null ? undefined : v;
}

export async function evalExpr(expr: PolicyExpr, ctx: EvalCtx): Promise<boolean> {
  switch (expr._tag) {
    case "const":
      return expr.value;
    case "class":
      return holdsClass(ctx.principal, expr.class);
    case "not":
      return !(await evalExpr(expr.expr, ctx));
    case "and": {
      for (const e of expr.exprs) if (!(await evalExpr(e, ctx))) return false;
      return true;
    }
    case "or": {
      for (const e of expr.exprs) if (await evalExpr(e, ctx)) return true;
      return false;
    }
    case "eq":
    case "ref":
      break;
  }
  // entity-scoped: memoize per (expr, e)
  const key = ctx.memo.exprId(expr) + "|" + ctx.e;
  const hit = ctx.memo.getExpr(key);
  if (hit !== undefined) return hit;
  const attr = ctx.db.attr(expr.attr);
  if (!attr) {
    ctx.memo.report("unknown-attr", expr.attr, `${expr.attr} is not in the installed schema; rule folds to false`);
    return ctx.memo.setExpr(key, false);
  }
  if (expr._tag === "eq") {
    const raw = resolveOperand(expr.operand, ctx.principal);
    if (raw === undefined || raw === null) return ctx.memo.setExpr(key, false);
    let tv;
    try {
      tv = ctx.db.coerce(attr, raw);
    } catch {
      return ctx.memo.setExpr(key, false); // claim type does not match the attribute
    }
    const d = await ctx.db.first(Index.EAVT, { e: ctx.e, a: attr.id, vt: tv.vt, v: tv.v });
    return ctx.memo.setExpr(key, d !== undefined);
  }
  // ref: follow every target of [e attr ?x]
  if (attr.valueType !== ValueTag.Ref) {
    ctx.memo.report("not-a-ref", expr.attr, `${expr.attr} is not :db.type/ref; rule folds to false`);
    return ctx.memo.setExpr(key, false);
  }
  const targets = new Set<number>();
  for (const d of await ctx.db.datomsArray(Index.EAVT, { e: ctx.e, a: attr.id })) {
    if (d.vt === ValueTag.Ref) targets.add(d.v as number);
  }
  const extra = ctx.overlay?.get(ctx.e + "|" + attr.id);
  if (extra) for (const x of extra) targets.add(x);
  for (const t of targets) {
    if (await evalExpr(expr.target, { ...ctx, e: t })) return ctx.memo.setExpr(key, true);
  }
  return ctx.memo.setExpr(key, false);
}

/** v2 fragment arm: class gate, then `true` (public) or a named rule. */
async function evalRuleArm(
  arm: Extract<PolicyArm, { rule: unknown }>,
  ctx: EvalCtx,
  rules: readonly unknown[] | undefined,
  useVisibleSet: boolean,
): Promise<boolean> {
  if (arm.class !== undefined && !arm.class.some((c) => holdsClass(ctx.principal, c))) return false;
  if (arm.rule === true) return true;
  return evalNamedRule(arm.rule, ctx, rules, useVisibleSet);
}

/**
 * Run `name` over the unfiltered rule db with `?me` = `Principal.eid`.
 * Reads materialize the visible set once (focus free) and look `e` up;
 * writes and the over-size / over-budget fallback bind `?e`. Non-empty
 * result = allow. No resolved principal → deny (only `true` arms apply).
 * A per-entity budget miss is {@link PolicyBudgetError}.
 */
async function evalNamedRule(
  name: string,
  ctx: EvalCtx,
  rules: readonly unknown[] | undefined,
  useVisibleSet: boolean,
): Promise<boolean> {
  const key = name + "|" + ctx.e;
  const hit = ctx.memo.getRule(key);
  if (hit !== undefined) return hit;
  if (ctx.principal.eid === undefined || rules === undefined || rules.length === 0) {
    return ctx.memo.setRule(key, false);
  }
  if (useVisibleSet) {
    const fromSet = await evalNamedRuleSet(name, ctx, rules);
    if (fromSet !== undefined) return ctx.memo.setRule(key, fromSet);
  }
  return evalNamedRuleBound(name, ctx, rules, key);
}

/** `true`/`false` from the cached or freshly materialized set; `undefined` → fallback. */
async function evalNamedRuleSet(
  name: string,
  ctx: EvalCtx,
  rules: readonly unknown[],
): Promise<boolean | undefined> {
  const cached = ctx.memo.visibleSet(name);
  if (cached?._tag === "fallback") return undefined;
  if (cached?._tag === "set") return cached.eids.has(ctx.e);
  try {
    const rows = await query(ctx.db, ctx.memo.setQuery(name, rules), [ctx.principal.eid], {
      maxCells: ctx.maxCells ?? ctx.memo.maxCells,
    });
    if (!Array.isArray(rows)) {
      ctx.memo.recordVisibleSet(name, new Set());
      return false;
    }
    if (rows.length > ctx.memo.visibleSetMax) {
      ctx.memo.recordVisibleSetFallback(name, "size", rows.length);
      return undefined;
    }
    const eids = new Set<number>();
    for (const row of rows) {
      const e = Array.isArray(row) ? row[0] : row;
      if (typeof e === "number") eids.add(e);
    }
    ctx.memo.recordVisibleSet(name, eids);
    return eids.has(ctx.e);
  } catch (err) {
    if (err instanceof QueryBudgetError) {
      ctx.memo.recordVisibleSetFallback(name, "budget");
      return undefined;
    }
    throw err;
  }
}

async function evalNamedRuleBound(
  name: string,
  ctx: EvalCtx,
  rules: readonly unknown[],
  key: string,
): Promise<boolean> {
  const db = ctx.overlay !== undefined && ctx.overlay.size > 0 ? ctx.memo.overlayView(ctx.db, ctx.overlay) : ctx.db;
  try {
    const rows = await query(db, ctx.memo.ruleQuery(name, rules), [ctx.principal.eid, ctx.e], {
      maxCells: ctx.maxCells ?? ctx.memo.maxCells,
    });
    return ctx.memo.setRule(key, Array.isArray(rows) && rows.length > 0);
  } catch (err) {
    if (err instanceof QueryBudgetError) throw new PolicyBudgetError(name, err);
    throw err;
  }
}

/** allow arms OR; any true deny wins; no arms → deny. */
async function evalArms(
  arms: readonly PolicyArm[],
  ctx: EvalCtx,
  rules: readonly unknown[] | undefined,
  useVisibleSet: boolean,
): Promise<boolean> {
  let allowed = false;
  for (const arm of arms) {
    if (isRuleArm(arm)) {
      if (await evalRuleArm(arm, ctx, rules, useVisibleSet)) allowed = true;
      continue;
    }
    const v = await evalExpr(arm.expr, ctx);
    if (arm._tag === "deny") {
      if (v) return false;
    } else if (v) allowed = true;
  }
  return allowed;
}

/**
 * Is `op` allowed on attribute `attrIdent` at `ctx.e`? The attribute rule
 * ANDs with (only narrows) its namespace rule; either alone applies; neither
 * denies.
 */
export async function allowsOp(
  policy: CompiledPolicy,
  op: PolicyOp,
  attrIdent: string,
  ctx: EvalCtx,
): Promise<boolean> {
  const key = op + "|" + attrIdent + "|" + ctx.e;
  const hit = ctx.memo.getOp(key);
  if (hit !== undefined) return hit;
  const attrArms = policy.attrs[attrIdent]?.[op];
  const prefix = nsPrefix(attrIdent);
  const nsArms = prefix === undefined ? undefined : policy.ns?.[prefix]?.[op];
  // Pushdown already conjoined this namespace's read rule. Skip the ns-level
  // check (do not cache — a later raw read must still enforce) and apply
  // only attr-level narrowing.
  if (op === "read" && ctx.overlay === undefined && ctx.memo.skipsNsBackstop(prefix)) {
    if (!attrArms) return true;
    return evalArms(attrArms, ctx, policy.rules, false);
  }
  // Reads: one set query per named rule, then membership. Writes keep the
  // per-entity path — they touch few entities and create arms need the overlay.
  const useVisibleSet =
    op === "read" && ctx.overlay === undefined && ctx.memo.visibleSetMax > 0;
  let res: boolean;
  if (attrArms && nsArms) {
    res =
      (await evalArms(nsArms, ctx, policy.rules, useVisibleSet)) &&
      (await evalArms(attrArms, ctx, policy.rules, useVisibleSet));
  } else if (attrArms || nsArms) res = await evalArms((attrArms ?? nsArms)!, ctx, policy.rules, useVisibleSet);
  else res = false;
  return ctx.memo.setOp(key, res);
}

export function canRead(policy: CompiledPolicy, attrIdent: string, ctx: EvalCtx): Promise<boolean> {
  return allowsOp(policy, "read", attrIdent, ctx);
}

// ---------------------------------------------------------------------------
// Create-arm ref overlay — the engine sees in-tx parent refs
// ---------------------------------------------------------------------------

function optionsOf(db: Db): DbOptions {
  return {
    store: db.store,
    roots: db.roots,
    novelty: db.novelty,
    basisT: db.basisT,
    schema: db.schema,
    nextEid: db.nextEid,
    asOfT: db.asOfT,
    history: db.isHistory,
  };
}

function overlayDatoms(overlay: RefOverlay, t: number): Datom[] {
  const out: Datom[] = [];
  for (const [key, targets] of overlay) {
    const sep = key.lastIndexOf("|");
    const e = Number(key.slice(0, sep));
    const a = Number(key.slice(sep + 1));
    for (const v of targets) out.push(datom(e, a, ValueTag.Ref, v, t));
  }
  return out;
}

function matchOverlay(extras: readonly Datom[], index: IndexId, prefix: Prefix): Datom[] {
  const matched = extras.filter((d) => comparePrefix(index, d, prefix) === 0);
  if (matched.length > 1) matched.sort(COMPARATORS[index]);
  return matched;
}

/**
 * Unfiltered db plus the refs this tx asserts. Create arms follow a parent
 * that exists only in the proposed datoms; add/retract/read never see this.
 */
export function withRefOverlay(db: Db, overlay: RefOverlay): Db {
  if (overlay.size === 0) return db;
  return new OverlayDb(db, overlay);
}

class OverlayDb extends Db {
  private readonly extras: readonly Datom[];

  constructor(base: Db, overlay: RefOverlay) {
    super(optionsOf(base));
    // t ≤ basisT so current-view collapse keeps the asserted refs.
    this.extras = overlayDatoms(overlay, base.basisT);
  }

  override datoms(index: IndexId, prefix: Prefix): AsyncGenerator<Datom[], void, undefined> {
    return this.union(super.datoms(index, prefix), matchOverlay(this.extras, index, prefix), index);
  }

  override async seekMany(index: IndexId, prefixes: readonly Prefix[]): Promise<Datom[][]> {
    const res = await super.seekMany(index, prefixes);
    const cmp = COMPARATORS[index];
    for (let i = 0; i < res.length; i++) {
      const extra = matchOverlay(this.extras, index, prefixes[i]);
      if (extra.length > 0) res[i] = sortedUnion(cmp, res[i], extra);
    }
    return res;
  }

  override async estimate(index: IndexId, prefix: Prefix): Promise<number> {
    return (await super.estimate(index, prefix)) + matchOverlay(this.extras, index, prefix).length;
  }

  private async *union(
    src: AsyncGenerator<Datom[], void, undefined>,
    extra: Datom[],
    index: IndexId,
  ): AsyncGenerator<Datom[], void, undefined> {
    if (extra.length === 0) {
      yield* src;
      return;
    }
    const cmp = COMPARATORS[index];
    let i = 0;
    for await (const arr of src) {
      if (i >= extra.length) {
        yield arr;
        continue;
      }
      const out: Datom[] = [];
      let j = 0;
      while (j < arr.length && i < extra.length) {
        if (cmp(extra[i], arr[j]) <= 0) out.push(extra[i++]);
        else out.push(arr[j++]);
      }
      while (j < arr.length) out.push(arr[j++]);
      if (out.length > 0) yield out;
    }
    if (i < extra.length) yield extra.slice(i);
  }
}
