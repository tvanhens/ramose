/**
 * The query kernel: inert typed clause descriptions over the engine IR.
 *
 * Primitives are **data, not Effects** — a clause value means nothing until
 * a query lowers it, so serializability is definitional and there is no
 * build runtime, ambient collector, or cast. The kernel is exactly:
 *
 *   - `Q.fact(e, attr, v?)` — the one pattern clause, five positions. An
 *     unbound position mints a typed var; the handle exposes
 *     `{ e, v, t, tx, op }`, so time-based questions are ordinary clauses.
 *   - Value comparisons (`Q.eq`, `Q.gt`, `Q.startsWith`, …) over bound vars.
 *     String predicates take `{ ignoreCase: true }`, lowered through the
 *     engine's `lower-case` function.
 *   - `Q.call(fn, …args)` — function-binding clause; the engine's builtin
 *     set as an escape hatch (`lower-case`, `str`, arithmetic, …).
 *   - `Q.or` / `Q.not` — take sub-generators; closure capture over outer
 *     handles supplies the join-variable lists. No explicit var lists, ever.
 *   - Rule invocation (`query.ts`) — yielding a rule application records an
 *     inert call descriptor.
 *   - `Q.var` / `Q._` — naming devices; they contribute nothing to the IR.
 *
 * `yield*` is the collector: you cannot obtain a clause's binding without
 * contributing the clause, clauses accumulate implicitly while bindings
 * return explicitly, and every inclusion re-runs the build function, so
 * fresh vars make self-joins hygienic with no alpha-renaming machinery.
 */

import { FUNCTIONS } from "../../internal/core/query/builtins.ts";
import type { Eid } from "../Eid.ts";
import type { AnyEntity, AnyQueryRoot } from "../Entity.ts";
import type { InFocus } from "./focus.ts";
import type { FocusShape, Shape, ValidShape, SelectResult, AttrValue } from "../shapes.ts";

// ── vars ────────────────────────────────────────────────────────────────────

/**
 * What a var stands for, which decides how its cell reads back:
 * an `entity` cell wraps as an `Eid`, a `t` cell converts the engine's tx
 * eid back to the basis `t`, everything else passes through.
 */
export type VarKind = "entity" | "value" | "t" | "tx" | "op";

/**
 * The namespace brand a var carries — the same `_ns` phantom {@link Eid}
 * uses. `Var<Eid<Issue>>` brands as `Issue`; a value var stays
 * {@link AnyEntity} (unconstrained).
 */
export type VarNs<T> = T extends { readonly _ns: infer E }
  ? E extends AnyQueryRoot
    ? E
    : AnyEntity
  : AnyEntity;

/**
 * A query variable — an *identity*, not a name. Two mentions of one `Var`
 * are the same variable wherever they appear; a typo is a compile error
 * because there is no string to mistype. `T` is the value the var binds
 * (phantom); `N` is the focus namespace an entity var is branded with
 * (the same brand {@link Eid} carries — not a fourth vocabulary).
 */
export interface Var<T = unknown, N extends AnyQueryRoot = VarNs<T>> {
  readonly _tag: "QVar";
  readonly id: number;
  /** @internal refined as positions are minted; drives cell reshaping */
  kind: VarKind;
  /** @internal the namespace an entity var is branded with, when known */
  ns?: string | undefined;
  /** Phantom — the bound value's type. Never present at runtime. */
  readonly _type?: T;
  /** Phantom — the focus namespace, same brand as {@link Eid}. */
  readonly _ns?: N;
}

export type AnyVar = Var<any, any>;

/** The focus namespace a var is branded with (`AnyEntity` when unbranded). */
export type FocusOf<V> = V extends Var<any, infer N> ? N : AnyEntity;

let nextVarId = 1;

/** @internal Mint a fresh var. Public spelling is {@link Q.var}. */
export const mkVar = <T = unknown, N extends AnyQueryRoot = VarNs<T>>(
  kind: VarKind = "value",
  ns?: string,
): Var<T, N> => ({ _tag: "QVar", id: nextVarId++, kind, ns }) as Var<T, N>;

export const isVar = (x: unknown): x is AnyVar =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "QVar";

/** `Q._` — "this position is unconstrained". Minting device, not IR. */
export interface Blank {
  readonly _tag: "QBlank";
}
const BLANK: Blank = { _tag: "QBlank" };

export const isBlank = (x: unknown): x is Blank =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "QBlank";

// ── the yieldable protocol ──────────────────────────────────────────────────

/**
 * The body of a query, rule or fragment: a generator whose yields are
 * kernel commands and whose return is the binding (a handle, a projection,
 * or nothing). Fragments compose by native delegation — `yield* frag(e)` —
 * typed by TS's own Generator types.
 */
export type QueryGen<R = void> = Generator<AnyCommand, R, any>;

/** The row cell an entity var reads back as: the wrapped id. */
export type EidCell = { readonly id: number };

/** A fragment: a rule with modes — bound vars are arguments, the free var
 * is its return. `void` keeps the pipeline's focus; a handle refocuses. */
export type Fragment<In = AnyVar, R = void> = (focus: In) => QueryGen<R>;

interface Yieldable<R> {
  [Symbol.iterator](): Iterator<AnyCommand, R, any>;
}

/** One `yield self, return what the collector answers` iterator. */
function yieldSelf<R>(self: unknown): Iterator<AnyCommand, R, any> {
  let state = 0;
  return {
    next(v: unknown) {
      if (state === 0) {
        state = 1;
        return { done: false, value: self as AnyCommand };
      }
      return { done: true, value: v as R };
    },
  };
}

// ── clause descriptions ─────────────────────────────────────────────────────

/** An attr reference in a clause: anything carrying an ident. */
export interface AttrLike {
  readonly ident: string;
}

/** A position: a var/handle, a literal, `Q._`, or omitted. */
export type Position = AnyVar | Blank | unknown;

/**
 * The handle a fact answers with. Positions are minted lazily — reading
 * `.t` is what puts the tx position on the wire, so an unread position
 * stays a blank. `t` and `tx` are the same position read two ways (the
 * basis `t`, or the transaction entity); a fact hands out one or the other.
 */
export interface FactHandle<T = unknown> {
  readonly e: Var<EidCell>;
  readonly v: Var<T>;
  readonly t: Var<number>;
  readonly tx: Var<EidCell>;
  readonly op: Var<boolean>;
}

export interface FactCommand<T = unknown> extends Yieldable<FactHandle<T>> {
  readonly _tag: "fact";
  /** @internal e as given; undefined/blank mints via the handle */
  readonly e0: Position | undefined;
  readonly attr: AttrLike | undefined;
  readonly v0: Position | undefined;
  /** @internal minted positions (lazy) */
  eVar?: AnyVar;
  vVar?: AnyVar;
  txVar?: AnyVar;
  txKind?: "t" | "tx";
  opVar?: AnyVar;
  readonly handle: FactHandle<T>;
}

export interface CmpCommand extends Yieldable<void> {
  readonly _tag: "cmp";
  /** engine builtin name: `=`, `not=`, `<`, `starts-with?`, `re-find?`, `in` … */
  readonly op: string;
  readonly args: readonly Position[];
  /** Fold both sides through `lower-case` before the predicate. */
  readonly ignoreCase?: boolean;
}

/**
 * A function-binding clause: `[(fn arg…) ?ret]`. `yield*` answers the
 * bound result var so the next clause can name it.
 */
export interface FnBindCommand extends Yieldable<AnyVar> {
  readonly _tag: "fnBind";
  readonly fn: string;
  readonly args: readonly Position[];
  readonly ret: AnyVar;
}

/** `{ ignoreCase: true }` on {@link Q.startsWith} / {@link Q.endsWith} / {@link Q.includes}. */
export interface StringPredOpts {
  readonly ignoreCase?: boolean;
}

export interface OrCommand extends Yieldable<void> {
  readonly _tag: "or";
  readonly branches: readonly SubBody[];
}

export interface NotCommand extends Yieldable<void> {
  readonly _tag: "not";
  readonly body: SubBody;
}

/** A sub-body: a generator function, an already-applied generator
 * (`Q.not(has(Issue.assignee)(e))`), or one bare command. */
export type SubBody =
  | QueryGen<unknown>
  | (() => QueryGen<unknown>)
  | CmpCommand
  | FactCommand<any>
  | OrCommand
  | NotCommand;

/** `entities(ns)` in a generator body: mint a branded var, membership rule. */
export interface MemberCommand<N extends AnyQueryRoot = AnyEntity> extends Yieldable<Var<Eid<N>>> {
  readonly _tag: "member";
  readonly ns: N;
}

/** A command that splices itself (rule calls, `q.open`) — it records its
 * own clauses through the collector it is handed. */
export interface SpliceCommand extends Yieldable<any> {
  readonly _tag: "splice";
  splice(ctx: BuildCtx): unknown;
}

export type AnyCommand =
  | FactCommand<any>
  | CmpCommand
  | FnBindCommand
  | OrCommand
  | NotCommand
  | MemberCommand
  | SpliceCommand;

// ── recorded clauses (what a build accumulates) ─────────────────────────────

export interface MemberClause {
  readonly _tag: "memberOf";
  readonly ns: AnyQueryRoot;
  readonly v: AnyVar;
}

export interface OrClause {
  readonly _tag: "orGroup";
  readonly branches: readonly BClause[][];
}

export interface NotClause {
  readonly _tag: "notGroup";
  readonly clauses: readonly BClause[];
}

/** An applied named rule; `query.ts` records these via a splice command. */
export interface CallClause {
  readonly _tag: "ruleCall";
  readonly rule: unknown;
  readonly args: readonly Position[];
  readonly ret: AnyVar;
}

export type BClause =
  | FactCommand<any>
  | CmpCommand
  | FnBindCommand
  | MemberClause
  | OrClause
  | NotClause
  | CallClause;

/** The local collector one build pass accumulates into. */
export interface BuildCtx {
  readonly clauses: BClause[];
}

// ── the collector ───────────────────────────────────────────────────────────

const toGen = (b: SubBody): QueryGen<unknown> => {
  if (typeof b === "function") return b();
  // a bare command is iterable too — `Q.or(Q.eq(a, 1), Q.eq(a, 2))` reads
  // as the one-clause branches it is
  if (typeof (b as Partial<Iterator<unknown>>).next !== "function") {
    return (b as Iterable<unknown>)[Symbol.iterator]() as QueryGen<unknown>;
  }
  return b as QueryGen<unknown>;
};

/**
 * Drive a body: yields are recorded as clauses, the yielded command's
 * handle flows back as the `yield*` value, and the return value is the
 * body's binding. Synchronous, pure, and total — this *is* `Query.gen`.
 */
export const runBody = <R>(gen: QueryGen<R>, ctx: BuildCtx): R => {
  let step = gen.next();
  while (!step.done) {
    step = gen.next(dispatch(step.value, ctx));
  }
  return step.value;
};

/** Record a whole sub-body into a fresh clause list. */
export const collectBody = (b: SubBody): BClause[] => {
  const ctx: BuildCtx = { clauses: [] };
  runBody(toGen(b), ctx);
  return ctx.clauses;
};

const dispatch = (cmd: AnyCommand, ctx: BuildCtx): unknown => {
  switch (cmd._tag) {
    case "fact":
      ctx.clauses.push(cmd);
      return cmd.handle;
    case "cmp":
      ctx.clauses.push(cmd);
      return undefined;
    case "fnBind":
      ctx.clauses.push(cmd);
      return cmd.ret;
    case "or":
      ctx.clauses.push({ _tag: "orGroup", branches: cmd.branches.map(collectBody) });
      return undefined;
    case "not":
      ctx.clauses.push({ _tag: "notGroup", clauses: collectBody(cmd.body) });
      return undefined;
    case "member": {
      const v = mkVar<Eid<AnyQueryRoot>>("entity", cmd.ns.ns);
      ctx.clauses.push({ _tag: "memberOf", ns: cmd.ns, v });
      return v;
    }
    case "splice":
      return cmd.splice(ctx);
  }
};

// ── projections (what a body returns) ───────────────────────────────────────

/** `Q.pull(focus, shape)` — project one root through a select shape. */
export interface PullSpec<Row = unknown> {
  readonly _tag: "pullSpec";
  readonly focus: AnyVar;
  readonly shape: Shape;
  /** Phantom — the row this projects to. Never present at runtime. */
  readonly _row?: Row;
}

/** An aggregate cell over a bound var (`Q.max(f.t)`, `Q.count(e)`). */
export interface AggSpec<T = unknown> {
  readonly _tag: "aggSpec";
  readonly fn: "count" | "count-distinct" | "sum" | "avg" | "min" | "max";
  readonly v: AnyVar;
  readonly _out?: T;
}

/** One projected cell: a bound var, a pull, an aggregate, or a nested record. */
export type Cell = AnyVar | PullSpec<any> | AggSpec<any> | CellRecord;
export interface CellRecord {
  readonly [key: string]: Cell;
}

/** `Q.rows({...})` — a multi-column projection, one cell per key. */
export interface RowsSpec<Row = unknown> {
  readonly _tag: "rowsSpec";
  readonly cells: CellRecord;
  readonly _row?: Row;
}

/**
 * `Q.value(cell)` — a scalar terminal. `db.query` resolves to the cell
 * itself (`number`, not `[{ n }]`). The engine's scalar find spec.
 */
export interface ValueSpec<T = unknown> {
  readonly _tag: "valueSpec";
  readonly cell: AggSpec<T> | AnyVar | PullSpec<any>;
  readonly _out?: T;
}

/**
 * `Q.distinct({ … })` — opt into unique projected tuples. The default is
 * one row per source record; this is the set of projected cells.
 */
export interface DistinctSpec<Row = unknown> {
  readonly _tag: "distinctSpec";
  readonly inner: PullSpec<any> | RowsSpec<any> | CellRecord;
  readonly _row?: Row;
}

/** A row projection `Q.distinct` may wrap — not a scalar `Q.value`. */
export type Distinctable = PullSpec<any> | RowsSpec<any> | CellRecord | DistinctSpec<any>;

export type Projection = PullSpec<any> | RowsSpec<any> | CellRecord | ValueSpec<any> | DistinctSpec<any>;

export const isPullSpec = (x: unknown): x is PullSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "pullSpec";
export const isRowsSpec = (x: unknown): x is RowsSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "rowsSpec";
export const isAggSpec = (x: unknown): x is AggSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "aggSpec";
export const isValueSpec = (x: unknown): x is ValueSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "valueSpec";
export const isDistinctSpec = (x: unknown): x is DistinctSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "distinctSpec";

/**
 * The fluent/lib `.select(shape, extras)` focus. `Q.count(Q.focus)` in
 * the extras record rewrites to the pipeline's current focus var.
 */
export const FOCUS: AnyVar = Object.freeze({
  _tag: "QVar",
  id: -1,
  kind: "entity",
}) as AnyVar;

export const isFocusSentinel = (v: unknown): v is AnyVar => isVar(v) && v.id === -1;

/** The row one cell reads back as. */
export type CellValue<C> = C extends Var<infer T>
  ? unknown extends T
    ? unknown
    : T
  : C extends PullSpec<infer R>
    ? R
    : C extends AggSpec<infer T>
      ? T
      : C extends CellRecord
        ? RecordRow<C>
        : never;

export type RecordRow<R> = { readonly [K in keyof R]: CellValue<R[K]> };

/** The row a projection value denotes. */
export type RowOfProjection<P> = P extends DistinctSpec<infer R>
  ? R
  : P extends ValueSpec<infer T>
    ? T
    : P extends PullSpec<infer R>
      ? R
      : P extends RowsSpec<infer R>
        ? R
        : P extends CellRecord
          ? RecordRow<P>
          : never;

// ── Q ───────────────────────────────────────────────────────────────────────

const factHandle = (cmd: {
  e0: Position | undefined;
  v0: Position | undefined;
  attr: AttrLike | undefined;
  eVar?: AnyVar;
  vVar?: AnyVar;
  txVar?: AnyVar;
  txKind?: "t" | "tx";
  opVar?: AnyVar;
}): FactHandle<any> => ({
  get e() {
    if (cmd.eVar === undefined) {
      cmd.eVar = isVar(cmd.e0)
        ? cmd.e0
        : mkVar("entity", cmd.attr === undefined ? undefined : nsOfIdent(cmd.attr.ident));
    }
    return cmd.eVar as Var<EidCell>;
  },
  get v() {
    if (cmd.vVar === undefined) {
      cmd.vVar = isVar(cmd.v0)
        ? cmd.v0
        : mkVar(isRefAttr(cmd.attr) ? "entity" : "value", refTargetNs(cmd.attr));
    }
    return cmd.vVar as Var<any>;
  },
  get t() {
    if (cmd.txVar === undefined) {
      cmd.txVar = mkVar<number>("t");
      cmd.txKind = "t";
    } else if (cmd.txKind !== "t") {
      throw new Error("ramose/query: read f.t or f.tx, not both — they are the same position read two ways");
    }
    return cmd.txVar as Var<number>;
  },
  get tx() {
    if (cmd.txVar === undefined) {
      cmd.txVar = mkVar<EidCell>("tx");
      cmd.txKind = "tx";
    } else if (cmd.txKind !== "tx") {
      throw new Error("ramose/query: read f.t or f.tx, not both — they are the same position read two ways");
    }
    return cmd.txVar as Var<EidCell>;
  },
  get op() {
    cmd.opVar ??= mkVar<boolean>("op");
    return cmd.opVar as Var<boolean>;
  },
});

const nsOfIdent = (ident: string): string | undefined =>
  /^:([^/]+)\//.exec(ident)?.[1];

const isRefAttr = (attr: AttrLike | undefined): boolean =>
  attr !== undefined && (attr as { valueType?: unknown }).valueType === "ref";

/** The namespace a ref attr's v-position brand flows from, when resolvable. */
const refTargetNs = (attr: AttrLike | undefined): string | undefined => {
  if (!isRefAttr(attr)) return undefined;
  const schema = (attr as { schema?: unknown }).schema;
  const resolve = (schema as { _resolve?: () => { ns?: unknown } } | undefined)?._resolve;
  if (typeof resolve !== "function") return undefined;
  try {
    const ns = resolve()?.ns;
    return typeof ns === "string" ? ns : undefined;
  } catch {
    return undefined;
  }
};

const cmp = (op: string, args: readonly Position[], ignoreCase = false): CmpCommand => ({
  _tag: "cmp",
  op,
  args,
  ...(ignoreCase ? { ignoreCase: true as const } : {}),
  [Symbol.iterator]() {
    return yieldSelf<void>(this);
  },
});

const stringPred =
  (op: string) =>
  (v: Operand<string>, needle: Operand<string>, opts?: StringPredOpts): CmpCommand =>
    cmp(op, [v, needle], opts?.ignoreCase === true);

const fnBind = (fn: string, args: readonly Position[]): FnBindCommand => {
  if (typeof fn !== "string" || fn.length === 0 || !Object.hasOwn(FUNCTIONS, fn)) {
    throw new Error(
      `ramose/query: Q.call(${JSON.stringify(fn)}) is not an engine function — the documented builtins are the names Q.call accepts`,
    );
  }
  const ret = mkVar("value");
  return {
    _tag: "fnBind",
    fn,
    args,
    ret,
    [Symbol.iterator]() {
      return yieldSelf<AnyVar>(this);
    },
  };
};

/**
 * When `e` is a namespace-branded var, the attr must be a member of that
 * focus's field map. Unbranded vars, blanks, and omitted e stay open.
 */
type FactAttr<E, A> = [E] extends [Var<any, infer N>]
  ? [AnyEntity] extends [N]
    ? A
    : [InFocus<A, N>] extends [true]
      ? A
      : {
          readonly "ramose/query: this attribute is not a field of the focus entity": never;
        }
  : A;

const factImpl = <A extends AttrLike>(
  e?: Position,
  attr?: A | Blank,
  v?: Position,
): FactCommand<AttrValue<A>> => {
  const a = attr === undefined || isBlank(attr) ? undefined : attr;
  if (a !== undefined && typeof (a as { ident?: unknown }).ident !== "string") {
    throw new Error("ramose/query: Q.fact's attr position takes an attribute reference (Issue.title) or Q._");
  }
  const cmd = {
    _tag: "fact",
    e0: e,
    attr: a,
    v0: v,
  } as { -readonly [K in keyof FactCommand]: FactCommand[K] };
  cmd.handle = factHandle(cmd);
  cmd[Symbol.iterator] = function () {
    return yieldSelf<FactHandle<AttrValue<A>>>(this);
  };
  // a bound var in e-position: refine its brand from the attr
  if (isVar(e) && a !== undefined && e.ns === undefined) e.ns = nsOfIdent(a.ident);
  return cmd as FactCommand<AttrValue<A>>;
};

const fact = <E extends Position | undefined, A extends AttrLike = AttrLike>(
  e?: E,
  attr?: FactAttr<E, A> | Blank,
  v?: Position,
): FactCommand<AttrValue<A>> => factImpl(e, attr as A | Blank | undefined, v);

/**
 * A comparison operand: a bound var, a literal, or an aggregate cell. A
 * comparison that mentions an aggregate cell lowers into the wire's
 * `:having` section — aggregates are not bound until after grouping, so
 * the placement *is* the semantics: it filters whole groups, after they
 * are computed. The cell must reach the projection (that is what names it
 * on the row), and such a comparison cannot sit inside `Q.or` / `Q.not`
 * — there is no group yet where those lower.
 */
export type Operand<T = unknown> = Var<T> | AggSpec<T> | T;

const agg = <T>(fn: AggSpec["fn"], v: AnyVar): AggSpec<T> => {
  if (!isVar(v)) {
    throw new Error(`ramose/query: Q.${fn === "count-distinct" ? "countDistinct" : fn}(...) aggregates a bound var`);
  }
  return { _tag: "aggSpec", fn, v };
};

/** Unwrap / validate the projection `Q.distinct` wraps. */
const distinctInner = (proj: unknown): DistinctSpec["inner"] => {
  if (isDistinctSpec(proj)) return proj.inner;
  if (isValueSpec(proj)) {
    throw new Error(
      "ramose/query: Q.distinct(...) wraps a row projection — Q.value is a scalar, not a set of rows",
    );
  }
  if (isPullSpec(proj) || isRowsSpec(proj)) return proj;
  if (
    isVar(proj) ||
    isAggSpec(proj) ||
    isBlank(proj) ||
    proj === null ||
    typeof proj !== "object" ||
    Array.isArray(proj)
  ) {
    throw new Error(
      "ramose/query: Q.distinct(...) wraps a row projection — Q.pull, Q.rows({ … }), or a record of bound handles",
    );
  }
  const tag = (proj as { _tag?: unknown })._tag;
  if (typeof tag === "string") {
    throw new Error(
      "ramose/query: Q.distinct(...) wraps a row projection — Q.pull, Q.rows({ … }), or a record of bound handles",
    );
  }
  if (Object.keys(proj).length === 0) {
    throw new Error("ramose/query: the body returned an empty projection — name at least one cell");
  }
  return proj as CellRecord;
};

/**
 * The kernel, as one namespace. Everything here is an inert description;
 * `db.query` is where computation (and Effect) begins.
 */
export const Q = {
  /**
   * The one pattern clause. Unbound positions mint typed vars — the
   * e-position brand flows from the attr — and the returned handle exposes
   * `{ e, v, t, tx, op }`. `Q.fact(e)` (attr-free) is generic over every
   * namespace: it says "some fact about `e`".
   */
  fact,

  /** A fresh var, unconstrained until a clause names it. */
  var: <T = unknown>(): Var<T> => mkVar<T>("value"),

  /** The unconstrained position. */
  _: BLANK,

  // ── comparisons over bound vars ──────────────────────────────────────────
  eq: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("=", [a, b]),
  ne: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("not=", [a, b]),
  lt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<", [a, b]),
  lte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<=", [a, b]),
  gt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">", [a, b]),
  gte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">=", [a, b]),
  startsWith: stringPred("starts-with?"),
  endsWith: stringPred("ends-with?"),
  includes: stringPred("includes?"),
  /** `re-find?` compiles the pattern with no flags — there is no inline `(?i)`. */
  matches: (v: Operand<string>, re: RegExp | string): CmpCommand =>
    cmp("re-find?", [re, v]),
  in: <T>(v: Operand<T>, values: readonly T[]): CmpCommand =>
    cmp("in", [v, values]),

  /**
   * Bind the result of an engine function: `yield* Q.call("+", a, 1)` is
   * `[(+ ?a 1) ?ret]`. The names `Q.call` accepts are the engine's
   * function set (`lower-case`, `str`, arithmetic, …) — documented on
   * the query-language page.
   */
  call: (fn: string, ...args: Position[]): FnBindCommand => fnBind(fn, args),

  /**
   * Disjunction of sub-bodies. Join variables are whatever outer handles
   * the branches close over — never an explicit list.
   */
  or: (...branches: readonly SubBody[]): OrCommand => ({
    _tag: "or",
    branches,
    [Symbol.iterator]() {
      return yieldSelf<void>(this);
    },
  }),

  /** Negation of a sub-body, scoped by closure capture like {@link Q.or}. */
  not: (body: SubBody): NotCommand => ({
    _tag: "not",
    body,
    [Symbol.iterator]() {
      return yieldSelf<void>(this);
    },
  }),

  // ── projections ──────────────────────────────────────────────────────────

  /** Project one root through a select shape — the closing contract of a
   * single-root body. A branded focus var rejects another entity's fields. */
  pull: <V extends AnyVar, const S extends Shape>(
    focus: V,
    shape: S & ValidShape<S> & FocusShape<FocusOf<V>, S>,
  ): PullSpec<SelectResult<S>> => {
    if (!isVar(focus)) {
      throw new Error("ramose/query: Q.pull's first argument is the bound focus var");
    }
    return { _tag: "pullSpec", focus, shape: shape as Shape };
  },

  /** Several roots (or computed cells) per row — the multi-root contract. */
  rows: <const R extends CellRecord>(cells: R): RowsSpec<RecordRow<R>> => ({
    _tag: "rowsSpec",
    cells,
  }),

  /**
   * A scalar terminal: `db.query` resolves to the cell, not a one-row
   * array. `Q.value(Q.count(e))` is a `number` — 0 over no matches.
   */
  value: <C extends AggSpec<any> | AnyVar | PullSpec<any>>(
    cell: C,
  ): ValueSpec<CellValue<C>> => {
    if (!isAggSpec(cell) && !isVar(cell) && !isPullSpec(cell)) {
      throw new Error(
        "ramose/query: Q.value(...) takes a bound var, Q.pull, or an aggregate cell",
      );
    }
    return { _tag: "valueSpec", cell: cell as ValueSpec<CellValue<C>>["cell"] };
  },

  /**
   * Unique projected tuples. The default is one row per source record
   * — two issues with the same title are two rows. Wrap the same
   * record (or `Q.rows` / `Q.pull`) to keep one row when every
   * projected cell agrees.
   */
  distinct: <const P extends Distinctable>(proj: P): DistinctSpec<RowOfProjection<P>> => ({
    _tag: "distinctSpec",
    inner: distinctInner(proj),
  }),

  /**
   * The `.select(shape, extras)` focus. Write `Q.count(Q.focus)` in the
   * extras record; lowering rewrites it to the pipeline's current focus.
   */
  focus: FOCUS,

  /** Merge extra cells onto a base projection (used by `Query.enrich`). */
  row: <Base extends Projection, const Extra extends CellRecord>(
    base: Base,
    extra: Extra,
  ): Base extends DistinctSpec<any>
    ? DistinctSpec<RowOfProjection<Base> & RecordRow<Extra>>
    : RowsSpec<RowOfProjection<Base> & RecordRow<Extra>> => {
    if (isDistinctSpec(base)) {
      return Q.distinct(Q.row(base.inner, extra)) as never;
    }
    const cells = isRowsSpec(base)
      ? { ...base.cells, ...extra }
      : isPullSpec(base)
        ? { ...extra, ["…"]: base }
        : { ...(base as CellRecord), ...extra };
    return { _tag: "rowsSpec", cells: cells as CellRecord } as never;
  },

  // ── aggregate cells ──────────────────────────────────────────────────────
  count: (v: AnyVar): AggSpec<number> => agg("count", v),
  countDistinct: (v: AnyVar): AggSpec<number> => agg("count-distinct", v),
  sum: (v: Var<number> | AnyVar): AggSpec<number> => agg("sum", v),
  avg: (v: Var<number> | AnyVar): AggSpec<number | null> => agg("avg", v),
  min: <T>(v: Var<T>): AggSpec<T | null> => agg("min", v),
  max: <T>(v: Var<T>): AggSpec<T | null> => agg("max", v),
};
