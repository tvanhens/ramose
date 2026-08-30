import { $, seededPath } from "./path.ts";
import {
  isAuthPath,
  isEntityTarget,
  isPathCarrier,
  isTraitTarget,
  READ_RULE_TAG,
  type AuthExpr,
  type AuthPathProxy,
  type FieldTargetFields,
  type ReadRule,
  type ReadTarget,
} from "./types.ts";

export type ReadBuilder<Proxy> = {
  readonly when: (expr: AuthExpr | ((proxy: Proxy) => AuthExpr)) => ReadRule;
  readonly deny: (expr: AuthExpr | ((proxy: Proxy) => AuthExpr)) => ReadRule;
};

const resolveExpr = (
  target: ReadTarget,
  expr: AuthExpr | ((proxy: AuthPathProxy) => AuthExpr),
): AuthExpr => {
  if (typeof expr !== "function" || isAuthPath(expr)) return expr as AuthExpr;
  if (isEntityTarget(target) || isTraitTarget(target)) {
    return expr($(target));
  }
  if (isPathCarrier(target)) {
    return expr(seededPath(target));
  }
  return expr($({ fields: {} }) as AuthPathProxy);
};

const ruleOf = (target: ReadTarget, kind: "allow" | "deny", expr: AuthExpr): ReadRule => ({
  _tag: READ_RULE_TAG,
  target,
  kind,
  expr,
});

const builder = <Proxy>(target: ReadTarget): ReadBuilder<Proxy> => ({
  when: (expr) =>
    ruleOf(target, "allow", resolveExpr(target, expr as AuthExpr | ((proxy: AuthPathProxy) => AuthExpr))),
  deny: (expr) =>
    ruleOf(target, "deny", resolveExpr(target, expr as AuthExpr | ((proxy: AuthPathProxy) => AuthExpr))),
});

export function read<N extends { readonly _tag: "Entity" | "Trait"; readonly fields: object }>(
  target: N,
): ReadBuilder<AuthPathProxy<N["fields"]>>;
export function read<F extends { readonly ident: string }>(
  target: F,
): ReadBuilder<AuthPathProxy<FieldTargetFields<F>>>;
export function read(target: ReadTarget): ReadBuilder<AuthPathProxy> {
  return builder(target);
}
