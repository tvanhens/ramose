import * as Data from "effect/Data";
import type {
  CatalogId,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  SchemaFingerprint,
} from "./identities.ts";

export type IncompleteReason =
  | { readonly _tag: "NotLoaded" }
  | { readonly _tag: "InvalidTraversal" }
  | { readonly _tag: "BudgetExhausted" }
  | { readonly _tag: "MissingMe" };

export const NotLoaded = { _tag: "NotLoaded" } as const satisfies IncompleteReason;
export const InvalidTraversal = {
  _tag: "InvalidTraversal",
} as const satisfies IncompleteReason;
export const BudgetExhausted = {
  _tag: "BudgetExhausted",
} as const satisfies IncompleteReason;
export const MissingMe = { _tag: "MissingMe" } as const satisfies IncompleteReason;

export class InvalidIR extends Data.TaggedError("InvalidIR")<{
  readonly message: string;
}> {}

export class CatalogMismatch extends Data.TaggedError("CatalogMismatch")<{
  readonly message: string;
  readonly expected?: CatalogId;
  readonly actual?: CatalogId;
  readonly expectedVersion?: CatalogVersion;
  readonly actualVersion?: CatalogVersion;
  readonly expectedFingerprint?: SchemaFingerprint;
  readonly actualFingerprint?: SchemaFingerprint;
  readonly expectedDatabase?: DatabaseId;
  readonly actualDatabase?: DatabaseId;
}> {}

export class AuthorizationBudgetExceeded extends Data.TaggedError(
  "AuthorizationBudgetExceeded",
)<{
  readonly message: string;
  readonly spent: number;
  readonly limit: number;
}> {}

export class AuthorizationDenied extends Data.TaggedError(
  "AuthorizationDenied",
) {}

export type AuthorizationFailure =
  | InvalidIR
  | CatalogMismatch
  | AuthorizationBudgetExceeded
  | AuthorizationDenied;

export class CatalogUnitCorrupt extends Data.TaggedError("CatalogUnitCorrupt")<{
  readonly message: string;
  readonly catalog: CatalogId;
}> {}

export class CatalogVersionMismatch extends Data.TaggedError("CatalogVersionMismatch")<{
  readonly catalog: CatalogId;
  readonly expected?: CatalogUnitHash;
  readonly actual?: CatalogUnitHash;
}> {}
