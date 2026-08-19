/**
 * `ramose/schema` — `effect/Schema`, re-exported.
 *
 * Ramose's field types are Effect schemas, so every schema file needs
 * `Schema`. Writing `import * as Schema from "effect/Schema"` is correct and
 * is what the docs show: `effect` is a dependency of `ramose`, so it is in the
 * tree either way. This subpath exists for the two cases where that import
 * does not resolve on its own — a resolver that refuses undeclared
 * dependencies (pnpm without hoisting, Yarn PnP), and a reader who would
 * rather name one package than two:
 *
 * ```typescript
 * import * as Schema from "ramose/schema";   // === effect/Schema
 * ```
 *
 * It is a re-export, not a copy: the module instance and every type identity
 * are `effect/Schema`'s own, so the two spellings are interchangeable in the
 * same file and across a package boundary.
 *
 * @module
 */

export * from "effect/Schema";
