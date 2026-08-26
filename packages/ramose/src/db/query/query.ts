/**
 * `Query.q(body)` — one constructor, one kind of object.
 *
 * A query is a rule: a body of kernel clauses plus a projection. The body
 * is a generator that returns the projection, or a function returning a
 * closed pipeline — two spellings of the same value, so escalating from
 * pipe to generator is un-sugaring, never rewriting.
 *
 * Output is inferred: the type of one return expression. Queries compose
 * one way — generator delegation — at three altitudes: `yield* frag(handle)`
 * (build-inlined fragment), `yield* q.open()` (a whole closed query as a
 * subquery), and `Query.rule` (engine-expanded, which is what makes
 * recursion work). Effect appears nowhere here: a built query is inert
 * data — hashable for live identity, stable as a hook dependency — and
 * computation starts at `db.query`.
 */

import { PREDICATES, vkey } from "../../internal/core/query/builtins.ts";
import { RAMOSE_TRAIT_IDENT, RAMOSE_TYPE_IDENT, TX_BASE } from "../../internal/core/schema.ts";
import { traitsOf } from "../compose.ts";
import { makeEid, type Eid } from "../Eid.ts";
import { InvalidRequest, NotOne } from "../Errors.ts";
import type { AnyEntity, AnyQueryRoot } from "../Entity.ts";
import {
  lowerOrderPath,
  requiredClauses,
  resetGensym,
  shapeToPullMap,
  type OrderDir,
  type OrderEmpty,
  type PathCarrier,
  type Shape,
  cardsOf,
  pathOf,
  revsOf,
} from "../shapes.ts";
import {
  inspectPullField,
  isAgain,
  isAllShape,
  lowerPullPattern,
  reshapePullResult,
} from "../Pull.ts";
import {
  Q,
  isFocusSentinel,
  isPullSpec,
  isRowsSpec,
  isAggSpec,
  isValueSpec,
  isDistinctSpec,
  isVar,
  isBlank,
  collectBody,
  mkVar,
  runBody,
  type AggSpec,
  type AnyVar,
  type BClause,
  type BuildCtx,
  type CallClause,
  type Cell,
  type CmpCommand,
  type EidCell,
  type CellRecord,
  type DistinctSpec,
  type FactCommand,
  type Fragment,
  type Position,
  type Projection,
  type PullSpec,
  type QueryGen,
  type RowOfProjection,
  type SpliceCommand,
  type ValueSpec,
  type Var,
} from "./kernel.ts";

// ── keyset paging ───────────────────────────────────────────────────────────

/**
 * Where a page ended — feed it to `q.after` to get the next one. Opaque: the
 * `keys` are the last row's sort-key values (the entity-id tie-breaker
 * included), and they mean something only to the query that minted them —
 * `.after` rejects a cursor whose shape does not fit. Hold it in memory, or
 * round-trip through `Query.encodeCursor` / `Query.decodeCursor` so Instant
 * keys stay `Date`s (a JSON-stringified `Date` sorts as a string).
 */
export interface Cursor {
  readonly _tag: "Cursor";
  /** @internal One value per lowered `:order` key, the tie-breaker last. */
  readonly keys: readonly unknown[];
}

export const isCursor = (x: unknown): x is Cursor =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Cursor" &&
  Array.isArray((x as { keys?: unknown }).keys);

/**
 * What a cursor-paged query resolves to: the page's rows, and the cursor of
 * its last row — `null` when there is no next page (the page came back empty,
 * or shorter than its `limit`). Without a `limit`, a full sweep always ends
 * on one empty page: the peer cannot know the last row is the last.
 */
export interface Page<Row = unknown> {
  readonly rows: readonly Row[];
  readonly cursor: Cursor | null;
}

// ── the pipeline value (built by `entities` + the pipe stages in lib.ts) ────

export type BuiltOrder =
  | {
      readonly kind: "path";
      readonly path: readonly string[];
      readonly revs: readonly boolean[];
      readonly dir: OrderDir;
      readonly empty: OrderEmpty;
    }
  | {
      readonly kind: "cell";
      readonly cell: Cell;
      readonly dir: OrderDir;
      readonly empty: OrderEmpty;
    };

/** Extra aggregate cells on a `select` — a record, or a callback of the focus. */
export type SelectExtra = CellRecord | ((focus: AnyVar) => CellRecord);

export type PipeStage =
  | { readonly kind: "frag"; readonly frag: Fragment<AnyVar, unknown> }
  | { readonly kind: "select"; readonly shape: Shape; readonly extra?: SelectExtra }
  | {
      readonly kind: "orderBy";
      readonly key: string | PathCarrier;
      readonly dir: OrderDir;
      readonly empty: OrderEmpty;
    }
  | { readonly kind: "limit"; readonly n: number }
  | { readonly kind: "offset"; readonly n: number }
  | { readonly kind: "ids" };

/**
 * What {@link QueryObject.orderBy} accepts: a selected column name, an
 * attribute path, a bound var / aggregate cell, or a picker of a projected
 * cell (`r => r.n`).
 */
export type QueryOrderKey<Row = unknown> =
  | (string & keyof Row)
  | AnyVar
  | AggSpec<any>
  | ((row: Row) => unknown);

export interface QueryOrder {
  readonly key: unknown;
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

/**
 * The pipe surface's incremental builder for the same body value
 * `Query.q` writes directly. `Row` is a phantom: the row the
 * pipeline's terminals have shaped so far. `N` is the current focus
 * namespace (`entities(User)` starts as `User`; `follow` moves it).
 * Runtime `ns` is the scan root `entities(...)` planted — membership
 * lowering reads that object; `N` is the type-level focus and does
 * not have to stay in lockstep after a traversal. In a generator
 * body the same value is a clause source: `yield* entities(Issue)`
 * mints the branded focus var and contributes membership.
 */
export interface Pipeline<Row = unknown, N extends AnyQueryRoot = AnyEntity> {
  readonly _tag: "Pipeline";
  readonly ns: N;
  readonly stages: readonly PipeStage[];
  readonly _row?: Row;
  [Symbol.iterator](): Iterator<never, Var<Eid<N>>, any>;
}

export const isPipeline = (x: unknown): x is Pipeline =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Pipeline";

/** A projection of bare ids: the pipe surface with no `select`. */
interface IdsSpec {
  readonly _tag: "idsSpec";
  readonly v: AnyVar;
}
const isIdsSpec = (x: unknown): x is IdsSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "idsSpec";

// ── the query value ─────────────────────────────────────────────────────────

/** What `yield* q.open(p)` answers: the focus to keep constraining, and the
 * opened query's projected columns to keep (or extend). `cols` is typed as
 * a pull spec carrying the opened query's row — treat it as opaque: return
 * it, or extend it with `Q.row(cols, extra)`. */
export interface OpenResult<Row = unknown> {
  readonly focus: Var<EidCell>;
  readonly cols: PullSpec<Row>;
  readonly _row?: Row;
}

interface OpenCommand<Row> extends SpliceCommand {
  readonly _row?: Row;
  [Symbol.iterator](): Iterator<never, OpenResult<Row>, any>;
}

/**
 * A closed query value: a body, runnable by `db.query` / `db.live` and
 * delegable into other builds via {@link QueryObject.open}. `Row` is the
 * inferred row; `Out` is what a terminal resolves to — the rows array by
 * default, one row (or `null`) after {@link QueryObject.one} /
 * {@link QueryObject.oneOrFail}, a {@link Page} after
 * {@link QueryObject.after}, a scalar after {@link Q.value}.
 *
 * `Term` distinguishes a body-derived scalar (`Q.value`) from cursor
 * terminals that also set `Out` (`one` / `oneOrFail` / `after`), so
 * {@link QueryObject.logic} can reset the latter to the rows array
 * without lying about the former.
 */
type QueryTerm = "rows" | "value" | "one" | "oneOrFail" | "after";

export interface QueryObject<
  Row = unknown,
  Out = readonly Row[],
  Term extends QueryTerm = "rows",
> {
  readonly _tag: "Query";
  /** @internal provenance: re-run per inclusion, so vars stay hygienic */
  readonly body: () => unknown;
  /** @internal `logic()` strips cursor stages instead of failing `open` */
  readonly stripCursor: boolean;
  /** @internal `one()` / `oneOrFail()` — forced `limit 1`/`2`, unwrapped. */
  readonly take: "one" | "oneOrFail" | undefined;
  /** @internal the keyset cursor `after(...)` seeks past; `null` is page one. */
  readonly seek: Cursor | null | undefined;
  /** @internal `orderBy` keys stored on the query value (both spellings). */
  readonly orders: readonly QueryOrder[];
  /** @internal `limit(n)` stored on the query value. */
  readonly limitN: number | undefined;
  /** @internal `offset(n)` stored on the query value. */
  readonly offsetN: number | undefined;

  /**
   * Delegate this whole query into an enclosing build: its clauses inline,
   * and it answers `{ focus, cols }` to keep constraining. Cursor terminals
   * don't delegate: extend then order, or strip with {@link QueryObject.logic}.
   */
  open(): OpenCommand<Row>;

  /** This query without its cursor (orderBy/limit/offset/one/after) — the
   * logic composes; the cursor was post-processing for the outermost query.
   * Body-derived `Q.value` scalars stay scalars; `one` / `oneOrFail` /
   * `after` reset to the rows array. */
  logic(): QueryObject<
    Row,
    Term extends "value" ? Out : readonly Row[],
    Term extends "value" ? "value" : "rows"
  >;

  /**
   * Sort by a selected column, an attribute path, a bound var / projected
   * cell, or a picker of one (`r => r.n`). Reaches both the fluent chain
   * and `Query.q` generator values. The fluent override keeps row-typed
   * string keys (`keyof Row`) and focus-typed attributes.
   */
  orderBy(key: (row: Row) => unknown, dir?: OrderDir, opts?: { readonly empty?: OrderEmpty }): QueryObject<Row, Out, Term>;
  orderBy(
    // `any` so FluentQuery's row-typed override stays assignable to
    // `QueryObject<any>` (`AnyQueryObject`); the fluent chain keeps
    // `keyof Row` / `FocusAttr<N>` checking.
    key: any,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): QueryObject<Row, Out, Term>;

  /** Keep at most `n` rows. */
  limit(n: number): QueryObject<Row, Out, Term>;

  /** Drop `n` rows from the front of the (ordered) result. */
  offset(n: number): QueryObject<Row, Out, Term>;

  /**
   * At most one row. Lowering forces `limit 1`; the result is that row or
   * `null`, the same absence `db.pull` uses. Extra matches are not fetched.
   */
  one(): QueryObject<Row, Row | null, "one">;
  /**
   * Exactly one row. Lowering forces `limit 2` so a second match is
   * witnessed without pulling a whole page, and `db.query` fails with `NotOne`
   * when the peer answers zero or two.
   */
  oneOrFail(): QueryObject<Row, Row, "oneOrFail">;
  /**
   * Keyset-page a sorted query: the result becomes a {@link Page}, whose
   * `cursor` is where it ended — pass `null` for the first page and the
   * previous page's cursor after that. Needs an `orderBy` (the cursor is a
   * position in the sort); the entity id rides as a final tie-breaker, so
   * rows that tie on every key still land on exactly one page. The seek is
   * the peer's: `limit(n)` is n rows *past* the cursor, and unlike `offset`
   * the walk does not shift when rows are inserted before it.
   */
  after(cursor: Cursor | null): QueryObject<Row, Page<Row>, "after">;

  /** Phantom — the inferred row. Never present at runtime. */
  readonly _row?: Row;
  /** Phantom — what a terminal resolves to. Never present at runtime. */
  readonly _out?: Out;
}

export type AnyQueryObject = QueryObject<any, any>;

/**
 * The row type a query yields — so an app names it once, from the query,
 * instead of restating the shape by hand:
 *
 * ```ts
 * const boardQuery = Query.q(() => pipe(entities(Issue), select({ … })));
 * type BoardRow = Ramose.Row<typeof boardQuery>;   // one row
 * type BoardRows = Ramose.Rows<typeof boardQuery>; // the readonly array
 * ```
 */
export type Row<Q> = Q extends QueryObject<infer R, any> ? R : never;

/** The readonly array of {@link Row} — what `db.query` resolves an unpaged,
 * untaken query to. */
export type Rows<Q> = readonly Row<Q>[];

export const isQueryObject = (x: unknown): x is AnyQueryObject =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Query";

/** What one build pass of a query value produced. */
interface Built {
  readonly clauses: BClause[];
  readonly proj: Exclude<Projection, DistinctSpec<any>> | IdsSpec;
  /** The select/pipeline focus — what `open` hands back, and what the
   * cursor's sort paths walk from. */
  readonly focus: AnyVar | undefined;
  readonly order: readonly BuiltOrder[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  /** Ident-path → group-key var from `expandShapeToCells` (nested hops
   * included). Empty when the projection is not `select(shape, extras)`. */
  readonly groupKeys: ReadonlyMap<string, AnyVar>;
  /** `Q.distinct(...)` — unique projected tuples, no row-provenance `:with`. */
  readonly distinct: boolean;
}

/** Fingerprint a sort path so an attribute-key `orderBy` can reuse the
 * group-key var `expandShapeToCells` already bound into `:find`. */
const groupKeyId = (path: readonly string[], revs: readonly boolean[]): string =>
  path.map((ident, i) => `${revs[i] ? "~" : ""}${ident}`).join("\0");

/** A pipe `orderBy("col")` that names a group key — resolved to a cell
 * after `expandShapeToCells` binds the var. */
type ShapeKeyOrder = {
  readonly kind: "shapeKey";
  readonly key: string;
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
};

type PendingOrder = BuiltOrder | ShapeKeyOrder;

const isGen = (x: unknown): x is QueryGen<unknown> =>
  typeof x === "object" && x !== null && typeof (x as Iterator<unknown>).next === "function";

/** Run the body once, collecting into `ctx`. */
const runInto = (
  qv: AnyQueryObject,
  ctx: BuildCtx,
  stripCursor: boolean,
): Built => {
  const out = qv.body();
  if (isPipeline(out)) return assemblePipeline(out, ctx, stripCursor);
  if (isGen(out)) {
    const raw = runBody(out, ctx);
    let distinct = false;
    let proj: unknown = raw;
    while (isDistinctSpec(proj)) {
      distinct = true;
      proj = proj.inner;
    }
    return {
      clauses: ctx.clauses,
      proj: normalizeProj(proj),
      focus: focusOf(proj),
      order: [],
      limit: undefined,
      offset: undefined,
      groupKeys: new Map(),
      distinct,
    };
  }
  throw new Error(
    "ramose/query: a Query.q body is a generator of clauses returning the projection, or a function returning a pipeline",
  );
};

const normalizeProj = (proj: unknown): Exclude<Projection, DistinctSpec<any>> | IdsSpec => {
  if (isVar(proj)) return { _tag: "idsSpec", v: proj };
  if (isDistinctSpec(proj)) {
    throw new Error("ramose/query: Q.distinct(...) wraps the whole projection, not one cell");
  }
  if (isPullSpec(proj) || isRowsSpec(proj) || isValueSpec(proj)) return proj;
  if (typeof proj === "object" && proj !== null && !Array.isArray(proj)) {
    const cells = proj as CellRecord;
    if (Object.keys(cells).length === 0) {
      throw new Error("ramose/query: the body returned an empty projection — name at least one cell");
    }
    return cells;
  }
  throw new Error(
    "ramose/query: the body must return its projection — Q.pull(focus, shape), Q.rows({ … }), Q.value(...), Q.distinct({ … }), a record of bound handles, or a focus var for bare ids",
  );
};

const focusOf = (proj: unknown): AnyVar | undefined => {
  if (isVar(proj)) return proj;
  if (isPullSpec(proj)) return proj.focus;
  return undefined;
};

const assemblePipeline = (pipe: Pipeline, ctx: BuildCtx, stripCursor: boolean): Built => {
  const root = mkVar<EidCell>("entity", pipe.ns.ns);
  ctx.clauses.push({ _tag: "memberOf", ns: pipe.ns, v: root });
  let focus: AnyVar = root;
  let select: Shape | undefined;
  let extraCells: CellRecord | undefined;
  let selectFocus: AnyVar = root;
  let projectIds = false;
  const order: PendingOrder[] = [];
  let limit: number | undefined;
  let offset: number | undefined;
  const groupKeys = new Map<string, AnyVar>();
  for (const st of pipe.stages) {
    switch (st.kind) {
      case "frag": {
        if (select !== undefined) {
          throw new Error(
            "ramose/query: a filter after select(...) — clauses close before the projection; move the stage before select",
          );
        }
        const r = runBody(st.frag(focus), ctx);
        if (isVar(r)) focus = r;
        break;
      }
      case "select":
        select = st.shape;
        selectFocus = focus;
        extraCells =
          st.extra === undefined
            ? undefined
            : rewriteExtra(typeof st.extra === "function" ? st.extra(focus) : st.extra, focus);
        projectIds = false;
        break;
      case "ids":
        projectIds = true;
        break;
      case "orderBy":
        order.push(resolveOrderKey(st, select, extraCells));
        break;
      case "limit":
        limit = st.n;
        break;
      case "offset":
        offset = st.n;
        break;
    }
  }
  if (stripCursor) {
    order.length = 0;
    limit = undefined;
    offset = undefined;
  }
  let proj: Projection | IdsSpec;
  let shapeCells: CellRecord | undefined;
  if (select !== undefined && !projectIds && extraCells !== undefined) {
    shapeCells = expandShapeToCells(selectFocus, select, ctx, groupKeys);
    proj = { ...shapeCells, ...extraCells };
  } else if (select !== undefined && !projectIds) {
    proj = { _tag: "pullSpec", focus: selectFocus, shape: select };
  } else {
    proj = { _tag: "idsSpec", v: focus };
  }
  return {
    clauses: ctx.clauses,
    proj,
    focus: select !== undefined && !projectIds ? selectFocus : focus,
    order: finalizePendingOrders(order, select, projectIds, shapeCells),
    limit,
    offset,
    groupKeys,
    distinct: false,
  };
};

/** Turn leftover `shapeKey` placeholders into real `BuiltOrder`s — or a
 * curated error. `ids()` / a later `select` can flip the projection after
 * `resolveOrderKey` already queued a placeholder. */
const finalizePendingOrders = (
  order: readonly PendingOrder[],
  select: Shape | undefined,
  projectIds: boolean,
  shapeCells: CellRecord | undefined,
): BuiltOrder[] => {
  const out: BuiltOrder[] = [];
  for (const o of order) {
    if (o.kind !== "shapeKey") {
      out.push(o);
      continue;
    }
    if (shapeCells !== undefined) {
      const cell = shapeCells[o.key];
      if (!isVar(cell)) {
        throw new Error(
          `ramose/query: orderBy("${o.key}") — a sort key is a direct attribute column`,
        );
      }
      out.push({ kind: "cell", cell, dir: o.dir, empty: o.empty });
      continue;
    }
    if (select !== undefined && !projectIds) {
      out.push(orderKeyFromSelectColumn(o.key, select, o.dir, o.empty));
      continue;
    }
    throw new Error(
      `ramose/query: orderBy("${o.key}") — the projection has no column "${o.key}"`,
    );
  }
  return out;
};

const orderKeyFromSelectColumn = (
  key: string,
  select: Shape,
  dir: OrderDir,
  empty: OrderEmpty,
): BuiltOrder => {
  let field = (select as Record<string, unknown>)[key];
  if (field === undefined) {
    throw new Error(`ramose/query: orderBy("${key}") — the select shape has no column "${key}"`);
  }
  while (
    typeof field === "object" &&
    field !== null &&
    ((field as { _tag?: unknown })._tag === "optional" ||
      (field as { _tag?: unknown })._tag === "default") &&
    "field" in field
  ) {
    field = (field as { field: unknown }).field;
  }
  if (typeof field !== "object" || field === null || typeof (field as { ident?: unknown }).ident !== "string") {
    throw new Error(`ramose/query: orderBy("${key}") — a sort key is a direct attribute column`);
  }
  const carrier = field as PathCarrier;
  const path = pathOf(carrier);
  if (cardsOf(carrier).includes("many")) {
    throw new Error(
      `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  return { kind: "path", path, revs: revsOf(carrier), dir, empty };
};

/** A sort key: a selected column's name, or an attr path directly. */
const resolveOrderKey = (
  st: Extract<PipeStage, { kind: "orderBy" }>,
  select: Shape | undefined,
  extra?: CellRecord,
): PendingOrder => {
  if (typeof st.key === "string" && extra !== undefined && extra[st.key] !== undefined) {
    return { kind: "cell", cell: extra[st.key]!, dir: st.dir, empty: st.empty };
  }
  if (typeof st.key === "string") {
    if (select === undefined) {
      throw new Error(`ramose/query: orderBy("${st.key}") names a selected column — select(...) first, or pass the attribute itself`);
    }
    if ((select as Record<string, unknown>)[st.key] === undefined) {
      throw new Error(`ramose/query: orderBy("${st.key}") — the select shape has no column "${st.key}"`);
    }
    // `select(shape, extras)` already bound this group key — reuse that
    // var after expand. A later `ids()` / `select` can drop extras; leftover
    // placeholders are resolved or rejected in `finalizePendingOrders`.
    if (extra !== undefined) {
      return { kind: "shapeKey", key: st.key, dir: st.dir, empty: st.empty };
    }
    return orderKeyFromSelectColumn(st.key, select, st.dir, st.empty);
  }
  const carrier = st.key;
  const path = pathOf(carrier);
  if (cardsOf(carrier).includes("many")) {
    throw new Error(
      `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  return { kind: "path", path, revs: revsOf(carrier), dir: st.dir, empty: st.empty };
};

const isPathCarrier = (x: unknown): x is PathCarrier =>
  typeof x === "object" && x !== null && typeof (x as { ident?: unknown }).ident === "string";

/** Bind a select shape as group-key cells (aggregates cannot group by a pull). */
const expandShapeToCells = (
  focus: AnyVar,
  shape: Shape,
  ctx: BuildCtx,
  groupKeys: Map<string, AnyVar>,
  prefix: { readonly path: readonly string[]; readonly revs: readonly boolean[] } = {
    path: [],
    revs: [],
  },
): CellRecord => {
  const cells: Record<string, Cell> = {};
  for (const [key, field] of Object.entries(shape)) {
    const info = inspectPullField(field);
    const attr = info.attr as PathCarrier | undefined;
    if (attr === undefined || typeof attr.ident !== "string") {
      throw new Error(`ramose/query: select(..., aggregates) field "${key}" is not an attribute`);
    }
    if (info.many) {
      throw new Error(
        `ramose/query: select(..., aggregates) cannot group by a cardinality-many field ("${key}")`,
      );
    }
    if (isAgain(info.nestedPattern) || isAllShape(info.nestedPattern)) {
      throw new Error(
        `ramose/query: select(..., aggregates) cannot group by all(...) or again(...) ("${key}")`,
      );
    }
    const path = [...prefix.path, ...pathOf(attr)];
    const revs = [...prefix.revs, ...revsOf(attr)];
    if (info.nestedPattern !== undefined && typeof info.nestedPattern === "object") {
      if (info.optional || info.hasDefault) {
        throw new Error(
          `ramose/query: select(..., aggregates) cannot group by an optional or defaulted nested shape ("${key}")`,
        );
      }
      const target = mkVar<EidCell>("entity");
      const cmd = info.reverse ? Q.fact(target, attr, focus) : Q.fact(focus, attr, target);
      ctx.clauses.push(cmd);
      cells[key] = expandShapeToCells(target, info.nestedPattern as Shape, ctx, groupKeys, {
        path,
        revs,
      });
      continue;
    }
    const v = bindGroupKey(focus, attr, info, ctx);
    groupKeys.set(groupKeyId(path, revs), v);
    cells[key] = v;
  }
  return cells;
};

/** A group-key var for one shape leaf. `:db/id` is a distinct value var
 * (not the entity var — that would wrap `{ id }` and collide with
 * `Q.count` of the same focus in the find spec). Optional / defaulted
 * fields or-join so a missing datom is still a group. */
const bindGroupKey = (
  focus: AnyVar,
  attr: PathCarrier,
  info: ReturnType<typeof inspectPullField>,
  ctx: BuildCtx,
): AnyVar => {
  if (attr.ident === ":db/id") {
    const id = mkVar("value");
    ctx.clauses.push(Q.fact(focus, attr, id));
    return id;
  }
  const isRef = (attr as { valueType?: unknown }).valueType === "ref";
  const v = isRef ? mkVar<EidCell>("entity") : mkVar("value");
  if (info.optional || info.hasDefault) {
    const fallback = info.hasDefault ? info.defaultValue : null;
    const present = info.reverse
      ? function* () {
          yield* Q.fact(v, attr, focus);
        }
      : function* () {
          yield* Q.fact(focus, attr, v);
        };
    const missing = info.reverse
      ? function* () {
          yield* Q.fact(Q._, attr, focus);
        }
      : function* () {
          yield* Q.fact(focus, attr);
        };
    ctx.clauses.push({
      _tag: "orGroup",
      branches: [
        collectBody(present),
        collectBody(function* () {
          yield* Q.not(missing);
          yield* Q.in(v, [fallback]);
        }),
      ],
    });
    return v;
  }
  if (info.reverse) {
    // Bind the referring entity — `Q.fact(Q._, attr, focus)` would reuse
    // `focus` as the value var and group by the select root.
    ctx.clauses.push(Q.fact(v, attr, focus));
    return v;
  }
  const cmd = Q.fact(focus, attr);
  ctx.clauses.push(cmd);
  return cmd.handle.v;
};

/** Prefix parent hops onto a nested leaf so `orderBy(r => r.owner.name)`
 * walks from the select focus, not the leaf's own entity. */
const extendPath = (parent: PathCarrier, leaf: PathCarrier): PathCarrier => ({
  ident: leaf.ident,
  cardinality: leaf.cardinality,
  __path: [...pathOf(parent), ...pathOf(leaf)],
  __cards: [...cardsOf(parent), ...cardsOf(leaf)],
  __revs: [...revsOf(parent), ...revsOf(leaf)],
});

const rewriteExtra = (extra: CellRecord, focus: AnyVar): CellRecord => {
  const out: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(extra)) {
    if (isAggSpec(cell)) {
      out[key] = isFocusSentinel(cell.v) ? { ...cell, v: focus } : cell;
      continue;
    }
    if (cell !== null && typeof cell === "object" && !isVar(cell) && !isPullSpec(cell) && !isValueSpec(cell)) {
      out[key] = rewriteExtra(cell as CellRecord, focus);
      continue;
    }
    throw new Error(
      `ramose/query: select(..., extras) cells are aggregates — "${key}" is not Q.count / Q.sum / …`,
    );
  }
  return out;
};

const pullShapeCells = (shape: Shape, parent?: PathCarrier): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const info = inspectPullField(field);
    const attr = info.attr as PathCarrier | undefined;
    // Nested `.select({...})` leaves start at the child entity. Prefix the
    // parent hops so `orderBy(r => r.owner.name)` walks from the focus
    // (`:issue/owner` then `:user/name`), not `:user/name` off the Issue.
    const fromFocus =
      parent !== undefined && attr !== undefined && typeof attr.ident === "string"
        ? extendPath(parent, attr)
        : attr;
    if (
      info.nestedPattern !== undefined &&
      typeof info.nestedPattern === "object" &&
      !isAgain(info.nestedPattern) &&
      !isAllShape(info.nestedPattern)
    ) {
      const nextParent =
        fromFocus !== undefined && typeof fromFocus.ident === "string" ? fromFocus : parent;
      out[key] = pullShapeCells(info.nestedPattern as Shape, nextParent);
    } else {
      out[key] = fromFocus ?? info.attr;
    }
  }
  return out;
};

const projectionCells = (proj: Projection | IdsSpec): unknown => {
  if (isValueSpec(proj)) return proj.cell;
  if (isIdsSpec(proj)) return { id: proj.v };
  if (isPullSpec(proj)) return pullShapeCells(proj.shape);
  return isRowsSpec(proj) ? proj.cells : proj;
};

// ── Query.q ─────────────────────────────────────────────────────────────────

/** What a body may produce. */
export type QueryBody<P, Prj> = (p: P) => QueryGen<Prj> | Pipeline<any>;

type RowFromBody<B> = B extends () => infer Out
  ? Out extends QueryGen<infer Prj>
    ? Prj extends ValueSpec<infer T>
      ? T
      : Prj extends AnyVar
        ? { readonly id: number }
        : RowOfProjection<Prj>
    : Out extends Pipeline<infer Row>
      ? Row
      : never
  : never;

type IsValueBody<B> = B extends () => QueryGen<infer Prj> ? (Prj extends ValueSpec<any> ? true : false) : false;

type OutFromBody<B> = IsValueBody<B> extends true ? RowFromBody<B> : readonly RowFromBody<B>[];

export const makeQueryObject = <
  Row,
  Out = readonly Row[],
  Term extends QueryTerm = "rows",
>(
  body: () => unknown,
  stripCursor: boolean,
  take?: "one" | "oneOrFail",
  seek?: Cursor | null,
  orders: readonly QueryOrder[] = [],
  limitN?: number,
  offsetN?: number,
): QueryObject<Row, Out, Term> => {
  const self: QueryObject<Row, Out, Term> = {
    _tag: "Query",
    body,
    stripCursor,
    take,
    seek,
    orders,
    limitN,
    offsetN,
    open: (() => openCommand(self)) as QueryObject<Row, Out, Term>["open"],
    logic: () =>
      makeQueryObject<Row, Term extends "value" ? Out : readonly Row[], Term extends "value" ? "value" : "rows">(
        body,
        true,
      ),
    orderBy: (key, dir = "asc", opts) =>
      makeQueryObject<Row, Out, Term>(body, stripCursor, take, seek, [
        ...orders,
        { key, dir, empty: opts?.empty ?? "last" },
      ], limitN, offsetN),
    limit: (n) => makeQueryObject<Row, Out, Term>(body, stripCursor, take, seek, orders, n, offsetN),
    offset: (n) => makeQueryObject<Row, Out, Term>(body, stripCursor, take, seek, orders, limitN, n),
    one: () => {
      if (seek !== undefined) {
        throw new Error(
          "ramose/query: one() unwraps a single row, and after(...) pages many — a paged query keeps its rows",
        );
      }
      return makeQueryObject(body, stripCursor, "one", undefined, orders, limitN, offsetN) as never;
    },
    oneOrFail: () => {
      if (seek !== undefined) {
        throw new Error(
          "ramose/query: oneOrFail() unwraps a single row, and after(...) pages many — a paged query keeps its rows",
        );
      }
      return makeQueryObject(body, stripCursor, "oneOrFail", undefined, orders, limitN, offsetN) as never;
    },
    after: (cursor) => {
      if (take !== undefined) {
        throw new Error(
          "ramose/query: one() / oneOrFail() answer a single row — there is no next page to cursor to",
        );
      }
      if (cursor !== null && !isCursor(cursor)) {
        throw new Error(
          "ramose/query: after(...) takes the previous page's cursor, or null for the first page",
        );
      }
      return makeQueryObject(body, stripCursor, undefined, cursor, orders, limitN, offsetN) as never;
    },
  };
  return self;
};

/**
 * Build a query. The body returns the projection; both the pipe and
 * generator spellings denote the same value. Put changing values in the
 * body as literals — `Query.q` takes one argument.
 */
export function q<B extends () => QueryGen<any> | Pipeline<any>>(
  body: B,
): QueryObject<RowFromBody<B>, OutFromBody<B>, IsValueBody<B> extends true ? "value" : "rows"> {
  if (typeof body !== "function") {
    throw new Error("ramose/query: Query.q(body) takes a generator or a function returning a pipeline");
  }
  return makeQueryObject<
    RowFromBody<B>,
    OutFromBody<B>,
    IsValueBody<B> extends true ? "value" : "rows"
  >(body, false);
}

// ── named rules ─────────────────────────────────────────────────────────────

interface RuleBuilt {
  readonly headVars: readonly AnyVar[];
  readonly retVar: AnyVar | undefined;
  readonly clauses: readonly BClause[];
}

/**
 * A named rule: apply it to bound handles (`yield* projectOf(issue)`) and
 * the application records an inert call descriptor — the body is expanded
 * by the engine, not the builder, which is what makes recursion work and
 * what lets the same value install as policy data.
 */
export interface RuleValue {
  (...args: readonly Position[]): SpliceCommand;
  readonly _tag: "QueryRule";
  readonly ruleName: string;
  /** @internal memoized head/body build */
  ensureBuilt(): RuleBuilt;
}

export const isRuleValue = (x: unknown): x is RuleValue =>
  typeof x === "function" && (x as { _tag?: unknown })._tag === "QueryRule";

const RULE_NAME = /^[A-Za-z][A-Za-z0-9_./-]*$/;

/**
 * `Query.rule(name, body)` — the named form of the head/body constructor.
 * The body's parameters are the bound head vars; a returned var joins the
 * head as the free position (promotion: an instantiated fragment becomes a
 * named engine rule in exactly this one mechanical call).
 */
export function rule(name: string, body: (...vars: never[]) => QueryGen<unknown>): RuleValue {
  if (!RULE_NAME.test(name)) {
    throw new Error(`ramose/query: "${name}" is not a rule name — use letters, digits, '_', '.', '/', '-', starting with a letter`);
  }
  let built: RuleBuilt | undefined;
  const ensureBuilt = (): RuleBuilt => {
    if (built) return built;
    const headVars = Array.from({ length: body.length }, () => mkVar("value"));
    const ctx: BuildCtx = { clauses: [] };
    const ret = runBody(body(...(headVars as never[])), ctx);
    let retVar: AnyVar | undefined;
    if (isVar(ret)) {
      if (headVars.includes(ret)) {
        throw new Error(
          `ramose/query: rule "${name}" returns one of its own arguments — a head var appears once; return a var the body binds`,
        );
      }
      retVar = ret;
    } else if (ret !== undefined) {
      throw new Error(`ramose/query: rule "${name}" must return a bound var (its free head position) or nothing`);
    }
    built = { headVars, retVar, clauses: ctx.clauses };
    return built;
  };
  const apply = (...args: readonly Position[]): SpliceCommand => {
    if (args.length !== body.length) {
      throw new Error(`ramose/query: rule "${name}" takes ${body.length} argument${body.length === 1 ? "" : "s"}, got ${args.length}`);
    }
    const ret = mkVar("value");
    const cmd: SpliceCommand = {
      _tag: "splice",
      splice: (ctx) => {
        const call: CallClause = { _tag: "ruleCall", rule: self, args, ret };
        ctx.clauses.push(call);
        return ret;
      },
      [Symbol.iterator]() {
        let state = 0;
        return {
          next: (v: unknown) =>
            state === 0
              ? ((state = 1), { done: false as const, value: cmd as never })
              : { done: true as const, value: v as never },
        };
      },
    };
    return cmd;
  };
  const self = Object.assign(apply, { _tag: "QueryRule" as const, ruleName: name, ensureBuilt });
  return self as RuleValue;
}

// ── open (whole-query delegation) ───────────────────────────────────────────

const openCommand = <Row>(qv: AnyQueryObject): OpenCommand<Row> => {
  const cmd: OpenCommand<Row> = {
    _tag: "splice",
    splice: (ctx) => {
      const built = runInto(qv, ctx, qv.stripCursor);
      const hasCursor =
        built.order.length > 0 ||
        built.limit !== undefined ||
        built.offset !== undefined ||
        qv.take !== undefined ||
        qv.seek !== undefined ||
        (!qv.stripCursor &&
          (qv.orders.length > 0 || qv.limitN !== undefined || qv.offsetN !== undefined));
      if (hasCursor) {
        throw new Error(
          "ramose/query: a query with a cursor (orderBy/limit/offset/one/after) does not delegate — the cursor is post-processing for the outermost query; extend then order, or strip it explicitly with q.logic()",
        );
      }
      const cols: Projection = isIdsSpec(built.proj) ? ({ id: built.proj.v } as CellRecord) : built.proj;
      const focus = built.focus ?? (isPullSpec(built.proj) ? built.proj.focus : undefined);
      if (focus === undefined) {
        throw new Error(
          "ramose/query: q.open(...) needs the opened query's focus — a multi-root projection has none to hand back; open its parts instead",
        );
      }
      return { focus, cols } as OpenResult;
    },
    [Symbol.iterator]() {
      let state = 0;
      const self = cmd;
      return {
        next: (v: unknown) =>
          state === 0
            ? ((state = 1), { done: false as const, value: self as never })
            : { done: true as const, value: v as never },
      };
    },
  };
  return cmd;
};

// ── derived transformers ────────────────────────────────────────────────────

/**
 * Lift an enricher generator into a query transformer: the query-level
 * generics live here, never in user code. The enricher sees the opened
 * query's focus and returns extra cells for the row.
 */
export const enrich =
  <Extra extends CellRecord>(body: (e: Var<EidCell>) => QueryGen<Extra>) =>
  <Row>(qv: QueryObject<Row>): QueryObject<Row & RowOfProjection<Extra>> =>
    makeQueryObject(
      function* () {
        const { focus, cols } = (yield* openCommand(qv)) as OpenResult;
        const extra = yield* body(focus);
        return Q.row(cols, extra);
      } as never,
      false,
    );

/** Shape-preserving sibling of {@link enrich}: extra constraints, same row. */
export const refine =
  (frag: Fragment<Var<EidCell>, unknown>) =>
  <Row>(qv: QueryObject<Row>): QueryObject<Row> =>
    makeQueryObject(
      function* () {
        const { focus, cols } = (yield* openCommand(qv)) as OpenResult;
        yield* frag(focus);
        return cols;
      } as never,
      false,
    );

// ── lowering ────────────────────────────────────────────────────────────────

export interface LoweredKernelQuery {
  /** The JS-form wire query (`find`/`where`/`rules`/`order`/`limit`/`offset`). */
  readonly query: Record<string, unknown>;
  /** Reshape the peer's raw result rows into the query's rows. */
  readonly finalize: (result: unknown) => unknown;
}

/** One projected column, flattened: where it lives in the row, how it
 * lowers into `:find`, and how its cell reads back. `agg` names the
 * aggregate fn when the cell is one — an all-agg projection synthesizes
 * the empty-set row from it. */
interface FlatCell {
  readonly path: readonly string[];
  readonly elem: unknown;
  readonly read: (cell: unknown) => unknown;
  readonly agg?: AggSpec["fn"];
}

/** Each aggregate's answer over no rows at all: the fn over the empty set. */
const EMPTY_AGG: Record<AggSpec["fn"], unknown> = {
  count: 0,
  "count-distinct": 0,
  sum: 0,
  avg: null,
  min: null,
  max: null,
};

const unwrapEidLike = (v: unknown): unknown =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { id?: unknown }).id === "number" &&
  Object.keys(v).length === 1
    ? (v as { id: number }).id
    : v;

const regexSource = (re: RegExp | string): string => {
  if (typeof re === "string") return re;
  if (re.flags !== "") {
    throw new Error(
      `ramose/query: matches(/${re.source}/${re.flags}) — the peer compiles the pattern with no flags; express it in the pattern instead`,
    );
  }
  return re.source;
};

/** The lowered wire AST — the same JSON `db.query` sends. */
export const lowerQueryAst = (qv: AnyQueryObject): Record<string, unknown> =>
  lowerQueryObject(qv).query;

/**
 * Lower, or throw {@link InvalidRequest}. `db.query` / `db.live` / an
 * operation's `q` handle share this so a query that cannot lower is a
 * 400 everywhere, not a 500 on the op path.
 */
export const tryLowerQueryObject = (qv: AnyQueryObject): LoweredKernelQuery => {
  try {
    return lowerQueryObject(qv);
  } catch (e) {
    if (e instanceof InvalidRequest) throw e;
    throw new InvalidRequest({
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

export const lowerQueryObject = (qv: AnyQueryObject): LoweredKernelQuery => {
  resetGensym();
  const ctx: BuildCtx = { clauses: [] };
  const built = runInto(qv, ctx, qv.stripCursor);

  const names = new Map<number, string>();
  let seq = 0;
  const nameOf = (v: AnyVar): string => {
    let n = names.get(v.id);
    if (n === undefined) {
      n = `?q${seq++}`;
      names.set(v.id, n);
    }
    return n;
  };
  let blanks = 0;
  const freshName = (prefix: string): string => `?q${prefix}${blanks++}`;

  // ── rules registry ───────────────────────────────────────────────────────
  interface RuleEntry {
    readonly wireName: string;
    readonly hasRet: boolean;
  }
  const byRule = new Map<RuleValue, RuleEntry>();
  const byNs = new Map<AnyQueryRoot, RuleEntry>();
  const takenNames = new Map<string, unknown>();
  const ruleDefs: unknown[] = [];

  const claimName = (name: string, source: unknown): void => {
    const holder = takenNames.get(name);
    if (holder !== undefined && holder !== source) {
      throw new Error(`ramose/query: two different rules named "${name}" reached one query — rule names are identities`);
    }
    takenNames.set(name, source);
  };

  const registerRule = (r: RuleValue): RuleEntry => {
    const seen = byRule.get(r);
    if (seen) return seen;
    const b = r.ensureBuilt();
    const entry: RuleEntry = { wireName: r.ruleName, hasRet: b.retVar !== undefined };
    claimName(r.ruleName, r);
    byRule.set(r, entry); // before the body lowers: self-reference lands here
    const headVars = b.retVar === undefined ? b.headVars : [...b.headVars, b.retVar];
    const head = [r.ruleName, ...headVars.map(nameOf)];
    const clauses = lowerClauses(b.clauses, varSet(headVars));
    ruleDefs.push([head, ...clauses]);
    return entry;
  };

  const registerMembership = (ns: AnyQueryRoot): RuleEntry => {
    const seen = byNs.get(ns);
    if (seen) return seen;
    const wireName = `is${ns.ns.charAt(0).toUpperCase()}${ns.ns.slice(1)}`.replace(/[^A-Za-z0-9_]/g, "_");
    claimName(wireName, ns);
    const entry: RuleEntry = { wireName, hasRet: false };
    byNs.set(ns, entry);
    const e = freshName("m");
    // Trait roots scan explicit membership. Composed entities share trait
    // idents with other composers — membership is the engine-owned type
    // fact, not an `or` over flattened fields.
    if (ns._tag === "Trait") {
      ruleDefs.push([[wireName, e], [e, RAMOSE_TRAIT_IDENT, `:${ns.ns}`]]);
    } else if (traitsOf(ns).length > 0) {
      ruleDefs.push([[wireName, e], [e, RAMOSE_TYPE_IDENT, `:${ns.ns}`]]);
    } else {
      const prefix = `:${ns.ns}/`;
      const idents = Object.values(ns.fields)
        .map((a) => (a as { ident: string }).ident)
        .filter((ident) => ident.startsWith(prefix));
      ruleDefs.push([[wireName, e], ["or", ...idents.map((ident) => [e, ident, "_"])]]);
    }
    return entry;
  };

  // ── var usage (for join lists and ret-var checks) ────────────────────────
  const varSet = (vs: readonly AnyVar[]): Set<number> => new Set(vs.map((v) => v.id));

  const factVars = (c: FactCommand<any>, into: Set<number>): void => {
    const e = c.eVar ?? c.e0;
    if (isVar(e)) into.add(e.id);
    const v = c.vVar ?? c.v0;
    if (isVar(v)) into.add(v.id);
    if (c.txVar) into.add(c.txVar.id);
    if (c.opVar) into.add(c.opVar.id);
  };

  const clauseListVars = (list: readonly BClause[], into = new Set<number>()): Set<number> => {
    for (const c of list) {
      switch (c._tag) {
        case "fact":
          factVars(c, into);
          break;
        case "cmp":
          for (const a of c.args) if (isVar(a)) into.add(a.id);
          break;
        case "fnBind":
          for (const a of c.args) if (isVar(a)) into.add(a.id);
          into.add(c.ret.id);
          break;
        case "memberOf":
          into.add(c.v.id);
          break;
        case "ruleCall":
          for (const a of c.args) if (isVar(a)) into.add(a.id);
          into.add(c.ret.id);
          break;
        case "orGroup":
          c.branches.forEach((b) => clauseListVars(b, into));
          break;
        case "notGroup":
          clauseListVars(c.clauses, into);
          break;
      }
    }
    return into;
  };

  // ── positions ────────────────────────────────────────────────────────────
  const lowerConst = (v: unknown, _use: string): unknown => unwrapEidLike(v);

  /** e/v/tx/op position of a fact: a var name, a constant, or "_". */
  const lowerPos = (v: unknown, use: string): unknown => {
    if (v === undefined || isBlank(v)) return "_";
    if (isVar(v)) return nameOf(v);
    if (isAggSpec(v)) {
      throw new Error(
        `ramose/query: an aggregate cell is not a value for ${use} — an aggregate exists only after grouping, as a projected cell or a top-level comparison operand`,
      );
    }
    return lowerConst(v, use);
  };

  const neverClause = (): unknown[] => [["ground", []], [freshName("n"), "..."]];

  // ── clauses ──────────────────────────────────────────────────────────────
  const lowerClauses = (list: readonly BClause[], outer: Set<number>): unknown[] => {
    const out: unknown[] = [];
    for (const c of list) {
      switch (c._tag) {
        case "fact": {
          const clause = lowerFact(c);
          if (clause !== undefined) out.push(clause);
          break;
        }
        case "cmp":
          out.push(...lowerCmp(c));
          break;
        case "fnBind":
          out.push([
            [c.fn, ...c.args.map((a) => lowerPos(a, `Q.call("${c.fn}")`))],
            nameOf(c.ret),
          ]);
          break;
        case "memberOf": {
          // entailment skip: a sibling fact already constrains this var
          // through one of the namespace's attrs, so membership is implied
          const prefix = `:${c.ns.ns}/`;
          const entailed = list.some(
            (s) =>
              s !== c &&
              s._tag === "fact" &&
              s.attr !== undefined &&
              s.attr.ident.startsWith(prefix) &&
              (s.eVar ?? s.e0) === c.v,
          );
          if (!entailed) {
            const entry = registerMembership(c.ns);
            out.push([entry.wireName, nameOf(c.v)]);
          }
          break;
        }
        case "ruleCall": {
          const entry = registerRule(c.rule as RuleValue);
          const args = c.args.map((a) => lowerPos(a, `rule ${entry.wireName}`));
          if (entry.hasRet) {
            out.push([entry.wireName, ...args, nameOf(c.ret)]);
          } else {
            const usedElsewhere = (() => {
              const rest = new Set<number>();
              clauseListVars(list.filter((s) => s !== c), rest);
              return rest.has(c.ret.id) || outer.has(c.ret.id);
            })();
            if (usedElsewhere) {
              throw new Error(`ramose/query: rule "${entry.wireName}" binds nothing — its application has no value to use`);
            }
            out.push([entry.wireName, ...args]);
          }
          break;
        }
        case "orGroup": {
          if (c.branches.length === 0) {
            out.push(neverClause());
            break;
          }
          const inner = new Set<number>();
          c.branches.forEach((b) => clauseListVars(b, inner));
          const rest = clauseListVars(list.filter((s) => s !== c));
          const join = [...inner].filter((id) => rest.has(id) || outer.has(id));
          const scope = new Set([...outer, ...rest]);
          out.push([
            "or-join",
            join.map((id) => names.get(id) ?? nameOf(findVar(c, id))),
            ...c.branches.map((b) => ["and", ...lowerClauses(b, scope)]),
          ]);
          break;
        }
        case "notGroup": {
          const inner = clauseListVars(c.clauses);
          const rest = clauseListVars(list.filter((s) => s !== c));
          const join = [...inner].filter((id) => rest.has(id) || outer.has(id));
          const scope = new Set([...outer, ...rest]);
          const lowered = lowerClauses(c.clauses, scope);
          if (lowered.length === 0) {
            out.push(neverClause());
            break;
          }
          out.push(["not-join", join.map((id) => names.get(id) ?? nameOf(findVar(c, id))), ...lowered]);
          break;
        }
      }
    }
    return out;
  };

  /** Recover the var object for a join id (it is inside the group). */
  const findVar = (group: BClause, id: number): AnyVar => {
    let found: AnyVar | undefined;
    const scan = (list: readonly BClause[]): void => {
      for (const c of list) {
        if (found) return;
        switch (c._tag) {
          case "fact": {
            const e = c.eVar ?? c.e0;
            if (isVar(e) && e.id === id) found = e;
            const v = c.vVar ?? c.v0;
            if (isVar(v) && v.id === id) found = v;
            if (c.txVar?.id === id) found = c.txVar;
            if (c.opVar?.id === id) found = c.opVar;
            break;
          }
          case "cmp":
            for (const a of c.args) if (isVar(a) && a.id === id) found = a;
            break;
          case "fnBind":
            for (const a of c.args) if (isVar(a) && a.id === id) found = a;
            if (c.ret.id === id) found = c.ret;
            break;
          case "memberOf":
            if (c.v.id === id) found = c.v;
            break;
          case "ruleCall":
            for (const a of c.args) if (isVar(a) && a.id === id) found = a;
            if (c.ret.id === id) found = c.ret;
            break;
          case "orGroup":
            c.branches.forEach(scan);
            break;
          case "notGroup":
            scan(c.clauses);
            break;
        }
      }
    };
    scan([group]);
    if (!found) throw new Error("ramose/query: internal — join var not found in its group");
    return found;
  };

  const isWireVar = (x: unknown): x is string => typeof x === "string" && x.startsWith("?");

  /**
   * `:db/id` is not an attribute — the engine's `requireAttr` / `resolveAttrConst`
   * throw `unknown attribute :db/id` if we emit `[e, ":db/id", v]`. The id *is*
   * the entity, so this unifies the e-position with the value: a constant
   * binds the var via `ground` (the same primitive `Q.in` uses); two vars
   * share a name; blanks are a no-op (every entity has an id).
   */
  const lowerIdFact = (c: FactCommand<any>): unknown[] | undefined => {
    if (c.txVar !== undefined || c.opVar !== undefined) {
      throw new Error(
        "ramose/query: :db/id is the entity's identity, not a datom — it has no tx or op position",
      );
    }
    const ePos = c.eVar ?? c.e0;
    const vPos = c.vVar ?? c.v0;
    if (isVar(ePos) && isVar(vPos)) {
      const eName = names.get(ePos.id);
      const vName = names.get(vPos.id);
      if (eName !== undefined && vName !== undefined) {
        // identity binds the value var to the eid; `=` would require both
        // already bound and leave a projected id cell unbound.
        return eName === vName ? undefined : [["identity", eName], vName];
      }
      const n = eName ?? vName ?? nameOf(ePos);
      names.set(ePos.id, n);
      names.set(vPos.id, n);
      return undefined;
    }
    const e = lowerPos(ePos, "an entity position");
    const v = lowerPos(vPos, ":db/id's value");
    if (e === v || e === "_" || v === "_") return undefined;
    if (isWireVar(e) && !isWireVar(v)) return [["ground", v], e];
    if (isWireVar(v) && !isWireVar(e)) return [["ground", e], v];
    return neverClause();
  };

  const lowerFact = (c: FactCommand<any>): unknown[] | undefined => {
    if (c.attr?.ident === ":db/id") return lowerIdFact(c);
    const e = lowerPos(c.eVar ?? c.e0, "an entity position");
    const attr = c.attr?.ident ?? "_";
    const v = lowerPos(c.vVar ?? c.v0, attr === "_" ? "a value position" : `${attr}'s value`);
    const clause: unknown[] = [e, attr, v];
    if (c.txVar !== undefined || c.opVar !== undefined) {
      clause.push(c.txVar !== undefined ? nameOf(c.txVar) : "_");
    }
    if (c.opVar !== undefined) clause.push(nameOf(c.opVar));
    return clause;
  };

  const lowerCmp = (c: CmpCommand): unknown[][] => {
    const { op, args, ignoreCase } = c;
    // f.t compares as a basis t: the wire slot binds the tx *eid*, so a
    // numeric operand converts by the stable tx partition base
    const tSided = args.some((a) => isVar(a) && a.kind === "t");
    const operand = (a: Position): unknown => {
      if (isAggSpec(a)) {
        // top-level aggregate comparisons were routed to :having before this
        // walk; one that reaches here sits inside Q.or / Q.not or a rule body
        throw new Error(
          "ramose/query: a comparison over an aggregate cell cannot appear inside Q.or / Q.not or a rule body — :having filters whole groups, and there is no group where those lower; write it at the query's top level",
        );
      }
      if (isVar(a)) return nameOf(a);
      let v: unknown = a;
      if (op === "re-find?") return regexSource(v as RegExp | string);
      if (op === "in") {
        if (!Array.isArray(v)) throw new Error(`ramose/query: Q.in takes an array of values, got ${String(v)}`);
        return v.map(unwrapEidLike);
      }
      v = unwrapEidLike(v);
      if (tSided && typeof v === "number") return TX_BASE + v;
      return v;
    };
    if (op === "in") {
      const [subject, list] = args;
      const values = operand(list) as unknown[];
      if (Array.isArray(values) && values.length === 0) return [neverClause()];
      if (!isVar(subject)) {
        throw new Error("ramose/query: Q.in's first argument is a bound var");
      }
      // the var is bound, so the collection binding filters it — one row
      // per match, not one per value
      return [[["ground", values], [nameOf(subject), "..."]]];
    }
    if (ignoreCase) {
      if (args.some(isAggSpec)) {
        throw new Error(
          "ramose/query: ignoreCase cannot wrap an aggregate comparison — :having does not bind functions; write the comparison at the query's top level without ignoreCase, or fold through Q.call(\"lower-case\") before aggregating",
        );
      }
      const extras: unknown[][] = [];
      const folded = args.map((a) => {
        if (isVar(a)) {
          const out = freshName("l");
          extras.push([["lower-case", nameOf(a)], out]);
          return out;
        }
        if (isBlank(a) || a === undefined) {
          throw new Error("ramose/query: ignoreCase needs a bound var or a string on each side");
        }
        const v = unwrapEidLike(a);
        if (typeof v !== "string") {
          throw new Error("ramose/query: ignoreCase applies to strings");
        }
        return v.toLowerCase();
      });
      return [...extras, [[op, ...folded]]];
    }
    return [[[op, ...args.map(operand)]]];
  };

  // ── :having partition ────────────────────────────────────────────────────
  // A comparison that mentions an aggregate cell is a post-group filter: it
  // routes into the wire's `:having` section, never `:where` — the aggregate
  // is not bound until after grouping, so the placement is the semantics.
  // Everything else (group-*key* filters included: filtering groups by a key
  // equals filtering rows by that value) stays an ordinary clause. Resolved
  // before the projection lowers, because a referenced aggregate cell needs
  // an `(as … ?alias)` name in `:find`.
  const clauses = built.clauses;
  const havingCmps: CmpCommand[] = [];
  const rowClauses: BClause[] = [];
  for (const c of clauses) {
    if (c._tag === "cmp" && c.args.some(isAggSpec)) {
      if (c.ignoreCase) {
        throw new Error(
          "ramose/query: ignoreCase cannot wrap an aggregate comparison — :having does not bind functions",
        );
      }
      havingCmps.push(c);
    } else rowClauses.push(c);
  }
  const nameCells = havingCmps.length > 0;
  /** Two `AggSpec` values with one fn over one var are the same cell —
   * `Q.gt(Q.count(e), 5)` names the projected `Q.count(e)` without having
   * to be the same object. */
  const aggKey = (a: AggSpec): string => {
    const id = isFocusSentinel(a.v) && built.focus !== undefined ? built.focus.id : a.v.id;
    return `${a.fn}:${id}`;
  };
  /** The `:find` alias of each projected aggregate cell (set while the
   * projection flattens; every aggregate is aliased when `:having` names
   * any, so summarized-var name collisions cannot arise). */
  const aggAlias = new Map<string, string>();
  /** What each aliased cell answers over the empty set — for re-checking
   * `:having` on the client-synthesized all-aggregate row. */
  const emptyCells = new Map<string, unknown>();
  /** Vars projected as their own plain cell — the ones `:having` may name. */
  const plainCellVars = new Set<number>();

  // ── projection ───────────────────────────────────────────────────────────
  const where: unknown[] = [];
  const flats: FlatCell[] = [];
  const find: unknown[] = [];

  const readVar = (v: AnyVar): ((cell: unknown) => unknown) => {
    switch (v.kind) {
      case "entity":
      case "tx":
        // Projected entity/tx vars stay `{ id }` rows; the cell is the
        // branded number. `select({ id: N.id })` is a different path and
        // yields the number directly.
        return (cell) =>
          typeof cell === "number" ? { id: makeEid(cell) } : cell;
      case "t":
        return (cell) => (typeof cell === "number" ? cell - TX_BASE : cell);
      default:
        return (cell) => cell;
    }
  };

  const flattenCell = (path: readonly string[], cell: Cell): void => {
    if (isVar(cell)) {
      plainCellVars.add(cell.id);
      flats.push({ path, elem: nameOf(cell), read: readVar(cell) });
      return;
    }
    if (isAggSpec(cell)) {
      const v = isFocusSentinel(cell.v)
        ? built.focus ??
          (() => {
            throw new Error(
              "ramose/query: Q.focus needs a select focus — use it in .select(shape, extras) or Q.pull",
            );
          })()
        : cell.v;
      const read =
        v.kind === "t" && (cell.fn === "min" || cell.fn === "max")
          ? (x: unknown) => (typeof x === "number" ? x - TX_BASE : x)
          : (x: unknown) => x;
      let elem: unknown = [cell.fn, nameOf(v)];
      // `:having` names an aggregate by its `(as … ?alias)` name; aliasing
      // every aggregate keeps summarized-var names from colliding
      if (nameCells) {
        const alias = aggAlias.get(aggKey(cell)) ?? freshName("h");
        aggAlias.set(aggKey(cell), alias);
        emptyCells.set(alias, EMPTY_AGG[cell.fn]);
        elem = ["as", elem, alias];
      }
      flats.push({ path, elem, read, agg: cell.fn });
      return;
    }
    if (isPullSpec(cell)) {
      if (nameCells) {
        throw new Error(
          "ramose/query: an aggregate-cell comparison and Q.pull cannot share a projection — the server's :having names find cells and a pull is not one; project bound vars beside the aggregate instead",
        );
      }
      const map = shapeToPullMap(cell.shape);
      const focus = nameOf(cell.focus);
      where.push(...requiredClauses(focus, map));
      flats.push({
        path,
        elem: ["pull", focus, lowerPullPattern(map)],
        read: (c) => reshapePullResult(map, c),
      });
      return;
    }
    if (isDistinctSpec(cell)) {
      throw new Error(
        "ramose/query: Q.distinct(...) wraps the whole projection, not one cell",
      );
    }
    if (typeof cell === "object" && cell !== null) {
      for (const [k, sub] of Object.entries(cell as CellRecord)) {
        flattenCell([...path, k], sub as Cell);
      }
      return;
    }
    throw new Error(`ramose/query: projection cell at ${path.join(".") || "<root>"} is not a bound handle, Q.pull, or an aggregate`);
  };

  let finalizeRows: (tuples: unknown[][]) => unknown;
  let scalar = false;

  const proj = built.proj;
  if (isValueSpec(proj)) {
    flattenCell(["$"], proj.cell as Cell);
    find.push(flats[0]!.elem, ".");
    scalar = true;
    const aggFn = flats[0]!.agg;
    finalizeRows = (raw) => {
      const empty = aggFn !== undefined ? EMPTY_AGG[aggFn] : null;
      if (raw.length === 0) return aggFn !== undefined && emptyRowPasses() ? [empty] : [];
      return raw;
    };
  } else if (isIdsSpec(proj)) {
    find.push(nameOf(proj.v));
    finalizeRows = (tuples) =>
      tuples.map((t) =>
        typeof t[0] === "number" ? { id: makeEid(t[0]) } : t[0],
      );
  } else if (isPullSpec(proj)) {
    const map = shapeToPullMap(proj.shape);
    const focus = nameOf(proj.focus);
    where.push(...requiredClauses(focus, map));
    find.push(["pull", focus, lowerPullPattern(map)]);
    finalizeRows = (tuples) => tuples.map((t) => reshapePullResult(map, t[0]));
  } else {
    const cells = isRowsSpec(proj) ? proj.cells : proj;
    for (const [k, cell] of Object.entries(cells)) flattenCell([k], cell as Cell);
    find.push(...flats.map((f) => f.elem));
    // an ungrouped aggregate always answers one row: with no non-aggregate
    // cell there is nothing to group by, so the whole (possibly empty) match
    // set is the one group, and each fn answers for the empty set — the same
    // rule SQL's aggregate-without-GROUP-BY follows. A projection with a
    // group key correctly stays []: no rows, no groups.
    const aggOnly = flats.length > 0 && flats.every((f) => f.agg !== undefined);
    finalizeRows = (raw) =>
      (raw.length === 0 && aggOnly && emptyRowPasses() ? [flats.map((f) => EMPTY_AGG[f.agg!])] : raw).map((t) => {
        const row: Record<string, unknown> = {};
        flats.forEach((f, i) => {
          const value = f.read(t[i]);
          let at = row;
          for (let d = 0; d < f.path.length - 1; d++) {
            const k = f.path[d]!;
            at = (at[k] ??= {}) as Record<string, unknown>;
          }
          const leaf = f.path[f.path.length - 1]!;
          if (leaf === "…") {
            Object.assign(at, value);
          } else {
            at[leaf] = value;
          }
        });
        return row;
      });
  }

  // ── clauses + cursor ─────────────────────────────────────────────────────
  const projVars = new Set<number>();
  /** Value vars whose rows must not collapse — see `withVars`. Aggregates
   * always join; a plain projected value joins unless `Q.distinct`. */
  const provenanceVars = new Set<number>();
  const addProvenance = (v: AnyVar): void => {
    // an entity (or tx) var is an identity — its bindings are already
    // distinct rows; a value var is not, so it needs row provenance
    if (v.kind !== "entity" && v.kind !== "tx") provenanceVars.add(v.id);
  };
  const collectProjVars = (cell: Cell): void => {
    if (isVar(cell)) {
      projVars.add(cell.id);
      if (!built.distinct) addProvenance(cell);
    } else if (isAggSpec(cell)) {
      const v = isFocusSentinel(cell.v) ? (built.focus ?? cell.v) : cell.v;
      projVars.add(v.id);
      // aggregates always keep row provenance — set semantics would
      // collapse the rows they summarize
      addProvenance(v);
    } else if (isPullSpec(cell)) projVars.add(cell.focus.id);
    else if (isDistinctSpec(cell)) {
      throw new Error(
        "ramose/query: Q.distinct(...) wraps the whole projection, not one cell",
      );
    } else if (typeof cell === "object" && cell !== null) {
      for (const sub of Object.values(cell as CellRecord)) collectProjVars(sub as Cell);
    }
  };
  if (isIdsSpec(proj)) projVars.add(proj.v.id);
  else if (isPullSpec(proj)) projVars.add(proj.focus.id);
  else if (isValueSpec(proj)) collectProjVars(proj.cell as Cell);
  else collectProjVars(isRowsSpec(proj) ? proj.cells : (proj as CellRecord));

  where.unshift(...lowerClauses(rowClauses, projVars));

  // ── :having lowering ─────────────────────────────────────────────────────
  const havingCellName = (a: AggSpec): string => {
    const alias = aggAlias.get(aggKey(a));
    if (alias === undefined) {
      throw new Error(
        `ramose/query: Q.${a.fn === "count-distinct" ? "countDistinct" : a.fn}(...) is compared but never projected — a post-group filter names an aggregate cell of the row, so the same cell value must reach the projection`,
      );
    }
    return alias;
  };
  const lowerHavingCmp = (c: CmpCommand): unknown => {
    // same t-conversion rule as lowerCmp: a min/max over `f.t` cells binds
    // the tx eid, so a numeric operand converts by the tx partition base
    const tSided = c.args.some(
      (a) =>
        (isVar(a) && a.kind === "t") ||
        (isAggSpec(a) && a.v.kind === "t" && (a.fn === "min" || a.fn === "max")),
    );
    const operand = (a: Position): unknown => {
      if (isAggSpec(a)) return havingCellName(a);
      if (isVar(a)) {
        if (!plainCellVars.has(a.id)) {
          throw new Error(
            "ramose/query: a post-group comparison sees the group's row, so a var beside the aggregate cell must be a projected cell of it — project the var, or compare against a literal",
          );
        }
        return nameOf(a);
      }
      let v: unknown = a;
      if (c.op === "re-find?") return regexSource(v as RegExp | string);
      if (c.op === "in") {
        if (!Array.isArray(v)) throw new Error(`ramose/query: Q.in takes an array of values, got ${String(v)}`);
        return v.map(unwrapEidLike);
      }
      v = unwrapEidLike(v);
      if (tSided && typeof v === "number") return TX_BASE + v;
      return v;
    };
    return [[c.op, ...c.args.map(operand)]];
  };
  const having = havingCmps.map(lowerHavingCmp);

  /**
   * The synthesized empty-set row of an all-aggregate projection must still
   * pass `:having` — the peer never saw a group to filter. Same predicate
   * semantics as the engine's `evalHaving`, over the aliased cells' empty
   * values (every non-cell arg is already a resolved constant here: a var
   * beside an aggregate would make the projection not all-aggregate).
   */
  const emptyRowPasses = (): boolean =>
    having.every((clause) => {
      const [op, ...args] = (clause as unknown[][])[0]!;
      const vals = args.map((a) => (typeof a === "string" && emptyCells.has(a) ? emptyCells.get(a) : a));
      if (op === "in") {
        const [v, list] = vals;
        return Array.isArray(list) && list.some((x) => vkey(x) === vkey(v));
      }
      const f = PREDICATES[op as string];
      return f !== undefined && Boolean(f(...vals));
    });

  // A projected *value* var must not collapse rows that agree on the value:
  // two entities with the same title are two rows (and two entities with
  // the same rank are two rows to a sum). The entity position of each fact
  // that binds the value rides in `:with` — distinctness includes it
  // without projecting it (the nav lowering carried its root the same
  // way). A value bound by `Q.call` traces each var argument back to the
  // fact that bound it (or rides an entity/tx argument itself). Facts
  // inside an or-join count when the e-position is already bound at the
  // top level — a join var, or a handle the branches close over. `not`
  // does not bind, so it contributes no provenance. An e-var already in
  // the projection is grouping, not multiplicity, and stays out.
  // `Q.distinct` skips this for plain projected cells; aggregates still
  // join so a sum sees every row.
  const withVars: string[] = [];
  if (provenanceVars.size > 0) {
    const walkGroups = (list: readonly BClause[], visit: (c: BClause) => void): void => {
      for (const c of list) {
        visit(c);
        if (c._tag === "orGroup") c.branches.forEach((b) => walkGroups(b, visit));
      }
    };

    // `Q.call` results are not fact-bound. Follow ret → args until every
    // projected (or aggregated) cell names the vars a fact can ride.
    const fnBindArgs = new Map<number, readonly Position[]>();
    walkGroups(clauses, (c) => {
      if (c._tag === "fnBind") fnBindArgs.set(c.ret.id, c.args);
    });
    const rideableDirect: AnyVar[] = [];
    const queue = [...provenanceVars];
    for (let i = 0; i < queue.length; i++) {
      const args = fnBindArgs.get(queue[i]!);
      if (args === undefined) continue;
      for (const a of args) {
        if (!isVar(a)) continue;
        if (a.kind === "entity" || a.kind === "tx") {
          rideableDirect.push(a);
          continue;
        }
        if (!provenanceVars.has(a.id)) {
          provenanceVars.add(a.id);
          queue.push(a.id);
        }
      }
    }

    // An e-var minted only inside a branch is not bound after the or-join
    // unless it is a join var. Riding one that is not available is a
    // query error, so nested facts only contribute already-visible e's.
    const topLevelBound = new Set<number>();
    for (const c of clauses) {
      switch (c._tag) {
        case "fact":
          factVars(c, topLevelBound);
          break;
        case "fnBind":
          for (const a of c.args) if (isVar(a)) topLevelBound.add(a.id);
          topLevelBound.add(c.ret.id);
          break;
        case "memberOf":
          topLevelBound.add(c.v.id);
          break;
        case "ruleCall":
          for (const a of c.args) if (isVar(a)) topLevelBound.add(a.id);
          topLevelBound.add(c.ret.id);
          break;
        case "orGroup": {
          const inner = new Set<number>();
          c.branches.forEach((b) => clauseListVars(b, inner));
          const rest = clauseListVars(clauses.filter((s) => s !== c));
          for (const id of inner) {
            if (rest.has(id) || projVars.has(id) || topLevelBound.has(id)) {
              topLevelBound.add(id);
            }
          }
          break;
        }
      }
    }

    const seen = new Set<number>();
    const ride = (e: unknown, requireBound: boolean): void => {
      if (!isVar(e) || projVars.has(e.id) || seen.has(e.id)) return;
      if (requireBound && !topLevelBound.has(e.id)) return;
      seen.add(e.id);
      withVars.push(nameOf(e));
    };
    for (const v of rideableDirect) ride(v, true);

    const walkFacts = (list: readonly BClause[], nested: boolean): void => {
      for (const c of list) {
        if (c._tag === "fact") {
          const v = c.vVar ?? c.v0;
          const bindsValue =
            (isVar(v) && provenanceVars.has(v.id)) ||
            (c.txVar !== undefined && provenanceVars.has(c.txVar.id)) ||
            (c.opVar !== undefined && provenanceVars.has(c.opVar.id));
          if (!bindsValue) continue;
          ride(c.eVar ?? c.e0, nested);
        } else if (c._tag === "orGroup") {
          c.branches.forEach((b) => walkFacts(b, true));
        }
      }
    };
    walkFacts(clauses, false);
  }

  const order: { var: string; dir: OrderDir; empty: OrderEmpty }[] = [];

  const queryAggregates = flats.some((f) => f.agg !== undefined);

  const bindOrderPath = (
    path: readonly string[],
    revs: readonly boolean[],
    dir: OrderDir,
    empty: OrderEmpty,
  ): void => {
    const group = built.groupKeys.get(groupKeyId(path, revs));
    if (group !== undefined) {
      order.push({ var: nameOf(group), dir, empty });
      return;
    }
    if (queryAggregates) {
      throw new Error(
        `ramose/query: orderBy(${path.join(" → ")}) is not a group key of this select — an aggregate query orders only by a projected cell`,
      );
    }
    if (built.focus === undefined) {
      throw new Error(
        "ramose/query: orderBy(attribute) needs a select focus — order a multi-root projection by a projected cell or bound var",
      );
    }
    const bound = lowerOrderPath(nameOf(built.focus), path, revs);
    where.push(...bound.clauses);
    order.push({ var: bound.var, dir, empty });
  };

  // Bound vars / aggregates do not need a select focus. Keyset paging still
  // does: `after()` appends the root eid as tie-breaker and raises if a
  // multi-root projection has none.
  const orderFromPicked = (picked: unknown, label: string, dir: OrderDir, empty: OrderEmpty): void => {
    if (isVar(picked)) {
      const v = isFocusSentinel(picked)
        ? built.focus ??
          (() => {
            throw new Error("ramose/query: Q.focus needs a select focus — order a projected cell instead");
          })()
        : picked;
      order.push({ var: nameOf(v), dir, empty });
      return;
    }
    if (isAggSpec(picked)) {
      const v = isFocusSentinel(picked.v)
        ? built.focus ??
          (() => {
            throw new Error("ramose/query: Q.focus needs a select focus — order a projected cell instead");
          })()
        : picked.v;
      // the engine orders an aggregate by the summarized variable
      order.push({ var: nameOf(v), dir, empty });
      return;
    }
    if (isPathCarrier(picked)) {
      if (cardsOf(picked).includes("many")) {
        throw new Error(
          `ramose/query: orderBy(${pathOf(picked).join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
        );
      }
      bindOrderPath(pathOf(picked), revsOf(picked), dir, empty);
      return;
    }
    throw new Error(
      `ramose/query: ${label} did not pick a bound var, projected cell, or attribute`,
    );
  };

  const lookupCell = (tree: unknown, key: string): unknown => {
    if (tree !== null && typeof tree === "object" && !Array.isArray(tree)) {
      return (tree as Record<string, unknown>)[key];
    }
    return undefined;
  };

  if (built.order.length > 0) {
    for (const o of built.order) {
      if (o.kind === "cell") {
        orderFromPicked(o.cell, "orderBy", o.dir, o.empty);
      } else if (o.kind === "path") {
        bindOrderPath(o.path, o.revs, o.dir, o.empty);
      } else {
        throw new Error("ramose/query: orderBy leftover is not a projected cell or attribute path");
      }
    }
  }

  if (!qv.stripCursor) {
    const cells = projectionCells(proj);
    for (const o of qv.orders) {
      let picked: unknown = o.key;
      if (typeof o.key === "function") {
        picked = (o.key as (row: unknown) => unknown)(cells);
      } else if (typeof o.key === "string") {
        picked = lookupCell(cells, o.key);
        if (picked === undefined) {
          throw new Error(
            `ramose/query: orderBy("${o.key}") — the projection has no column "${o.key}"`,
          );
        }
      }
      orderFromPicked(picked, "orderBy", o.dir, o.empty);
    }
  }

  if (isValueSpec(proj) && (order.length > 0 || qv.limitN !== undefined || qv.offsetN !== undefined || qv.seek !== undefined)) {
    throw new Error(
      "ramose/query: Q.value is a single value — orderBy / limit / offset / after page rows",
    );
  }

  const boundCount = (n: number | undefined, what: string): number | undefined => {
    if (n === undefined) return undefined;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`ramose/query: ${what} takes a non-negative integer, got ${String(n)}`);
    }
    return n;
  };
  const take = qv.stripCursor ? undefined : qv.take;
  const seek = qv.stripCursor ? undefined : qv.seek;
  // `one()` asks for one row; `oneOrFail()` asks for two so a second match
  // is witnessed. A `limit(n)` on the query value wins over a pipeline stage.
  const limit =
    take === "one"
      ? 1
      : take === "oneOrFail"
        ? 2
        : boundCount(qv.stripCursor ? undefined : (qv.limitN ?? built.limit), "limit");
  const offset = boundCount(qv.stripCursor ? undefined : (qv.offsetN ?? built.offset), "offset");

  // Keyset paging: a cursor is a position in a *total* order, so the entity
  // id rides as the final tie-breaker (unless a sort key already is it), and
  // every sort-key variable rides in `find` after the row cells — that is
  // what the client mints the next cursor from.
  const pagedVars: string[] = [];
  if (seek !== undefined) {
    if (offset !== undefined) {
      throw new Error(
        "ramose/query: after(...) and offset both say where the page starts — a cursor already is the offset",
      );
    }
    if (order.length === 0) {
      throw new Error(
        "ramose/query: after(...) pages a sorted query — add an orderBy for the cursor to be a position in",
      );
    }
    if (built.focus === undefined) {
      throw new Error(
        "ramose/query: after(...) pages by a root entity's id as tie-breaker — a multi-root projection has no paging root",
      );
    }
    const root = nameOf(built.focus);
    if (!order.some((o) => o.var === root)) {
      order.push({ var: root, dir: "asc", empty: "last" });
    }
    pagedVars.push(...order.map((o) => o.var));
    if (seek !== null && seek.keys.length !== order.length) {
      throw new Error(
        `ramose/query: this cursor does not fit — it carries ${seek.keys.length} sort-key values and the query orders by ${order.length}; a cursor only continues the query that minted it`,
      );
    }
    find.push(...pagedVars);
  }
  const baseLen = find.length - pagedVars.length;

  const query: Record<string, unknown> = {
    find,
    where,
    ...(withVars.length > 0 ? { with: withVars } : {}),
    ...(having.length > 0 ? { having } : {}),
    ...(ruleDefs.length > 0 ? { rules: ruleDefs } : {}),
    ...(order.length > 0 ? { order } : {}),
    ...(seek !== undefined && seek !== null ? { after: [...seek.keys] } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };

  return {
    query,
    finalize: (result) => {
      if (scalar) {
        const cell = flats[0]!;
        const empty = cell.agg !== undefined ? EMPTY_AGG[cell.agg] : null;
        if (result === null || result === undefined) {
          return cell.agg !== undefined && emptyRowPasses() ? cell.read(empty) : null;
        }
        if (Array.isArray(result)) {
          const first = result[0];
          const raw = Array.isArray(first) ? first[0] : first;
          if (raw === undefined) {
            return cell.agg !== undefined && emptyRowPasses() ? cell.read(empty) : null;
          }
          return cell.read(raw);
        }
        return cell.read(result);
      }
      const tuples = Array.isArray(result) ? (result as unknown[][]) : [];
      const rows = finalizeRows(tuples) as readonly unknown[];
      // the cursor is the last raw row's sort-key cells (everything past the
      // projection); `null` when the page is over — it came back empty, or
      // shorter than its limit, so there is nothing past it to ask for
      if (seek !== undefined) {
        const last = tuples[tuples.length - 1];
        return {
          rows,
          cursor:
            !Array.isArray(last) ||
            (typeof limit === "number" && tuples.length < limit)
              ? null
              : { _tag: "Cursor", keys: last.slice(baseLen) },
        } satisfies Page;
      }
      // `one()` picks the cell; `oneOrFail()` names the miss. The NotOne is
      // returned (not thrown) so `db.query` fails its Effect with it.
      if (take !== undefined) {
        if (take === "one") return rows[0] ?? null;
        if (rows.length === 1) return rows[0];
        return new NotOne({
          message:
            rows.length === 0
              ? "ramose/query: expected exactly one row, found none"
              : "ramose/query: expected exactly one row, found 2",
          found: rows.length === 0 ? 0 : 2,
        });
      }
      return rows;
    },
  };
};
