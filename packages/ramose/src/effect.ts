/**
 * `ramose/effect` — the Effect modules Ramose's own API hands you, under one
 * import.
 *
 * Ramose's calls return Effect values, so a stack file needs `Effect` and
 * `Layer`, a schema file needs `Schema`, and a live query outside React is a
 * `Stream`. Naming them the ecosystem way — `import * as Effect from
 * "effect/Effect"` — is correct and is what the docs show: `effect` is a
 * dependency of `ramose`, so it is in the tree either way. This subpath exists
 * for the two cases where that import does not resolve on its own — a resolver
 * that refuses undeclared dependencies (pnpm without hoisting, Yarn PnP), and
 * a reader who would rather name one package than two:
 *
 * ```typescript
 * import { Effect, Layer, Schema, Redacted, pipe } from "ramose/effect";
 * ```
 *
 * These are re-exports, not copies: the module instances and every type
 * identity are `effect`'s own, so the two spellings are interchangeable in the
 * same file and across a package boundary. Anything not re-exported here is
 * still reachable as `effect/<Module>`. `pipe` and `Redacted` live here as
 * well — this subpath is the Effect escape hatch, not the app path.
 *
 * @module
 */

export * as Cause from "effect/Cause";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
export * as Layer from "effect/Layer";
export * as Redacted from "effect/Redacted";
export * as Schema from "effect/Schema";
export * as Stream from "effect/Stream";
export { pipe } from "effect/Function";
