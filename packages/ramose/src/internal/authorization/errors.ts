/**
 * Typed authorization failures. One outer fail-closed boundary maps
 * these to deny/close. Do not `catchAll(() => Deny)` at inner layers.
 */

import * as Data from "effect/Data";

export class InvalidIR extends Data.TaggedError("InvalidIR")<{
  readonly reason: string;
}> {}

export class CatalogMismatch extends Data.TaggedError("CatalogMismatch")<{
  readonly reason: string;
}> {}

export class IncompleteRuleSnapshot extends Data.TaggedError("IncompleteRuleSnapshot")<{
  readonly reason: string;
}> {}

export class AuthorizationBudgetExceeded extends Data.TaggedError("AuthorizationBudgetExceeded")<{
  readonly reason: string;
}> {}

export class LeaseExpired extends Data.TaggedError("LeaseExpired")<{
  readonly reason: string;
}> {}

export class AuthorizationDenied extends Data.TaggedError("AuthorizationDenied")<{
  readonly reason: string;
}> {}

export type AuthorizationFailure =
  | InvalidIR
  | CatalogMismatch
  | IncompleteRuleSnapshot
  | AuthorizationBudgetExceeded
  | LeaseExpired
  | AuthorizationDenied;
