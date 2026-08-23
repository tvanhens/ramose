/**
 * `Ramose.Query` — the query language's named surface. `Query.q` builds,
 * `Query.rule` names, the stdlib combinators pipe, and `Query.enrich` /
 * `Query.refine` transform closed queries. (`Ramose.Q` is the kernel.)
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

export {
  assertedBy,
  backlink,
  byId,
  entities,
  every,
  follow,
  has,
  is,
  limit,
  missing,
  none,
  offset,
  orderBy,
  select,
  some,
  stage,
  updatedSince,
  when,
  where,
} from "./lib.ts";
export type { FilterStage, IdRow, TraversalStage } from "./lib.ts";

export type { Fragment, QueryGen, Var } from "./kernel.ts";
