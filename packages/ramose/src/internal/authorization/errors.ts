/** Typed authorization failures. One fail-closed boundary maps these to deny. */

import * as Data from "effect/Data";

export class InvalidTemplate extends Data.TaggedError("InvalidTemplate")<{
  readonly message: string;
  readonly path?: string;
}> {}

export class InvalidInstalledIR extends Data.TaggedError("InvalidInstalledIR")<{
  readonly message: string;
  readonly path?: string;
}> {}

export class CatalogMismatch extends Data.TaggedError("CatalogMismatch")<{
  readonly message: string;
  readonly catalogId?: string;
  readonly catalogVersion?: string;
}> {}

export class IncompleteRuleSnapshot extends Data.TaggedError(
  "IncompleteRuleSnapshot",
)<{
  readonly message: string;
  readonly detail?: string;
}> {}

export class AuthorizationBudgetExceeded extends Data.TaggedError(
  "AuthorizationBudgetExceeded",
)<{
  readonly message: string;
}> {}

export class LeaseExpired extends Data.TaggedError("LeaseExpired")<{
  readonly message: string;
  readonly expiresAt?: number;
}> {}

export class AuthorizationDenied extends Data.TaggedError("AuthorizationDenied")<{
  readonly message: string;
}> {}

export class HashFailure extends Data.TaggedError("HashFailure")<{
  readonly message: string;
}> {}

export class RuleIdentityCollision extends Data.TaggedError(
  "RuleIdentityCollision",
)<{
  readonly message: string;
  readonly ruleId: string;
}> {}

export type AuthorizationFailure =
  | InvalidTemplate
  | InvalidInstalledIR
  | CatalogMismatch
  | IncompleteRuleSnapshot
  | AuthorizationBudgetExceeded
  | LeaseExpired
  | AuthorizationDenied
  | HashFailure
  | RuleIdentityCollision;
