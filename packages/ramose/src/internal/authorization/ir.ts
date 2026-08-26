/**
 * Two-stage authorization IR.
 *
 * Authoring compiles a catalog-relative {@link PolicyTemplateIR}. An
 * Effectful install binds it against the authoritative catalog and seals
 * {@link InstalledAuthorizationIR}. Runtime accepts only the installed
 * form. Contract: `src/internal/design/authorization.md`.
 */

export const AUTHORIZATION_IR_VERSION = 1 as const;

/**
 * Max ref hops on any one path (resource, bind, or `me`).
 * `Taggable → Tag → TagGrant` is depth 2 and must compile.
 */
export const MAX_TRAVERSAL_DEPTH = 3;

export const REGISTERED_CLAIM_KEYS = ["sub", "iss", "aud", "exp", "nbf"] as const;
export type RegisteredClaimKey = (typeof REGISTERED_CLAIM_KEYS)[number];

export type JsonLiteral = string | number | boolean | null;

export type OwnerKind = "entity" | "trait";

/** Canonical owner: kind + local name. Catalog id lands in later binding work. */
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

export type OperationTarget = "none" | "resource";

/**
 * Owner, localName (the `withOperations` map key), and target are
 * independent and mandatory. Ownerless operations are not in the model.
 */
export interface OperationId {
  readonly kind: "operation";
  readonly owner: OwnerId;
  readonly localName: string;
  readonly name: string;
  readonly target: OperationTarget;
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
  | { readonly kind: "lit"; readonly value: JsonLiteral }
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
  readonly usesMe: boolean;
  readonly usesInput: boolean;
  readonly claims: readonly string[];
  readonly classes: readonly string[];
  readonly exists: readonly { readonly entity: string }[];
}

/** `.allow(a, b)` is OR. Any true deny wins. Missing decision is deny. */
export interface IrDecision {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * JWT `sub` always exists. The application `me` row is optional.
 * Class/claims-only policies need no principal entity.
 */
export interface PrincipalSpec {
  readonly subjectClaim: "sub";
  readonly ident?: string;
  readonly entity?: string;
}

export interface CatalogBinding {
  readonly databaseId: string;
  readonly catalogName: string;
  readonly catalogVersion: number;
  readonly schemaFingerprint: string;
}

export interface IrIdentities {
  readonly entities: readonly OwnerId[];
  readonly traits: readonly OwnerId[];
  readonly fields: readonly FieldId[];
  readonly operations: readonly OperationId[];
}

interface PolicyBody {
  readonly version: typeof AUTHORIZATION_IR_VERSION;
  readonly principal: PrincipalSpec;
  readonly classes: readonly string[];
  readonly claims: readonly string[];
  readonly identities: IrIdentities;
  readonly rules: readonly IrRule[];
  readonly rows: { readonly [entityNs: string]: IrDecision };
  readonly traits: { readonly [traitNs: string]: IrDecision };
  readonly fields: { readonly [ident: string]: IrDecision };
  readonly operations: { readonly [name: string]: IrDecision };
}

/** Catalog-relative compiler output. Not accepted by runtime. */
export interface PolicyTemplateIR extends PolicyBody {
  readonly form: "template";
}

/**
 * Sealed installed form. Runtime accepts only this. Contains catalog
 * identity, schema fingerprint, canonical identities, policy hash, and
 * recomputed rule metadata.
 */
export interface InstalledAuthorizationIR extends PolicyBody {
  readonly form: "installed";
  readonly catalog: CatalogBinding;
  readonly policyHash: string;
}

/** Runtime document. Alias of the sealed installed form. */
export type AuthorizationIR = InstalledAuthorizationIR;
