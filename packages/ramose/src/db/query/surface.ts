/**
 * `Ramose.Query` — the query language's named surface. `Query.from` is the
 * primary app spelling; `Query.q` is the generator/kernel constructor;
 * `Query.rule` names; the stdlib combinators stay one tier down. (`Ramose.Q`
 * is the kernel.)
 */

export { decodeCursor, encodeCursor } from "./cursor.ts";
export { enrich, isCursor, q, refine, rule } from "./query.ts";
export type {
  AnyQueryObject,
  Cursor,
  OpenResult,
  Page,
  Pipeline,
  QueryObject,
  Row,
  Rows,
  RuleValue,
} from "./query.ts";

export { from } from "./fluent.ts";
export type { EntityRow, FluentQuery, RefIdCell, WhereEq } from "./fluent.ts";

export {
  any,
  assertedBy,
  backlink,
  byId,
  entities,
  every,
  follow,
  gt,
  gte,
  has,
  ids,
  includes,
  is,
  limit,
  lt,
  lte,
  matching,
  missing,
  none,
  not,
  offset,
  orderBy,
  select,
  some,
  stage,
  startsWith,
  updatedSince,
} from "./lib.ts";
export type { FilterStage, FollowStage, HatchIdRow, IdRow, TraversalStage } from "./lib.ts";

export type { Fragment, QueryGen, Var } from "./kernel.ts";
