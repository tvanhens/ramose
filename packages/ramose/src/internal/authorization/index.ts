/**
 * Authorization identities, IR vocabulary, and catalog descriptors.
 *
 * Internal module. Not a public package export. Persisted and
 * boundary-crossing models are Effect Schema definitions; TypeScript
 * types are `typeof Model.Type`. Trust-boundary decode, encode,
 * canonicalization, and hashing reuse those same schemas. Runtime
 * enforcement (#343) will import installed types from here without
 * importing authoring.
 *
 * Contract: `src/internal/design/authorization.md`.
 */

export * from "./bounds.ts";
export * from "./catalog.ts";
export * from "./decode.ts";
export * from "./expr.ts";
export * from "./failures.ts";
export * from "./identities.ts";
export * from "./ir.ts";
export * from "./json.ts";
export * from "./principal.ts";
export * from "./truth.ts";
