/**
 * Authorization principal model.
 *
 * The verified JWT subject always exists. `me` is an optional application
 * entity resolved through an optional catalog-configured unique field.
 * Claims and classes are explicit. Empty class vocabularies are allowed.
 *
 * Core v1 claims are scalars or one-dimensional arrays of scalars.
 * Recursive struct / nested-array claim shapes fail Schema decoding.
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

/** One-dimensional array of scalar claims. Nested arrays are not v1. */
export const ClaimArrayShape = Schema.TaggedStruct("array", { items: ClaimScalarShape });
export type ClaimArrayShape = typeof ClaimArrayShape.Type;

export const ClaimShape = Schema.Union([ClaimScalarShape, ClaimArrayShape]);
export type ClaimShape = typeof ClaimShape.Type;

const uniqueKeys = (kind: string) =>
  Schema.makeFilter((fields: ReadonlyArray<{ readonly key: string }>) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) return `duplicate ${kind} key '${field.key}'`;
      seen.add(field.key);
    }
    return undefined;
  });

const ClaimKey = Schema.String.check(
  Schema.makeFilter((key) => (key.length === 0 ? "blank claim key" : undefined)),
);

export const ClaimDescriptor = Schema.Struct({
  key: ClaimKey,
  optional: Schema.Boolean,
  shape: ClaimShape,
});
export type ClaimDescriptor = typeof ClaimDescriptor.Type;

/** JWT subject claim name. The verified subject always exists. */
export const SubjectClaim = Schema.String.check(
  Schema.makeFilter((key) => (key.length === 0 ? "blank principal subject claim" : undefined)),
);
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
  eid: Schema.Finite,
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

const ClassName = Schema.String.check(
  Schema.makeFilter((name) => (name.length === 0 ? "blank class name" : undefined)),
);

/** Declared class names. Empty is allowed. Names must be unique. */
export const ClassVocabulary = Schema.Array(ClassName).check(
  Schema.makeFilter((classes: ReadonlyArray<string>) => {
    const seen = new Set<string>();
    for (const name of classes) {
      if (seen.has(name)) return `duplicate class '${name}'`;
      seen.add(name);
    }
    return undefined;
  }),
);
export type ClassVocabulary = typeof ClassVocabulary.Type;

/** Declared claims with shapes. Empty is allowed. Keys alone are not enough. */
export const ClaimVocabulary = Schema.Array(ClaimDescriptor).check(uniqueKeys("claim"));
export type ClaimVocabulary = typeof ClaimVocabulary.Type;
