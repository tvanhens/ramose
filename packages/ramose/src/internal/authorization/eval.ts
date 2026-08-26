/**
 * Pure, deterministic, bounded IR evaluator.
 *
 * Consumes {@link AuthorizationIR} and a finite rule-snapshot projection.
 * Does not import authoring syntax. Later the authorized datom cursor (#343)
 * calls these helpers; they are the decision function, not the cursor.
 *
 * Policy-input facts (grants, named resource fields) may change the
 * decision and are never treated as application output (**NI-1**).
 */

import type { AuthorizationIR, IrDecision, IrExpr, IrOperand, IrPath } from "./ir.ts";

export interface RuleRecord {
  readonly id: number;
  readonly type: string;
  readonly traits?: readonly string[];
  /** Attribute ident → scalar or array of scalars / eids. */
  readonly attrs: Readonly<Record<string, unknown>>;
}

export interface EvalCtx {
  readonly me: number;
  readonly classes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly resource?: RuleRecord;
  /** Entity ns → records on the trusted rule snapshot. */
  readonly entities: Readonly<Record<string, readonly RuleRecord[]>>;
}

const asList = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const recordOf = (ctx: EvalCtx, id: unknown): RuleRecord | undefined => {
  if (typeof id !== "number") return undefined;
  for (const rows of Object.values(ctx.entities)) {
    for (const row of rows) {
      if (row.id === id) return row;
    }
  }
  if (ctx.resource?.id === id) return ctx.resource;
  return undefined;
};

const startOf = (ctx: EvalCtx, binds: Readonly<Record<string, unknown>>, root: string): unknown => {
  switch (root) {
    case "me":
      return ctx.me;
    case "claims":
      return ctx.claims;
    case "input":
      return ctx.input;
    case "resource":
      return ctx.resource;
    default:
      return binds[root];
  }
};

const readPath = (
  ctx: EvalCtx,
  binds: Readonly<Record<string, unknown>>,
  path: IrPath,
): unknown => {
  let current: unknown = startOf(ctx, binds, path.root);
  for (const step of path.steps) {
    if (current === undefined || current === null) return undefined;
    if (step.key !== undefined) {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[step.key];
      continue;
    }
    const ident = step.ident!;
    if (typeof current === "number") {
      current = recordOf(ctx, current)?.attrs[ident];
      continue;
    }
    if (typeof current === "object" && current !== null && "attrs" in current) {
      current = (current as RuleRecord).attrs[ident];
      continue;
    }
    return undefined;
  }
  if (path.root === "me" && path.steps.length === 0) return ctx.me;
  if (path.root === "resource" && path.steps.length === 0) return ctx.resource?.id;
  return current;
};

const operandValue = (
  ctx: EvalCtx,
  binds: Readonly<Record<string, unknown>>,
  operand: IrOperand,
): unknown => {
  switch (operand.kind) {
    case "me":
      return ctx.me;
    case "lit":
      return operand.value;
    case "path":
      return readPath(ctx, binds, operand.path);
  }
};

const same = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  return false;
};

const evalExpr = (
  expr: IrExpr,
  ctx: EvalCtx,
  binds: Readonly<Record<string, unknown>>,
): boolean => {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "hasClass":
      return ctx.classes.includes(expr.class);
    case "eq":
      return same(operandValue(ctx, binds, expr.left), operandValue(ctx, binds, expr.right));
    case "has": {
      const found = readPath(ctx, binds, expr.path);
      if (expr.value === undefined) {
        if (Array.isArray(found)) return found.length > 0;
        return found !== undefined && found !== null;
      }
      const wanted = operandValue(ctx, binds, expr.value);
      return asList(found).some((item) => same(item, wanted));
    }
    case "some": {
      const items = asList(readPath(ctx, binds, expr.path));
      return items.some((item) => evalExpr(expr.body, ctx, { ...binds, [expr.bind]: item }));
    }
    case "overlaps": {
      const left = asList(readPath(ctx, binds, expr.left));
      const right = new Set(asList(readPath(ctx, binds, expr.right)));
      return left.some((item) => [...right].some((other) => same(item, other)));
    }
    case "exists": {
      const rows = ctx.entities[expr.entity] ?? [];
      return rows.some((row) => evalExpr(expr.body, ctx, { ...binds, [expr.bind]: row }));
    }
    case "and":
      return expr.exprs.every((child) => evalExpr(child, ctx, binds));
    case "or":
      return expr.exprs.some((child) => evalExpr(child, ctx, binds));
    case "not":
      return !evalExpr(expr.expr, ctx, binds);
  }
};

const ruleById = (ir: AuthorizationIR): ReadonlyMap<string, (typeof ir.rules)[number]> => {
  const map = new Map<string, (typeof ir.rules)[number]>();
  for (const rule of ir.rules) map.set(rule.id, rule);
  return map;
};

/**
 * Evaluate one decision. Missing decision, missing rule, or incomplete
 * context fails closed (deny). Explicit deny wins; allow arms OR.
 */
export const decide = (ir: AuthorizationIR, decision: IrDecision | undefined, ctx: EvalCtx): boolean => {
  if (decision === undefined) return false;
  const rules = ruleById(ir);
  for (const id of decision.deny) {
    const rule = rules.get(id);
    if (rule === undefined) return false;
    if (evalExpr(rule.expr, ctx, {})) return false;
  }
  for (const id of decision.allow) {
    const rule = rules.get(id);
    if (rule === undefined) return false;
    if (evalExpr(rule.expr, ctx, {})) return true;
  }
  return false;
};

/** Entity row visibility (**POL-1**). Missing row policy denies. */
export const authorizeRow = (ir: AuthorizationIR, entityNs: string, ctx: EvalCtx): boolean =>
  decide(ir, ir.rows[entityNs], ctx);

/**
 * Trait-owned field visibility (**POL-2**, **POL-5**): composing row AND
 * trait policy. Missing trait policy hides the field.
 */
export const authorizeTraitField = (
  ir: AuthorizationIR,
  args: { readonly entity: string; readonly trait: string },
  ctx: EvalCtx,
): boolean => {
  if (!authorizeRow(ir, args.entity, ctx)) return false;
  if (ir.traits[args.trait] === undefined) return false;
  return decide(ir, ir.traits[args.trait], ctx);
};

/**
 * Field cell: row, then trait (when the field is trait-owned), then optional
 * field narrowing (**POL-3**).
 */
export const authorizeField = (
  ir: AuthorizationIR,
  args: {
    readonly entity: string;
    readonly fieldIdent: string;
    readonly trait?: string;
  },
  ctx: EvalCtx,
): boolean => {
  if (args.trait !== undefined) {
    if (!authorizeTraitField(ir, { entity: args.entity, trait: args.trait }, ctx)) return false;
  } else if (!authorizeRow(ir, args.entity, ctx)) {
    return false;
  }
  const extra = ir.fields[args.fieldIdent];
  if (extra === undefined) return true;
  return decide(ir, extra, ctx);
};

/** Operation authorization (**WR-2** / **WR-4**). Missing op policy denies. */
export const authorizeOperation = (ir: AuthorizationIR, name: string, ctx: EvalCtx): boolean =>
  decide(ir, ir.operations[name], ctx);
