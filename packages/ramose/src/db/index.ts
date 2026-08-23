/**
 * `ramose/db` — the portable half of Ramose.
 *
 * Schema, connecting, the database and the tagged errors, in one flat
 * namespace: `import * as Ramose from "ramose/db"`. It runs in a
 * browser, in a Worker, in Node/Bun and in a test.
 *
 * **Nothing reachable from this module imports `alchemy`** (the deploy engine)
 * or the engine barrel (`src/internal/core/index.ts`) — that is what makes it
 * browser-safe without a
 * bundler alias, and `test/db-portable.test.ts` fails the build if it ever
 * stops being true. The deploy-time surface (`Server`, the capability, the
 * transport layers, `Policy`) lives in `ramose`.
 *
 * ```typescript
 * import * as Ramose from "ramose/db";
 *
 * export const Todo = Ramose.Entity("todo", {
 *   title: Ramose.string(),
 *   done: Ramose.boolean(),
 *   createdAt: Ramose.timestamp(),
 * });
 * export const Todos = Ramose.Schema({ todo: Todo });
 *
 * const ramose = Ramose.connect({ url, token });
 * export const db = ramose.db("todos", Todos);
 * // Effect users: `db.effect.query` / `import { layer } from "ramose/db/effect"`.
 * // Advanced schemas: `Ramose.Field(schema)` still accepts a raw Effect Schema.
 * ```
 */

// ── schema ─────────────────────────────────────────────────────────────────
export {
  Enum,
  Field,
  Ref,
  boolean,
  bytes,
  float,
  int,
  string,
  timestamp,
  uuid,
} from "./Field.ts";
export { Schema } from "./Schema.ts";
export { Entity } from "./Entity.ts";
export { Bytes, Instant, Long, Uuid, UuidString } from "./valueTypes.ts";
// `Ramose.all(Todo)` — the wildcard pull, as a select shape, a nested
// `ref.select(all(N))`, or a pull pattern
export { all } from "./Pull.ts";
// `Ramose.again(n)` — re-apply the enclosing select on a self-ref, n hops
export { again } from "./Pull.ts";
// `Ramose.values(attr, { where, limit, offset })` — a card-many scalar
// collection with pull-phase constraints; refs take the same record in
// `.select(shape, opts)`
export { values, type NestedOpts, type ValuesField } from "./shapes.ts";
// value holes: declare with `params`, mark unbound-ok with `optional`,
// gate clauses with `when`; `EidOf(N)` declares an entity-valued hole
export { EidOf, optional, params } from "./Params.ts";

// ── the query language (kernel + pipe surface) ─────────────────────────────
// `Q` is the kernel (fact, comparisons, or/not, projections); `Query` is
// the constructor, named rules, transformers and the pipeable stdlib —
// `Ramose.Query.q({...}, (p) => pipe(Query.entities(Issue), ...))`. The
// same names are importable flat from `ramose/query`.
export { Q } from "./query/index.ts";
export * as Query from "./query/surface.ts";
export type {
  AnyQueryObject,
  Cursor,
  OpenArgs,
  OpenResult,
  Page,
  Pipeline,
  QueryObject,
  Row,
  Rows,
  RuleValue,
} from "./query/index.ts";
export type { EidLike, Shape } from "./shapes.ts";
export type { Param, ParamBindings, ParamsOf } from "./Params.ts";

// ── connecting ─────────────────────────────────────────────────────────────
export {
  type Client,
  type ClientOptions,
  connect,
} from "./connect.ts";
export {
  type Claims,
  token,
  type TokenInput,
  type TokenSource,
} from "./token.ts";
export type { Subscription } from "./subscription.ts";
// the peer's database-name rule, so an app can validate a user-minted name
// (multi-tenant "create workspace") before the peer does — not a slugify
export { DATABASE_NAME_RE, isDatabaseName } from "./DatabaseName.ts";

// ── the database ───────────────────────────────────────────────────────────
export type {
  Db,
  DbPrincipal,
  QueryError,
  ReadDb,
  TxReport,
} from "./Db.ts";
export type { SchemaEid, Eid } from "./Eid.ts";
export type { LookupRef } from "./idents.ts";
// the pattern-side types too, so `ramose/react`'s `usePull` can accept
// exactly what `db.pull` accepts (type-only: the runtime surface is unchanged)
export type {
  Again,
  AllRow,
  AllShape,
  IdentPullPattern,
  Pull,
  RecurDepth,
  RecurStub,
  ValidatePull,
} from "./Pull.ts";

// ── operations ─────────────────────────────────────────────────────────────
export {
  EntityId,
  Operation,
  Operations,
  PrefixHalt,
  type AnyOperation,
  type AnyOperations,
  type Op,
  type OpPrincipal,
  type OpReport,
  type OperationEffectContext,
  type OperationInvocation,
} from "./Operation.ts";

// ── errors ─────────────────────────────────────────────────────────────────
export {
  DatabaseNotFound,
  type DbError,
  InternalError,
  InvalidRequest,
  NetworkError,
  NotOne,
  OperationRejected,
  ParamError,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
