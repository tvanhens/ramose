/**
 * Versioned, data-only authorization IR.
 *
 * Runtime evaluates this document. It does not execute authoring callbacks
 * or import the authoring module. Contract: `src/internal/design/authorization.md`
 * (**LANG-1**–**LANG-6**, **POL-1**–**POL-6**, **WR-4**, **FC-1**, **CAT-1**).
 */

/** Current IR version. There is no legacy document and no adapter. */
export const AUTHORIZATION_IR_VERSION = 1 as const;

/**
 * Max ref hops on any one path (resource, bind, or `me`).
 * `Taggable → Tag → TagGrant` is depth 2 and must compile.
 */
export const MAX_TRAVERSAL_DEPTH = 3;

export type OwnerKind = "entity" | "trait";

/** Canonical owner: kind + local name. Catalog id lands in #341. */
export interface OwnerId {
  readonly kind: OwnerKind;
  readonly ns: string;
}

export interface FieldId {
  readonly kind: "field";
  readonly ident: string;
  readonly owner: OwnerId;
  readonly name: string;
  readonly cardinality: "one" | "many";
  readonly valueType: string;
}

export interface OperationId {
  readonly kind: "operation";
  readonly name: string;
  readonly owner?: OwnerId;
  readonly targetless: boolean;
}

export interface PathStep {
  readonly ident?: string;
  readonly key?: string;
  readonly cardinality: "one" | "many";
  readonly valueType: string;
}

export interface IrPath {
  readonly root: string;
  readonly steps: readonly PathStep[];
}

export type IrOperand =
  | { readonly kind: "me" }
  | { readonly kind: "lit"; readonly value: unknown }
  | { readonly kind: "path"; readonly path: IrPath };

export type IrExpr =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "hasClass"; readonly class: string }
  | { readonly kind: "eq"; readonly left: IrOperand; readonly right: IrOperand }
  | { readonly kind: "has"; readonly path: IrPath; readonly value?: IrOperand }
  | { readonly kind: "some"; readonly path: IrPath; readonly bind: string; readonly body: IrExpr }
  | { readonly kind: "overlaps"; readonly left: IrPath; readonly right: IrPath }
  | { readonly kind: "exists"; readonly entity: string; readonly bind: string; readonly body: IrExpr }
  | { readonly kind: "and"; readonly exprs: readonly IrExpr[] }
  | { readonly kind: "or"; readonly exprs: readonly IrExpr[] }
  | { readonly kind: "not"; readonly expr: IrExpr };

export interface IrRule {
  readonly id: string;
  readonly focus: OwnerId;
  readonly expr: IrExpr;
  readonly usesResource: boolean;
  readonly usesInput: boolean;
}

/** `.allow(a, b)` is OR. Any true deny wins. Missing decision is deny. */
export interface IrDecision {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * Compiled authorization document. JSON-serializable, no closures, no
 * functions, canonical identities only.
 */
export interface AuthorizationIR {
  readonly version: typeof AUTHORIZATION_IR_VERSION;
  readonly principal: {
    readonly ident: string;
    readonly entity: string;
  };
  readonly classes: readonly string[];
  /** Declared claim keys (plus registered JWT keys the compiler allows). */
  readonly claims: readonly string[];
  readonly identities: {
    readonly entities: readonly OwnerId[];
    readonly traits: readonly OwnerId[];
    readonly fields: readonly FieldId[];
    readonly operations: readonly OperationId[];
  };
  readonly rules: readonly IrRule[];
  readonly rows: { readonly [entityNs: string]: IrDecision };
  readonly traits: { readonly [traitNs: string]: IrDecision };
  readonly fields: { readonly [ident: string]: IrDecision };
  readonly operations: { readonly [name: string]: IrDecision };
}

export const REGISTERED_CLAIM_KEYS = ["sub", "iss", "aud", "exp", "nbf"] as const;
