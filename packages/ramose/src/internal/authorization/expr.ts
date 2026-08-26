/**
 * Data-only expression vocabulary for the initial authorization language.
 *
 * Authoring callbacks are build-time macros. Runtime evaluates this data,
 * not those callbacks. No aggregates, ordering, limiting, unrestricted
 * recursion, database effects, or author functions appear here (LANG-1–3).
 */

import type { IdentitySpace, RelativeIdentities } from "./identities.ts";
import type { JsonScalar } from "./json.ts";

export type PathRoot =
  | { readonly _tag: "resource" }
  | { readonly _tag: "me" }
  | { readonly _tag: "bind"; readonly name: string };

export type PathStep<I extends IdentitySpace = RelativeIdentities> = {
  readonly field: I["field"];
};

/** Typed fixed-depth ref traversal. Depth is `steps.length`; bounded at install. */
export type RefTerm<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "ref";
  readonly root: PathRoot;
  readonly steps: readonly PathStep<I>[];
};

export type LitTerm = {
  readonly _tag: "lit";
  readonly value: JsonScalar;
};

/** Verified JWT subject. Always present in authorization context. */
export type SubjectTerm = { readonly _tag: "subject" };

/** Optional application principal row. Incomplete when no row resolves. */
export type MeTerm = { readonly _tag: "me" };

/** Typed claim access. Key must be in the declared claims vocabulary. */
export type ClaimTerm = {
  readonly _tag: "claim";
  readonly key: string;
};

/**
 * Typed operation input. `path` walks struct keys; `[]` is the input root.
 * A root term is required when the operation codec is a top-level scalar,
 * ref, or array — there is no field key to name.
 */
export type InputTerm = {
  readonly _tag: "input";
  readonly path: readonly string[];
};

/** Existential or `some` binding. */
export type BindTerm = {
  readonly _tag: "bind";
  readonly name: string;
};

export type ValueTerm<I extends IdentitySpace = RelativeIdentities> =
  | LitTerm
  | SubjectTerm
  | MeTerm
  | ClaimTerm
  | InputTerm
  | BindTerm
  | RefTerm<I>;

export type ConstExpr = {
  readonly _tag: "const";
  readonly value: boolean;
};

export type AndExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "and";
  readonly exprs: readonly AuthorizationExpr<I>[];
};

export type OrExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "or";
  readonly exprs: readonly AuthorizationExpr<I>[];
};

export type NotExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "not";
  readonly expr: AuthorizationExpr<I>;
};

export type EqExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "eq";
  readonly left: ValueTerm<I>;
  readonly right: ValueTerm<I>;
};

/** Presence of a value (field, input path including the root, optional `me`). */
export type HasExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "has";
  readonly term: ValueTerm<I>;
};

/** Membership of a value in a cardinality-many collection. */
export type InExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "in";
  readonly value: ValueTerm<I>;
  readonly collection: ValueTerm<I>;
};

export type SomeExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "some";
  readonly collection: RefTerm<I>;
  readonly bind: string;
  readonly pred: AuthorizationExpr<I>;
};

export type OverlapsExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "overlaps";
  readonly left: RefTerm<I>;
  readonly right: RefTerm<I>;
};

/** Typed exists over an entity. Nested exists is bounded; self-joins are allowed. */
export type ExistsExpr<I extends IdentitySpace = RelativeIdentities> = {
  readonly _tag: "exists";
  readonly entity: I["entity"];
  readonly bind: string;
  readonly pred: AuthorizationExpr<I>;
};

export type HasClassExpr = {
  readonly _tag: "hasClass";
  readonly class: string;
};

export type AuthorizationExpr<I extends IdentitySpace = RelativeIdentities> =
  | ConstExpr
  | AndExpr<I>
  | OrExpr<I>
  | NotExpr<I>
  | EqExpr<I>
  | HasExpr<I>
  | InExpr<I>
  | SomeExpr<I>
  | OverlapsExpr<I>
  | ExistsExpr<I>
  | HasClassExpr;
