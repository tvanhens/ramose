/**
 * Rule evaluation. Rules read the *unfiltered* db at the rule basis — a rule
 * must follow `:doc/owner` even when the caller cannot read it. Results are
 * memoized per (expr, e) and per (op, attr, e) for one request.
 */

import { Index, ValueTag } from "../datom.ts";
import type { Db } from "../db.ts";
import { FIRST_USER_EID } from "../schema.ts";
import {
  type CompiledPolicy,
  type PolicyArm,
  type PolicyExpr,
  type PolicyOp,
  type PolicyOperand,
  nsPrefix,
} from "./ast.ts";
import { type Principal, claimValue } from "./principal.ts";

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

/** Refs asserted by the tx under check: `${e}|${attrId}` → target eids. */
export type RefOverlay = ReadonlyMap<string, readonly number[]>;

export class PolicyMemo {
  private readonly exprIds = new WeakMap<object, number>();
  private nextExprId = 1;
  private readonly exprCache = new Map<string, boolean>();
  private readonly opCache = new Map<string, boolean>();
  private readonly errs = new Map<string, PolicyError>();

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
      return ctx.principal.class === expr.class;
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

/** allow arms OR; any true deny wins; no arms → deny. */
async function evalArms(arms: readonly PolicyArm[], ctx: EvalCtx): Promise<boolean> {
  let allowed = false;
  for (const arm of arms) {
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
  let res: boolean;
  if (attrArms && nsArms) res = (await evalArms(nsArms, ctx)) && (await evalArms(attrArms, ctx));
  else if (attrArms || nsArms) res = await evalArms((attrArms ?? nsArms)!, ctx);
  else res = false;
  return ctx.memo.setOp(key, res);
}

export function canRead(policy: CompiledPolicy, attrIdent: string, ctx: EvalCtx): Promise<boolean> {
  return allowsOp(policy, "read", attrIdent, ctx);
}
