/**
 * Authorization identities, IR vocabulary, and catalog descriptors.
 *
 * Internal module. Not a public package export. Later #337 slices add
 * decoding, binding, the authoring API, and the evaluator on top of these
 * types. Runtime enforcement (#343) will import installed types from here
 * without importing authoring.
 *
 * Contract: `src/internal/design/authorization.md`.
 */

export * from "./bounds.ts";
export * from "./catalog.ts";
export * from "./expr.ts";
export * from "./failures.ts";
export * from "./identities.ts";
export * from "./ir.ts";
export * from "./json.ts";
export * from "./principal.ts";
export * from "./truth.ts";
