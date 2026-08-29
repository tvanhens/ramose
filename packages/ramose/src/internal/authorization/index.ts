/**
 * Authorization identities, IR vocabulary, and catalog descriptors.
 *
 * Internal module. Not a public package export. Persisted and
 * boundary-crossing models are Effect Schema definitions; TypeScript
 * types are `typeof Model.Type`. Trust-boundary decode, encode,
 * canonicalization, and hashing reuse those same schemas. Catalog binding
 * (#384) resolves relative identities against one authoritative descriptor.
 * Semantic validation recomputes rule metadata from the bound expression.
 * Install assembles {@link InstalledAuthorizationIRV2} from that verified
 * path. Structural decode of {@link InstalledAuthorizationIR} is not
 * that brand. The read authoring language (#406) lowers to
 * {@link PolicyTemplateIR}; it is not a public `ramose` / `ramose/db`
 * export. Fail-closed until verified JWT (#412) and a deployed catalog.
 * #421 constructs the filtered `Db`; #423 runs query/pull/entity/ref/graph
 * through that value only. #415 recomputes and diffs that same one-shot
 * read under a short authorization lease.
 * Executable policy is authorization language v1.
 *
 * Contract: `src/internal/design/authorization.md`.
 */

export * from "./authoring/index.ts";
export * from "./bind.ts";
export * from "./bounds.ts";
export * from "./canonical-json.ts";
export * from "./catalog.ts";
export * from "./catalog-unit.ts";
export * from "./composition.ts";
export * from "./decode.ts";
export * from "./database-bindings.ts";
export * from "./deployed.ts";
export * from "./definitions.ts";
export * from "./expr.ts";
export * from "./failures.ts";
export * from "./graph-path.ts";
export * from "./graph-path-live.ts";
export * from "./identities.ts";
export * from "./install.ts";
export * from "./invocation-receipts.ts";
export * from "./ir.ts";
export * from "./json.ts";
export * from "./live.ts";
export * from "./operation-grant.ts";
export * from "./operations-runtime.ts";
export * from "./principal.ts";
export * from "./read-filter.ts";
export * from "./read-compatibility.ts";
export * from "./reads.ts";
export * from "./request.ts";
export * from "./truth.ts";
export * from "./validate.ts";
export * from "./version.ts";
