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

import type { Eid } from "../Eid.ts";
import type { AnyEntity } from "../Entity.ts";
import type { UnbrandedId } from "../idents.ts";
import type { AttrValue, OrderDir, OrderEmpty, PathCarrier, Shape, ValidShape, SelectResult } from "../shapes.ts";
import {
  Q,
  type AnyVar,
  type AttrLike,
  type EidCell,
  type QueryGen,
  type Var,
} from "./kernel.ts";
import { isPipeline, type Pipeline, type PipeStage } from "./query.ts";

// ── the pipeline value ──────────────────────────────────────────────────────

const addStage = <Row, N extends AnyEntity>(
  p: Pipeline<unknown, N>,
  stage: PipeStage,
): Pipeline<Row, N> => makePipeline(p.ns, [...p.stages, stage]);

const makePipeline = <Row, N extends AnyEntity>(
  ns: N,
  stages: readonly PipeStage[],
): Pipeline<Row, N> => ({
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
export type IdRow<N extends AnyEntity = AnyEntity> = { readonly id: Eid<N> };

/**
 * The source stage: the entities of one namespace. There is no entity
 * table — membership means "has at least one fact in the namespace", named
 * as a catalog-generated rule so the planner can treat it as a scan; when
 * the pipeline already constrains the focus through a namespace attr, the
 * rule is entailed and lowering emits nothing.
 */
export const entities = <N extends AnyEntity>(ns: N): Pipeline<IdRow<N>, N> => {
  if (typeof ns !== "object" || ns === null || (ns as { _tag?: unknown })._tag !== "Entity") {
    throw new Error("ramose/query: entities(...) takes an entity");
  }
  return makePipeline(ns, []);
};

// ── the dual stage adapter ──────────────────────────────────────────────────

/**
 * Dual stage output: a pipeline keeps its row and focus namespace;
 * anything else is the generator fragment. One generic (not an
 * overload) so `pipe` infers `N` from the argument instead of
 * defaulting it to {@link AnyEntity}.
 */
type FilterOut<X> = [X] extends [never]
  ? QueryGen<void>
  : [X] extends [Pipeline<infer Row, infer N>]
    ? [N] extends [AnyEntity]
      ? Pipeline<Row, N>
      : QueryGen<void>
    : QueryGen<void>;

/**
 * A filter: keeps the pipeline's focus; as a fragment, contributes clauses.
 * The return is branded with the attribute ident so a policy arm can
 * require that ident to belong to the arm entity's stamped field set.
 * The function stays generic so `pipe` still instantiates `X`.
 */
export type FilterStage<Ident extends string = string> = <X>(
  x: X,
) => FilterOut<X> & { readonly _ident?: Ident };

/**
 * The entity a `Ref(User)` field points at. Self-refs / untargeted refs
 * resolve to the pipeline's current focus. Optional `_target` infers
 * `T | undefined`; strip that before the `AnyEntity` test (same as
 * {@link import("../idents.ts").FieldTargetEntity}).
 */
type RefTarget<A, Enclosing extends AnyEntity> = A extends {
  readonly schema: { readonly _target?: infer T };
}
  ? Exclude<T, undefined> extends AnyEntity
    ? Exclude<T, undefined>
    : Enclosing
  : Enclosing;

type FollowOut<A extends AttrLike, X> = [X] extends [never]
  ? QueryGen<Var<EidCell>>
  : [X] extends [Pipeline<infer _Row, infer N>]
    ? [N] extends [AnyEntity]
      ? Pipeline<IdRow<RefTarget<A, N>>, RefTarget<A, N>>
      : QueryGen<Var<EidCell>>
    : QueryGen<Var<EidCell>>;

/** `follow(A)` as a dual stage: pipeline in keeps a branded target row. */
export type FollowStage<A extends AttrLike> = <X>(x: X) => FollowOut<A, X>;

/**
 * `{ id }` row when a traversal's target namespace is not known
 * statically (`backlink`, `stage`). `row.id` is the documented
 * unbranded-number hatch; the row itself is not a branded cell.
 */
export type HatchIdRow = { readonly id: UnbrandedId };

type TraversalOut<X> = [X] extends [never]
  ? QueryGen<Var<EidCell>>
  : [X] extends [Pipeline<any, any>]
    ? Pipeline<HatchIdRow>
    : QueryGen<Var<EidCell>>;

/** A traversal: refocuses the pipeline; as a fragment, returns the new focus. */
export type TraversalStage = <X>(x: X) => TraversalOut<X>;

const filter = <Ident extends string = string>(
  frag: (focus: AnyVar) => QueryGen<void>,
): FilterStage<Ident> =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as FilterStage<Ident>;

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

type ValueIn<A> = AttrValue<A> | AnyVar | { readonly id: number };

/** `is(A, v)`: `p(e) := [e A v]`. `is(N.id, v)` is the same filter as {@link byId}. */
export const is = <A extends AttrLike>(attr: A, value: ValueIn<A>): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    yield* Q.fact(e, attr, value);
  });

/**
 * `byId(id)`: the focus is this entity. The blessed spelling of a filter by
 * entity id — a serializable query stage, equivalent to `is(N.id, id)`. The
 * id is a number or an `{ id }` cell; lowering unifies the focus with that
 * id (`ground`), and never emits a `:db/id` pattern (that is not an
 * attribute).
 */
export const byId = (id: number | AnyVar | { readonly id: number }): FilterStage<":db/id"> =>
  is({ ident: ":db/id" as const }, id);

/** `has(A)`: the focus carries some `A` fact. */
export const has = <A extends AttrLike>(attr: A): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    yield* Q.fact(e, attr);
  });

/** `missing(A)`: no `A` fact at all. */
export const missing = <A extends AttrLike>(attr: A): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    yield* Q.not(has(attr)(e));
  });

/**
 * `matching(A, (v) => cmp)`: bind the attr's value and constrain it —
 * `matching(Issue.title, (t) => Q.startsWith(t, "re:"))`. The callback may
 * return one comparison or a whole generator of clauses.
 *
 * Renamed from `where` so the general filter is `.where` / object-literal
 * equality on the fluent chain (#204, #208).
 */
export const matching = <A extends AttrLike>(
  attr: A,
  pred: (v: Var<AttrValue<A>>) => Iterable<unknown>,
): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    const f = yield* Q.fact(e, attr);
    yield* pred(f.v) as QueryGen<unknown>;
  });

// ── traversals ──────────────────────────────────────────────────────────────

/** `follow(A)`: `p(e) → other := [e A other]` — refocus on the target. */
export const follow = <A extends AttrLike>(attr: A): FollowStage<A> =>
  traversal(function* (e) {
    return (yield* Q.fact(e, attr)).v as Var<EidCell>;
  }) as unknown as FollowStage<A>;

/** `backlink(A)`: same clause, opposite mode — refocus on the referrer. */
export const backlink = (attr: AttrLike): TraversalStage =>
  traversal(function* (other) {
    return (yield* Q.fact(Q._, attr, other)).e;
  });

// ── quantifiers over a reverse ref ──────────────────────────────────────────

type ElemPred = (focus: AnyVar) => Iterable<unknown>;

/** `some(R, ps…)`: ∃ other. `[other R e]` ∧ ps(other). */
export const some = <A extends AttrLike>(ref: A, ...ps: readonly ElemPred[]): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    const other = yield* backlink(ref)(e);
    for (const p of ps) yield* p(other) as QueryGen<unknown>;
  });

/** `none(R, ps…)`: ¬∃ other. `[other R e]` ∧ ps(other). */
export const none = <A extends AttrLike>(ref: A, ...ps: readonly ElemPred[]): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    yield* Q.not(function* () {
      const other = yield* backlink(ref)(e);
      for (const p of ps) yield* p(other) as QueryGen<unknown>;
    });
  });

/** `every(R, ps…)`: ¬∃ other. `[other R e]` ∧ ¬ps(other) — vacuously true
 * of a focus nothing points at, like the nav surface's `every`. */
export const every = <A extends AttrLike>(ref: A, ...ps: readonly ElemPred[]): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    yield* Q.not(function* () {
      const other = yield* backlink(ref)(e);
      yield* Q.not(function* () {
        for (const p of ps) yield* p(other) as QueryGen<unknown>;
      });
    });
  });

// ── time — generic over every namespace ─────────────────────────────────────

/** Some fact about the focus was asserted at basis `t >= since`. */
export const updatedSince = (since: number): FilterStage =>
  filter(function* (e) {
    const f = yield* Q.fact(e);
    yield* Q.gte(f.t, since);
  });

/** Some fact about the focus rides a transaction whose entity carries
 * `[tx A who]` — provenance as an ordinary clause. */
export const assertedBy = <A extends AttrLike>(attr: A, who: ValueIn<A>): FilterStage<A["ident"]> =>
  filter<A["ident"]>(function* (e) {
    const f = yield* Q.fact(e);
    yield* Q.fact(f.tx, attr, who);
  });

// ── terminals: they close the query, not compose it ─────────────────────────

const assertPipeline = <N extends AnyEntity = AnyEntity>(
  x: unknown,
  what: string,
): Pipeline<any, N> => {
  if (!isPipeline(x)) {
    throw new Error(`ramose/query: ${what}(...) is a pipeline terminal — it closes a pipe, it is not a fragment`);
  }
  return x as Pipeline<any, N>;
};

/** Contribute the projection — what a generator body says with its return. */
export const select =
  <const S extends Shape>(shape: S & ValidShape<S>) =>
  <N extends AnyEntity>(q: Pipeline<any, N>): Pipeline<SelectResult<S>, N> =>
    addStage(assertPipeline(q, "select"), { kind: "select", shape: shape as Shape });

/** Contribute a sort key: a selected column's name, or an attr path. */
export const orderBy =
  (key: string | PathCarrier, dir: OrderDir = "asc", opts?: { readonly empty?: OrderEmpty }) =>
  <Row, N extends AnyEntity>(q: Pipeline<Row, N>): Pipeline<Row, N> =>
    addStage(assertPipeline(q, "orderBy"), {
      kind: "orderBy",
      key,
      dir,
      empty: opts?.empty ?? "last",
    });

/** Keep at most `n` rows. */
export const limit =
  (n: number) =>
  <Row, N extends AnyEntity>(q: Pipeline<Row, N>): Pipeline<Row, N> =>
    addStage(assertPipeline(q, "limit"), { kind: "limit", n });

/** Drop `n` rows from the front of the (ordered) result. */
export const offset =
  (n: number) =>
  <Row, N extends AnyEntity>(q: Pipeline<Row, N>): Pipeline<Row, N> =>
    addStage(assertPipeline(q, "offset"), { kind: "offset", n });

/**
 * Project only the matched entity ids — today's cheap-subscription shape
 * (`{ id }` rows). The focus namespace is the pipeline's `N`, so a
 * `pipe(entities(User), ids())` row is `IdRow<User>` and a valid
 * {@link import("../idents.ts").EntityRef}.
 */
export const ids =
  () =>
  <Row, N extends AnyEntity>(q: Pipeline<Row, N>): Pipeline<IdRow<N>, N> =>
    addStage(assertPipeline(q, "ids"), { kind: "ids" });
