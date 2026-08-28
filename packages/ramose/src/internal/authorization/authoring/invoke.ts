/**
 * `invoke(operation).when` / `.deny` builder for principal-only operation
 * grants. Target fields, operation input, and resource paths are invalid.
 */

import type { AnyEntity } from "../../../db/Entity.ts";
import type { AnyOperation } from "../../../db/Operation.ts";
import type { AnyTrait } from "../../../db/Trait.ts";
import type { OperationTarget, OwnerRef } from "../identities.ts";
import {
  INVOKE_RULE_TAG,
  isAuthPath,
  isEntityTarget,
  isPathCarrier,
  isTraitTarget,
  type AuthExpr,
  type InvokeRule,
  type InvokeTarget,
} from "./types.ts";

export type InvokeBuilder = {
  readonly when: (expr: AuthExpr) => InvokeRule;
  readonly deny: (expr: AuthExpr) => InvokeRule;
};

const ownerRefOf = (owner: AnyEntity | AnyTrait | OwnerRef): OwnerRef => {
  if (isEntityTarget(owner)) return { kind: "entity", name: owner.ns };
  if (isTraitTarget(owner)) return { kind: "trait", name: owner.ns };
  return owner;
};

const localNameOfOperation = (name: string): string => {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
};

const ownerNameOfOperation = (name: string): string | undefined => {
  const slash = name.lastIndexOf("/");
  return slash > 0 ? name.slice(0, slash) : undefined;
};

export const invokeTargetOf = (
  target: InvokeTarget,
): {
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
} => {
  if (
    typeof target === "object" &&
    target !== null &&
    (target as { readonly _tag?: unknown })._tag === "Operation"
  ) {
    const operation = target as AnyOperation;
    const on = operation.on;
    if (on !== undefined && on !== null && typeof on === "object" && typeof on.ns === "string") {
      return {
        owner: { kind: "entity", name: on.ns },
        localName: localNameOfOperation(operation.name),
        target: "required",
      };
    }
    const ownerName = ownerNameOfOperation(operation.name);
    if (ownerName === undefined) {
      throw new Error(`ramose: invoke(${JSON.stringify(operation.name)}) needs an owner`);
    }
    return {
      owner: { kind: "entity", name: ownerName },
      localName: localNameOfOperation(operation.name),
      target: "none",
    };
  }
  const explicit = target as {
    readonly owner: AnyEntity | AnyTrait | OwnerRef;
    readonly localName: string;
    readonly target?: OperationTarget;
    readonly self?: boolean;
  };
  const required =
    explicit.target ?? (explicit.self === false ? "none" : "required");
  return {
    owner: ownerRefOf(explicit.owner),
    localName: explicit.localName,
    target: required,
  };
};

const ruleOf = (target: InvokeTarget, kind: "allow" | "deny", expr: AuthExpr): InvokeRule => ({
  _tag: INVOKE_RULE_TAG,
  target,
  kind,
  expr,
});

export function invoke(target: InvokeTarget): InvokeBuilder {
  return {
    when: (expr) => {
      if (typeof expr === "function" || isAuthPath(expr) || isPathCarrier(expr)) {
        throw new Error("ramose: invoke().when cannot close over a target path");
      }
      return ruleOf(target, "allow", expr);
    },
    deny: (expr) => {
      if (typeof expr === "function" || isAuthPath(expr) || isPathCarrier(expr)) {
        throw new Error("ramose: invoke().deny cannot close over a target path");
      }
      return ruleOf(target, "deny", expr);
    },
  };
}
