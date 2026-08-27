/**
 * Authoring-time types for the read-authorization language (#406).
 *
 * These objects exist only before compile. The compiled artifact is
 * Schema-decoded {@link import("../ir.ts").PolicyTemplateIR} — no
 * functions, prototypes, Effects, or authoring tags.
 */

import type { AnySchema } from "../../../db/Schema.ts";
import type { PathCarrier } from "../../../db/shapes.ts";
import type { AnyEntity } from "../../../db/Entity.ts";
import type { AnyTrait } from "../../../db/Trait.ts";
import type { JsonScalar } from "../json.ts";
import type { ClaimDescriptor } from "../principal.ts";

export const AUTH_PATH_TAG = "AuthPath" as const;
export const READ_RULE_TAG = "ReadRule" as const;

export type AuthPathStep = {
  readonly ident: string;
  readonly localName: string;
  readonly cardinality: "one" | "many";
  readonly valueType: string | undefined;
  readonly reverse: boolean;
};

export type AuthPathLike = {
  readonly _tag: typeof AUTH_PATH_TAG;
  readonly steps: readonly AuthPathStep[];
};

export type BoxedOperand =
  | { readonly _tag: "me" }
  | { readonly _tag: "subject" }
  | { readonly _tag: "claim"; readonly key: string }
  | { readonly _tag: "lit"; readonly value: JsonScalar }
  | { readonly _tag: "path"; readonly steps: readonly AuthPathStep[] };

export type AuthExpr =
  | { readonly _tag: "const"; readonly value: boolean }
  | { readonly _tag: "hasClass"; readonly class: string }
  | { readonly _tag: "and"; readonly exprs: readonly AuthExpr[] }
  | { readonly _tag: "or"; readonly exprs: readonly AuthExpr[] }
  | { readonly _tag: "not"; readonly expr: AuthExpr }
  | { readonly _tag: "eq"; readonly left: unknown; readonly right: unknown }
  | { readonly _tag: "in"; readonly value: unknown; readonly collection: unknown };

export type AuthOperandInput =
  | AuthPathLike
  | PathCarrier
  | BoxedOperand
  | JsonScalar
  | { readonly _tag: string };

export type ReadTarget = AnyEntity | AnyTrait | PathCarrier;

export type ReadRule = {
  readonly _tag: typeof READ_RULE_TAG;
  readonly target: ReadTarget;
  readonly kind: "allow" | "deny";
  readonly expr: AuthExpr;
};

export type CompileReadAuthorizationInput = {
  readonly schema: AnySchema;
  readonly rules: readonly ReadRule[];
  readonly classes?: readonly string[];
  readonly claims?: readonly ClaimDescriptor[];
  readonly principal?: {
    readonly subjectClaim?: string;
    readonly entity?: PathCarrier;
  };
};

type RefTargetFields<F> = F extends {
  readonly schema: { readonly _target?: infer T };
}
  ? T extends { readonly fields: infer Fields }
    ? Fields
    : { readonly [key: string]: unknown }
  : { readonly [key: string]: unknown };

/** Fields reachable after a field-target `read(Issue.owner)` hop. */
export type FieldTargetFields<T> = T extends {
  readonly schema: { readonly _target?: infer Target };
}
  ? Target extends { readonly fields: infer Fields }
    ? Fields
    : { readonly [key: string]: unknown }
  : { readonly [key: string]: unknown };

export type AuthPathMethods = AuthPathLike & {
  readonly eq: (rhs: AuthOperandInput) => AuthExpr;
  readonly contains: (rhs: AuthOperandInput) => AuthExpr;
};

export type AuthPathProxy<Fields = object> = AuthPathMethods & {
  readonly [K in keyof Fields]: AuthPathProxy<RefTargetFields<Fields[K]>>;
} & ((rhs: AuthOperandInput) => AuthExpr);

export const isAuthPath = (value: unknown): value is AuthPathLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === AUTH_PATH_TAG &&
  Array.isArray((value as { readonly steps?: unknown }).steps);

export const isEntityTarget = (value: unknown): value is AnyEntity =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Entity" &&
  typeof (value as { readonly ns?: unknown }).ns === "string";

export const isTraitTarget = (value: unknown): value is AnyTrait =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Trait" &&
  typeof (value as { readonly ns?: unknown }).ns === "string";

export const isPathCarrier = (value: unknown): value is PathCarrier =>
  typeof value === "object" &&
  value !== null &&
  !isAuthPath(value) &&
  typeof (value as { readonly ident?: unknown }).ident === "string";

export const isJsonScalar = (value: unknown): value is JsonScalar => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
};

export const parseIdent = (
  ident: string,
): { readonly ns: string; readonly localName: string } | undefined => {
  const match = /^:([^/]+)\/([^/]+)$/.exec(ident);
  if (match === null) return undefined;
  return { ns: match[1]!, localName: match[2]! };
};

export const stepFromCarrier = (carrier: PathCarrier): AuthPathStep => {
  const ident = carrier.ident;
  const parsed = parseIdent(ident);
  const attrName = (carrier as { readonly attrName?: unknown }).attrName;
  const localName = typeof attrName === "string" ? attrName : (parsed?.localName ?? ident);
  const valueType = (carrier as { readonly valueType?: unknown }).valueType;
  const revs = carrier.__revs ?? [];
  return {
    ident,
    localName,
    cardinality: carrier.cardinality === "many" ? "many" : "one",
    valueType: typeof valueType === "string" ? valueType : undefined,
    reverse: carrier.__reverse === true || revs.some(Boolean),
  };
};
