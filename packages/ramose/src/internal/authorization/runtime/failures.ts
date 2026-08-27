/**
 * Narrow tagged failures for the #338 capability boundaries.
 *
 * Inner services fail with these tags (diagnostics). The one outer
 * deny/close boundary maps every incomplete or missing-wiring path to
 * payload-free {@link AuthorizationDenied} (FC-1, FC-2, AUTH-5).
 *
 * @internal
 */

import * as Data from "effect/Data";
import type {
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  IncompleteReason,
  IncompleteRuleSnapshot,
  InvalidIR,
  LeaseExpired,
} from "../failures.ts";
import type { CatalogId, OperationId } from "../identities.ts";

export {
  AuthorizationDenied,
  type AuthorizationFailure,
  type IncompleteReason,
} from "../failures.ts";

export class RawStorageUnavailable extends Data.TaggedError("RawStorageUnavailable")<{
  readonly message: string;
}> {}

export class RuleSnapshotUnavailable extends Data.TaggedError("RuleSnapshotUnavailable")<{
  readonly message: string;
  readonly reason?: IncompleteReason;
}> {}

export class ApplicationSnapshotUnavailable extends Data.TaggedError(
  "ApplicationSnapshotUnavailable",
)<{
  readonly message: string;
}> {}

export class CatalogOperationNotFound extends Data.TaggedError("CatalogOperationNotFound")<{
  readonly catalog: CatalogId;
  readonly operation: OperationId;
}> {}

export class AuthenticationRejected extends Data.TaggedError("AuthenticationRejected")<{
  readonly message: string;
}> {}

export class SnapshotCancelled extends Data.TaggedError("SnapshotCancelled")<{
  readonly message: string;
}> {}

export {
  AuthorizationBudgetExceeded,
  CatalogMismatch,
  IncompleteRuleSnapshot,
  InvalidIR,
  LeaseExpired,
} from "../failures.ts";

export type RawStorageFailure = RawStorageUnavailable;
export type RuleSnapshotFailure =
  | RuleSnapshotUnavailable
  | IncompleteRuleSnapshot
  | AuthorizationBudgetExceeded
  | LeaseExpired
  | CatalogMismatch
  | InvalidIR
  | SnapshotCancelled;
export type ApplicationSnapshotFailure =
  | ApplicationSnapshotUnavailable
  | CatalogMismatch
  | InvalidIR
  | LeaseExpired
  | SnapshotCancelled;
export type CatalogOperationFailure = CatalogOperationNotFound;
export type AuthenticationAdmissionFailure = AuthenticationRejected;

export type CapabilityFailure =
  | RawStorageFailure
  | RuleSnapshotFailure
  | ApplicationSnapshotFailure
  | CatalogOperationFailure
  | AuthenticationAdmissionFailure;
