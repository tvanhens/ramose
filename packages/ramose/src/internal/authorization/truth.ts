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

export type ProjectedScalar = string | number | boolean | null;

export type ProjectedAtom = string | number | boolean | Date | Uint8Array;
export type ProjectedValue = ProjectedAtom | readonly ProjectedAtom[];

export type Present<T = ProjectedValue> = [undefined] extends [T]
  ? never
  : {
      readonly _tag: "Present";
      readonly value: T;
    };

export type FieldAbsent = { readonly _tag: "FieldAbsent" };

export type EntityAbsent = { readonly _tag: "EntityAbsent" };

export type NotLoadedProjection = { readonly _tag: "NotLoaded" };

export type InvalidTraversalProjection = { readonly _tag: "InvalidTraversal" };

export type BudgetExhaustedProjection = { readonly _tag: "BudgetExhausted" };

export type MissingMeProjection = { readonly _tag: "MissingMe" };

export type Projected<T = ProjectedValue> =
  | Present<T>
  | FieldAbsent
  | EntityAbsent
  | NotLoadedProjection
  | InvalidTraversalProjection
  | BudgetExhaustedProjection
  | MissingMeProjection;

export type CompleteProjected<T = ProjectedValue> =
  | Present<T>
  | FieldAbsent
  | EntityAbsent;

export type IncompleteProjected =
  | NotLoadedProjection
  | InvalidTraversalProjection
  | BudgetExhaustedProjection
  | MissingMeProjection;

export const Present = <T = ProjectedValue>(
  value: [undefined] extends [T] ? never : T,
): Present<T> => {
  if (value === undefined) {
    throw new TypeError("ramose/authorization: Present cannot hold undefined");
  }
  return { _tag: "Present", value } as Present<T>;
};

export const FieldAbsent: FieldAbsent = { _tag: "FieldAbsent" };
export const EntityAbsent: EntityAbsent = { _tag: "EntityAbsent" };
export const NotLoadedProjection: NotLoadedProjection = { _tag: "NotLoaded" };
export const InvalidTraversalProjection: InvalidTraversalProjection = {
  _tag: "InvalidTraversal",
};
export const BudgetExhaustedProjection: BudgetExhaustedProjection = {
  _tag: "BudgetExhausted",
};
export const MissingMeProjection: MissingMeProjection = { _tag: "MissingMe" };
