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

import * as Schema from "effect/Schema";
import { EntityId, FieldId, RelativeFieldId } from "./identities.ts";
import { JsonValue } from "./json.ts";

/** JWT JSON scalar a declared claim may hold. */
export const ClaimScalarType = Schema.Literals(["string", "long", "double", "boolean"]);
export type ClaimScalarType = typeof ClaimScalarType.Type;

export const ClaimScalarShape = Schema.TaggedStruct("scalar", { valueType: ClaimScalarType });
export type ClaimScalarShape = typeof ClaimScalarShape.Type;

export const ClaimOpaqueShape = Schema.TaggedStruct("opaque", {});
export type ClaimOpaqueShape = typeof ClaimOpaqueShape.Type;

/**
 * Authoritative shape of one declared claim. Nested arrays/structs stay
 * intact so the binder can check `teams: Schema.Array(Schema.String)`.
 *
 * Recursive types exist only to break the inference cycle. The Schema
 * annotations check those types against the runtime models.
 */
export type ClaimDescriptor = {
  readonly key: string;
  readonly optional: boolean;
  readonly shape: ClaimShape;
};

export type ClaimShape =
  | ClaimScalarShape
  | ClaimOpaqueShape
  | { readonly _tag: "struct"; readonly fields: ReadonlyArray<ClaimDescriptor> }
  | { readonly _tag: "array"; readonly items: ClaimShape };

export const ClaimDescriptor: Schema.Schema<ClaimDescriptor> = Schema.Struct({
  key: Schema.String,
  optional: Schema.Boolean,
  shape: Schema.suspend(() => ClaimShape),
});

export const ClaimShape: Schema.Schema<ClaimShape> = Schema.Union([
  ClaimScalarShape,
  Schema.TaggedStruct("struct", { fields: Schema.Array(ClaimDescriptor) }),
  Schema.TaggedStruct("array", { items: Schema.suspend(() => ClaimShape) }),
  ClaimOpaqueShape,
]);

/** JWT subject claim name. The verified subject always exists. */
export const SubjectClaim = Schema.String;
export type SubjectClaim = typeof SubjectClaim.Type;

/**
 * How the principal is resolved: subject always, application row optional.
 *
 * Conceptually `{ subjectClaim: "sub", entity?: User.authId }`.
 */
export const PrincipalResolutionConfig = Schema.Struct({
  subjectClaim: SubjectClaim,
  /** Optional unique field used to resolve `me`. Absent = no application row. */
  entity: Schema.optionalKey(RelativeFieldId),
});
export type PrincipalResolutionConfig = typeof PrincipalResolutionConfig.Type;

export const InstalledPrincipalResolution = Schema.Struct({
  subjectClaim: SubjectClaim,
  entity: Schema.optionalKey(FieldId),
});
export type InstalledPrincipalResolution = typeof InstalledPrincipalResolution.Type;

export const ApplicationEntityRef = Schema.Struct({
  entity: EntityId,
  eid: Schema.Number,
});
export type ApplicationEntityRef = typeof ApplicationEntityRef.Type;

/**
 * Runtime authorization principal. `subject` is mandatory. `me` is
 * optional so service JWTs work without an application principal row.
 * A rule that reads `me` evaluates Incomplete/deny when no row resolves.
 */
export const AuthorizationPrincipal = Schema.Struct({
  subject: Schema.String,
  me: Schema.optionalKey(ApplicationEntityRef),
  claims: Schema.Record(Schema.String, JsonValue),
  classes: Schema.Array(Schema.String),
});
export type AuthorizationPrincipal = typeof AuthorizationPrincipal.Type;

/** Declared class names. Empty is allowed. */
export const ClassVocabulary = Schema.Array(Schema.String);
export type ClassVocabulary = typeof ClassVocabulary.Type;

/** Declared claims with shapes. Empty is allowed. Keys alone are not enough. */
export const ClaimVocabulary = Schema.Array(ClaimDescriptor);
export type ClaimVocabulary = typeof ClaimVocabulary.Type;
