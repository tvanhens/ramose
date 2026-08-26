/**
 * Typed authorization failures and incompleteness reasons.
 *
 * Effect classes for the orchestration shell. The pure evaluator (#337 later)
 * returns {@link import("./truth.ts").Truth}; these failures surface at the
 * one fail-closed boundary (FC-1, FC-2). Do not scatter deny-catching.
 */

import * as Data from "effect/Data";
import type { CatalogId, CatalogVersion } from "./identities.ts";

/**
 * Why a three-valued result is Incomplete — never JavaScript `undefined`.
 * Authoritative absence is a complete projection ({@link import("./truth.ts").Projected}),
 * not an incompleteness reason.
 */
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

/** Template or installed IR failed structural or semantic checks. */
export class InvalidIR extends Data.TaggedError("InvalidIR")<{
  readonly message: string;
}> {}

/** Catalog, schema fingerprint, or version does not match the IR. */
export class CatalogMismatch extends Data.TaggedError("CatalogMismatch")<{
  readonly message: string;
  readonly expected?: CatalogId;
  readonly actual?: CatalogId;
  readonly expectedVersion?: CatalogVersion;
  readonly actualVersion?: CatalogVersion;
}> {}

/** A required rule projection could not be completed. */
export class IncompleteRuleSnapshot extends Data.TaggedError("IncompleteRuleSnapshot")<{
  readonly message: string;
  readonly reason: IncompleteReason;
}> {}

/** Evaluation or projection exceeded the explicit work budget. */
export class AuthorizationBudgetExceeded extends Data.TaggedError(
  "AuthorizationBudgetExceeded",
)<{
  readonly message: string;
  readonly spent: number;
  readonly limit: number;
}> {}

/** REV-5: no result may be emitted under an expired lease. */
export class LeaseExpired extends Data.TaggedError("LeaseExpired")<{
  readonly message: string;
}> {}

/**
 * Fail-closed denial. MUST NOT reveal whether protected data exists (FC-1).
 * No payload — a later HTTP mapper must emit a fixed denial, not resource
 * or policy details. Diagnostics stay on the internal failure that caused this.
 */
export class AuthorizationDenied extends Data.TaggedError("AuthorizationDenied") {}

export type AuthorizationFailure =
  | InvalidIR
  | CatalogMismatch
  | IncompleteRuleSnapshot
  | AuthorizationBudgetExceeded
  | LeaseExpired
  | AuthorizationDenied;
