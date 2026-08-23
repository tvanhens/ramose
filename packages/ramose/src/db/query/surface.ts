/**
 * `Ramose.Query` — the query language's named surface. `Query.from` is the
 * primary app spelling; `Query.q` is the generator/kernel constructor;
 * `Query.rule` names; the stdlib combinators stay one tier down. (`Ramose.Q`
 * is the kernel.)
 */

export { enrich, isCursor, q, refine, rule } from "./query.ts";
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
} from "./query.ts";

export { from } from "./fluent.ts";
export type { EntityRow, FluentQuery, RefIdCell, WhereEq } from "./fluent.ts";

export {
  assertedBy,
  backlink,
  byId,
  entities,
  every,
  follow,
  has,
  ids,
  is,
  limit,
  matching,
  missing,
  none,
  offset,
  orderBy,
  select,
  some,
  stage,
  updatedSince,
  when,
} from "./lib.ts";
export type { FilterStage, IdRow, TraversalStage } from "./lib.ts";

export type { Fragment, QueryGen, Var } from "./kernel.ts";
