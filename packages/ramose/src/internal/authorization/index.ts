/**
 * Authorization identities, IR vocabulary, and catalog descriptors.
 *
 * Internal module. Not a public package export. Persisted and
 * boundary-crossing models are Effect Schema definitions; TypeScript
 * types are `typeof Model.Type`. Trust-boundary decode, encode,
 * canonicalization, and hashing reuse those same schemas. Catalog binding
 * (#384) resolves relative identities against one authoritative descriptor.
 * Semantic validation recomputes rule metadata from the bound expression.
 * Install assembles {@link InstalledAuthorizationIRV1} from that verified
 * path. Structural decode of {@link InstalledAuthorizationIR} is not
 * that brand. Fail-closed until verified JWT (#412), an installed catalog,
 * and a filtered `Db` (#421/#423). Executable policy is authorization language v1.
 *
 * Contract: `src/internal/design/authorization.md`.
 */

export * from "./bind.ts";
export * from "./bounds.ts";
export * from "./canonical-json.ts";
export * from "./catalog.ts";
export * from "./decode.ts";
export * from "./expr.ts";
export * from "./failures.ts";
export * from "./identities.ts";
export * from "./install.ts";
export * from "./ir.ts";
export * from "./json.ts";
export * from "./principal.ts";
export * from "./truth.ts";
export * from "./validate.ts";
export * from "./version.ts";
