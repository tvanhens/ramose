/**
 * The pipeable standard library — every combinator here bootstraps from the
 * kernel (`fact`, comparisons, `or`/`not`, rules), which is the test of the
 * kernel's completeness: a userland combinator is indistinguishable from a
 * shipped one.
 *
 * A fragment is a rule with modes: bound head vars are the function's
 * arguments, the free var is its return — exactly the dataflow that makes
 * `pipe` thread. Each shipped combinator is dual-natured: applied to a
 * pipeline it appends itself as a stage, applied to a bound handle it is
 * the plain generator fragment (`yield* is(Issue.done, false)(issue)`), so
 * one vocabulary serves both spellings.
 */

import type { AnyEntity } from "../Entity.ts";
import type { AnyParam } from "../Params.ts";
import type { AttrValue, OrderDir, OrderEmpty, PathCarrier, Shape, ValidShape, SelectResult } from "../shapes.ts";
import {
  Q,
  isVar,
  type AnyVar,
  type AttrLike,
  type EidCell,
  type QueryGen,
  type ValidGate,
  type Var,
} from "./kernel.ts";
import { isPipeline, type Pipeline, type PipeStage } from "./query.ts";

// ── the pipeline value ──────────────────────────────────────────────────────

const addStage = <Row>(p: Pipeline<any>, stage: PipeStage): Pipeline<Row> =>
  makePipeline(p.ns, [...p.stages, stage]);

const makePipeline = <Row>(ns: AnyEntity, stages: readonly PipeStage[]): Pipeline<Row> => ({
  _tag: "Pipeline",
  ns,
  stages,
  // in a generator body the same value is a clause source: `yield*
  // entities(Team)` mints the branded focus var via a membership command
  [Symbol.iterator]() {
    let state = 0;
    const cmd = { _tag: "member" as const, ns };
    return {
      next: (v: unknown) =>
        state === 0
          ? ((state = 1), { done: false as const, value: cmd as never })
          : { done: true as const, value: v as Var<EidCell> },
    };
  },
});

/** The row a bare (select-less) pipeline yields: the matched entity id. */
export type IdRow = { readonly id: number };

/**
 * The source stage: the entities of one namespace. There is no entity
 * table — membership means "has at least one fact in the namespace", named
 * as a catalog-generated rule so the planner can treat it as a scan; when
 * the pipeline already constrains the focus through a namespace attr, the
 * rule is entailed and lowering emits nothing.
 */
export const entities = <N extends AnyEntity>(ns: N): Pipeline<IdRow> => {
  if (typeof ns !== "object" || ns === null || (ns as { _tag?: unknown })._tag !== "Entity") {
    throw new Error("ramose/query: entities(...) takes an entity");
  }
  return makePipeline(ns, []);
};

// ── the dual stage adapter ──────────────────────────────────────────────────

/** A filter: keeps the pipeline's focus; as a fragment, contributes
 * clauses. (The fragment overload comes first: `pipe` matches arrow
 * compatibility against the last overload, the pipeline one.) */
export interface FilterStage {
  (focus: AnyVar): QueryGen<void>;
  <Row>(q: Pipeline<Row>): Pipeline<Row>;
}

/** A traversal: refocuses the pipeline; as a fragment, returns the new focus. */
export interface TraversalStage {
  (focus: AnyVar): QueryGen<Var<EidCell>>;
  (q: Pipeline<any>): Pipeline<IdRow>;
}

const filter = (frag: (focus: AnyVar) => QueryGen<void>): FilterStage =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as FilterStage;

const traversal = (frag: (focus: AnyVar) => QueryGen<Var<EidCell>>): TraversalStage =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as TraversalStage;

/**
 * Lift a plain fragment into a pipeable stage — the same adapter every
 * shipped combinator uses, so a userland combinator is indistinguishable
 * from a shipped one. A fragment returning a handle refocuses the
 * pipeline; `void` keeps the focus.
 */
export const stage: {
  (frag: (focus: AnyVar) => QueryGen<Var<EidCell>>): TraversalStage;
  (frag: (focus: AnyVar) => QueryGen<void>): FilterStage;
} = ((frag: (focus: AnyVar) => QueryGen<any>) =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar))) as never;

// ── filters ─────────────────────────────────────────────────────────────────

type ValueIn<A> = AttrValue<A> | AnyParam | AnyVar | { readonly id: number };

/** `is(A, v)`: `p(e) := [e A v]`. `is(N.id, v)` is the same filter as {@link byId}. */
export const is = <A extends AttrLike>(attr: A, value: ValueIn<A>): FilterStage =>
  filter(function* (e) {
    yield* Q.fact(e, attr, value);
  });

/**
 * `byId(id)`: the focus is this entity. The blessed spelling of a filter by
 * entity id — a serializable query stage, equivalent to `is(N.id, id)`. The
 * id is a number, an `{ id }` cell, or a param; lowering unifies the focus
 * with that id (`ground`), and never emits a `:db/id` pattern (that is not
 * an attribute).
 */
export const byId = (id: number | AnyParam | AnyVar | { readonly id: number }): FilterStage =>
  is({ ident: ":db/id" }, id);

/** `has(A)`: the focus carries some `A` fact. */
export const has = (attr: AttrLike): FilterStage =>
  filter(function* (e) {
    yield* Q.fact(e, attr);
  });

/** `missing(A)`: no `A` fact at all. */
export const missing = (attr: AttrLike): FilterStage =>
  filter(function* (e) {
    yield* Q.not(has(attr)(e));
  });

/**
 * `where(A, (v) => cmp)`: bind the attr's value and constrain it —
 * `where(Issue.title, (t) => Q.startsWith(t, "re:"))`. The callback may
 * return one comparison or a whole generator of clauses.
 */
export const where = <A extends AttrLike>(
  attr: A,
  pred: (v: Var<AttrValue<A>>) => Iterable<unknown>,
): FilterStage =>
  filter(function* (e) {
    const f = yield* Q.fact(e, attr);
    yield* pred(f.v) as QueryGen<unknown>;
  });

// ── traversals ──────────────────────────────────────────────────────────────

/** `follow(A)`: `p(e) → other := [e A other]` — refocus on the target. */
export const follow = (attr: AttrLike): TraversalStage =>
  traversal(function* (e) {
    return (yield* Q.fact(e, attr)).v as Var<EidCell>;
  });

/** `backlink(A)`: same clause, opposite mode — refocus on the referrer. */
export const backlink = (attr: AttrLike): TraversalStage =>
  traversal(function* (other) {
    return (yield* Q.fact(Q._, attr, other)).e;
  });

// ── quantifiers over a reverse ref ──────────────────────────────────────────

type ElemPred = (focus: AnyVar) => Iterable<unknown>;

/** `some(R, ps…)`: ∃ other. `[other R e]` ∧ ps(other). */
export const some = (ref: AttrLike, ...ps: readonly ElemPred[]): FilterStage =>
  filter(function* (e) {
    const other = yield* backlink(ref)(e);
    for (const p of ps) yield* p(other) as QueryGen<unknown>;
  });

/** `none(R, ps…)`: ¬∃ other. `[other R e]` ∧ ps(other). */
export const none = (ref: AttrLike, ...ps: readonly ElemPred[]): FilterStage =>
  filter(function* (e) {
    yield* Q.not(function* () {
      const other = yield* backlink(ref)(e);
      for (const p of ps) yield* p(other) as QueryGen<unknown>;
    });
  });

/** `every(R, ps…)`: ¬∃ other. `[other R e]` ∧ ¬ps(other) — vacuously true
 * of a focus nothing points at, like the nav surface's `every`. */
export const every = (ref: AttrLike, ...ps: readonly ElemPred[]): FilterStage =>
  filter(function* (e) {
    yield* Q.not(function* () {
      const other = yield* backlink(ref)(e);
      yield* Q.not(function* () {
        for (const p of ps) yield* p(other) as QueryGen<unknown>;
      });
    });
  });

// ── param-gated clauses ─────────────────────────────────────────────────────

/**
 * `when(gate, ps…)`: the given filters are part of the query only while the
 * gate is on — a `Param<boolean>` (on when bound `true`) or a
 * `Ramose.optional` param (on when bound at all; inside the body that param
 * is bound, so referencing it there is always legal). Gate on, the clauses
 * lower exactly as if written inline; gate off, they lower to nothing. A
 * gate changes which **rows**, never the row's shape.
 *
 * ```ts
 * Query.when(p.assignee, Query.is(Issue.assignee, p.assignee))
 * ```
 */
export const when = <G extends AnyParam>(
  gate: G & ValidGate<G>,
  ...ps: readonly ElemPred[]
): FilterStage =>
  filter(function* (e) {
    yield* Q.when(gate as never, function* () {
      for (const p of ps) yield* p(e) as QueryGen<unknown>;
    });
  });

// ── time — generic over every namespace ─────────────────────────────────────

/** Some fact about the focus was asserted at basis `t >= since`. */
export const updatedSince = (since: number | AnyParam): FilterStage =>
  filter(function* (e) {
    const f = yield* Q.fact(e);
    yield* Q.gte(f.t, since);
  });

/** Some fact about the focus rides a transaction whose entity carries
 * `[tx A who]` — provenance as an ordinary clause. */
export const assertedBy = <A extends AttrLike>(attr: A, who: ValueIn<A>): FilterStage =>
  filter(function* (e) {
    const f = yield* Q.fact(e);
    yield* Q.fact(f.tx, attr, who);
  });

// ── terminals: they close the query, not compose it ─────────────────────────

const assertPipeline = (x: unknown, what: string): Pipeline<any> => {
  if (!isPipeline(x)) {
    throw new Error(`ramose/query: ${what}(...) is a pipeline terminal — it closes a pipe, it is not a fragment`);
  }
  return x;
};

/** Contribute the projection — what a generator body says with its return. */
export const select =
  <const S extends Shape>(shape: S & ValidShape<S>) =>
  (q: Pipeline<any>): Pipeline<SelectResult<S>> =>
    addStage(assertPipeline(q, "select"), { kind: "select", shape: shape as Shape });

/** Contribute a sort key: a selected column's name, or an attr path. */
export const orderBy =
  (key: string | PathCarrier, dir: OrderDir = "asc", opts?: { readonly empty?: OrderEmpty }) =>
  <Row>(q: Pipeline<Row>): Pipeline<Row> =>
    addStage(assertPipeline(q, "orderBy"), {
      kind: "orderBy",
      key,
      dir,
      empty: opts?.empty ?? "last",
    });

/** Keep at most `n` rows. */
export const limit =
  (n: number | AnyParam) =>
  <Row>(q: Pipeline<Row>): Pipeline<Row> =>
    addStage(assertPipeline(q, "limit"), { kind: "limit", n });

/** Drop `n` rows from the front of the (ordered) result. */
export const offset =
  (n: number | AnyParam) =>
  <Row>(q: Pipeline<Row>): Pipeline<Row> =>
    addStage(assertPipeline(q, "offset"), { kind: "offset", n });
