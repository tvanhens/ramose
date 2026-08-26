/**
 * `Query.from(Entity | Trait)` — the primary app spelling.
 *
 * Thin wrappers over the existing immutable pipeline AST. Stage functions
 * stay one tier down for the generator/kernel path; this chain is the
 * serializable value `db.query` / `useLive` run. Changing values go in
 * `.where` as literals.
 */

import type { Eid } from "../Eid.ts";
import type { AnyEntity, AnyQueryRoot } from "../Entity.ts";
import type { FocusAttr } from "./focus.ts";
import type {
  AttrValue,
  FocusShape,
  OrderDir,
  OrderEmpty,
  PathCarrier,
  SelectResult,
  Shape,
  ValidShape,
} from "../shapes.ts";
import {
  entities,
  ids as idsStage,
  is,
  limit as limitStage,
  offset as offsetStage,
  select as selectStage,
  type IdRow,
} from "./lib.ts";
import {
  type AggSpec,
  type CellRecord,
  type EidCell,
  type Var,
} from "./kernel.ts";
import {
  makeQueryObject,
  type Cursor,
  type Pipeline,
  type QueryObject,
  type QueryOrder,
  type QueryOrderKey,
} from "./query.ts";

// ── default row ─────────────────────────────────────────────────────────────

type IsMany<A> = A extends { readonly cardinality: "many" } ? true : false;
type IsRef<A> = A extends { readonly valueType: "ref" } ? true : false;
type IsOptional<A> = A extends { readonly isOptional: true }
  ? true
  : undefined extends AttrValue<A>
    ? true
    : false;

/** Instant is a branded `Date`; the app row is the friendly `Date`. */
type FriendlyScalar<T> = T extends Date ? Date : T;

/**
 * The entity a `Ref(Issue)` field points at. Self-refs resolve to the
 * enclosing entity. Untargeted refs stay `AnyEntity`.
 */
type RefTarget<A, Enclosing extends AnyQueryRoot> = A extends {
  readonly schema: { readonly _target?: infer T };
}
  ? [T] extends [AnyQueryRoot]
    ? T
    : Enclosing
  : AnyEntity;

/**
 * A ref under the default shape: an `{ id }` cell branded with the
 * *target* entity, never auto-nested. `Comment.issue` → `{ id: Eid<Issue> }`.
 */
export type RefIdCell<N extends AnyQueryRoot = AnyEntity> = {
  readonly id: Eid<N>;
};

type ScalarRow<A, Enclosing extends AnyQueryRoot> = IsRef<A> extends true
  ? RefIdCell<RefTarget<A, Enclosing>>
  : FriendlyScalar<Exclude<AttrValue<A>, undefined>>;

type FieldRow<A, Enclosing extends AnyQueryRoot> = IsMany<A> extends true
  ? readonly ScalarRow<A, Enclosing>[]
  : IsOptional<A> extends true
    ? ScalarRow<A, Enclosing> | undefined
    : ScalarRow<A, Enclosing>;

/**
 * The row a select-less fluent query yields: friendly keys, refs as
 * `{ id: Eid<Target> }` cells. `| undefined` only on optional fields;
 * required scalars stay required. Card-many are arrays. Not `all(N)` /
 * `[*]` — lowering expands `N.fields` into this shape.
 */
export type EntityRow<N extends AnyQueryRoot> = {
  readonly id: Eid<N>;
} & {
  readonly [K in keyof N["fields"]]: FieldRow<N["fields"][K], N>;
};

/** Expand `N.fields` into the pull shape the default row serializes as. */
const entityId = (ns: AnyQueryRoot): PathCarrier =>
  (ns as AnyQueryRoot & { readonly id: PathCarrier }).id;

/** The entity or trait `Ref(Issue)` / `Ref(Taggable)` was declared against. */
const refTargetEntity = (
  field: { readonly schema?: unknown },
  source: AnyQueryRoot,
): AnyQueryRoot => {
  const schema = field.schema as
    | { readonly _resolve?: () => unknown; readonly _self?: boolean }
    | undefined;
  if (schema?._self === true) return source;
  const resolve = schema?._resolve;
  if (typeof resolve !== "function") return source;
  const target = resolve();
  if (
    typeof target === "object" &&
    target !== null &&
    ((target as { _tag?: unknown })._tag === "Entity" ||
      (target as { _tag?: unknown })._tag === "Trait")
  ) {
    return target as AnyQueryRoot;
  }
  return source;
};

/**
 * Expand `N.fields` into the pull shape. Card-one fields are `.optional` at
 * runtime so a missing fact does not drop the row; {@link EntityRow} still
 * types required scalars as required (optimistic about presence).
 */
export const entityShape = (ns: AnyQueryRoot): Shape => {
  const sourceId = entityId(ns);
  const out: Record<string, unknown> = { id: sourceId };
  for (const [key, field] of Object.entries(ns.fields)) {
    const f = field as unknown as {
      readonly valueType?: string;
      readonly cardinality?: string;
      readonly schema?: unknown;
      readonly select: (shape: Shape) => { readonly optional: unknown };
      readonly optional: unknown;
    };
    if (f.valueType === "ref") {
      const nested = f.select({ id: entityId(refTargetEntity(f, ns)) });
      out[key] = f.cardinality === "many" ? nested : nested.optional;
    } else {
      out[key] = f.cardinality === "many" ? field : f.optional;
    }
  }
  return out as Shape;
};

/** Insert the default select *before* orderBy/limit/offset so string keys resolve. */
const withDefaultShape = (pipe: Pipeline): Pipeline => {
  if (pipe.stages.some((s) => s.kind === "select" || s.kind === "ids")) return pipe;
  const idx = pipe.stages.findIndex(
    (s) => s.kind === "orderBy" || s.kind === "limit" || s.kind === "offset",
  );
  const head = idx === -1 ? pipe : { ...pipe, stages: pipe.stages.slice(0, idx) };
  const next = selectStage(entityShape(pipe.ns))(head as never);
  return idx === -1 ? next : { ...next, stages: [...next.stages, ...pipe.stages.slice(idx)] };
};

// ── where object ────────────────────────────────────────────────────────────

type EqValue<A> = IsRef<A> extends true
  ? AttrValue<A> | { readonly id: number }
  : AttrValue<A>;

/**
 * Object-literal equality filters. Keys are the entity's fields (plus `id`);
 * a wrong key or value type is a compile error.
 */
export type WhereEq<N extends AnyQueryRoot> = {
  readonly [K in keyof N["fields"]]?: EqValue<N["fields"][K]>;
} & {
  readonly id?: Eid<N> | number | { readonly id: number };
};

/**
 * Equality clauses `applyEq` just appended — used to peel a trailing run of
 * them so chained `.where({ done }).where({ rank })` re-sorts with the new
 * keys. A fragment in between is left in place.
 */
const EQ_CLAUSE = new WeakMap<object, { readonly key: string; readonly value: unknown }>();

const applyEq = (pipe: Pipeline, ns: AnyQueryRoot, eq: Record<string, unknown>): Pipeline => {
  const kept = [...pipe.stages];
  const prior: { key: string; value: unknown }[] = [];
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    const clause = EQ_CLAUSE.get(last);
    if (clause === undefined) break;
    kept.pop();
    prior.unshift(clause);
  }
  const added = Object.keys(eq).map((key) => ({ key, value: eq[key] }));
  const all = [...prior, ...added].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  let next: Pipeline = kept.length === pipe.stages.length ? pipe : { ...pipe, stages: kept };
  for (const { key, value } of all) {
    const attr = key === "id" ? entityId(ns) : ns.fields[key];
    if (attr === undefined) {
      throw new Error(`ramose/query: where({ ${key} }) — "${ns.ns}" has no field "${key}"`);
    }
    next = (is(attr, value as never) as unknown as (q: Pipeline) => Pipeline)(next);
    EQ_CLAUSE.set(next.stages[next.stages.length - 1]!, { key, value });
  }
  return next;
};

const applyStages = (
  pipe: Pipeline,
  stages: ReadonlyArray<(q: Pipeline) => Pipeline>,
): Pipeline => {
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
  N extends AnyQueryRoot = AnyEntity,
  Row = unknown,
  Out = readonly Row[],
> extends QueryObject<Row, Out> {
  /**
   * Conjunction of equality filters, keys typechecked from the entity's
   * fields; or one-or-more stage fragments (`Query.some`, `Query.any`,
   * `Query.gt`, `Query.matching`, …).
   */
  where<const W extends WhereEq<N>>(eq: W): FluentQuery<N, Row, Out>;
  where(
    ...stages: ReadonlyArray<(q: Pipeline<Row, N>) => Pipeline<Row, N>>
  ): FluentQuery<N, Row, Out>;

  /** Narrow / reshape the row. Without this, the default is the full entity.
   * A second argument adds aggregate cells beside the shape. */
  select<const S extends Shape>(
    shape: S & ValidShape<S> & FocusShape<N, S>,
  ): FluentQuery<N, SelectResult<S>>;
  select<const S extends Shape, const Extra>(
    shape: S & ValidShape<S> & FocusShape<N, S>,
    extra: (e: Var<EidCell>) => Extra & { readonly [K in keyof Extra]: AggSpec<any> },
  ): FluentQuery<N, SelectResult<S> & { readonly [K in keyof Extra]: Extra[K] extends AggSpec<infer T> ? T : never }>;
  select<const S extends Shape, const Extra>(
    shape: S & ValidShape<S> & FocusShape<N, S>,
    extra: Extra & { readonly [K in keyof Extra]: AggSpec<any> },
  ): FluentQuery<N, SelectResult<S> & { readonly [K in keyof Extra]: Extra[K] extends AggSpec<infer T> ? T : never }>;

  orderBy(
    key: QueryOrderKey<Row> | FocusAttr<N>,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): FluentQuery<N, Row, Out>;

  limit(n: number): FluentQuery<N, Row, Out>;

  offset(n: number): FluentQuery<N, Row, Out>;

  /**
   * Id-only projection — today's cheap live-subscription workhorse.
   * Default-full-entity widens invalidation; `.select` / `.ids` are the levers.
   */
  ids(): FluentQuery<N, IdRow<N>>;
}

const makeFluent = <N extends AnyQueryRoot, Row>(
  ns: N,
  pipe: Pipeline,
  stripCursor: boolean,
  take?: "one" | "oneOrFail",
  seek?: Cursor | null,
  orders: readonly QueryOrder[] = [],
  limitN?: number,
  offsetN?: number,
): FluentQuery<N, Row> => {
  const qv = makeQueryObject<Row>(
    () => withDefaultShape(pipe),
    stripCursor,
    take,
    seek,
    orders,
    limitN,
    offsetN,
  );
  const next = (nextPipe: Pipeline): FluentQuery<N, any> =>
    makeFluent(ns, nextPipe, stripCursor, take, seek, orders, limitN, offsetN);

  const fluent = qv as FluentQuery<N, Row>;
  fluent.where = ((
    arg: WhereEq<N> | ((q: Pipeline) => Pipeline),
    ...rest: Array<(q: Pipeline) => Pipeline>
  ) => {
    if (arg === undefined && rest.length === 0) {
      throw new Error(
        "ramose/query: where() takes an equality object or one or more filter stages",
      );
    }
    if (typeof arg === "function") {
      return next(applyStages(pipe, [arg, ...rest]));
    }
    return next(applyEq(pipe, ns, arg as Record<string, unknown>));
  }) as FluentQuery<N, Row>["where"];
  fluent.select = ((shape: Shape & ValidShape<Shape>, extra?: CellRecord | ((e: Var<EidCell>) => CellRecord)) =>
    extra === undefined
      ? next(selectStage(shape)(pipe as never))
      : next(selectStage(shape, extra as never)(pipe as never))) as FluentQuery<N, Row>["select"];
  fluent.orderBy = (key, dir, opts) =>
    makeFluent(ns, pipe, stripCursor, take, seek, [
      ...orders,
      { key, dir: dir ?? "asc", empty: opts?.empty ?? "last" },
    ], limitN, offsetN);
  fluent.limit = ((n: number) => next(limitStage(n)(pipe as never))) as FluentQuery<N, Row>["limit"];
  fluent.offset = ((n: number) => next(offsetStage(n)(pipe as never))) as FluentQuery<N, Row>["offset"];
  fluent.ids = () => makeFluent(ns, idsStage()(pipe as never), stripCursor, take, seek, orders, limitN, offsetN);
  // terminals stay on the same object so `.where(…).one()` typechecks
  const baseOne = qv.one.bind(qv);
  const baseFail = qv.oneOrFail.bind(qv);
  const baseAfter = qv.after.bind(qv);
  fluent.one = () => {
    const taken = baseOne();
    return makeFluent(ns, pipe, taken.stripCursor, taken.take, taken.seek, taken.orders, taken.limitN, taken.offsetN) as never;
  };
  fluent.oneOrFail = () => {
    const taken = baseFail();
    return makeFluent(ns, pipe, taken.stripCursor, taken.take, taken.seek, taken.orders, taken.limitN, taken.offsetN) as never;
  };
  fluent.after = (cursor) => {
    const paged = baseAfter(cursor);
    return makeFluent(ns, pipe, paged.stripCursor, paged.take, paged.seek, paged.orders, paged.limitN, paged.offsetN) as never;
  };
  fluent.logic = () => makeFluent(ns, pipe, true) as never;
  return fluent;
};

/**
 * Start a fluent query at an entity or a trait. Select-less, the row is
 * the full focus (friendly keys); a trait root exposes id and trait
 * fields. `.select` narrows, `.ids` keeps today's id-only cheap
 * subscription. Put changing values in `.where` — two independently
 * built queries with the same literals share a live subscription.
 */
export const from = <N extends AnyQueryRoot>(ns: N): FluentQuery<N, EntityRow<N>> => {
  if (typeof ns !== "object" || ns === null) {
    throw new Error("ramose/query: Query.from(...) takes an entity or a trait");
  }
  const tag = (ns as { _tag?: unknown })._tag;
  if (tag !== "Entity" && tag !== "Trait") {
    throw new Error("ramose/query: Query.from(...) takes an entity or a trait");
  }
  return makeFluent(ns, entities(ns) as Pipeline, false);
};
