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
 * transport layers) lives in `ramose`.
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
 * // Advanced schemas: `Ramose.Field(schema)` still accepts a raw Effect Schema;
 * // wrap with `stored(schema, vt)` when inference cannot name `:db.type/*`.
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
  type AnyField,
  type FieldOptions,
  type ValueOf,
} from "./Field.ts";
export { Schema, type AnySchema } from "./Schema.ts";
export { Entity, type AnyEntity } from "./Entity.ts";
export { Trait, type AnyTrait } from "./Trait.ts";
export {
  Bytes,
  Instant,
  Long,
  Uuid,
  stored,
  type DbValueType,
} from "./valueTypes.ts";
// `Ramose.all(Todo)` — the wildcard pull, as a select shape, a nested
// `ref.select(all(N))`, or a pull pattern
export { all } from "./Pull.ts";
// `Ramose.again(n)` — re-apply the enclosing select on a self-ref, n hops
export { again } from "./Pull.ts";
// `Ramose.pick(User, "name", "age")` — same-entity field subset for a shape
export { pick } from "./Pull.ts";
// `Ramose.values(attr, { where, limit, offset })` — a card-many scalar
// collection with pull-phase constraints; refs take the same record in
// `.select(shape, opts)`
export { values, type NestedOpts, type ValuesField } from "./shapes.ts";
// ── the query language (fluent + kernel) ───────────────────────────────────
// `Q` is the kernel (fact, comparisons, or/not, projections); `Query` is
// the constructor. App spelling: `Query.from(Issue).where({…}).orderBy(…)`.
// `Query.q` remains the generator-tier constructor.
export { Q } from "./query/index.ts";
export * as Query from "./query/surface.ts";
export type {
  AnyQueryObject,
  Cursor,
  EntityRow,
  FluentQuery,
  RefIdCell,
  OpenResult,
  Page,
  Pipeline,
  QueryObject,
  Row,
  Rows,
  RuleValue,
} from "./query/index.ts";
export type { EidLike, Shape } from "./shapes.ts";

// ── connecting ─────────────────────────────────────────────────────────────
export {
  type Client,
  type ClientOptions,
  type ConnectionStatus,
  connect,
} from "./connect.ts";
export type { DatabasesShape } from "./client-shape.ts";
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
// entity / field name rule — definition-time, like DATABASE_NAME_RE
export {
  IDENT_NAME_RE,
  RESERVED_FIELD_KEYS,
  isIdentName,
  isReservedFieldKey,
} from "./IdentName.ts";

// ── the database ───────────────────────────────────────────────────────────
export type {
  Db,
  DbPrincipal,
  QueryError,
  ReadDb,
  TxReport,
} from "./Db.ts";
export type { InstallOptions, SchemaChange } from "./Errors.ts";
export type { SchemaEid, Eid } from "./Eid.ts";
export type { EntityRef, LookupRef } from "./idents.ts";
export { tempid, type Tempid } from "./entityArg.ts";
// the pattern-side types too, so pull helpers can accept exactly what
// `db.pull` accepts (type-only: the runtime surface is unchanged)
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
  checkOperationsCoverage,
  defineOperations,
  operationCards,
  operationNames,
  type AnyOperation,
  type AnyOperations,
  type DefinedOperations,
  type Op,
  type OpPrincipal,
  type OpReport,
  type OperationCard,
  type OperationEffectContext,
  type OperationInvocation,
} from "./Operation.ts";

// ── errors ─────────────────────────────────────────────────────────────────
export {
  DatabaseNotFound,
  type DbError,
  InternalError,
  InvalidRequest,
  isDatabaseError,
  NetworkError,
  NotOne,
  OperationRejected,
  OperationsCoverageError,
  IncompatibleSchema,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
