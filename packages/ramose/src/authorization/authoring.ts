/**
 * Policy authoring surface. Bindings are compile-time values; the compiler
 * lowers them to IR and drops every callback.
 *
 *   read(Issue).allow(ownsIssue, canReadTagged)
 *   read(Issue.internalNotes).allow(hasClass("support"))
 *   run(Issue.operations.rename).allow(ownsIssue, canReadTagged)
 *   run(Taggable.operations.addTag).allow(canReadTagged)
 *   run(Issue.operations.seed).allow(hasClass("member"))
 */

import type { AnyEntity } from "../db/Entity.ts";
import type { AnyOperation } from "../db/Operation.ts";
import type { AnyTrait } from "../db/Trait.ts";
import type { OperationTarget } from "../internal/authorization/ir.ts";
import {
  isAuthExpr,
  type AnyFocus,
  type AuthExpr,
  type AuthPath,
  type Snapshot,
} from "./expr.ts";

export const AUTH_OWNER: unique symbol = Symbol.for("ramose.authorization.owner");
export const AUTH_LOCAL_NAME: unique symbol = Symbol.for("ramose.authorization.localName");
export const AUTH_TARGET: unique symbol = Symbol.for("ramose.authorization.target");

export type AuthOperation = AnyOperation & {
  readonly [AUTH_OWNER]?: AnyFocus;
  readonly [AUTH_LOCAL_NAME]?: string;
  readonly [AUTH_TARGET]?: OperationTarget;
};

export type ClaimPaths<C = Record<string, unknown>> = [keyof C] extends [never]
  ? { readonly [key: string]: AuthPath }
  : { readonly [K in keyof C]: AuthPath };

export type AuthRule<
  F extends AnyFocus = AnyFocus,
  Claims = Record<string, never>,
  Input = Record<string, never>,
> = {
  readonly _tag: "AuthRule";
  readonly focus: F;
  readonly body: (ctx: RuleContext<F, Claims, Input>) => AuthExpr;
};

export interface RuleContext<
  F extends AnyFocus = AnyFocus,
  Claims = Record<string, never>,
  Input = Record<string, never>,
> {
  readonly me: AuthPath;
  readonly resource: AuthPath & Snapshot<F>;
  readonly claims: ClaimPaths<Claims>;
  readonly input: ClaimPaths<Input>;
}

/** `AuthRule<any>` so a focused rule is assignable into `.allow(...)`. */
export type Allowable = AuthRule<any> | AuthExpr;

export type BindingKind = "row" | "trait" | "field" | "operation";

export interface AuthBinding {
  readonly _tag: "AuthBinding";
  readonly kind: BindingKind;
  readonly allowArms: readonly Allowable[];
  readonly denyArms: readonly Allowable[];
  readonly entity?: AnyEntity;
  readonly trait?: AnyTrait;
  readonly field?: { readonly ident: string };
  readonly operation?: AuthOperation;
  allow(...arms: readonly Allowable[]): AuthBinding;
  deny(...arms: readonly Allowable[]): AuthBinding;
}

const isRule = (value: unknown): value is AuthRule =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "AuthRule";

export const isAllowable = (value: unknown): value is Allowable => isRule(value) || isAuthExpr(value);

const asAllowables = (arms: readonly unknown[], where: string): Allowable[] => {
  if (arms.length === 0) {
    throw new Error(`ramose/authorization: ${where} needs at least one rule or expression`);
  }
  for (const arm of arms) {
    if (!isAllowable(arm)) {
      throw new Error(`ramose/authorization: ${where} takes rule(...) or an expression`);
    }
  }
  return arms as Allowable[];
};

const builder = (
  seed: Omit<AuthBinding, "_tag" | "allowArms" | "denyArms" | "allow" | "deny">,
  allowArms: readonly Allowable[],
  denyArms: readonly Allowable[],
): AuthBinding => {
  const binding: AuthBinding = {
    _tag: "AuthBinding",
    ...seed,
    allowArms,
    denyArms,
    allow: (...arms: readonly Allowable[]) =>
      builder(seed, [...allowArms, ...asAllowables(arms, "allow")], denyArms),
    deny: (...arms: readonly Allowable[]) =>
      builder(seed, allowArms, [...denyArms, ...asAllowables(arms, "deny")]),
  };
  return binding;
};

const isEntity = (value: unknown): value is AnyEntity =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Entity";

const isTrait = (value: unknown): value is AnyTrait =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Trait";

const isField = (value: unknown): value is { readonly ident: string; readonly _tag?: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly ident?: unknown }).ident === "string" &&
  (value as { readonly ident: string }).ident.includes("/");

/**
 * Row, trait, or field visibility.
 * `read(Entity)` is a row policy; `read(Trait)` gates trait-owned fields;
 * `read(Field)` narrows one attribute.
 */
export function read(target: AnyEntity): AuthBinding;
export function read(target: AnyTrait): AuthBinding;
export function read(target: { readonly ident: string }): AuthBinding;
export function read(target: unknown): AuthBinding {
  if (isEntity(target)) return builder({ kind: "row", entity: target }, [], []);
  if (isTrait(target)) return builder({ kind: "trait", trait: target }, [], []);
  if (isField(target)) return builder({ kind: "field", field: { ident: target.ident } }, [], []);
  throw new Error("ramose/authorization: read() takes an Entity, Trait, or Field");
}

/** Operation authorization. Accepts `Focus.operations.name` from {@link withOperations}. */
export function run(operation: AuthOperation): AuthBinding {
  if (operation?._tag !== "Operation" || typeof operation.name !== "string") {
    throw new Error("ramose/authorization: run() takes an Operation");
  }
  return builder({ kind: "operation", operation }, [], []);
}

export function rule<F extends AnyFocus>(
  focus: F,
  body: (ctx: RuleContext<F>) => AuthExpr,
): AuthRule<F>;
export function rule<
  F extends AnyFocus,
  Claims extends Record<string, unknown>,
  Input extends Record<string, unknown> = Record<string, never>,
>(
  focus: F,
  body: (ctx: RuleContext<F, Claims, Input>) => AuthExpr,
): AuthRule<F, Claims, Input>;
export function rule<F extends AnyFocus>(
  focus: F,
  body: (ctx: RuleContext<F>) => AuthExpr,
): AuthRule<F> {
  if (!isEntity(focus) && !isTrait(focus)) {
    throw new Error("ramose/authorization: rule() takes an Entity or Trait focus");
  }
  if (typeof body !== "function") {
    throw new Error("ramose/authorization: rule() takes a compile-time expression callback");
  }
  return { _tag: "AuthRule", focus, body };
}

/**
 * Attach named operations so authoring can say `Issue.operations.rename`.
 * Binds owner (the focus), localName (the map key), and target independently.
 */
export function withOperations<F extends AnyFocus, const M extends Record<string, AnyOperation>>(
  focus: F,
  operations: M,
): F & { readonly operations: { readonly [K in keyof M]: AuthOperation } } {
  const bound = {} as { [K in keyof M]: AuthOperation };
  for (const key of Object.keys(operations) as (keyof M)[]) {
    const op = operations[key]!;
    const target: OperationTarget =
      op.on !== undefined || focus._tag === "Trait" ? "resource" : "none";
    bound[key] = Object.assign({}, op, {
      [AUTH_OWNER]: focus,
      [AUTH_LOCAL_NAME]: String(key),
      [AUTH_TARGET]: target,
    });
  }
  return Object.assign({}, focus, { operations: bound });
}

export const ownerOfOperation = (operation: AuthOperation): AnyFocus | undefined =>
  operation[AUTH_OWNER];

export const localNameOfOperation = (operation: AuthOperation): string | undefined =>
  operation[AUTH_LOCAL_NAME];

export const targetOfOperation = (operation: AuthOperation): OperationTarget | undefined =>
  operation[AUTH_TARGET];

export const isBoundOperation = (operation: AuthOperation): boolean =>
  ownerOfOperation(operation) !== undefined &&
  localNameOfOperation(operation) !== undefined &&
  targetOfOperation(operation) !== undefined;
