/**
 * `Query.from(Entity)` — the primary app spelling.
 *
 * Thin wrappers over the existing immutable pipeline AST. Stage functions
 * stay one tier down for the generator/kernel path; this chain is the
 * hoistable, serializable value `db.query` / `useLive` run.
 */

import type { Eid } from "../Eid.ts";
import type { AnyEntity } from "../Entity.ts";
import {
  isParam,
  type AnyParam,
  type AnyParamSet,
  type ParamsSpec,
  type ScopeOf,
} from "../Params.ts";
import type { AttrValue, OrderDir, OrderEmpty, PathCarrier, SelectResult, Shape, ValidShape } from "../shapes.ts";
import {
  entities,
  ids as idsStage,
  is,
  limit as limitStage,
  offset as offsetStage,
  orderBy as orderByStage,
  paramsOfStage,
  select as selectStage,
  type FilterStage,
  type IdRow,
} from "./lib.ts";
import { makeQueryObject, type Cursor, type Pipeline, type QueryObject } from "./query.ts";

// ── default row ─────────────────────────────────────────────────────────────

type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;
type IsRef<A> = A extends { readonly valueType: "ref" } ? true : false;

/** A ref under the default shape: an `{ id }` Eid cell, never auto-nested. */
export type RefIdCell = { readonly id: number };

/**
 * The row a select-less fluent query yields: friendly keys, refs as
 * `{ id }` cells, optional card-one fields (`| undefined`), card-many as
 * arrays. Not `all(N)` / `[*]` — lowering expands `N.fields` into this shape.
 */
export type EntityRow<N extends AnyEntity> = {
  readonly id: Eid<N>;
} & {
  readonly [K in keyof N["fields"]]: IsMany<N["fields"][K]> extends true
    ? IsRef<N["fields"][K]> extends true
      ? readonly RefIdCell[]
      : readonly AttrValue<N["fields"][K]>[]
    : IsRef<N["fields"][K]> extends true
      ? RefIdCell | undefined
      : AttrValue<N["fields"][K]> | undefined;
};

/** Expand `N.fields` into the pull shape the default row serializes as. */
export const entityShape = (ns: AnyEntity): Shape => {
  const out: Record<string, unknown> = { id: ns.id };
  for (const [key, field] of Object.entries(ns.fields)) {
    const f = field as {
      readonly valueType?: string;
      readonly cardinality?: string;
      readonly select: (shape: Shape) => { readonly optional: unknown };
      readonly optional: unknown;
    };
    if (f.valueType === "ref") {
      const nested = f.select({ id: ns.id });
      out[key] = f.cardinality === "many" ? nested : nested.optional;
    } else {
      out[key] = f.cardinality === "many" ? field : f.optional;
    }
  }
  return out as Shape;
};

const withDefaultShape = (pipe: Pipeline): Pipeline => {
  if (pipe.stages.some((s) => s.kind === "select" || s.kind === "ids")) return pipe;
  return selectStage(entityShape(pipe.ns))(pipe);
};

// ── where object ────────────────────────────────────────────────────────────

/** Covariant in `T` so `Param<Eid<N>>` is accepted where a number/ref is. */
type ParamLike<T> = { readonly _tag: "Param"; readonly _type?: T };

type EqValue<A> = IsRef<A> extends true
  ? AttrValue<A> | { readonly id: number } | ParamLike<AttrValue<A>> | ParamLike<Eid<AnyEntity>>
  : AttrValue<A> | ParamLike<AttrValue<A>>;

/**
 * Object-literal equality filters. Keys are the entity's fields (plus `id`);
 * a wrong key or value type is a compile error.
 */
export type WhereEq<N extends AnyEntity> = {
  readonly [K in keyof N["fields"]]?: EqValue<N["fields"][K]>;
} & {
  readonly id?: Eid<N> | number | { readonly id: number } | Param<Eid<N>, any, boolean> | Param<number, any, boolean>;
};

type ScopeOfWhere<W> = ScopeOf<W[keyof W]>;

/** Accumulate `ScopeOf` from a value; foreign-set tokens collapse to `never`. */
export type MergeScope<PB, V> = [ScopeOf<V>] extends [never]
  ? PB
  : [PB] extends [never]
    ? ScopeOf<V>
    : [ScopeOf<V>] extends [PB]
      ? [PB] extends [ScopeOf<V>]
        ? PB
        : never
      : never;

type ForeignSet = {
  readonly "ramose/query": "this param belongs to a different set than the query is scoped to";
};

type CompatibleWhere<PB, W> = [ScopeOfWhere<W>] extends [never]
  ? W
  : [PB] extends [never]
    ? W
    : [ScopeOfWhere<W>] extends [PB]
      ? [PB] extends [ScopeOfWhere<W>]
        ? W
        : ForeignSet
      : ForeignSet;

type CompatibleValue<PB, V> = [ScopeOf<V>] extends [never]
  ? V
  : [PB] extends [never]
    ? V
    : [ScopeOf<V>] extends [PB]
      ? [PB] extends [ScopeOf<V>]
        ? V
        : ForeignSet
      : ForeignSet;

// ── param set ───────────────────────────────────────────────────────────────

const setOf = (p: AnyParam): AnyParamSet => p.set as AnyParamSet;

const adoptParam = (current: AnyParamSet | undefined, p: AnyParam): AnyParamSet => {
  const set = setOf(p);
  if (current === undefined || current === set) return set;
  if (current[p.key] !== p) {
    throw new Error(
      `ramose/params: the param "${p.key}" belongs to a different set than the one this query is scoped to`,
    );
  }
  return current;
};

const adoptValue = (current: AnyParamSet | undefined, value: unknown): AnyParamSet | undefined => {
  if (isParam(value)) return adoptParam(current, value);
  if (typeof value === "function") {
    let next = current;
    for (const p of paramsOfStage(value)) next = adoptParam(next, p);
    return next;
  }
  return current;
};

const specFromSet = (set: AnyParamSet | undefined): ParamsSpec | undefined => {
  if (set === undefined) return undefined;
  const spec: Record<string, { readonly Type: unknown }> = {};
  for (const key of Object.keys(set)) spec[key] = { Type: undefined };
  return spec;
};

const applyEq = (pipe: Pipeline, ns: AnyEntity, eq: Record<string, unknown>): Pipeline => {
  let next = pipe;
  for (const [key, value] of Object.entries(eq)) {
    const attr = key === "id" ? ns.id : ns.fields[key];
    if (attr === undefined) {
      throw new Error(`ramose/query: where({ ${key} }) — "${ns.ns}" has no field "${key}"`);
    }
    next = is(attr, value as never)(next);
  }
  return next;
};

const applyStages = (pipe: Pipeline, stages: readonly FilterStage[]): Pipeline => {
  let next = pipe;
  for (const stage of stages) next = stage(next);
  return next;
};

// ── the fluent query ────────────────────────────────────────────────────────

/**
 * A closed query that still accepts chain methods. Immutable: each call
 * returns a new value, hoistable at module scope exactly as `Query.q` is.
 */
export interface FluentQuery<
  N extends AnyEntity = AnyEntity,
  Row = unknown,
  PB = never,
  Out = readonly Row[],
> extends QueryObject<Row, PB, Out> {
  /**
   * Conjunction of equality filters, keys typechecked from the entity's
   * fields; or one-or-more stage fragments (`Query.some`, `Query.matching`, …).
   */
  where<const W extends WhereEq<N>>(
    eq: W & CompatibleWhere<PB, W>,
  ): FluentQuery<N, Row, MergeScope<PB, W[keyof W]>, Out>;
  where(...stages: readonly FilterStage[]): FluentQuery<N, Row, PB, Out>;

  /** Narrow / reshape the row. Without this, the default is the full entity. */
  select<const S extends Shape>(
    shape: S & ValidShape<S>,
  ): FluentQuery<N, SelectResult<S>, PB>;

  orderBy(
    key: string | PathCarrier,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): FluentQuery<N, Row, PB, Out>;

  limit<V extends number | AnyParam>(
    n: V & CompatibleValue<PB, V>,
  ): FluentQuery<N, Row, MergeScope<PB, V>, Out>;

  offset<V extends number | AnyParam>(
    n: V & CompatibleValue<PB, V>,
  ): FluentQuery<N, Row, MergeScope<PB, V>, Out>;

  /**
   * Id-only projection — today's cheap live-subscription workhorse.
   * Default-full-entity widens invalidation; `.select` / `.ids` are the levers.
   */
  ids(): FluentQuery<N, IdRow, PB>;
}

const makeFluent = <N extends AnyEntity, Row, PB>(
  ns: N,
  pipe: Pipeline,
  paramSet: AnyParamSet | undefined,
  stripCursor: boolean,
  take?: "one" | "oneOrFail",
  seek?: Cursor | null,
): FluentQuery<N, Row, PB> => {
  const qv = makeQueryObject<Row, PB>(
    specFromSet(paramSet),
    paramSet,
    () => withDefaultShape(pipe),
    stripCursor,
    take,
    seek,
  );
  const next = (
    nextPipe: Pipeline,
    nextSet: AnyParamSet | undefined = paramSet,
  ): FluentQuery<N, any, any> => makeFluent(ns, nextPipe, nextSet, stripCursor, take, seek);

  const fluent = qv as FluentQuery<N, Row, PB>;
  fluent.where = ((arg: WhereEq<N> | FilterStage, ...rest: FilterStage[]) => {
    if (typeof arg === "function") {
      const stages = [arg, ...rest];
      let set = paramSet;
      for (const stage of stages) set = adoptValue(set, stage);
      return next(applyStages(pipe, stages), set);
    }
    const eq = arg as Record<string, unknown>;
    let set = paramSet;
    for (const value of Object.values(eq)) set = adoptValue(set, value);
    return next(applyEq(pipe, ns, eq), set);
  }) as FluentQuery<N, Row, PB>["where"];
  fluent.select = ((shape: Shape & ValidShape<Shape>) =>
    next(selectStage(shape)(pipe))) as FluentQuery<N, Row, PB>["select"];
  fluent.orderBy = (key, dir, opts) => next(orderByStage(key, dir, opts)(pipe));
  fluent.limit = ((n: number | AnyParam) =>
    next(limitStage(n)(pipe), adoptValue(paramSet, n))) as FluentQuery<N, Row, PB>["limit"];
  fluent.offset = ((n: number | AnyParam) =>
    next(offsetStage(n)(pipe), adoptValue(paramSet, n))) as FluentQuery<N, Row, PB>["offset"];
  fluent.ids = () => makeFluent(ns, idsStage()(pipe), paramSet, stripCursor, take, seek);
  // terminals stay on the same object so `.where(…).one()` typechecks
  const baseOne = qv.one.bind(qv);
  const baseFail = qv.oneOrFail.bind(qv);
  const baseAfter = qv.after.bind(qv);
  const baseLogic = qv.logic.bind(qv);
  fluent.one = () => {
    const taken = baseOne();
    return makeFluent(ns, pipe, paramSet, taken.stripCursor, taken.take, taken.seek) as never;
  };
  fluent.oneOrFail = () => {
    const taken = baseFail();
    return makeFluent(ns, pipe, paramSet, taken.stripCursor, taken.take, taken.seek) as never;
  };
  fluent.after = (cursor) => {
    const paged = baseAfter(cursor);
    return makeFluent(ns, pipe, paramSet, paged.stripCursor, paged.take, paged.seek) as never;
  };
  fluent.logic = () => makeFluent(ns, pipe, paramSet, true) as never;
  return fluent;
};

/**
 * Start a fluent query at an entity. Select-less, the row is the full
 * entity (friendly keys); `.select` narrows, `.ids` keeps today's id-only
 * cheap subscription. Hoist the result at module scope.
 */
export const from = <N extends AnyEntity>(ns: N): FluentQuery<N, EntityRow<N>, never> => {
  if (typeof ns !== "object" || ns === null || (ns as { _tag?: unknown })._tag !== "Entity") {
    throw new Error("ramose/query: Query.from(...) takes an entity");
  }
  return makeFluent(ns, entities(ns), undefined, false);
};
