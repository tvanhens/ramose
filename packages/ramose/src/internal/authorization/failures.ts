/**
 * Typed authorization failures and incompleteness reasons.
 *
 * Effect classes for orchestration; one fail-closed boundary.
 */

import * as Data from "effect/Data";
import type {
  CatalogId,
  CatalogUnitHash,
  CatalogVersion,
  DatabaseId,
  SchemaFingerprint,
} from "./identities.ts";

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

/** Catalog, schema fingerprint, version, or database does not match the IR. */
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

/** Evaluation or projection exceeded the explicit work budget. */
export class AuthorizationBudgetExceeded extends Data.TaggedError(
  "AuthorizationBudgetExceeded",
)<{
  readonly message: string;
  readonly spent: number;
  readonly limit: number;
}> {}

/**
 * Fail-closed denial. MUST NOT reveal whether protected data exists (FC-1).
 * No payload — a later HTTP mapper must emit a fixed denial, not resource
 * or policy details. Diagnostics stay on the internal failure that caused this.
 */
export class AuthorizationDenied extends Data.TaggedError(
  "AuthorizationDenied",
) {}

export type AuthorizationFailure =
  | InvalidIR
  | CatalogMismatch
  | AuthorizationBudgetExceeded
  | AuthorizationDenied;

/**
 * Catalog-unit bytes failed hash, decode, or completeness checks.
 * Not an authorization-evaluation failure.
 */
export class CatalogUnitCorrupt extends Data.TaggedError("CatalogUnitCorrupt")<{
  readonly message: string;
  readonly catalog: CatalogId;
}> {}

/**
 * Requested unit hash is not the currently deployed unit.
 * Internal diagnostic only — not an {@link AuthorizationFailure}.
 * Later HTTP mappers collapse this to opaque {@link import("../../db/Errors.ts").Unauthorized}.
 */
export class CatalogVersionMismatch extends Data.TaggedError("CatalogVersionMismatch")<{
  readonly catalog: CatalogId;
  readonly expected?: CatalogUnitHash;
  readonly actual?: CatalogUnitHash;
}> {}
