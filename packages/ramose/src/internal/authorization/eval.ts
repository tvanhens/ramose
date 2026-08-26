/**
 * Pure synchronous three-valued authorization evaluator.
 *
 * No authoring imports. No Effect services. Not a datom cursor and not a
 * full-database scanner. Only True authorizes.
 */

import { DEFAULT_WORK_BUDGET } from "./bounds.ts";
import type { AuthPath, Expr, Operand } from "./expr.ts";
import {
  relativeFieldKey,
  relativeOperationKey,
  type RelativeOperationRef,
} from "./identity.ts";
import {
  isSealedInstalled,
  type InstalledAuthorizationIR,
  type InstalledDecision,
  type SealedInstalledAuthorizationIR,
} from "./installed.ts";
import {
  Absent,
  authorizes,
  False,
  Incomplete,
  Present,
  True,
  type IncompleteReason,
  type JsonScalar,
  type Projection,
  type Truth,
} from "./truth.ts";

export interface BudgetState {
  remaining: number;
}

export const createBudget = (limit = DEFAULT_WORK_BUDGET): BudgetState => ({
  remaining: limit,
});

const consume = (budget: BudgetState, n = 1): boolean => {
  budget.remaining -= n;
  return budget.remaining >= 0;
};

export interface RuleRecord {
  readonly id: JsonScalar;
  readonly entity: string;
  readonly traits: ReadonlySet<string>;
  readonly fields: ReadonlyMap<string, Projection>;
}

export type EntityStore =
  | { readonly _tag: "Loaded"; readonly records: readonly RuleRecord[] }
  | { readonly _tag: "Missing" };

export interface RuleSnapshotData {
  readonly entities: ReadonlyMap<string, EntityStore>;
  readonly byId: ReadonlyMap<JsonScalar, RuleRecord | "absent">;
}

export interface EvalPrincipal {
  readonly subject: string;
  readonly classes: ReadonlySet<string>;
  readonly claims: ReadonlyMap<string, Projection>;
  readonly me: Projection;
}

export interface EvalContext {
  readonly principal: EvalPrincipal;
  readonly resource: Projection | { readonly _tag: "Record"; readonly record: RuleRecord };
  readonly input: ReadonlyMap<string, Projection>;
  readonly snapshot: RuleSnapshotData;
  readonly budget: BudgetState;
  readonly bindings: ReadonlyMap<string, Projection>;
}

const budgetReason: IncompleteReason = {
  _tag: "BudgetExhausted",
  detail: "authorization work budget exhausted",
};
const budgetExhausted = Incomplete(budgetReason);

const not = (truth: Truth): Truth => {
  switch (truth._tag) {
    case "True":
      return False;
    case "False":
      return True;
    case "Incomplete":
      return truth;
  }
};

const andAll = (results: readonly Truth[]): Truth => {
  let incomplete: Truth | undefined;
  for (const result of results) {
    if (result._tag === "False") return False;
    if (result._tag === "Incomplete") incomplete = result;
  }
  return incomplete ?? True;
};

const orAll = (results: readonly Truth[]): Truth => {
  let incomplete: Truth | undefined;
  for (const result of results) {
    if (result._tag === "True") return True;
    if (result._tag === "Incomplete") incomplete = result;
  }
  return incomplete ?? False;
};

const scalarEq = (left: JsonScalar, right: JsonScalar): boolean =>
  Object.is(left, right);

const projectionOfPath = (
  ctx: EvalContext,
  path: AuthPath,
): Projection => {
  let current: Projection | { readonly _tag: "Record"; readonly record: RuleRecord };
  if (path.root._tag === "resource") {
    current = ctx.resource;
  } else if (path.root._tag === "binding") {
    const bound = ctx.bindings.get(path.root.name ?? "");
    if (bound === undefined) {
      return {
        _tag: "Unavailable",
        reason: { _tag: "NotLoaded", detail: `unbound ${path.root.name}` },
      };
    }
    current = bound;
  } else {
    return {
      _tag: "Invalid",
      reason: { _tag: "InvalidTraversal", detail: "unknown path root" },
    };
  }

  for (const step of path.steps) {
    if (!consume(ctx.budget)) return { _tag: "Unavailable", reason: budgetReason };
    const key = relativeFieldKey(step.field);
    if (current._tag === "Unavailable" || current._tag === "Invalid") return current;
    if (current._tag === "Absent") {
      return {
        _tag: "Invalid",
        reason: { _tag: "InvalidTraversal", detail: `traverse through absent ${key}` },
      };
    }
    if (current._tag === "Present" || current._tag === "PresentMany") {
      if (current._tag === "PresentMany") {
        return {
          _tag: "Invalid",
          reason: { _tag: "InvalidTraversal", detail: `traverse through collection ${key}` },
        };
      }
      const target = ctx.snapshot.byId.get(current.value);
      if (target === undefined) {
        return {
          _tag: "Unavailable",
          reason: { _tag: "NotLoaded", detail: `ref ${String(current.value)} was not loaded` },
        };
      }
      if (target === "absent") {
        return {
          _tag: "Invalid",
          reason: { _tag: "InvalidTraversal", detail: `ref ${String(current.value)} is absent` },
        };
      }
      current = { _tag: "Record", record: target };
    }
    if (current._tag !== "Record") {
      return {
        _tag: "Invalid",
        reason: { _tag: "InvalidTraversal", detail: `cannot read ${key}` },
      };
    }
    if (step.field.localName === "id") {
      current = Present(current.record.id);
      continue;
    }
    const cell = current.record.fields.get(key);
    if (cell === undefined) {
      return {
        _tag: "Unavailable",
        reason: { _tag: "NotLoaded", detail: `field ${key} was not loaded` },
      };
    }
    current = cell;
  }
  return current._tag === "Record"
    ? Present(current.record.id)
    : current;
};

const resolveOperand = (ctx: EvalContext, operand: Operand): Projection => {
  switch (operand._tag) {
    case "lit":
      return Present(operand.value);
    case "subject":
      return Present(ctx.principal.subject);
    case "me": {
      const me = ctx.principal.me;
      if (me._tag === "Absent") {
        return {
          _tag: "Unavailable",
          reason: {
            _tag: "MissingMe",
            detail: "principal row did not resolve",
          },
        };
      }
      return me;
    }
    case "claim": {
      const claim = ctx.principal.claims.get(operand.key);
      return (
        claim ?? {
          _tag: "Unavailable",
          reason: { _tag: "NotLoaded", detail: `claim ${operand.key} was not loaded` },
        }
      );
    }
    case "input": {
      const input = ctx.input.get(operand.key);
      return (
        input ?? {
          _tag: "Unavailable",
          reason: { _tag: "NotLoaded", detail: `input ${operand.key} was not loaded` },
        }
      );
    }
    case "binding": {
      const bound = ctx.bindings.get(operand.name);
      return (
        bound ?? {
          _tag: "Unavailable",
          reason: { _tag: "NotLoaded", detail: `binding ${operand.name} was not loaded` },
        }
      );
    }
    case "path":
      return projectionOfPath(ctx, operand.path);
  }
};

const eqProjections = (left: Projection, right: Projection): Truth => {
  if (left._tag === "Unavailable" || right._tag === "Unavailable") {
    return Incomplete(
      left._tag === "Unavailable" ? left.reason : (right as { reason: IncompleteReason }).reason,
    );
  }
  if (left._tag === "Invalid" || right._tag === "Invalid") {
    return Incomplete(
      left._tag === "Invalid" ? left.reason : (right as { reason: IncompleteReason }).reason,
    );
  }
  if (left._tag === "Absent" && right._tag === "Absent") return True;
  if (left._tag === "Absent" || right._tag === "Absent") return False;
  if (left._tag === "Present" && right._tag === "Present") {
    return scalarEq(left.value, right.value) ? True : False;
  }
  if (left._tag === "PresentMany" && right._tag === "PresentMany") {
    if (left.values.length !== right.values.length) return False;
    const rightSet = new Set(right.values.map((value) => JSON.stringify(value)));
    return left.values.every((value) => rightSet.has(JSON.stringify(value)))
      ? True
      : False;
  }
  if (left._tag === "Present" && right._tag === "PresentMany") {
    return right.values.some((value) => scalarEq(value, left.value)) ? True : False;
  }
  if (left._tag === "PresentMany" && right._tag === "Present") {
    return left.values.some((value) => scalarEq(value, right.value)) ? True : False;
  }
  return False;
};

const hasProjection = (projection: Projection): Truth => {
  switch (projection._tag) {
    case "Present":
      return True;
    case "PresentMany":
      return projection.values.length > 0 ? True : False;
    case "Absent":
      return False;
    case "Unavailable":
    case "Invalid":
      return Incomplete(projection.reason);
  }
};

const manyValues = (projection: Projection): { readonly ok: true; readonly values: readonly JsonScalar[] } | { readonly ok: false; readonly truth: Truth } => {
  switch (projection._tag) {
    case "Present":
      return { ok: true, values: [projection.value] };
    case "PresentMany":
      return { ok: true, values: projection.values };
    case "Absent":
      return { ok: true, values: [] };
    case "Unavailable":
    case "Invalid":
      return { ok: false, truth: Incomplete(projection.reason) };
  }
};

export const evaluateExpr = (expr: Expr, ctx: EvalContext): Truth => {
  if (!consume(ctx.budget)) return budgetExhausted;
  switch (expr._tag) {
    case "const":
      return expr.value ? True : False;
    case "hasClass":
      return ctx.principal.classes.has(expr.class) ? True : False;
    case "and":
      return andAll(expr.exprs.map((child) => evaluateExpr(child, ctx)));
    case "or":
      return orAll(expr.exprs.map((child) => evaluateExpr(child, ctx)));
    case "not":
      return not(evaluateExpr(expr.expr, ctx));
    case "eq":
      return eqProjections(resolveOperand(ctx, expr.left), resolveOperand(ctx, expr.right));
    case "has":
      return hasProjection(resolveOperand(ctx, expr.operand));
    case "overlaps": {
      const left = manyValues(projectionOfPath(ctx, expr.left));
      const right = manyValues(projectionOfPath(ctx, expr.right));
      if (!left.ok) return left.truth;
      if (!right.ok) return right.truth;
      if (!consume(ctx.budget, left.values.length + right.values.length)) {
        return budgetExhausted;
      }
      const rightSet = new Set(right.values.map((value) => JSON.stringify(value)));
      return left.values.some((value) => rightSet.has(JSON.stringify(value)))
        ? True
        : False;
    }
    case "some": {
      const collection = manyValues(projectionOfPath(ctx, expr.path));
      if (!collection.ok) return collection.truth;
      let incomplete: Truth | undefined;
      for (const value of collection.values) {
        if (!consume(ctx.budget)) return budgetExhausted;
        const next: EvalContext = {
          ...ctx,
          bindings: new Map(ctx.bindings).set(expr.bind, Present(value)),
        };
        const result = evaluateExpr(expr.pred, next);
        if (result._tag === "True") return True;
        if (result._tag === "Incomplete") incomplete = result;
      }
      return incomplete ?? False;
    }
    case "exists": {
      const store = ctx.snapshot.entities.get(expr.entity.name);
      if (store === undefined || store._tag === "Missing") {
        return Incomplete({
          _tag: "NotLoaded",
          detail: `entity ${expr.entity.name} was not loaded`,
        });
      }
      let incomplete: Truth | undefined;
      for (const record of store.records) {
        if (!consume(ctx.budget)) return budgetExhausted;
        const byId = new Map(ctx.snapshot.byId);
        byId.set(record.id, record);
        const next: EvalContext = {
          ...ctx,
          bindings: new Map(ctx.bindings).set(expr.bind, Present(record.id)),
          snapshot: { ...ctx.snapshot, byId },
        };
        const result = evaluateExpr(expr.pred, next);
        if (result._tag === "True") return True;
        if (result._tag === "Incomplete") incomplete = result;
      }
      return incomplete ?? False;
    }
  }
};

export const evaluateRule = (
  expr: Expr,
  ctx: EvalContext,
): Truth => evaluateExpr(expr, ctx);

/**
 * Decision lattice: explicit deny wins; incomplete deny denies; allow arms
 * OR; incomplete allow cannot authorize; missing decision denies.
 */
export const evaluateDecision = (
  decision: InstalledDecision | undefined,
  rules: ReadonlyMap<string, Expr>,
  ctx: EvalContext,
): Truth => {
  if (decision === undefined) return False;
  for (const id of decision.deny) {
    const expr = rules.get(id);
    if (expr === undefined) {
      return Incomplete({
        _tag: "NotLoaded",
        detail: `deny rule ${id} is missing`,
      });
    }
    const truth = evaluateExpr(expr, ctx);
    if (truth._tag === "True") return False;
    if (truth._tag === "Incomplete") return False;
  }
  let incomplete: Truth | undefined;
  for (const id of decision.allow) {
    const expr = rules.get(id);
    if (expr === undefined) {
      return Incomplete({
        _tag: "NotLoaded",
        detail: `allow rule ${id} is missing`,
      });
    }
    const truth = evaluateExpr(expr, ctx);
    if (truth._tag === "True") return True;
    if (truth._tag === "Incomplete") incomplete = truth;
  }
  return incomplete ?? False;
};

const ruleMap = (
  installed: InstalledAuthorizationIR,
): Map<string, Expr> =>
  new Map(installed.rules.map((rule) => [rule.id, rule.expr]));

const requireSealed = (
  installed: InstalledAuthorizationIR,
): SealedInstalledAuthorizationIR | undefined =>
  isSealedInstalled(installed) ? installed : undefined;

export const authorizeRow = (
  installed: InstalledAuthorizationIR,
  entityName: string,
  ctx: EvalContext,
): Truth => {
  if (requireSealed(installed) === undefined) {
    return Incomplete({
      _tag: "Unavailable",
      detail: "runtime accepts only sealed InstalledAuthorizationIR",
    });
  }
  return evaluateDecision(installed.decisions.rows[entityName], ruleMap(installed), ctx);
};

export const authorizeTrait = (
  installed: InstalledAuthorizationIR,
  entityName: string,
  traitName: string,
  ctx: EvalContext,
): Truth => {
  const row = authorizeRow(installed, entityName, ctx);
  if (row._tag !== "True") return row._tag === "Incomplete" ? row : False;
  return evaluateDecision(installed.decisions.traits[traitName], ruleMap(installed), ctx);
};

export const authorizeField = (
  installed: InstalledAuthorizationIR,
  entityName: string,
  fieldKey: string,
  traitName: string | undefined,
  ctx: EvalContext,
): Truth => {
  const parent =
    traitName === undefined
      ? authorizeRow(installed, entityName, ctx)
      : authorizeTrait(installed, entityName, traitName, ctx);
  if (parent._tag !== "True") return False;
  const field = installed.decisions.fields[fieldKey];
  if (field === undefined) return True;
  return evaluateDecision(field, ruleMap(installed), ctx);
};

export const authorizeOperation = (
  installed: InstalledAuthorizationIR,
  operation: RelativeOperationRef,
  ctx: EvalContext,
): Truth => {
  if (requireSealed(installed) === undefined) {
    return Incomplete({
      _tag: "Unavailable",
      detail: "runtime accepts only sealed InstalledAuthorizationIR",
    });
  }
  return evaluateDecision(
    installed.decisions.operations[relativeOperationKey(operation)],
    ruleMap(installed),
    ctx,
  );
};

export const decide = (truth: Truth): boolean => authorizes(truth);

export { Absent, False, Incomplete, Present, True };
