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
import type {
  AttrValue,
  FocusSelect,
  OrderDir,
  OrderEmpty,
  PathCarrier,
  Shape,
  ValidShape,
  SelectResult,
} from "../shapes.ts";
import type { FocusMismatch, InFocus, OwnerOf, RefTarget, ReverseOk } from "./focus.ts";
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
          : { done: true as const, value: v as Var<Eid<N>> },
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
 * A filter's argument: a pipeline is accepted only when `A` is a member
 * of the focus field map (`A = void` is namespace-generic — `byId`,
 * `updatedSince`). One generic so `pipe` infers `N` from the argument.
 */
type FilterParam<X, A> = [X] extends [Pipeline<any, infer N>]
  ? [A] extends [void]
    ? X
    : [InFocus<A, N>] extends [true]
      ? X
      : FocusMismatch
  : X;

/**
 * A filter parameterized by the focus namespace. `N` is the pipeline
 * focus the stage may be applied to; the attr-capturing form
 * (`FilterStage<AnyEntity, typeof User.name>`) rejects a foreign
 * field map at the call site. The return carries an ident brand so a
 * policy `FragFn` can tell a `Query.is` from a handwritten generator
 * (`{ _ident?: never }`).
 */
export type FilterStage<
  N extends AnyEntity = AnyEntity,
  A = void,
> = <X>(
  x: FilterParam<X, A>,
) => FilterOut<X> & {
  readonly _ident?: A extends { readonly ident: infer I extends string } ? I : ":db/id";
};

type FollowOut<A extends AttrLike, X> = [X] extends [never]
  ? QueryGen<Var<Eid<RefTarget<A, AnyEntity>>>>
  : [X] extends [Pipeline<infer _Row, infer N>]
    ? [N] extends [AnyEntity]
      ? Pipeline<IdRow<RefTarget<A, N>>, RefTarget<A, N>>
      : QueryGen<Var<Eid<RefTarget<A, AnyEntity>>>>
    : QueryGen<Var<Eid<RefTarget<A, AnyEntity>>>>;

type FollowParam<X, A> = [X] extends [Pipeline<any, infer N>]
  ? [InFocus<A, N>] extends [true]
    ? X
    : FocusMismatch
  : X;

/** `follow(A)` as a dual stage: pipeline in keeps a branded target row. */
export type FollowStage<A extends AttrLike> = <X>(
  x: FollowParam<X, A>,
) => FollowOut<A, X>;

/**
 * `{ id }` row when a traversal's target namespace is not known
 * statically (`backlink`, `stage`). `row.id` is the documented
 * unbranded-number hatch; the row itself is not a branded cell.
 */
export type HatchIdRow = { readonly id: UnbrandedId };

type TraversalOut<A, X> = [X] extends [never]
  ? QueryGen<Var<EidCell>>
  : [X] extends [Pipeline<any, any>]
    ? [A] extends [void]
      ? Pipeline<HatchIdRow>
      : Pipeline<HatchIdRow, OwnerOf<A>>
    : QueryGen<Var<EidCell>>;

/**
 * A reverse-ref argument: the attr must point at the current focus
 * (`backlink(Comment.issue)` on an Issue pipeline).
 */
type ReverseParam<X, A> = [X] extends [Pipeline<any, infer N>]
  ? [A] extends [void]
    ? X
    : [ReverseOk<A, N>] extends [true]
      ? X
      : FocusMismatch
  : X;

/** A traversal: refocuses the pipeline; as a fragment, returns the new focus. */
export type TraversalStage<A = void> = <X>(
  x: ReverseParam<X, A>,
) => TraversalOut<A, X>;

const filter = <A = void>(frag: (focus: AnyVar) => QueryGen<void>): FilterStage<AnyEntity, A> =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as FilterStage<
    AnyEntity,
    A
  >;

const traversal = <A = void>(
  frag: (focus: AnyVar) => QueryGen<Var<EidCell>>,
): TraversalStage<A> =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as TraversalStage<A>;

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
export const is = <A extends AttrLike>(
  attr: A,
  value: ValueIn<A>,
): FilterStage<AnyEntity, A> =>
  filter<A>(function* (e) {
    yield* Q.fact(e, attr, value);
  });

/**
 * `byId(id)`: the focus is this entity. The blessed spelling of a filter by
 * entity id — a serializable query stage, equivalent to `is(N.id, id)`. The
 * id is a number or an `{ id }` cell; lowering unifies the focus with that
 * id (`ground`), and never emits a `:db/id` pattern (that is not an
 * attribute).
 */
export const byId = (id: number | AnyVar | { readonly id: number }): FilterStage =>
  filter<void>(function* (e) {
    yield* Q.fact(e, { ident: ":db/id" as const }, id);
  });

/** `has(A)`: the focus carries some `A` fact. */
export const has = <A extends AttrLike>(attr: A): FilterStage<AnyEntity, A> =>
  filter<A>(function* (e) {
    yield* Q.fact(e, attr);
  });

/** `missing(A)`: no `A` fact at all. */
export const missing = <A extends AttrLike>(attr: A): FilterStage<AnyEntity, A> =>
  filter<A>(function* (e) {
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
): FilterStage<AnyEntity, A> =>
  filter<A>(function* (e) {
    const f = yield* Q.fact(e, attr);
    yield* pred(f.v as Var<AttrValue<A>>) as QueryGen<unknown>;
  });

// ── traversals ──────────────────────────────────────────────────────────────

/** `follow(A)`: `p(e) → other := [e A other]` — refocus on the target. */
export const follow = <A extends AttrLike>(attr: A): FollowStage<A> =>
  traversal(function* (e) {
    return (yield* Q.fact(e, attr)).v as Var<EidCell>;
  }) as unknown as FollowStage<A>;

/** `backlink(A)`: same clause, opposite mode — refocus on the referrer. */
export const backlink = <A extends AttrLike>(attr: A): TraversalStage<A> =>
  traversal<A>(function* (other) {
    return (yield* Q.fact(Q._, attr, other)).e as Var<EidCell>;
  });

// ── quantifiers over a reverse ref ──────────────────────────────────────────

type ElemPred = (focus: AnyVar) => Iterable<unknown>;

/** A filter over a reverse ref: the attr must point at the current focus. */
export type ReverseFilter<A extends AttrLike> = <X>(
  x: ReverseParam<X, A>,
) => FilterOut<X>;

const reverseFilter = <A extends AttrLike>(
  frag: (focus: AnyVar) => QueryGen<void>,
): ReverseFilter<A> =>
  ((x: unknown) =>
    isPipeline(x) ? addStage(x, { kind: "frag", frag }) : frag(x as AnyVar)) as ReverseFilter<A>;

/** `some(R, ps…)`: ∃ other. `[other R e]` ∧ ps(other). */
export const some = <A extends AttrLike>(
  ref: A,
  ...ps: readonly ElemPred[]
): ReverseFilter<A> =>
  reverseFilter<A>(function* (e) {
    const other = yield* backlink(ref)(e);
    for (const p of ps) yield* p(other) as QueryGen<unknown>;
  });

/** `none(R, ps…)`: ¬∃ other. `[other R e]` ∧ ps(other). */
export const none = <A extends AttrLike>(
  ref: A,
  ...ps: readonly ElemPred[]
): ReverseFilter<A> =>
  reverseFilter<A>(function* (e) {
    yield* Q.not(function* () {
      const other = yield* backlink(ref)(e);
      for (const p of ps) yield* p(other) as QueryGen<unknown>;
    });
  });

/** `every(R, ps…)`: ¬∃ other. `[other R e]` ∧ ¬ps(other) — vacuously true
 * of a focus nothing points at, like the nav surface's `every`. */
export const every = <A extends AttrLike>(
  ref: A,
  ...ps: readonly ElemPred[]
): ReverseFilter<A> =>
  reverseFilter<A>(function* (e) {
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
  filter<void>(function* (e) {
    const f = yield* Q.fact(e);
    yield* Q.gte(f.t, since);
  });

/** Some fact about the focus rides a transaction whose entity carries
 * `[tx A who]` — provenance as an ordinary clause. */
export const assertedBy = <A extends AttrLike>(attr: A, who: ValueIn<A>): FilterStage =>
  filter<void>(function* (e) {
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

type SelectArg<S, N extends AnyEntity> = [S] extends [FocusSelect<N, S>]
  ? unknown
  : FocusMismatch;

/** Contribute the projection — what a generator body says with its return. */
export const select =
  <const S extends Shape>(shape: S & ValidShape<S>) =>
  <N extends AnyEntity>(
    q: Pipeline<any, N> & SelectArg<S, N>,
  ): Pipeline<SelectResult<S>, N> =>
    addStage(assertPipeline(q, "select"), { kind: "select", shape: shape as Shape });

type OrderKeyArg<K, Row, N extends AnyEntity> = [K] extends [string]
  ? [K] extends [keyof Row]
    ? unknown
    : FocusMismatch
  : [InFocus<K, N>] extends [true]
    ? unknown
    : FocusMismatch;

/** Contribute a sort key: a selected column's name, or an attr path. */
export const orderBy =
  <const K extends string | PathCarrier>(
    key: K,
    dir: OrderDir = "asc",
    opts?: { readonly empty?: OrderEmpty },
  ) =>
  <Row, N extends AnyEntity>(
    q: Pipeline<Row, N> & OrderKeyArg<K, Row, N>,
  ): Pipeline<Row, N> =>
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
