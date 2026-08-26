/**
 * Typed expression builders. Callbacks run at compile time and return
 * data-only trees — nothing here is stored as a closure on the IR.
 */

import type { AnyEntity } from "../db/Entity.ts";
import type { AnyTrait } from "../db/Trait.ts";
import type { IrExpr, IrOperand, IrPath, PathStep } from "../internal/authorization/ir.ts";

export type AnyFocus = AnyEntity | AnyTrait;

export type AuthPath = {
  readonly _tag: "AuthPath";
  readonly root: string;
  readonly steps: readonly PathStep[];
};

export type AuthExpr = {
  readonly _tag: "AuthExpr";
  readonly expr: IrExpr;
};

export type Snapshot<F extends { readonly fields: Readonly<Record<string, unknown>> }> = {
  readonly [K in keyof F["fields"]]: AuthPath;
} & (F extends AnyEntity ? { readonly id: AuthPath } : {});

const isAuthPath = (value: unknown): value is AuthPath =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthPath";

export const isAuthExpr = (value: unknown): value is AuthExpr =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthExpr";

export const pathOf = (value: unknown): IrPath => {
  if (!isAuthPath(value)) {
    throw new Error("ramose/authorization: expected a path operand");
  }
  return { root: value.root, steps: value.steps };
};

let bindSeq = 0;

export const withBindScope = <T>(fn: () => T): T => {
  const prev = bindSeq;
  bindSeq = 0;
  try {
    return fn();
  } finally {
    bindSeq = prev;
  }
};

const nextBind = (): string => `b${bindSeq++}`;

const expr = (node: IrExpr): AuthExpr => ({ _tag: "AuthExpr", expr: node });

const asOperand = (value: unknown): IrOperand => {
  if (isAuthPath(value)) {
    if (value.root === "me" && value.steps.length === 0) return { kind: "me" };
    return { kind: "path", path: { root: value.root, steps: value.steps } };
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { kind: "lit", value };
  }
  throw new Error("ramose/authorization: operand is a path, me, or a literal");
};

export const and = (...exprs: readonly AuthExpr[]): AuthExpr => {
  if (exprs.length === 0) throw new Error("ramose/authorization: and() needs at least one expression");
  if (!exprs.every(isAuthExpr)) throw new Error("ramose/authorization: and() takes expressions");
  return expr({ kind: "and", exprs: exprs.map((e) => e.expr) });
};

export const or = (...exprs: readonly AuthExpr[]): AuthExpr => {
  if (exprs.length === 0) throw new Error("ramose/authorization: or() needs at least one expression");
  if (!exprs.every(isAuthExpr)) throw new Error("ramose/authorization: or() takes expressions");
  return expr({ kind: "or", exprs: exprs.map((e) => e.expr) });
};

export const not = (inner: AuthExpr): AuthExpr => {
  if (!isAuthExpr(inner)) throw new Error("ramose/authorization: not() takes an expression");
  return expr({ kind: "not", expr: inner.expr });
};

export const eq = (left: unknown, right: unknown): AuthExpr =>
  expr({ kind: "eq", left: asOperand(left), right: asOperand(right) });

export const has = (path: AuthPath, value?: unknown): AuthExpr => {
  if (!isAuthPath(path)) throw new Error("ramose/authorization: has() takes a path");
  return expr({
    kind: "has",
    path: { root: path.root, steps: path.steps },
    ...(value === undefined ? {} : { value: asOperand(value) }),
  });
};

export const some = (path: AuthPath, pred: (item: AuthPath) => AuthExpr): AuthExpr => {
  if (!isAuthPath(path)) throw new Error("ramose/authorization: some() takes a collection path");
  if (typeof pred !== "function") throw new Error("ramose/authorization: some() takes a predicate");
  const bind = nextBind();
  const item: AuthPath = { _tag: "AuthPath", root: bind, steps: [] };
  const body = pred(item);
  if (!isAuthExpr(body)) throw new Error("ramose/authorization: some() predicate must return an expression");
  return expr({
    kind: "some",
    path: { root: path.root, steps: path.steps },
    bind,
    body: body.expr,
  });
};

export const overlaps = (left: AuthPath, right: AuthPath): AuthExpr => {
  if (!isAuthPath(left) || !isAuthPath(right)) {
    throw new Error("ramose/authorization: overlaps() takes two collection paths");
  }
  return expr({
    kind: "overlaps",
    left: { root: left.root, steps: left.steps },
    right: { root: right.root, steps: right.steps },
  });
};

export const exists = <E extends AnyEntity>(
  entity: E,
  pred: (row: AuthPath & Snapshot<E>) => AuthExpr,
): AuthExpr => {
  if (entity?._tag !== "Entity") throw new Error("ramose/authorization: exists() takes an Entity");
  if (typeof pred !== "function") throw new Error("ramose/authorization: exists() takes a predicate");
  const bind = nextBind();
  const row = snapshotOf(entity, bind) as AuthPath & Snapshot<E>;
  const body = pred(row);
  if (!isAuthExpr(body)) throw new Error("ramose/authorization: exists() predicate must return an expression");
  return expr({ kind: "exists", entity: entity.ns, bind, body: body.expr });
};

export const hasClass = (name: string): AuthExpr => {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("ramose/authorization: hasClass() needs a class name");
  }
  return expr({ kind: "hasClass", class: name });
};

type FieldLike = {
  readonly ident?: unknown;
  readonly cardinality?: unknown;
  readonly valueType?: unknown;
  readonly schema?: { readonly _resolve?: () => AnyFocus; readonly _self?: boolean };
};

const stepOf = (field: FieldLike): PathStep => {
  if (typeof field.ident !== "string") {
    throw new Error("ramose/authorization: snapshot field is missing an ident");
  }
  return {
    ident: field.ident,
    cardinality: field.cardinality === "many" ? "many" : "one",
    valueType: typeof field.valueType === "string" ? field.valueType : "unknown",
  };
};

const resolveTarget = (field: FieldLike, enclosing: AnyFocus): AnyFocus | undefined => {
  const schema = field.schema;
  if (schema?._self === true) return enclosing;
  try {
    return schema?._resolve?.();
  } catch {
    return undefined;
  }
};

const extendPath = (base: AuthPath, field: FieldLike, target: AnyFocus | undefined): AuthPath => {
  const next: AuthPath = {
    _tag: "AuthPath",
    root: base.root,
    steps: [...base.steps, stepOf(field)],
  };
  if (field.valueType === "ref" && field.cardinality !== "many" && target !== undefined) {
    return snapshotFrom(next, target);
  }
  return pathProxy(next, target);
};

const pathProxy = (node: AuthPath, focus: AnyFocus | undefined): AuthPath =>
  new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (focus === undefined) return undefined;
      if (prop === "id" && focus._tag === "Entity") {
        return extendPath(target, { ident: ":db/id", cardinality: "one", valueType: "ref" }, undefined);
      }
      const field = (focus.fields as Record<string, FieldLike | undefined>)[prop];
      if (field === undefined) return undefined;
      return extendPath(target, field, resolveTarget(field, focus));
    },
  });

const snapshotFrom = (base: AuthPath, focus: AnyFocus): AuthPath => pathProxy(base, focus);

export const snapshotOf = (focus: AnyFocus, root: string): AuthPath =>
  snapshotFrom({ _tag: "AuthPath", root, steps: [] }, focus);

export const claimsProxy = (): AuthPath =>
  new Proxy({ _tag: "AuthPath" as const, root: "claims", steps: [] as readonly PathStep[] }, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      return {
        _tag: "AuthPath" as const,
        root: "claims",
        steps: [{ key: prop, cardinality: "one" as const, valueType: "unknown" }],
      };
    },
  });

export const inputProxy = (): AuthPath =>
  new Proxy({ _tag: "AuthPath" as const, root: "input", steps: [] as readonly PathStep[] }, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      return {
        _tag: "AuthPath" as const,
        root: "input",
        steps: [{ key: prop, cardinality: "one" as const, valueType: "unknown" }],
      };
    },
  });

export const mePath = (principal?: AnyEntity): AuthPath =>
  principal === undefined
    ? { _tag: "AuthPath", root: "me", steps: [] }
    : snapshotOf(principal, "me");
