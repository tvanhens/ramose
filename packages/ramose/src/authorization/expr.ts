/**
 * Typed expression builders. Callbacks run at compile time and return
 * data-only trees — nothing here is stored as a closure on the IR.
 *
 * Path metadata lives in a WeakMap so schema fields named `root`,
 * `steps`, `_tag`, or `constructor` cannot collide with the carrier.
 */

import type { AnyEntity } from "../db/Entity.ts";
import type { AnyTrait } from "../db/Trait.ts";
import type { IrExpr, IrOperand, IrPath, JsonLiteral, PathStep } from "../internal/authorization/ir.ts";

export type AnyFocus = AnyEntity | AnyTrait;

type PathMeta = {
  readonly root: string;
  readonly steps: readonly PathStep[];
};

const PATH = new WeakMap<object, PathMeta>();

export type AuthPath = object & { readonly __authPath?: never };

export type AuthExpr = {
  readonly _tag: "AuthExpr";
  readonly expr: IrExpr;
};

export type Snapshot<F extends { readonly fields: Readonly<Record<string, unknown>> }> = {
  readonly [K in keyof F["fields"]]: AuthPath;
} & (F extends AnyEntity ? { readonly id: AuthPath } : {});

export const isAuthPath = (value: unknown): value is AuthPath =>
  typeof value === "object" && value !== null && PATH.has(value);

export const isAuthExpr = (value: unknown): value is AuthExpr =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthExpr";

export const pathOf = (value: unknown): IrPath => {
  if (!isAuthPath(value)) {
    throw new Error("ramose/authorization: expected a path operand");
  }
  const meta = PATH.get(value)!;
  return { root: meta.root, steps: meta.steps };
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

const asJsonLiteral = (value: unknown): JsonLiteral => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("ramose/authorization: number literals must be finite JSON numbers");
    }
    return value;
  }
  throw new Error("ramose/authorization: operand is a path, me, or a finite JSON literal");
};

const asOperand = (value: unknown): IrOperand => {
  if (isAuthPath(value)) {
    const meta = PATH.get(value)!;
    if (meta.root === "me" && meta.steps.length === 0) return { kind: "me" };
    return { kind: "path", path: { root: meta.root, steps: meta.steps } };
  }
  return { kind: "lit", value: asJsonLiteral(value) };
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
  const meta = PATH.get(path)!;
  return expr({
    kind: "has",
    path: { root: meta.root, steps: meta.steps },
    ...(value === undefined ? {} : { value: asOperand(value) }),
  });
};

const makePath = (meta: PathMeta): AuthPath => {
  const node = Object.create(null) as AuthPath;
  PATH.set(node, meta);
  return node;
};

export const some = (path: AuthPath, pred: (item: AuthPath) => AuthExpr): AuthExpr => {
  if (!isAuthPath(path)) throw new Error("ramose/authorization: some() takes a collection path");
  if (typeof pred !== "function") throw new Error("ramose/authorization: some() takes a predicate");
  const bind = nextBind();
  const item = makePath({ root: bind, steps: [] });
  const body = pred(item);
  if (!isAuthExpr(body)) throw new Error("ramose/authorization: some() predicate must return an expression");
  const meta = PATH.get(path)!;
  return expr({
    kind: "some",
    path: { root: meta.root, steps: meta.steps },
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
    left: pathOf(left),
    right: pathOf(right),
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
  const meta = PATH.get(base)!;
  const next = makePath({ root: meta.root, steps: [...meta.steps, stepOf(field)] });
  if (field.valueType === "ref" && field.cardinality !== "many" && target !== undefined) {
    return snapshotFrom(next, target);
  }
  return pathProxy(next, target);
};

const pathProxy = (node: AuthPath, focus: AnyFocus | undefined): AuthPath => {
  const proxy = new Proxy(node, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (focus === undefined) return undefined;
      if (prop === "id" && focus._tag === "Entity") {
        return extendPath(node, { ident: ":db/id", cardinality: "one", valueType: "ref" }, undefined);
      }
      const field = (focus.fields as Record<string, FieldLike | undefined>)[prop];
      if (field === undefined) return undefined;
      return extendPath(node, field, resolveTarget(field, focus));
    },
  });
  PATH.set(proxy, PATH.get(node)!);
  return proxy;
};

const snapshotFrom = (base: AuthPath, focus: AnyFocus): AuthPath => pathProxy(base, focus);

export const snapshotOf = (focus: AnyFocus, root: string): AuthPath =>
  snapshotFrom(makePath({ root, steps: [] }), focus);

const keyProxy = (root: "claims" | "input"): AuthPath => {
  const node = makePath({ root, steps: [] });
  const proxy = new Proxy(node, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return makePath({
        root,
        steps: [{ key: prop, cardinality: "one", valueType: "unknown" }],
      });
    },
  });
  PATH.set(proxy, PATH.get(node)!);
  return proxy;
};

export const claimsProxy = (): AuthPath => keyProxy("claims");

export const inputProxy = (): AuthPath => keyProxy("input");

export const mePath = (principal?: AnyEntity): AuthPath =>
  principal === undefined ? makePath({ root: "me", steps: [] }) : snapshotOf(principal, "me");
