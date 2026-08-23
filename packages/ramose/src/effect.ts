/**
 * `ramose/effect` — the Effect modules Ramose's own API hands you, under one
 * import.
 *
 * App code on `ramose/db` and `ramose/react` is promise-first. This subpath
 * re-exports Effect's own modules for deploy files and for callers of
 * `db.effect.*` / `ramose/db/effect`. Naming them the ecosystem way —
 * `import * as Effect from "effect/Effect"` — is correct: `effect` is a
 * dependency of `ramose`, so it is in the tree either way. This subpath exists
 * for the two cases where that import does not resolve on its own — a resolver
 * that refuses undeclared dependencies (pnpm without hoisting, Yarn PnP), and
 * a reader who would rather name one package than two:
 *
 * ```typescript
 * import { Effect, Function, Layer, Schema, Redacted, pipe } from "ramose/effect";
 * ```
 *
 * These are re-exports, not copies: the module instances and every type
 * identity are `effect`'s own, so the two spellings are interchangeable in the
 * same file and across a package boundary. Anything not re-exported here is
 * still reachable as `effect/<Module>`. This subpath is the Effect escape
 * hatch, not the app path — `ramose/db` and `ramose/react` stay
 * promise-first.
 *
 * @module
 */

export * as Cause from "effect/Cause";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
export * as Function from "effect/Function";
export * as Layer from "effect/Layer";
export * as Redacted from "effect/Redacted";
export * as Schema from "effect/Schema";
export * as Stream from "effect/Stream";
export { pipe } from "effect/Function";
/** Hatch-only unwrap: Promise rejects with the tagged error, not a FiberFailure. */
export { runPromise } from "./db/promise.ts";
