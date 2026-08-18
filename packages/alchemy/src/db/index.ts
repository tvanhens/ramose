/**
 * `@ripple/alchemy/db` — the portable half of Ripple.
 *
 * Schema, connecting, the database and the tagged errors, in one flat
 * namespace: `import * as Ripple from "@ripple/alchemy/db"`. It runs in a
 * browser, in a Worker, in Node/Bun and in a test.
 *
 * **Nothing reachable from this module imports `alchemy`** (the deploy engine)
 * or the `@ripple/core` barrel — that is what makes it browser-safe without a
 * bundler alias, and `test/db-portable.test.ts` fails the build if it ever
 * stops being true. The deploy-time surface (`Server`, the capability, the
 * transport layers, `Policy`) lives in `@ripple/alchemy`.
 *
 * ```typescript
 * import * as Ripple from "@ripple/alchemy/db";
 * import * as ManagedRuntime from "effect/ManagedRuntime";
 * import * as Schema from "effect/Schema";
 *
 * export const Todo = Ripple.Namespace("todo", {
 *   title: Ripple.Attr(Schema.String),
 *   done: Ripple.Attr(Schema.Boolean),
 * });
 * export const Todos = Ripple.Catalog({ todo: Todo });
 *
 * const runtime = ManagedRuntime.make(Ripple.layer({ url, token }));
 * export const db = runtime.runSync(Ripple.Databases).db("todos", Todos);
 * ```
 */

// ── schema ─────────────────────────────────────────────────────────────────
export { Attr, type Attribute } from "./Attribute.ts";
export { Catalog } from "./Catalog.ts";
export { Namespace } from "./Namespace.ts";
export { Bytes, Instant, Long, Ref, Uuid, UuidString } from "./valueTypes.ts";
export { not, or, query } from "./NavQuery.ts";
export type {
  EidLike,
  NavQuery,
  NavQueryBuilder,
  Not,
  Or,
  Predicate,
  Shape,
  WhereNode,
} from "./NavQuery.ts";

// ── connecting ─────────────────────────────────────────────────────────────
export { type ClientOptions, Databases, layer } from "./Databases.ts";

// ── the database ───────────────────────────────────────────────────────────
export type { Db, ReadDb, TxReport } from "./Db.ts";
export type { Eid } from "./Eid.ts";
export type { LookupRef } from "./idents.ts";
export type { Pull } from "./Pull.ts";
export type { Entity, Tx } from "./Tx.ts";

// ── errors ─────────────────────────────────────────────────────────────────
export {
  DatabaseNotFound,
  type DbError,
  InternalError,
  InvalidRequest,
  NetworkError,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
