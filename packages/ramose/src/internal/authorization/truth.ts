/**
 * Three-valued truth and completeness-aware projections.
 *
 * Do not model both absent and unavailable as JavaScript `undefined`.
 * Only {@link True} authorizes. Comparing two unavailable values must
 * never return true; negation must not turn Incomplete into allow.
 */

import type { IncompleteReason } from "./failures.ts";

export type True = { readonly _tag: "True" };
export type False = { readonly _tag: "False" };
export type Incomplete = {
  readonly _tag: "Incomplete";
  readonly reason: IncompleteReason;
};

export type Truth = True | False | Incomplete;

export const True: True = { _tag: "True" };
export const False: False = { _tag: "False" };
export const Incomplete = (reason: IncompleteReason): Incomplete => ({
  _tag: "Incomplete",
  reason,
});

/** JSON-safe scalar a complete projection may hold. */
export type ProjectedScalar = string | number | boolean | null;

/**
 * A value that exists on the rule snapshot.
 * Distinct from authoritative absence and from not-loaded data.
 */
export type Present<T = ProjectedScalar> = {
  readonly _tag: "Present";
  readonly value: T;
};

/** Field is authoritatively absent (usable in presence/absence policies). */
export type FieldAbsent = { readonly _tag: "FieldAbsent" };

/** Entity or ref target is authoritatively absent. */
export type EntityAbsent = { readonly _tag: "EntityAbsent" };

/** Required data was not loaded into the projection. */
export type NotLoadedProjection = { readonly _tag: "NotLoaded" };

/** Path is not a valid traversal against canonical field metadata. */
export type InvalidTraversalProjection = { readonly _tag: "InvalidTraversal" };

/** Projection or evaluation exhausted the work budget. */
export type BudgetExhaustedProjection = { readonly _tag: "BudgetExhausted" };

/**
 * Completeness-aware cell. Complete vs absent vs not-loaded are
 * distinct tags — none of these is `undefined`.
 */
export type Projected<T = ProjectedScalar> =
  | Present<T>
  | FieldAbsent
  | EntityAbsent
  | NotLoadedProjection
  | InvalidTraversalProjection
  | BudgetExhaustedProjection;

export type CompleteProjected<T = ProjectedScalar> =
  | Present<T>
  | FieldAbsent
  | EntityAbsent;

export type IncompleteProjected =
  | NotLoadedProjection
  | InvalidTraversalProjection
  | BudgetExhaustedProjection;

export const Present = <T = ProjectedScalar>(value: T): Present<T> => ({
  _tag: "Present",
  value,
});

export const FieldAbsent: FieldAbsent = { _tag: "FieldAbsent" };
export const EntityAbsent: EntityAbsent = { _tag: "EntityAbsent" };
export const NotLoadedProjection: NotLoadedProjection = { _tag: "NotLoaded" };
export const InvalidTraversalProjection: InvalidTraversalProjection = {
  _tag: "InvalidTraversal",
};
export const BudgetExhaustedProjection: BudgetExhaustedProjection = {
  _tag: "BudgetExhausted",
};
