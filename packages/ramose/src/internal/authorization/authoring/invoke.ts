/** Principal-only operation-grant authoring. */

import type { AnyOwnedOperation } from "../../../db/Operation.ts";
import type { AuthExpr, InvokeRule } from "./types.ts";
import { INVOKE_RULE_TAG } from "./types.ts";

export type InvokeBuilder = {
  readonly when: (expr: AuthExpr) => InvokeRule;
  readonly deny: (expr: AuthExpr) => InvokeRule;
};

const ruleOf = (
  target: AnyOwnedOperation,
  kind: "allow" | "deny",
  expr: AuthExpr,
): InvokeRule => ({ _tag: INVOKE_RULE_TAG, target, kind, expr });

/** Grant or explicitly deny invocation without exposing input or target state. */
export const invoke = (target: AnyOwnedOperation): InvokeBuilder => ({
  when: (expr) => ruleOf(target, "allow", expr),
  deny: (expr) => ruleOf(target, "deny", expr),
});
