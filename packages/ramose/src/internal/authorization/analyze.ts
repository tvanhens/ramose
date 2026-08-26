/**
 * Pure expression analysis. Shared by compile, install, and semantic
 * validation. Nested `exists(SameEntity)` is a bounded self-join, not
 * rejected recursion.
 */

import { MAX_TRAVERSAL_DEPTH, type IrExpr, type IrOperand, type IrPath } from "./ir.ts";

export interface Analysis {
  readonly usesResource: boolean;
  readonly usesMe: boolean;
  readonly usesInput: boolean;
  readonly maxDepth: number;
  readonly exists: readonly string[];
  readonly claimKeys: readonly string[];
  readonly inputKeys: readonly string[];
  readonly classNames: readonly string[];
}

interface MutableAnalysis {
  usesResource: boolean;
  usesMe: boolean;
  usesInput: boolean;
  maxDepth: number;
  readonly exists: Set<string>;
  readonly claimKeys: Set<string>;
  readonly inputKeys: Set<string>;
  readonly classNames: Set<string>;
  readonly bindDepth: Record<string, number>;
}

const pathDepth = (path: IrPath): number =>
  path.steps.filter((step) => step.ident !== undefined && (step.valueType === "ref" || step.ident === ":db/id"))
    .length;

const pathRootKind = (root: string): "resource" | "me" | "claims" | "input" | "bind" => {
  if (root === "resource" || root === "me" || root === "claims" || root === "input") return root;
  return "bind";
};

const analyzePath = (path: IrPath, analysis: MutableAnalysis): void => {
  const kind = pathRootKind(path.root);
  if (kind === "resource") analysis.usesResource = true;
  if (kind === "me") analysis.usesMe = true;
  if (kind === "input") {
    analysis.usesInput = true;
    for (const step of path.steps) {
      if (step.key !== undefined) analysis.inputKeys.add(step.key);
    }
  }
  if (kind === "claims") {
    for (const step of path.steps) {
      if (step.key !== undefined) analysis.claimKeys.add(step.key);
    }
  }
  const extra = pathDepth(path);
  const base = kind === "bind" ? (analysis.bindDepth[path.root] ?? 0) : 0;
  analysis.maxDepth = Math.max(analysis.maxDepth, base + extra);
};

const analyzeOperand = (operand: IrOperand, analysis: MutableAnalysis): void => {
  if (operand.kind === "me") analysis.usesMe = true;
  if (operand.kind === "path") analyzePath(operand.path, analysis);
};

const analyzeExpr = (expr: IrExpr, analysis: MutableAnalysis): void => {
  switch (expr.kind) {
    case "const":
      return;
    case "hasClass":
      analysis.classNames.add(expr.class);
      return;
    case "eq":
      analyzeOperand(expr.left, analysis);
      analyzeOperand(expr.right, analysis);
      return;
    case "has":
      analyzePath(expr.path, analysis);
      if (expr.value !== undefined) analyzeOperand(expr.value, analysis);
      return;
    case "some": {
      analyzePath(expr.path, analysis);
      const hop = pathDepth(expr.path);
      const parent = pathRootKind(expr.path.root) === "bind" ? (analysis.bindDepth[expr.path.root] ?? 0) : 0;
      analysis.bindDepth[expr.bind] = parent + hop;
      analyzeExpr(expr.body, analysis);
      return;
    }
    case "overlaps":
      analyzePath(expr.left, analysis);
      analyzePath(expr.right, analysis);
      return;
    case "exists":
      analysis.exists.add(expr.entity);
      analysis.bindDepth[expr.bind] = 0;
      analyzeExpr(expr.body, analysis);
      return;
    case "and":
    case "or":
      for (const child of expr.exprs) analyzeExpr(child, analysis);
      return;
    case "not":
      analyzeExpr(expr.expr, analysis);
      return;
  }
};

export const analyze = (expr: IrExpr): Analysis => {
  const mutable: MutableAnalysis = {
    usesResource: false,
    usesMe: false,
    usesInput: false,
    maxDepth: 0,
    exists: new Set(),
    claimKeys: new Set(),
    inputKeys: new Set(),
    classNames: new Set(),
    bindDepth: {},
  };
  analyzeExpr(expr, mutable);
  return {
    usesResource: mutable.usesResource,
    usesMe: mutable.usesMe,
    usesInput: mutable.usesInput,
    maxDepth: mutable.maxDepth,
    exists: [...mutable.exists],
    claimKeys: [...mutable.claimKeys],
    inputKeys: [...mutable.inputKeys],
    classNames: [...mutable.classNames],
  };
};

export const lastStep = (path: IrPath): IrPath["steps"][number] | undefined =>
  path.steps[path.steps.length - 1];

export const exprShapeError = (expr: IrExpr, where: string): string | undefined => {
  switch (expr.kind) {
    case "some": {
      const step = lastStep(expr.path);
      if (step === undefined || step.cardinality !== "many") {
        return `${where}: some() requires a card-many path`;
      }
      return exprShapeError(expr.body, where);
    }
    case "overlaps": {
      const left = lastStep(expr.left);
      const right = lastStep(expr.right);
      if (left?.cardinality !== "many" || right?.cardinality !== "many") {
        return `${where}: overlaps() requires two card-many paths`;
      }
      return undefined;
    }
    case "eq": {
      const card = (operand: IrOperand): string | undefined => {
        if (operand.kind !== "path") return undefined;
        return lastStep(operand.path)?.cardinality;
      };
      if (card(expr.left) === "many" || card(expr.right) === "many") {
        return `${where}: eq() does not compare card-many paths — use has(), some(), or overlaps()`;
      }
      return undefined;
    }
    case "and":
    case "or": {
      for (const child of expr.exprs) {
        const err = exprShapeError(child, where);
        if (err !== undefined) return err;
      }
      return undefined;
    }
    case "not":
      return exprShapeError(expr.expr, where);
    case "exists":
      return exprShapeError(expr.body, where);
    case "has":
    case "const":
    case "hasClass":
      return undefined;
  }
};

export const exceedsTraversal = (analysis: Analysis): boolean => analysis.maxDepth > MAX_TRAVERSAL_DEPTH;
