/** Data-only authorization expression IR. No functions or callbacks. */

import type { JsonLiteral } from "./json.ts";
import type {
  RelativeEntityRef,
  RelativeFieldRef,
} from "./identity.ts";

export type PathRoot =
  | { readonly _tag: "resource" }
  | { readonly _tag: "binding"; readonly name: string };

export interface PathStep {
  readonly field: RelativeFieldRef;
}

export interface AuthPath {
  readonly root: PathRoot;
  readonly steps: readonly PathStep[];
}

export type Operand =
  | { readonly _tag: "path"; readonly path: AuthPath }
  | { readonly _tag: "subject" }
  | { readonly _tag: "me" }
  | { readonly _tag: "claim"; readonly key: string }
  | { readonly _tag: "input"; readonly key: string }
  | { readonly _tag: "lit"; readonly value: JsonLiteral }
  | { readonly _tag: "binding"; readonly name: string };

export type Expr =
  | { readonly _tag: "const"; readonly value: boolean }
  | { readonly _tag: "and"; readonly exprs: readonly Expr[] }
  | { readonly _tag: "or"; readonly exprs: readonly Expr[] }
  | { readonly _tag: "not"; readonly expr: Expr }
  | { readonly _tag: "eq"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "has"; readonly operand: Operand }
  | {
      readonly _tag: "some";
      readonly path: AuthPath;
      readonly bind: string;
      readonly pred: Expr;
    }
  | {
      readonly _tag: "overlaps";
      readonly left: AuthPath;
      readonly right: AuthPath;
    }
  | {
      readonly _tag: "exists";
      readonly entity: RelativeEntityRef;
      readonly bind: string;
      readonly pred: Expr;
    }
  | { readonly _tag: "hasClass"; readonly class: string };

export type RuleFocus =
  | { readonly _tag: "entity"; readonly name: string }
  | { readonly _tag: "trait"; readonly name: string }
  | {
      readonly _tag: "operation";
      readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
      readonly localName: string;
      readonly target: "required" | "none";
    };

export interface RuleMetadata {
  readonly usesResource: boolean;
  readonly usesInput: boolean;
  readonly usesMe: boolean;
  readonly usesSubject: boolean;
  readonly traversalDepth: number;
  readonly existsNesting: number;
  readonly exprNodes: number;
}

export const analyzeExpr = (expr: Expr): RuleMetadata => {
  let usesResource = false;
  let usesInput = false;
  let usesMe = false;
  let usesSubject = false;
  let traversalDepth = 0;
  let existsNesting = 0;
  let exprNodes = 0;
  let maxExists = 0;

  const visitOperand = (operand: Operand): void => {
    switch (operand._tag) {
      case "path":
        visitPath(operand.path);
        break;
      case "me":
        usesMe = true;
        break;
      case "subject":
        usesSubject = true;
        break;
      case "input":
        usesInput = true;
        break;
      case "claim":
      case "lit":
      case "binding":
        break;
    }
  };

  const visitPath = (path: AuthPath): void => {
    if (path.root._tag === "resource") usesResource = true;
    traversalDepth = Math.max(traversalDepth, path.steps.length);
  };

  const visit = (node: Expr, existsDepth: number): void => {
    exprNodes += 1;
    switch (node._tag) {
      case "const":
      case "hasClass":
        break;
      case "and":
      case "or":
        for (const child of node.exprs) visit(child, existsDepth);
        break;
      case "not":
        visit(node.expr, existsDepth);
        break;
      case "eq":
        visitOperand(node.left);
        visitOperand(node.right);
        break;
      case "has":
        visitOperand(node.operand);
        break;
      case "some":
        visitPath(node.path);
        visit(node.pred, existsDepth);
        break;
      case "overlaps":
        visitPath(node.left);
        visitPath(node.right);
        break;
      case "exists": {
        const next = existsDepth + 1;
        maxExists = Math.max(maxExists, next);
        visit(node.pred, next);
        break;
      }
    }
  };

  visit(expr, 0);
  existsNesting = maxExists;
  return {
    usesResource,
    usesInput,
    usesMe,
    usesSubject,
    traversalDepth,
    existsNesting,
    exprNodes,
  };
};

export const collectExprDependencies = (expr: Expr): readonly string[] => {
  const entities = new Set<string>();
  const walk = (node: Expr): void => {
    switch (node._tag) {
      case "and":
      case "or":
        for (const child of node.exprs) walk(child);
        break;
      case "not":
        walk(node.expr);
        break;
      case "some":
        walk(node.pred);
        break;
      case "exists":
        entities.add(node.entity.name);
        walk(node.pred);
        break;
      default:
        break;
    }
  };
  walk(expr);
  return [...entities].sort();
};
