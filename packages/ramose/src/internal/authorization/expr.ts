/**
 * Data-only expression vocabulary for the initial authorization language.
 *
 * Authoring callbacks are build-time macros. Runtime evaluates this data,
 * not those callbacks. No aggregates, ordering, limiting, unrestricted
 * recursion, database effects, or author functions appear here (LANG-1–3).
 *
 * Effect Schema is the source of truth. Parameterized nodes are factories
 * over relative or canonical identity schemas. Types are `typeof Model.Type`
 * except the recursive expression unions, which exist only to break the
 * inference cycle and are checked by `Schema.Codec<Decoded, Encoded>`.
 */

import * as Schema from "effect/Schema";
import {
  CanonicalIdentitySchemas,
  EntityId,
  RelativeEntityId,
  RelativeIdentitySchemas,
  type AnyIdentitySchemaSpace,
  type CanonicalIdentities,
  type IdentitySpace,
  type RelativeIdentities,
} from "./identities.ts";
import { JsonScalar } from "./json.ts";

export const PathRoot = Schema.Union([
  Schema.TaggedStruct("resource", {}),
  Schema.TaggedStruct("me", {}),
  Schema.TaggedStruct("bind", { name: Schema.String }),
]);
export type PathRoot = typeof PathRoot.Type;

export const PathStep = <F extends Schema.Top>(field: F) => Schema.Struct({ field });

/** Typed fixed-depth ref traversal. Depth is `steps.length`; bounded at install. */
export const RefTerm = <F extends Schema.Top>(field: F) =>
  Schema.TaggedStruct("ref", {
    root: PathRoot,
    steps: Schema.Array(PathStep(field)),
  });

export const LitTerm = Schema.TaggedStruct("lit", {
  value: JsonScalar,
});
export type LitTerm = typeof LitTerm.Type;

/** Verified JWT subject. Always present in authorization context. */
export const SubjectTerm = Schema.TaggedStruct("subject", {});
export type SubjectTerm = typeof SubjectTerm.Type;

/** Optional application principal row. Incomplete when no row resolves. */
export const MeTerm = Schema.TaggedStruct("me", {});
export type MeTerm = typeof MeTerm.Type;

/** Typed claim access. Key must be in the declared claims vocabulary. */
export const ClaimTerm = Schema.TaggedStruct("claim", {
  key: Schema.String,
});
export type ClaimTerm = typeof ClaimTerm.Type;

/**
 * Typed operation input. `path` walks struct keys; `[]` is the input root.
 * A root term is required when the operation codec is a top-level scalar,
 * ref, or array — there is no field key to name.
 */
export const InputTerm = Schema.TaggedStruct("input", {
  path: Schema.Array(Schema.String),
});
export type InputTerm = typeof InputTerm.Type;

/** Existential or `some` binding. */
export const BindTerm = Schema.TaggedStruct("bind", {
  name: Schema.String,
});
export type BindTerm = typeof BindTerm.Type;

export const ValueTerm = <F extends Schema.Top>(field: F) =>
  Schema.Union([
    LitTerm,
    SubjectTerm,
    MeTerm,
    ClaimTerm,
    InputTerm,
    BindTerm,
    RefTerm(field),
  ]);

export const ConstExpr = Schema.TaggedStruct("const", {
  value: Schema.Boolean,
});
export type ConstExpr = typeof ConstExpr.Type;

export const HasClassExpr = Schema.TaggedStruct("hasClass", {
  class: Schema.String,
});
export type HasClassExpr = typeof HasClassExpr.Type;

export const AndExpr = <E extends Schema.Top>(expr: E) =>
  Schema.TaggedStruct("and", { exprs: Schema.Array(expr) });

export const OrExpr = <E extends Schema.Top>(expr: E) =>
  Schema.TaggedStruct("or", { exprs: Schema.Array(expr) });

export const NotExpr = <E extends Schema.Top>(expr: E) =>
  Schema.TaggedStruct("not", { expr });

export const EqExpr = <V extends Schema.Top>(value: V) =>
  Schema.TaggedStruct("eq", { left: value, right: value });

export const HasExpr = <V extends Schema.Top>(value: V) =>
  Schema.TaggedStruct("has", { term: value });

export const InExpr = <V extends Schema.Top>(value: V) =>
  Schema.TaggedStruct("in", { value, collection: value });

export const SomeExpr = <R extends Schema.Top, E extends Schema.Top>(ref: R, expr: E) =>
  Schema.TaggedStruct("some", {
    collection: ref,
    bind: Schema.String,
    pred: expr,
  });

export const OverlapsExpr = <R extends Schema.Top>(ref: R) =>
  Schema.TaggedStruct("overlaps", { left: ref, right: ref });

export const ExistsExpr = <Entity extends Schema.Top, E extends Schema.Top>(entity: Entity, expr: E) =>
  Schema.TaggedStruct("exists", {
    entity,
    bind: Schema.String,
    pred: expr,
  });

export const RelativePathStep = PathStep(RelativeIdentitySchemas.field);
export type RelativePathStep = typeof RelativePathStep.Type;
export const CanonicalPathStep = PathStep(CanonicalIdentitySchemas.field);
export type CanonicalPathStep = typeof CanonicalPathStep.Type;

export const RelativeRefTerm = RefTerm(RelativeIdentitySchemas.field);
export type RelativeRefTerm = typeof RelativeRefTerm.Type;
export const CanonicalRefTerm = RefTerm(CanonicalIdentitySchemas.field);
export type CanonicalRefTerm = typeof CanonicalRefTerm.Type;

export const RelativeValueTerm = ValueTerm(RelativeIdentitySchemas.field);
export type RelativeValueTerm = typeof RelativeValueTerm.Type;
export const CanonicalValueTerm = ValueTerm(CanonicalIdentitySchemas.field);
export type CanonicalValueTerm = typeof CanonicalValueTerm.Type;

export type RelativeValueTermEncoded = typeof RelativeValueTerm.Encoded;
export type CanonicalValueTermEncoded = typeof CanonicalValueTerm.Encoded;
export type RelativeRefTermEncoded = typeof RelativeRefTerm.Encoded;
export type CanonicalRefTermEncoded = typeof CanonicalRefTerm.Encoded;

export type RelativeAuthorizationExpr =
  | ConstExpr
  | HasClassExpr
  | { readonly _tag: "and"; readonly exprs: ReadonlyArray<RelativeAuthorizationExpr> }
  | { readonly _tag: "or"; readonly exprs: ReadonlyArray<RelativeAuthorizationExpr> }
  | { readonly _tag: "not"; readonly expr: RelativeAuthorizationExpr }
  | { readonly _tag: "eq"; readonly left: RelativeValueTerm; readonly right: RelativeValueTerm }
  | { readonly _tag: "has"; readonly term: RelativeValueTerm }
  | { readonly _tag: "in"; readonly value: RelativeValueTerm; readonly collection: RelativeValueTerm }
  | {
      readonly _tag: "some";
      readonly collection: RelativeRefTerm;
      readonly bind: string;
      readonly pred: RelativeAuthorizationExpr;
    }
  | { readonly _tag: "overlaps"; readonly left: RelativeRefTerm; readonly right: RelativeRefTerm }
  | {
      readonly _tag: "exists";
      readonly entity: RelativeEntityId;
      readonly bind: string;
      readonly pred: RelativeAuthorizationExpr;
    };

export type CanonicalAuthorizationExpr =
  | ConstExpr
  | HasClassExpr
  | { readonly _tag: "and"; readonly exprs: ReadonlyArray<CanonicalAuthorizationExpr> }
  | { readonly _tag: "or"; readonly exprs: ReadonlyArray<CanonicalAuthorizationExpr> }
  | { readonly _tag: "not"; readonly expr: CanonicalAuthorizationExpr }
  | { readonly _tag: "eq"; readonly left: CanonicalValueTerm; readonly right: CanonicalValueTerm }
  | { readonly _tag: "has"; readonly term: CanonicalValueTerm }
  | { readonly _tag: "in"; readonly value: CanonicalValueTerm; readonly collection: CanonicalValueTerm }
  | {
      readonly _tag: "some";
      readonly collection: CanonicalRefTerm;
      readonly bind: string;
      readonly pred: CanonicalAuthorizationExpr;
    }
  | { readonly _tag: "overlaps"; readonly left: CanonicalRefTerm; readonly right: CanonicalRefTerm }
  | {
      readonly _tag: "exists";
      readonly entity: EntityId;
      readonly bind: string;
      readonly pred: CanonicalAuthorizationExpr;
    };

export type RelativeAuthorizationExprEncoded =
  | ConstExpr
  | HasClassExpr
  | { readonly _tag: "and"; readonly exprs: ReadonlyArray<RelativeAuthorizationExprEncoded> }
  | { readonly _tag: "or"; readonly exprs: ReadonlyArray<RelativeAuthorizationExprEncoded> }
  | { readonly _tag: "not"; readonly expr: RelativeAuthorizationExprEncoded }
  | { readonly _tag: "eq"; readonly left: RelativeValueTermEncoded; readonly right: RelativeValueTermEncoded }
  | { readonly _tag: "has"; readonly term: RelativeValueTermEncoded }
  | { readonly _tag: "in"; readonly value: RelativeValueTermEncoded; readonly collection: RelativeValueTermEncoded }
  | {
      readonly _tag: "some";
      readonly collection: RelativeRefTermEncoded;
      readonly bind: string;
      readonly pred: RelativeAuthorizationExprEncoded;
    }
  | { readonly _tag: "overlaps"; readonly left: RelativeRefTermEncoded; readonly right: RelativeRefTermEncoded }
  | {
      readonly _tag: "exists";
      readonly entity: typeof RelativeEntityId.Encoded;
      readonly bind: string;
      readonly pred: RelativeAuthorizationExprEncoded;
    };

export type CanonicalAuthorizationExprEncoded =
  | ConstExpr
  | HasClassExpr
  | { readonly _tag: "and"; readonly exprs: ReadonlyArray<CanonicalAuthorizationExprEncoded> }
  | { readonly _tag: "or"; readonly exprs: ReadonlyArray<CanonicalAuthorizationExprEncoded> }
  | { readonly _tag: "not"; readonly expr: CanonicalAuthorizationExprEncoded }
  | { readonly _tag: "eq"; readonly left: CanonicalValueTermEncoded; readonly right: CanonicalValueTermEncoded }
  | { readonly _tag: "has"; readonly term: CanonicalValueTermEncoded }
  | { readonly _tag: "in"; readonly value: CanonicalValueTermEncoded; readonly collection: CanonicalValueTermEncoded }
  | {
      readonly _tag: "some";
      readonly collection: CanonicalRefTermEncoded;
      readonly bind: string;
      readonly pred: CanonicalAuthorizationExprEncoded;
    }
  | { readonly _tag: "overlaps"; readonly left: CanonicalRefTermEncoded; readonly right: CanonicalRefTermEncoded }
  | {
      readonly _tag: "exists";
      readonly entity: typeof EntityId.Encoded;
      readonly bind: string;
      readonly pred: CanonicalAuthorizationExprEncoded;
    };

const authorizationExprUnion = <
  Entity extends Schema.Top,
  Trait extends Schema.Top,
  Field extends Schema.Top,
  Operation extends Schema.Top,
  E extends Schema.Top,
>(
  ids: AnyIdentitySchemaSpace<Entity, Trait, Field, Operation>,
  expr: E,
) => {
  const value = ValueTerm(ids.field);
  const ref = RefTerm(ids.field);
  return Schema.Union([
    ConstExpr,
    AndExpr(expr),
    OrExpr(expr),
    NotExpr(expr),
    EqExpr(value),
    HasExpr(value),
    InExpr(value),
    SomeExpr(ref, expr),
    OverlapsExpr(ref),
    ExistsExpr(ids.entity, expr),
    HasClassExpr,
  ]);
};

export const RelativeAuthorizationExpr: Schema.Codec<
  RelativeAuthorizationExpr,
  RelativeAuthorizationExprEncoded
> = Schema.suspend(() => authorizationExprUnion(RelativeIdentitySchemas, RelativeAuthorizationExpr));

export const CanonicalAuthorizationExpr: Schema.Codec<
  CanonicalAuthorizationExpr,
  CanonicalAuthorizationExprEncoded
> = Schema.suspend(() => authorizationExprUnion(CanonicalIdentitySchemas, CanonicalAuthorizationExpr));

export type PathStep<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalPathStep
  : RelativePathStep;

export type RefTerm<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalRefTerm
  : RelativeRefTerm;

export type ValueTerm<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalValueTerm
  : RelativeValueTerm;

export type AndExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "and" }>;
export type OrExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "or" }>;
export type NotExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "not" }>;
export type EqExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "eq" }>;
export type HasExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "has" }>;
export type InExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "in" }>;
export type SomeExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "some" }>;
export type OverlapsExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "overlaps" }>;
export type ExistsExpr = Extract<RelativeAuthorizationExpr | CanonicalAuthorizationExpr, { readonly _tag: "exists" }>;

export type AuthorizationExpr<I extends IdentitySpace = RelativeIdentities> = I extends CanonicalIdentities
  ? CanonicalAuthorizationExpr
  : I extends RelativeIdentities
    ? RelativeAuthorizationExpr
    : RelativeAuthorizationExpr | CanonicalAuthorizationExpr;
