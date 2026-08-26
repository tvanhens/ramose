/**
 * Pure three-valued evaluator over a complete rule projection.
 *
 * Does not import authoring syntax or Effect services. Incomplete data
 * is `Incomplete`, never `undefined`. Only `True` authorizes — the
 * Effect shell maps anything else to a typed failure at one boundary.
 */

import type { InstalledAuthorizationIR, IrDecision, IrExpr, IrOperand, IrPath } from "./ir.ts";
import type { CompleteRuleProjection, LoadedValue, ProjectedRecord } from "./snapshot.ts";

export type Truth =
  | { readonly _tag: "True" }
  | { readonly _tag: "False" }
  | { readonly _tag: "Incomplete"; readonly reason: string };

const True: Truth = { _tag: "True" };
const False: Truth = { _tag: "False" };
const Incomplete = (reason: string): Truth => ({ _tag: "Incomplete", reason });

const asList = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const recordOf = (
  projection: CompleteRuleProjection,
  id: unknown,
): ProjectedRecord | undefined => {
  if (typeof id !== "number") return undefined;
  for (const rows of Object.values(projection.entities)) {
    for (const row of rows) {
      if (row.id === id) return row;
    }
  }
  if (projection.resource?.id === id) return projection.resource;
  return undefined;
};

const attrOf = (record: ProjectedRecord, ident: string): LoadedValue => {
  if (ident === ":db/id") return { _tag: "Value", value: record.id };
  return record.attrs[ident] ?? { _tag: "Absent" };
};

const startOf = (
  projection: CompleteRuleProjection,
  binds: Readonly<Record<string, unknown>>,
  root: string,
): LoadedValue => {
  switch (root) {
    case "me":
      return projection.me === undefined ? { _tag: "Absent" } : { _tag: "Value", value: projection.me };
    case "claims":
      return { _tag: "Value", value: projection.claims };
    case "input":
      return { _tag: "Value", value: projection.input };
    case "resource":
      return projection.resource === undefined
        ? { _tag: "Absent" }
        : { _tag: "Value", value: projection.resource };
    default: {
      const bound = binds[root];
      return bound === undefined ? { _tag: "Absent" } : { _tag: "Value", value: bound };
    }
  }
};

const unwrap = (loaded: LoadedValue): unknown => (loaded._tag === "Value" ? loaded.value : undefined);

const readPath = (
  projection: CompleteRuleProjection,
  binds: Readonly<Record<string, unknown>>,
  path: IrPath,
): LoadedValue => {
  let current = startOf(projection, binds, path.root);
  if (current._tag === "Absent") return current;
  for (const step of path.steps) {
    const value = unwrap(current);
    if (value === undefined || value === null) return { _tag: "Absent" };
    if (step.key !== undefined) {
      if (typeof value !== "object") return { _tag: "Absent" };
      const bag = value as Record<string, unknown>;
      const next = bag[step.key];
      if (next !== undefined && typeof next === "object" && next !== null && "_tag" in next) {
        const tagged = next as LoadedValue;
        if (tagged._tag === "Value" || tagged._tag === "Absent") {
          current = tagged;
          continue;
        }
      }
      current = next === undefined ? { _tag: "Absent" } : { _tag: "Value", value: next };
      continue;
    }
    const ident = step.ident!;
    if (typeof value === "number") {
      const record = recordOf(projection, value);
      if (record === undefined) return { _tag: "Absent" };
      current = attrOf(record, ident);
      continue;
    }
    if (typeof value === "object" && value !== null && "attrs" in value && "id" in value) {
      current = attrOf(value as ProjectedRecord, ident);
      continue;
    }
    return { _tag: "Absent" };
  }
  if (path.root === "me" && path.steps.length === 0) {
    return projection.me === undefined ? { _tag: "Absent" } : { _tag: "Value", value: projection.me };
  }
  if (path.root === "resource" && path.steps.length === 0) {
    return projection.resource === undefined
      ? { _tag: "Absent" }
      : { _tag: "Value", value: projection.resource.id };
  }
  return current;
};

const operandValue = (
  projection: CompleteRuleProjection,
  binds: Readonly<Record<string, unknown>>,
  operand: IrOperand,
): LoadedValue => {
  switch (operand.kind) {
    case "me":
      return projection.me === undefined ? { _tag: "Absent" } : { _tag: "Value", value: projection.me };
    case "lit":
      return { _tag: "Value", value: operand.value };
    case "path":
      return readPath(projection, binds, operand.path);
  }
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  return Object.is(left, right);
};

const eqLoaded = (left: LoadedValue, right: LoadedValue): Truth => {
  if (left._tag === "Absent" || right._tag === "Absent") return False;
  return sameValue(left.value, right.value) ? True : False;
};

const andTruth = (left: Truth, right: () => Truth): Truth => {
  if (left._tag === "False") return False;
  const next = right();
  if (next._tag === "False") return False;
  if (left._tag === "Incomplete") return left;
  return next;
};

const orTruth = (left: Truth, right: () => Truth): Truth => {
  if (left._tag === "True") return True;
  const next = right();
  if (next._tag === "True") return True;
  if (left._tag === "Incomplete") return left;
  return next;
};

const evalExpr = (
  expr: IrExpr,
  projection: CompleteRuleProjection,
  binds: Readonly<Record<string, unknown>>,
): Truth => {
  switch (expr.kind) {
    case "const":
      return expr.value ? True : False;
    case "hasClass":
      return projection.classes.includes(expr.class) ? True : False;
    case "eq":
      return eqLoaded(
        operandValue(projection, binds, expr.left),
        operandValue(projection, binds, expr.right),
      );
    case "has": {
      const found = readPath(projection, binds, expr.path);
      if (found._tag === "Absent") return False;
      if (expr.value === undefined) {
        if (Array.isArray(found.value)) return found.value.length > 0 ? True : False;
        return found.value !== undefined && found.value !== null ? True : False;
      }
      const wanted = operandValue(projection, binds, expr.value);
      if (wanted._tag === "Absent") return False;
      return asList(found.value).some((item) => sameValue(item, wanted.value)) ? True : False;
    }
    case "some": {
      const found = readPath(projection, binds, expr.path);
      if (found._tag === "Absent") return False;
      let incomplete: Truth | undefined;
      for (const item of asList(found.value)) {
        const truth = evalExpr(expr.body, projection, { ...binds, [expr.bind]: item });
        if (truth._tag === "True") return True;
        if (truth._tag === "Incomplete") incomplete = truth;
      }
      return incomplete ?? False;
    }
    case "overlaps": {
      const left = readPath(projection, binds, expr.left);
      const right = readPath(projection, binds, expr.right);
      if (left._tag === "Absent" || right._tag === "Absent") return False;
      const rightSet = new Set(asList(right.value));
      return asList(left.value).some((item) => {
        if (rightSet.has(item)) return true;
        if (typeof item === "number" || typeof item === "string" || typeof item === "boolean") {
          return rightSet.has(item);
        }
        for (const other of rightSet) {
          if (sameValue(item, other)) return true;
        }
        return false;
      })
        ? True
        : False;
    }
    case "exists": {
      const rows = projection.entities[expr.entity];
      if (rows === undefined) return Incomplete(`exists(${expr.entity}) is not in the projection`);
      let incomplete: Truth | undefined;
      for (const row of rows) {
        const truth = evalExpr(expr.body, projection, { ...binds, [expr.bind]: row });
        if (truth._tag === "True") return True;
        if (truth._tag === "Incomplete") incomplete = truth;
      }
      return incomplete ?? False;
    }
    case "and": {
      let acc: Truth = True;
      for (const child of expr.exprs) {
        acc = andTruth(acc, () => evalExpr(child, projection, binds));
        if (acc._tag === "False") return False;
      }
      return acc;
    }
    case "or": {
      let acc: Truth = False;
      for (const child of expr.exprs) {
        acc = orTruth(acc, () => evalExpr(child, projection, binds));
        if (acc._tag === "True") return True;
      }
      return acc;
    }
    case "not": {
      const inner = evalExpr(expr.expr, projection, binds);
      if (inner._tag === "Incomplete") return inner;
      return inner._tag === "True" ? False : True;
    }
  }
};

const ruleById = (ir: InstalledAuthorizationIR): ReadonlyMap<string, IrRuleLike> => {
  const map = new Map<string, IrRuleLike>();
  for (const rule of ir.rules) map.set(rule.id, rule);
  return map;
};

type IrRuleLike = InstalledAuthorizationIR["rules"][number];

/**
 * Pure decision over a complete projection. Missing decision or missing
 * rule is `False`. `Incomplete` is returned only when the projection
 * itself is missing a required segment.
 */
export const evaluatePure = (
  ir: InstalledAuthorizationIR,
  projection: CompleteRuleProjection,
  decision: IrDecision | undefined,
): Truth => {
  if (decision === undefined) return False;
  const rules = ruleById(ir);
  for (const id of decision.deny) {
    const rule = rules.get(id);
    if (rule === undefined) return False;
    const truth = evalExpr(rule.expr, projection, {});
    if (truth._tag === "Incomplete") return truth;
    if (truth._tag === "True") return False;
  }
  for (const id of decision.allow) {
    const rule = rules.get(id);
    if (rule === undefined) return False;
    const truth = evalExpr(rule.expr, projection, {});
    if (truth._tag === "Incomplete") return truth;
    if (truth._tag === "True") return True;
  }
  return False;
};

export const traitOwnerOfField = (
  ir: InstalledAuthorizationIR,
  fieldIdent: string,
): string | undefined => {
  const field = ir.identities.fields.find((item) => item.ident === fieldIdent);
  return field?.owner.kind === "trait" ? field.owner.ns : undefined;
};

export const exprNodeCount = (expr: IrExpr): number => {
  switch (expr.kind) {
    case "const":
    case "hasClass":
    case "eq":
    case "has":
    case "overlaps":
      return 1;
    case "some":
    case "exists":
      return 1 + exprNodeCount(expr.kind === "some" ? expr.body : expr.body);
    case "and":
    case "or":
      return 1 + expr.exprs.reduce((sum, child) => sum + exprNodeCount(child), 0);
    case "not":
      return 1 + exprNodeCount(expr.expr);
  }
};
