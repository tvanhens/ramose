import { Q, type QueryGen } from "./kernel.ts";
import { q, rule as defineRule, type Pipeline, type RuleValue } from "./query.ts";

export type QueryBuilder = typeof Q;

/** Build a portable query from typed relational clauses and a projection. */
export const build = <B extends (query: QueryBuilder) => QueryGen<any> | Pipeline<any>>(
  body: B,
): ReturnType<typeof q<() => ReturnType<B>>> =>
  q(() => body(Q)) as ReturnType<typeof q<() => ReturnType<B>>>;

/** Declare a reusable relational rule using the same query builder. */
export const rule = (
  name: string,
  body: (query: QueryBuilder, ...vars: never[]) => QueryGen<unknown>,
): RuleValue => {
  const apply = (...vars: never[]) => body(Q, ...vars);
  Object.defineProperty(apply, "length", { value: Math.max(0, body.length - 1) });
  return defineRule(name, apply);
};

export { isCursor } from "./query.ts";
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
