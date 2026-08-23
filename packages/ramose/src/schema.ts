/**
 * `ramose/schema` — `effect/Schema`, re-exported.
 *
 * App schemas use the value shorthands on `ramose/db` (`Ramose.string()`,
 * `Ramose.Enum([...])`, …) and do not import this module. This subpath is
 * the advanced hatch: custom Effect Schemas, operation codecs, and
 * resolvers that refuse undeclared dependencies (pnpm without hoisting,
 * Yarn PnP).
 *
 * ```typescript
 * import * as Schema from "ramose/schema";   // === effect/Schema
 * import { Field } from "ramose/db";
 * const title = Field(Schema.String);
 * ```
 *
 * It is a re-export, not a copy: the module instance and every type identity
 * are `effect/Schema`'s own, so the two spellings are interchangeable in the
 * same file and across a package boundary.
 *
 * @module
 */

export * from "effect/Schema";
