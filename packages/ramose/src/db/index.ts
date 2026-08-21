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
 * import * as Schema from "effect/Schema";
 *
 * export const Todo = Ramose.Namespace("todo", {
 *   title: Ramose.Attr(Schema.String),
 *   done: Ramose.Attr(Schema.Boolean),
 * });
 * export const Todos = Ramose.Catalog({ todo: Todo });
 *
 * const ramose = Ramose.connect({ url, token });
 * export const db = ramose.db("todos", Todos);
 * // Effect users: `Ramose.layer({ url, token })` is the same client as a
 * // scoped Layer<Databases>.
 * ```
 */

// ── schema ─────────────────────────────────────────────────────────────────
export { Attr, type Attribute } from "./Attribute.ts";
export { Catalog } from "./Catalog.ts";
export { Namespace } from "./Namespace.ts";
export { Bytes, Instant, Long, Ref, Uuid, UuidString } from "./valueTypes.ts";
export {
  avg,
  count,
  countDistinct,
  max,
  min,
  not,
  or,
  query,
  sum,
  when,
} from "./NavQuery.ts";
// `Ramose.all(Todo)` — the wildcard pull, as a select shape, a nested
// `ref.select(all(N))`, or a pull pattern
export { all } from "./Pull.ts";
// `Ramose.again(n)` — re-apply the enclosing select on a self-ref, n hops
export { again } from "./Pull.ts";
// value holes: declare with `params`, mark unbound-ok with `optional`,
// gate clauses with `when`
export { optional, params } from "./Params.ts";
export type {
  Agg,
  AggRow,
  AggShape,
  Cursor,
  EidLike,
  GroupedAggQuery,
  GroupedNavQueryBuilder,
  GroupedRow,
  GroupShape,
  HavingCells,
  HavingNav,
  NavQuery,
  NavQueryBuilder,
  Not,
  Or,
  Page,
  Predicate,
  Row,
  Rows,
  Shape,
  When,
  WhereNode,
} from "./NavQuery.ts";
export type { Param, ParamBindings, ParamsOf } from "./Params.ts";

// ── connecting ─────────────────────────────────────────────────────────────
export {
  type Client,
  type ClientOptions,
  connect,
  Databases,
  layer,
} from "./Databases.ts";
export type { ByteStore } from "./persist.ts";
export { type Claims, token, type TokenSource } from "./token.ts";
// the peer's database-name rule, so an app can validate a user-minted name
// (multi-tenant "create workspace") before the peer does — not a slugify
export { DATABASE_NAME_RE, isDatabaseName } from "./DatabaseName.ts";

// ── the database ───────────────────────────────────────────────────────────
export type {
  Db,
  DbPrincipal,
  QueryError,
  QueryInput,
  ReadDb,
  TxReport,
} from "./Db.ts";
export type { CatalogEid, Eid } from "./Eid.ts";
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
export type { Entity, Tx } from "./Tx.ts";

// ── errors ─────────────────────────────────────────────────────────────────
export {
  DatabaseNotFound,
  type DbError,
  InternalError,
  InvalidRequest,
  NetworkError,
  NotOne,
  ParamError,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
