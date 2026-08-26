/**
 * Authorization principal model.
 *
 * The verified JWT subject always exists. `me` is an optional application
 * entity resolved through an optional catalog-configured unique field.
 * Claims and classes are explicit. Empty class vocabularies are allowed.
 *
 * No API key, shared secret, anonymous principal, configured-admin bypass,
 * or `RAMOSE_TOKEN` exists in this model (AUTH-1).
 */

import type { EntityId, FieldId, RelativeFieldId } from "./identities.ts";
import type { JsonValue } from "./json.ts";

/** JWT JSON scalar a declared claim may hold. */
export type ClaimScalarType = "string" | "long" | "double" | "boolean";

/**
 * Authoritative shape of one declared claim. Nested arrays/structs stay
 * intact so the binder can check `teams: Schema.Array(Schema.String)`.
 */
export type ClaimShape =
  | { readonly _tag: "scalar"; readonly valueType: ClaimScalarType }
  | { readonly _tag: "struct"; readonly fields: readonly ClaimDescriptor[] }
  | { readonly _tag: "array"; readonly items: ClaimShape }
  | { readonly _tag: "opaque" };

export type ClaimDescriptor = {
  readonly key: string;
  readonly optional: boolean;
  readonly shape: ClaimShape;
};

/** JWT subject claim name. The verified subject always exists. */
export type SubjectClaim = string;

/**
 * How the principal is resolved: subject always, application row optional.
 *
 * Conceptually `{ subjectClaim: "sub", entity?: User.authId }`.
 */
export type PrincipalResolutionConfig = {
  readonly subjectClaim: SubjectClaim;
  /** Optional unique field used to resolve `me`. Absent = no application row. */
  readonly entity?: RelativeFieldId;
};

export type InstalledPrincipalResolution = {
  readonly subjectClaim: SubjectClaim;
  readonly entity?: FieldId;
};

export type ApplicationEntityRef = {
  readonly entity: EntityId;
  readonly eid: number;
};

/**
 * Runtime authorization principal. `subject` is mandatory. `me` is
 * optional so service JWTs work without an application principal row.
 * A rule that reads `me` evaluates Incomplete/deny when no row resolves.
 */
export type AuthorizationPrincipal = {
  readonly subject: string;
  readonly me?: ApplicationEntityRef;
  readonly claims: Readonly<Record<string, JsonValue>>;
  readonly classes: readonly string[];
};

/** Declared class names. Empty is allowed. */
export type ClassVocabulary = readonly string[];

/** Declared claims with shapes. Empty is allowed. Keys alone are not enough. */
export type ClaimVocabulary = readonly ClaimDescriptor[];
