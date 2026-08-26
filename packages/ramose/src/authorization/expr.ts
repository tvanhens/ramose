/** Build-time expression macros. Trusted to construct data; not executed at runtime. */

import type { AnyEntity } from "../db/Entity.ts";
import type { AnyField } from "../db/Field.ts";
import { refTargetOf } from "../db/valueTypes.ts";
import type { AuthPath, Expr, Operand, PathStep } from "../internal/authorization/expr.ts";
import type { RelativeFieldRef, RelativeOwnerRef } from "../internal/authorization/identity.ts";
import type { JsonLiteral } from "../internal/authorization/json.ts";

export type AuthExpr = {
  readonly _tag: "AuthExpr";
  readonly expr: Expr;
};

export type Comparable = AuthExpr | PathCell | Operand | JsonLiteral | SubjectCell | MeCell | ClaimCell | InputCell;

export type SubjectCell = { readonly _tag: "subject" };
export type MeCell = { readonly _tag: "me" };

export type ClaimCell = {
  readonly _tag: "claim";
  readonly key: string;
  eq(other: Comparable): AuthExpr;
  has(): AuthExpr;
};

export type InputCell = {
  readonly _tag: "input";
  readonly key: string;
  eq(other: Comparable): AuthExpr;
  has(): AuthExpr;
};

export type PathCell = {
  readonly _tag: "path";
  readonly path: AuthPath;
  eq(other: Comparable): AuthExpr;
  has(): AuthExpr;
  some(pred: (item: PathCell) => AuthExpr): AuthExpr;
  overlaps(other: PathCell | Comparable): AuthExpr;
};

let bindSeq = 0;
const nextBind = (prefix: string): string => {
  bindSeq += 1;
  return `${prefix}$${bindSeq}`;
};

export const resetBindSeq = (): void => {
  bindSeq = 0;
};

export const authExpr = (expr: Expr): AuthExpr => ({ _tag: "AuthExpr", expr });

export const always: AuthExpr = authExpr({ _tag: "const", value: true });

export const and = (...exprs: readonly AuthExpr[]): AuthExpr =>
  authExpr({ _tag: "and", exprs: exprs.map((expr) => expr.expr) });

export const or = (...exprs: readonly AuthExpr[]): AuthExpr =>
  authExpr({ _tag: "or", exprs: exprs.map((expr) => expr.expr) });

export const not = (expr: AuthExpr): AuthExpr => authExpr({ _tag: "not", expr: expr.expr });

export const hasClass = <const ClassName extends string>(name: ClassName): AuthExpr =>
  authExpr({ _tag: "hasClass", class: name });

const fieldRef = (field: RelativeFieldRef): PathStep => ({ field });

const pathOperand = (path: AuthPath): Operand => ({ _tag: "path", path });

export const toOperand = (value: Comparable): Operand => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { _tag: "lit", value };
  }
  if (typeof value === "object" && "_tag" in value) {
    switch (value._tag) {
      case "AuthExpr":
        throw new Error("ramose/authorization: expression cannot be an equality operand");
      case "path":
        return pathOperand(value.path);
      case "subject":
        return { _tag: "subject" };
      case "me":
        return { _tag: "me" };
      case "claim":
        return { _tag: "claim", key: value.key };
      case "input":
        return { _tag: "input", key: value.key };
      default:
        break;
    }
  }
  throw new Error("ramose/authorization: invalid operand");
};

export const makePathCell = (path: AuthPath): PathCell => ({
  _tag: "path",
  path,
  eq(other: Comparable): AuthExpr {
    return authExpr({ _tag: "eq", left: pathOperand(path), right: toOperand(other) });
  },
  has(): AuthExpr {
    return authExpr({ _tag: "has", operand: pathOperand(path) });
  },
  some(pred: (item: PathCell) => AuthExpr): AuthExpr {
    const bind = nextBind("some");
    const item = makePathCell({ root: { _tag: "binding", name: bind }, steps: [] });
    return authExpr({
      _tag: "some",
      path,
      bind,
      pred: pred(item).expr,
    });
  },
  overlaps(other: PathCell | Comparable): AuthExpr {
    const right =
      typeof other === "object" && other !== null && "_tag" in other && other._tag === "path"
        ? (other as PathCell).path
        : undefined;
    if (right === undefined) {
      throw new Error("ramose/authorization: overlaps expects a collection path");
    }
    return authExpr({ _tag: "overlaps", left: path, right });
  },
});

export const appendField = (path: AuthPath, field: RelativeFieldRef): AuthPath => ({
  root: path.root,
  steps: [...path.steps, fieldRef(field)],
});

export const relativeFieldFromStamped = (
  owner: RelativeOwnerRef,
  localName: string,
): RelativeFieldRef => ({ owner, localName });

export const snapshotOf = (
  owner: RelativeOwnerRef,
  fields: Record<string, AnyField & { readonly ident?: string; readonly attrName?: string }>,
  root: AuthPath["root"] = { _tag: "resource" },
): Record<string, PathCell> => {
  const out: Record<string, PathCell> = {};
  const walk = (
    current: AuthPath,
    map: Record<string, AnyField & { readonly ident?: string; readonly attrName?: string }>,
    fieldOwner: RelativeOwnerRef,
    depth: number,
  ): Record<string, PathCell> => {
    const cells: Record<string, PathCell> = {};
    for (const [name, field] of Object.entries(map)) {
      const ident = typeof field.ident === "string" ? field.ident : `:${fieldOwner.name}/${name}`;
      const rest = ident.startsWith(":") ? ident.slice(1) : ident;
      const slash = rest.indexOf("/");
      const ns = slash >= 0 ? rest.slice(0, slash) : fieldOwner.name;
      const owner: RelativeOwnerRef = {
        kind: ns !== fieldOwner.name ? "trait" : fieldOwner.kind,
        name: ns === fieldOwner.name ? fieldOwner.name : ns,
      };
      const next = appendField(current, { owner, localName: name });
      const cell = makePathCell(next);
      if (field.valueType === "ref" && depth < 4) {
        const target = refTargetOf(field.schema)?.();
        if (target !== undefined) {
          const nested = walk(
            next,
            target.fields as Record<string, AnyField & { readonly ident?: string }>,
            { kind: "entity", name: target.ns ?? name },
            depth + 1,
          );
          Object.assign(cell, nested);
        }
      }
      cells[name] = cell;
    }
    return cells;
  };

  const rootPath: AuthPath = { root, steps: [] };
  Object.assign(out, walk(rootPath, fields, owner, 0));
  out.id = makePathCell(appendField(rootPath, { owner, localName: "id" }));
  return out;
};

export const exists = (
  entity: AnyEntity,
  pred: (bound: Record<string, PathCell>) => AuthExpr,
): AuthExpr => {
  const bind = nextBind(entity.ns);
  const snapshot = snapshotOf(
    { kind: "entity", name: entity.ns },
    entity.fields as Record<string, AnyField & { readonly ident?: string }>,
    { _tag: "binding", name: bind },
  );
  return authExpr({
    _tag: "exists",
    entity: { name: entity.ns },
    bind,
    pred: pred(snapshot).expr,
  });
};

export const subject: SubjectCell = { _tag: "subject" };
export const me: MeCell = { _tag: "me" };

export const claimCells = (keys: readonly string[]): Record<string, ClaimCell> => {
  const out: Record<string, ClaimCell> = {};
  for (const key of keys) {
    out[key] = {
      _tag: "claim",
      key,
      eq(other: Comparable) {
        return authExpr({ _tag: "eq", left: { _tag: "claim", key }, right: toOperand(other) });
      },
      has() {
        return authExpr({ _tag: "has", operand: { _tag: "claim", key } });
      },
    };
  }
  return out;
};

export const inputCells = (keys: readonly string[]): Record<string, InputCell> => {
  const out: Record<string, InputCell> = {};
  for (const key of keys) {
    out[key] = {
      _tag: "input",
      key,
      eq(other: Comparable) {
        return authExpr({ _tag: "eq", left: { _tag: "input", key }, right: toOperand(other) });
      },
      has() {
        return authExpr({ _tag: "has", operand: { _tag: "input", key } });
      },
    };
  }
  return out;
};

export const self: AuthExpr = authExpr({
  _tag: "eq",
  left: {
    _tag: "path",
    path: {
      root: { _tag: "resource" },
      steps: [{ field: { owner: { kind: "entity", name: "*" }, localName: "id" } }],
    },
  },
  right: { _tag: "me" },
});

export const isAuthExpr = (value: unknown): value is AuthExpr =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthExpr";
