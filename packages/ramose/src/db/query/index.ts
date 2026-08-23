/**
 * The query language: kernel (`Q`), constructor and composition (`Query`),
 * the fluent app spelling (`Query.from`), and the pipeable stdlib. One
 * kind of object — every query is a rule — with two advanced spellings
 * (pipe, generator) under the fluent chain.
 */

export {
  Q,
  isVar,
  mkVar,
  runBody,
  type AnyCommand,
  type AnyVar,
  type AttrLike,
  type BClause,
  type BuildCtx,
  type Cell,
  type CellRecord,
  type FactHandle,
  type Fragment,
  type Projection,
  type PullSpec,
  type QueryGen,
  type RowOfProjection,
  type RowsSpec,
  type Var,
} from "./kernel.ts";

export {
  enrich,
  isCursor,
  isPipeline,
  isQueryObject,
  isRuleValue,
  lowerQueryAst,
  lowerQueryObject,
  q,
  refine,
  rule,
  type AnyQueryObject,
  type Cursor,
  type LoweredKernelQuery,
  type OpenArgs,
  type OpenResult,
  type Page,
  type Pipeline,
  type PipeStage,
  type QueryBody,
  type QueryObject,
  type Row,
  type Rows,
  type RuleValue,
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
  type FilterStage,
  type IdRow,
  type TraversalStage,
} from "./lib.ts";
