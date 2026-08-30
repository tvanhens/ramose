/**
 * `ramose/db` — the portable half of Ramose.
 *
 * Schema, query, operation, and transaction authoring in one flat
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
 * // Advanced schemas: `Ramose.Field(schema)` accepts a raw Effect Schema;
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
  type CreationDefault,
  type CreationDefaultContext,
  type CreationDefaultInputs,
  type ImmutableCreationDefaultInputs,
  creationDefault,
  type FieldOptions,
  type ValueOf,
} from "./Field.ts";
export {
  type BindableTrait,
  type BindingDefaults,
  type BindingValues,
  type CodeDefinition,
  type CodeDefinitionRef,
  type TraitBinding,
  type TraitBindingSpec,
} from "./Binding.ts";
export {
  assertNoFixedValues,
  compositionValueMetadata,
  resolveCreationValues,
  BindingConflictError,
  CreationValueError,
} from "./creation.ts";
export {
  collectCodeReachability,
  ReachabilityConflictError,
  type CodeReachability,
} from "./reachability.ts";
export { Schema, type AnySchema } from "./Schema.ts";
export { Entity, type AnyEntity } from "./Entity.ts";
export { Trait, type AnyTrait } from "./Trait.ts";
export { Graph } from "./Graph.ts";
export type { AnyComposer } from "./Composer.ts";
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
// `QueryDocument` is the portable plain-data query representation: the
// versioned grammar, its JSON Schema, the deterministic compiler onto the
// query language above, and the function-registry seam. Transport free —
// a wire envelope refers to it; it refers to no transport.
export * as QueryDocument from "./query/document/index.ts";
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
  OwnedOperations,
  checkOperationsCoverage,
  defineOperations,
  operationCards,
  operationNames,
  type AnyOperation,
  type AnyOperations,
  type DefinedOperations,
  type Op,
  type OpPrincipal,
  type OperationCard,
  type OperationEffectContext,
} from "./Operation.ts";

// ── errors ─────────────────────────────────────────────────────────────────
export {
  DatabaseNotFound,
  type DbError,
  InternalError,
  InvalidRequest,
  isDatabaseError,
  NotOne,
  OperationRejected,
  OperationsCoverageError,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
