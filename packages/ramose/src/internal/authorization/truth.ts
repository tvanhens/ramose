/** Three-valued authorization results and projection cells. */

export type IncompleteReason =
  | { readonly _tag: "NotLoaded"; readonly detail: string }
  | { readonly _tag: "InvalidTraversal"; readonly detail: string }
  | { readonly _tag: "BudgetExhausted"; readonly detail: string }
  | { readonly _tag: "MissingMe"; readonly detail: string }
  | { readonly _tag: "Unavailable"; readonly detail: string };

export type Truth =
  | { readonly _tag: "True" }
  | { readonly _tag: "False" }
  | { readonly _tag: "Incomplete"; readonly reason: IncompleteReason };

export const True: Truth = { _tag: "True" };
export const False: Truth = { _tag: "False" };

export const Incomplete = (reason: IncompleteReason): Truth => ({
  _tag: "Incomplete",
  reason,
});

export const isTrue = (truth: Truth): boolean => truth._tag === "True";
export const isFalse = (truth: Truth): boolean => truth._tag === "False";
export const isIncomplete = (
  truth: Truth,
): truth is { readonly _tag: "Incomplete"; readonly reason: IncompleteReason } =>
  truth._tag === "Incomplete";

/** Only True authorizes. Incomplete and False both deny. */
export const authorizes = (truth: Truth): boolean => truth._tag === "True";

export type JsonScalar = string | number | boolean | null;

/**
 * A projected cell. Absent is authoritative. Unavailable is incomplete.
 * These are never represented as JavaScript `undefined`.
 */
export type Projection =
  | { readonly _tag: "Present"; readonly value: JsonScalar }
  | { readonly _tag: "PresentMany"; readonly values: readonly JsonScalar[] }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unavailable"; readonly reason: IncompleteReason }
  | { readonly _tag: "Invalid"; readonly reason: IncompleteReason };

export const Present = (value: JsonScalar): Projection => ({
  _tag: "Present",
  value,
});

export const PresentMany = (values: readonly JsonScalar[]): Projection => ({
  _tag: "PresentMany",
  values,
});

export const Absent: Projection = { _tag: "Absent" };

export const Unavailable = (reason: IncompleteReason): Projection => ({
  _tag: "Unavailable",
  reason,
});

export const Invalid = (reason: IncompleteReason): Projection => ({
  _tag: "Invalid",
  reason,
});

export const projectionUnavailable = (projection: Projection): boolean =>
  projection._tag === "Unavailable" || projection._tag === "Invalid";
