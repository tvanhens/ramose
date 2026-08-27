/**
 * `read(target).when` / `.deny` builder for the read-authorization language (#406).
 *
 * The optional callback is a compile-time macro: it receives a proxied
 * schema (`$()`), never a `Db` or Effect environment.
 */

import { $, path } from "./path.ts";
import {
  isEntityTarget,
  isPathCarrier,
  isTraitTarget,
  READ_RULE_TAG,
  type AuthExpr,
  type AuthPathProxy,
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
  if (typeof expr !== "function") return expr;
  if (isEntityTarget(target) || isTraitTarget(target)) {
    return expr($(target));
  }
  if (isPathCarrier(target)) {
    return expr(path(target) as AuthPathProxy);
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
export function read(target: { readonly ident: string }): ReadBuilder<AuthPathProxy>;
export function read(target: ReadTarget): ReadBuilder<AuthPathProxy> {
  return builder(target);
}
