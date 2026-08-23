/**
 * `Query.q(params?, body)` — one constructor, one kind of object.
 *
 * A query is a rule: a head (its declared params) plus a body (its clauses
 * and its projection). The body is a generator of kernel clauses that
 * returns the projection, or a function returning a closed pipeline — two
 * spellings of the same `(head, body)` value, so escalating from pipe to
 * generator is un-sugaring, never rewriting.
 *
 * Inputs are declared, output is inferred: the params record is the query's
 * binding type (collisions are compile errors at the merge site, the
 * interface moves only when the head moves), while the output is the type
 * of one return expression — nothing merges there, so inference is sound.
 *
 * Queries compose one way — generator delegation — at three altitudes:
 * `yield* frag(handle)` (build-inlined fragment), `yield* q.open(p)` (a
 * whole closed query as a subquery), and `Query.rule` (engine-expanded,
 * which is what makes recursion work). Effect appears nowhere here: a
 * built query is inert data — hashable for live identity, stable as a
 * hook dependency — and computation starts at `db.query`.
 */

import { PREDICATES, vkey } from "../../internal/core/query/builtins.ts";
import { TX_BASE } from "../../internal/core/schema.ts";
import { makeEid } from "../Eid.ts";
import { NotOne } from "../Errors.ts";
import type { AnyEntity } from "../Entity.ts";
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
  bindParams,
  holesBinder,
  isParam,
  isParamHole,
  params as makeParams,
  type AnyParam,
  type AnyParamSet,
  type ParamBinder,
  type ParamBindings,
  type ParamsOf,
  type ParamsSpec,
} from "../Params.ts";
import { bindPullParams, lowerPullPattern, reshapePullResult } from "../Pull.ts";
import {
  Q,
  isPullSpec,
  isRowsSpec,
  isAggSpec,
  isVar,
  isBlank,
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
  type FactCommand,
  type Fragment,
  type Position,
  type Projection,
  type PullSpec,
  type QueryGen,
  type RowOfProjection,
  type SpliceCommand,
  type Var,
} from "./kernel.ts";

// ── keyset paging ───────────────────────────────────────────────────────────

/**
 * Where a page ended — feed it to `q.after` to get the next one. Opaque: the
 * `keys` are the last row's sort-key values (the entity-id tie-breaker
 * included), and they mean something only to the query that minted them —
 * `.after` rejects a cursor whose shape does not fit. Keep it in memory
 * between pages; it is not designed to survive serialization (a `Date` key
 * that round-trips as a string would sort as one).
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

export interface BuiltOrder {
  readonly path: readonly string[];
  readonly revs: readonly boolean[];
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

export type PipeStage =
  | { readonly kind: "frag"; readonly frag: Fragment<AnyVar, unknown> }
  | { readonly kind: "select"; readonly shape: Shape }
  | {
      readonly kind: "orderBy";
      readonly key: string | PathCarrier;
      readonly dir: OrderDir;
      readonly empty: OrderEmpty;
    }
  | { readonly kind: "limit"; readonly n: number | AnyParam }
  | { readonly kind: "offset"; readonly n: number | AnyParam }
  | { readonly kind: "ids" };

/**
 * The pipe surface's incremental builder for the same `(params, body)`
 * value `Query.q` writes directly. `Row` is a phantom: the row the
 * pipeline's terminals have shaped so far. In a generator body the same
 * value is a clause source: `yield* entities(Issue)` mints the branded
 * focus var and contributes membership.
 */
export interface Pipeline<Row = unknown> {
  readonly _tag: "Pipeline";
  readonly ns: AnyEntity;
  readonly stages: readonly PipeStage[];
  readonly _row?: Row;
  [Symbol.iterator](): Iterator<never, Var<EidCell>, any>;
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

/** The arguments `open` rebinds the opened query's params from: an outer
 * param token to forward, a bound handle to correlate on, or a literal. */
export type OpenArgs<PB> = { readonly [K in keyof PB]: Var<any> | AnyParam | PB[K] };

interface OpenCommand<Row> extends SpliceCommand {
  readonly _row?: Row;
  [Symbol.iterator](): Iterator<never, OpenResult<Row>, any>;
}

/**
 * A closed query value: `(params, body)`, runnable by `db.query` / `db.live`
 * and delegable into other builds via {@link QueryObject.open}. `Row` is
 * the inferred row; `PB` the declared bindings record; `Out` is what a
 * terminal resolves to — the rows array by default, one row (or `null`)
 * after {@link QueryObject.one} / {@link QueryObject.oneOrFail}, a
 * {@link Page} after {@link QueryObject.after}.
 */
export interface QueryObject<Row = unknown, PB = never, Out = readonly Row[]> {
  readonly _tag: "Query";
  /** The declared head, if any. */
  readonly paramsSpec: ParamsSpec | undefined;
  /** @internal the token set the body was built against */
  readonly paramSet: AnyParamSet | undefined;
  /** @internal provenance: re-run per inclusion, so vars stay hygienic */
  readonly body: (p: never) => unknown;
  /** @internal `logic()` strips cursor stages instead of failing `open` */
  readonly stripCursor: boolean;
  /** @internal `one()` / `oneOrFail()` — forced `limit 1`/`2`, unwrapped. */
  readonly take: "one" | "oneOrFail" | undefined;
  /** @internal the keyset cursor `after(...)` seeks past; `null` is page one. */
  readonly seek: Cursor | null | undefined;

  /**
   * Delegate this whole query into an enclosing build: its clauses inline,
   * its declared params rebind from `args` — an inner need satisfied by a
   * local handle stays internal; one forwarded from an outer param is a
   * visible choice — and it answers `{ focus, cols }` to keep constraining.
   * Cursor terminals don't delegate: extend then order, or strip with
   * {@link QueryObject.logic}.
   */
  open(
    ...args: [PB] extends [never] ? [] : [args: OpenArgs<PB>]
  ): OpenCommand<Row>;

  /** This query without its cursor (orderBy/limit/offset/one/after) — the
   * logic composes; the cursor was post-processing for the outermost query. */
  logic(): QueryObject<Row, PB>;

  /**
   * At most one row. Lowering forces `limit 1`; the result is that row or
   * `null`, the same absence `db.pull` uses. Extra matches are not fetched.
   */
  one(): QueryObject<Row, PB, Row | null>;
  /**
   * Exactly one row. Lowering forces `limit 2` so a second match is
   * witnessed without pulling a whole page, and `db.query` fails with `NotOne`
   * when the peer answers zero or two.
   */
  oneOrFail(): QueryObject<Row, PB, Row>;
  /**
   * Keyset-page a sorted query: the result becomes a {@link Page}, whose
   * `cursor` is where it ended — pass `null` for the first page and the
   * previous page's cursor after that. Needs an `orderBy` (the cursor is a
   * position in the sort); the entity id rides as a final tie-breaker, so
   * rows that tie on every key still land on exactly one page. The seek is
   * the peer's: `limit(n)` is n rows *past* the cursor, and unlike `offset`
   * the walk does not shift when rows are inserted before it.
   */
  after(cursor: Cursor | null): QueryObject<Row, PB, Page<Row>>;

  /** Phantom — the inferred row. Never present at runtime. */
  readonly _row?: Row;
  /** Phantom — the declared bindings record. Never present at runtime. */
  readonly _params?: PB;
  /** Phantom — what a terminal resolves to. Never present at runtime. */
  readonly _out?: Out;
}

export type AnyQueryObject = QueryObject<any, any, any>;

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
export type Row<Q> = Q extends QueryObject<infer R, any, any> ? R : never;

/** The readonly array of {@link Row} — what `db.query` resolves an unpaged,
 * untaken query to. */
export type Rows<Q> = readonly Row<Q>[];

export const isQueryObject = (x: unknown): x is AnyQueryObject =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "Query";

/** What one build pass of a query value produced. */
interface Built {
  readonly clauses: BClause[];
  readonly proj: Projection | IdsSpec;
  /** The select/pipeline focus — what `open` hands back, and what the
   * cursor's sort paths walk from. */
  readonly focus: AnyVar | undefined;
  readonly order: readonly BuiltOrder[];
  readonly limit: number | AnyParam | undefined;
  readonly offset: number | AnyParam | undefined;
}

const isGen = (x: unknown): x is QueryGen<unknown> =>
  typeof x === "object" && x !== null && typeof (x as Iterator<unknown>).next === "function";

/** Run the body once against `p`, collecting into `ctx`. */
const runInto = (
  qv: AnyQueryObject,
  p: unknown,
  ctx: BuildCtx,
  stripCursor: boolean,
): Built => {
  const out = (qv.body as (p: unknown) => unknown)(p);
  if (isPipeline(out)) return assemblePipeline(out, ctx, stripCursor);
  if (isGen(out)) {
    const proj = runBody(out, ctx);
    return {
      clauses: ctx.clauses,
      proj: normalizeProj(proj),
      focus: focusOf(proj),
      order: [],
      limit: undefined,
      offset: undefined,
    };
  }
  throw new Error(
    "ramose/query: a Query.q body is a generator of clauses returning the projection, or a function returning a pipeline",
  );
};

const normalizeProj = (proj: unknown): Projection | IdsSpec => {
  if (isVar(proj)) return { _tag: "idsSpec", v: proj };
  if (isPullSpec(proj) || isRowsSpec(proj)) return proj;
  if (typeof proj === "object" && proj !== null && !Array.isArray(proj)) {
    const cells = proj as CellRecord;
    if (Object.keys(cells).length === 0) {
      throw new Error("ramose/query: the body returned an empty projection — name at least one cell");
    }
    return cells;
  }
  throw new Error(
    "ramose/query: the body must return its projection — Q.pull(focus, shape), Q.rows({ … }), a record of bound handles, or a focus var for bare ids",
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
  let selectFocus: AnyVar = root;
  let projectIds = false;
  const order: BuiltOrder[] = [];
  let limit: number | AnyParam | undefined;
  let offset: number | AnyParam | undefined;
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
        projectIds = false;
        break;
      case "ids":
        projectIds = true;
        break;
      case "orderBy":
        order.push(resolveOrderKey(st, select));
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
  return {
    clauses: ctx.clauses,
    proj:
      select !== undefined && !projectIds
        ? { _tag: "pullSpec", focus: selectFocus, shape: select }
        : { _tag: "idsSpec", v: focus },
    focus: select !== undefined && !projectIds ? selectFocus : focus,
    order,
    limit,
    offset,
  };
};

/** A sort key: a selected column's name, or an attr path directly. */
const resolveOrderKey = (
  st: Extract<PipeStage, { kind: "orderBy" }>,
  select: Shape | undefined,
): BuiltOrder => {
  let carrier: PathCarrier;
  if (typeof st.key === "string") {
    if (select === undefined) {
      throw new Error(`ramose/query: orderBy("${st.key}") names a selected column — select(...) first, or pass the attribute itself`);
    }
    let field = (select as Record<string, unknown>)[st.key];
    if (field === undefined) {
      throw new Error(`ramose/query: orderBy("${st.key}") — the select shape has no column "${st.key}"`);
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
      throw new Error(`ramose/query: orderBy("${st.key}") — a sort key is a direct attribute column`);
    }
    carrier = field as PathCarrier;
  } else {
    carrier = st.key;
  }
  const path = pathOf(carrier);
  if (cardsOf(carrier).includes("many")) {
    throw new Error(
      `ramose/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
    );
  }
  return { path, revs: revsOf(carrier), dir: st.dir, empty: st.empty };
};

// ── Query.q ─────────────────────────────────────────────────────────────────

/** What a body may produce. */
export type QueryBody<P, Prj> = (p: P) => QueryGen<Prj> | Pipeline<any>;

type RowFromBody<B> = B extends (p: never) => infer Out
  ? Out extends QueryGen<infer Prj>
    ? Prj extends AnyVar
      ? { readonly id: number }
      : RowOfProjection<Prj>
    : Out extends Pipeline<infer Row>
      ? Row
      : never
  : never;

export const makeQueryObject = <Row, PB>(
  paramsSpec: ParamsSpec | undefined,
  paramSet: AnyParamSet | undefined,
  body: (p: never) => unknown,
  stripCursor: boolean,
  take?: "one" | "oneOrFail",
  seek?: Cursor | null,
): QueryObject<Row, PB> => {
  const self: QueryObject<Row, PB> = {
    _tag: "Query",
    paramsSpec,
    paramSet,
    body,
    stripCursor,
    take,
    seek,
    open: ((args?: Record<string, unknown>) => openCommand(self, args)) as QueryObject<Row, PB>["open"],
    logic: () => makeQueryObject<Row, PB>(paramsSpec, paramSet, body, true),
    one: () => {
      if (seek !== undefined) {
        throw new Error(
          "ramose/query: one() unwraps a single row, and after(...) pages many — a paged query keeps its rows",
        );
      }
      return makeQueryObject(paramsSpec, paramSet, body, stripCursor, "one") as never;
    },
    oneOrFail: () => {
      if (seek !== undefined) {
        throw new Error(
          "ramose/query: oneOrFail() unwraps a single row, and after(...) pages many — a paged query keeps its rows",
        );
      }
      return makeQueryObject(paramsSpec, paramSet, body, stripCursor, "oneOrFail") as never;
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
      return makeQueryObject(paramsSpec, paramSet, body, stripCursor, undefined, cursor) as never;
    },
  };
  return self;
};

/**
 * Build a query. `Query.q(body)` for a paramless one;
 * `Query.q({ me: Ramose.EidOf(User), … }, body)` declares the head. The
 * body receives the param tokens and returns the projection; both the pipe
 * and generator spellings denote the same value.
 */
export function q<B extends (p: never) => QueryGen<any> | Pipeline<any>>(
  body: B,
): QueryObject<RowFromBody<B>, never>;
export function q<
  const Spec extends ParamsSpec,
  B extends (p: ParamsOf<Spec>) => QueryGen<any> | Pipeline<any>,
>(spec: Spec, body: B): QueryObject<RowFromBody<B>, ParamBindings<Spec>>;
export function q(
  specOrBody: ParamsSpec | ((p: never) => unknown),
  body?: (p: never) => unknown,
): AnyQueryObject {
  if (typeof specOrBody === "function") {
    return makeQueryObject(undefined, undefined, specOrBody, false);
  }
  if (typeof body !== "function") {
    throw new Error("ramose/query: Query.q(params, body) takes the body as its second argument");
  }
  const set = makeParams(specOrBody);
  return makeQueryObject(specOrBody, set as AnyParamSet, body, false);
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

const openCommand = <Row>(qv: AnyQueryObject, args: Record<string, unknown> | undefined): OpenCommand<Row> => {
  const cmd: OpenCommand<Row> = {
    _tag: "splice",
    splice: (ctx) => {
      const p: Record<string, unknown> = {};
      for (const key of Object.keys(qv.paramSet ?? qv.paramsSpec ?? {})) {
        const supplied = args?.[key];
        if (supplied === undefined) {
          throw new Error(
            `ramose/query: q.open(...) must supply "${key}" — pass a bound handle, an outer param token, or a literal`,
          );
        }
        p[key] = supplied;
      }
      const built = runInto(qv, p, ctx, qv.stripCursor);
      if (built.order.length > 0 || built.limit !== undefined || built.offset !== undefined || qv.take !== undefined || qv.seek !== undefined) {
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
  <Row, PB>(qv: QueryObject<Row, PB>): QueryObject<Row & RowOfProjection<Extra>, PB> =>
    makeQueryObject(
      qv.paramsSpec,
      qv.paramSet,
      function* (p: Record<string, unknown>) {
        const { focus, cols } = (yield* openCommand(qv, p)) as OpenResult;
        const extra = yield* body(focus);
        return Q.row(cols, extra);
      } as never,
      false,
    );

/** Shape-preserving sibling of {@link enrich}: extra constraints, same row. */
export const refine =
  (frag: Fragment<Var<EidCell>, unknown>) =>
  <Row, PB>(qv: QueryObject<Row, PB>): QueryObject<Row, PB> =>
    makeQueryObject(
      qv.paramsSpec,
      qv.paramSet,
      function* (p: Record<string, unknown>) {
        const { focus, cols } = (yield* openCommand(qv, p)) as OpenResult;
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

/**
 * The lowered wire AST with param holes left as `{ $param: key }` instead
 * of bound values. Subscription keys use this so a params query is
 * `astKey + paramsKey` and does not re-lower on every bindings change.
 */
export const lowerQueryAst = (qv: AnyQueryObject): Record<string, unknown> =>
  lowerQueryObject(qv, undefined, { holes: true }).query;

export const lowerQueryObject = (
  qv: AnyQueryObject,
  bindings?: Readonly<Record<string, unknown>>,
  opts?: { readonly holes?: boolean },
): LoweredKernelQuery => {
  resetGensym();
  const binder =
    opts?.holes === true ? holesBinder() : bindParams(qv.paramSet, bindings);
  const ctx: BuildCtx = { clauses: [] };
  const built = runInto(qv, qv.paramSet ?? {}, ctx, qv.stripCursor);

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
  const byNs = new Map<AnyEntity, RuleEntry>();
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

  const registerMembership = (ns: AnyEntity): RuleEntry => {
    const seen = byNs.get(ns);
    if (seen) return seen;
    const wireName = `is${ns.ns.charAt(0).toUpperCase()}${ns.ns.slice(1)}`.replace(/[^A-Za-z0-9_]/g, "_");
    claimName(wireName, ns);
    const entry: RuleEntry = { wireName, hasRet: false };
    byNs.set(ns, entry);
    const e = freshName("m");
    const idents = Object.values(ns.fields).map((a) => (a as { ident: string }).ident);
    ruleDefs.push([[wireName, e], ["or", ...idents.map((ident) => [e, ident, "_"])]]);
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
        case "whenGroup":
          clauseListVars(c.clauses, into);
          break;
      }
    }
    return into;
  };

  // ── positions ────────────────────────────────────────────────────────────
  const lowerConst = (v: unknown, use: string): unknown => {
    if (isParam(v)) return unwrapEidLike(binder.resolve(v, use));
    return unwrapEidLike(v);
  };

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
          out.push(...lowerCmp(c.op, c.args));
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
        case "whenGroup":
          // top-level groups were resolved before lowering; one that survives
          // is inside a branch whose truth an off gate would corrupt
          throw new Error(
            "ramose/query: Q.when(...) cannot appear inside Q.or / Q.not or a rule body — an off gate lowers to no clauses, which under `or` would make the branch vacuously true. Gate at the query's top level",
          );
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
          case "whenGroup":
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
        return eName === vName ? undefined : [["=", eName, vName]];
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

  const lowerCmp = (op: string, args: readonly Position[]): unknown[][] => {
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
      if (isParam(a)) v = binder.resolve(a, `${op}(...)`);
      if (isParamHole(v)) return v;
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
  const clauses = resolveWhens(built.clauses, binder);
  const havingCmps: CmpCommand[] = [];
  const rowClauses: BClause[] = [];
  for (const c of clauses) {
    if (c._tag === "cmp" && c.args.some(isAggSpec)) havingCmps.push(c);
    else rowClauses.push(c);
  }
  const nameCells = havingCmps.length > 0;
  /** Two `AggSpec` values with one fn over one var are the same cell —
   * `Q.gt(Q.count(e), 5)` names the projected `Q.count(e)` without having
   * to be the same object. */
  const aggKey = (a: AggSpec): string => `${a.fn}:${a.v.id}`;
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
        return (cell) => (typeof cell === "number" ? makeEid(cell) : cell);
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
      const read =
        cell.v.kind === "t" && (cell.fn === "min" || cell.fn === "max")
          ? (x: unknown) => (typeof x === "number" ? x - TX_BASE : x)
          : (x: unknown) => x;
      let elem: unknown = [cell.fn, nameOf(cell.v)];
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
        elem: ["pull", focus, bindPullParams(lowerPullPattern(map), binder.resolve)],
        read: (c) => reshapePullResult(map, c),
      });
      return;
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

  const proj = built.proj;
  if (isIdsSpec(proj)) {
    find.push(nameOf(proj.v));
    finalizeRows = (tuples) => tuples.map((t) => (typeof t[0] === "number" ? makeEid(t[0]) : t[0]));
  } else if (isPullSpec(proj)) {
    const map = shapeToPullMap(proj.shape);
    const focus = nameOf(proj.focus);
    where.push(...requiredClauses(focus, map));
    find.push(["pull", focus, bindPullParams(lowerPullPattern(map), binder.resolve)]);
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
  /** Aggregated *value* vars: their rows must not collapse — see `withVars`. */
  const aggValueVars = new Set<number>();
  const collectProjVars = (cell: Cell): void => {
    if (isVar(cell)) projVars.add(cell.id);
    else if (isAggSpec(cell)) {
      projVars.add(cell.v.id);
      // an entity (or tx) var is an identity — its bindings are already
      // distinct rows; a value var is not, so it needs row provenance
      if (cell.v.kind !== "entity" && cell.v.kind !== "tx") aggValueVars.add(cell.v.id);
    } else if (isPullSpec(cell)) projVars.add(cell.focus.id);
    else if (typeof cell === "object" && cell !== null) {
      for (const sub of Object.values(cell as CellRecord)) collectProjVars(sub as Cell);
    }
  };
  if (isIdsSpec(proj)) projVars.add(proj.v.id);
  else if (isPullSpec(proj)) projVars.add(proj.focus.id);
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
            "ramose/query: a post-group comparison sees the group's row, so a var beside the aggregate cell must be a projected cell of it — project the var, or compare against a literal or param",
          );
        }
        return nameOf(a);
      }
      let v: unknown = a;
      if (isParam(a)) v = binder.resolve(a, `${c.op}(...)`);
      if (isParamHole(v)) return v;
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

  // Aggregating over a *value* var must not collapse rows that agree on the
  // value: two entities with the same rank are two rows to a sum. The entity
  // position of each fact that binds an aggregated value rides in `:with` —
  // distinctness includes it without projecting it (the nav lowering carried
  // its root the same way). An e-var already in the projection is grouping,
  // not multiplicity, and stays out.
  // Top-level facts only: a var bound solely inside an or/not group is not
  // bound at the query's top level, so it cannot ride `:with` (and gated
  // groups were already spliced inline by resolveWhens).
  const withVars: string[] = [];
  if (aggValueVars.size > 0) {
    const seen = new Set<number>();
    for (const c of clauses) {
      if (c._tag !== "fact") continue;
      const v = c.vVar ?? c.v0;
      const bindsAgg =
        (isVar(v) && aggValueVars.has(v.id)) ||
        (c.txVar !== undefined && aggValueVars.has(c.txVar.id)) ||
        (c.opVar !== undefined && aggValueVars.has(c.opVar.id));
      if (!bindsAgg) continue;
      const e = c.eVar ?? c.e0;
      if (isVar(e) && !projVars.has(e.id) && !seen.has(e.id)) {
        seen.add(e.id);
        withVars.push(nameOf(e));
      }
    }
  }

  const order: { var: string; dir: OrderDir; empty: OrderEmpty }[] = [];
  if (built.order.length > 0) {
    if (built.focus === undefined) {
      throw new Error("ramose/query: orderBy needs the select focus — a multi-root projection orders by its own bound vars");
    }
    const root = nameOf(built.focus);
    for (const o of built.order) {
      const bound = lowerOrderPath(root, o.path, o.revs);
      where.push(...bound.clauses);
      order.push({ var: bound.var, dir: o.dir, empty: o.empty });
    }
  }

  const boundCount = (
    n: number | AnyParam | undefined,
    what: string,
  ): number | { readonly $param: string } | undefined => {
    if (n === undefined) return undefined;
    const v = isParam(n) ? binder.resolve(n, what) : n;
    if (isParamHole(v)) return v;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`ramose/query: ${what} takes a non-negative integer, got ${String(v)}`);
    }
    return v;
  };
  const take = qv.stripCursor ? undefined : qv.take;
  const seek = qv.stripCursor ? undefined : qv.seek;
  // `one()` asks for one row; `oneOrFail()` asks for two so a second match
  // is witnessed. A `limit(n)` stage does not widen that — take wins.
  const limit =
    take === "one" ? 1 : take === "oneOrFail" ? 2 : boundCount(built.limit, "limit");
  const offset = boundCount(built.offset, "offset");

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
    const root = nameOf(built.focus!);
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

/**
 * Resolve the param-gated groups `Q.when` recorded: gate on, the clauses
 * splice exactly as if written inline; gate off, they lower to nothing.
 * Runs before anything reads the clause list, so join-variable analysis
 * never sees a dropped clause.
 */
const resolveWhens = (list: readonly BClause[], binder: ParamBinder): BClause[] => {
  const out: BClause[] = [];
  for (const c of list) {
    if (c._tag === "whenGroup") {
      if (!binder.gateOn(c.gate)) continue;
      out.push(...resolveWhens(c.clauses, binder));
      continue;
    }
    out.push(c);
  }
  return out;
};
