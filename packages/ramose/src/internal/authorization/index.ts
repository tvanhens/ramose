/**
 * Authorization identities, IR vocabulary, and catalog descriptors.
 *
 * Internal module. Not a public package export. Persisted and
 * boundary-crossing models are Effect Schema definitions; TypeScript
 * types are `typeof Model.Type`. Trust-boundary decode, encode,
 * canonicalization, and hashing reuse those same schemas. Catalog binding
 * (#384) resolves relative identities against one authoritative descriptor.
 * Semantic validation (#385) recomputes rule metadata from the bound
 * expression. Access-plan derivation and installed-IR assembly produce the
 * sealed artifact runtime accepts. Runtime enforcement (#343) will import
 * installed types from here without importing authoring.
 *
 * Contract: `src/internal/design/authorization.md`.
 */

export * from "./assemble.ts";
export * from "./bind.ts";
export * from "./bounds.ts";
export * from "./canonical-json.ts";
export * from "./catalog.ts";
export * from "./decode.ts";
export * from "./digest.ts";
export * from "./expr.ts";
export * from "./failures.ts";
export * from "./identities.ts";
export * from "./ir.ts";
export * from "./json.ts";
export * from "./principal.ts";
export * from "./truth.ts";
export * from "./validate.ts";
