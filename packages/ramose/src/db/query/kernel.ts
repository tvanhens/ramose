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

import type { AnyNamespace } from "../Namespace.ts";
import type { AnyParam, Param } from "../Params.ts";
import type { Shape, ValidShape, SelectResult, AttrValue } from "../shapes.ts";

// ── vars ────────────────────────────────────────────────────────────────────

/**
 * What a var stands for, which decides how its cell reads back:
 * an `entity` cell wraps as an `Eid`, a `t` cell converts the engine's tx
 * eid back to the basis `t`, everything else passes through.
 */
export type VarKind = "entity" | "value" | "t" | "tx" | "op";

/**
 * A query variable — an *identity*, not a name. Two mentions of one `Var`
 * are the same variable wherever they appear; a typo is a compile error
 * because there is no string to mistype. `T` is the value the var binds
 * (phantom); `ns` is the entity-namespace hint an attr's e-position brand
 * flows into.
 */
export interface Var<T = unknown> {
  readonly _tag: "QVar";
  readonly id: number;
  /** @internal refined as positions are minted; drives cell reshaping */
  kind: VarKind;
  /** @internal the namespace an entity var is branded with, when known */
  ns?: string | undefined;
  /** Phantom — the bound value's type. Never present at runtime. */
  readonly _type?: T;
}

export type AnyVar = Var<any>;

let nextVarId = 1;

/** @internal Mint a fresh var. Public spelling is {@link Q.var}. */
export const mkVar = <T = unknown>(kind: VarKind = "value", ns?: string): Var<T> =>
  ({ _tag: "QVar", id: nextVarId++, kind, ns }) as Var<T>;

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

/** A position: a var/handle, a literal, a param hole, `Q._`, or omitted. */
export type Position = AnyVar | Blank | AnyParam | unknown;

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
export interface MemberCommand extends Yieldable<Var<EidCell>> {
  readonly _tag: "member";
  readonly ns: AnyNamespace;
}

/** `Q.when(gate, body)` — clauses that are part of the query only while the
 * gate is on. Recorded as a {@link WhenClause}; lowering splices or drops. */
export interface WhenCommand extends Yieldable<void> {
  readonly _tag: "when";
  readonly gate: AnyParam;
  readonly body: SubBody;
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
  | OrCommand
  | NotCommand
  | MemberCommand
  | WhenCommand
  | SpliceCommand;

// ── recorded clauses (what a build accumulates) ─────────────────────────────

export interface MemberClause {
  readonly _tag: "memberOf";
  readonly ns: AnyNamespace;
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

/** A param-gated clause group: spliced when the gate is on, dropped when it
 * is off. Resolved by the lowering pass before anything reads the clauses. */
export interface WhenClause {
  readonly _tag: "whenGroup";
  readonly gate: AnyParam;
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
  | MemberClause
  | OrClause
  | NotClause
  | WhenClause
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
    case "or":
      ctx.clauses.push({ _tag: "orGroup", branches: cmd.branches.map(collectBody) });
      return undefined;
    case "not":
      ctx.clauses.push({ _tag: "notGroup", clauses: collectBody(cmd.body) });
      return undefined;
    case "member": {
      const v = mkVar<EidCell>("entity", cmd.ns.ns);
      ctx.clauses.push({ _tag: "memberOf", ns: cmd.ns, v });
      return v;
    }
    case "when":
      ctx.clauses.push({
        _tag: "whenGroup",
        gate: cmd.gate,
        clauses: collectBody(cmd.body),
      });
      return undefined;
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

export type Projection = PullSpec<any> | RowsSpec<any> | CellRecord;

export const isPullSpec = (x: unknown): x is PullSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "pullSpec";
export const isRowsSpec = (x: unknown): x is RowsSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "rowsSpec";
export const isAggSpec = (x: unknown): x is AggSpec =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "aggSpec";

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
export type RowOfProjection<P> = P extends PullSpec<infer R>
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
  attr !== undefined && (attr as { valueType?: unknown }).valueType === ":db.type/ref";

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

const cmp = (op: string, ...args: Position[]): CmpCommand => ({
  _tag: "cmp",
  op,
  args,
  [Symbol.iterator]() {
    return yieldSelf<void>(this);
  },
});

const fact = <A extends AttrLike>(
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

/** A comparison operand: a bound var, a literal, or a param hole. */
export type Operand<T = unknown> = Var<T> | AnyParam | T;

/**
 * The error `Q.when` resolves an ungateable param to: a gate is a
 * `Param<boolean>` (on when bound `true`) or a `Ramose.optional` param (on
 * when bound at all) — a required non-boolean param has no off state.
 */
export type ValidGate<G> = G extends Param<any, any, true>
  ? unknown
  : G extends Param<boolean, any, false>
    ? unknown
    : `Q.when's gate is a Param<boolean> or a Ramose.optional param — a required non-boolean param has no off state`;

const agg = <T>(fn: AggSpec["fn"], v: AnyVar): AggSpec<T> => {
  if (!isVar(v)) {
    throw new Error(`ramose/query: Q.${fn === "count-distinct" ? "countDistinct" : fn}(...) aggregates a bound var`);
  }
  return { _tag: "aggSpec", fn, v };
};

/**
 * The kernel, as one namespace. Everything here is an inert description;
 * `db.q` is where computation (and Effect) begins.
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
  eq: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("=", a, b),
  ne: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("not=", a, b),
  lt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<", a, b),
  lte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<=", a, b),
  gt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">", a, b),
  gte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">=", a, b),
  startsWith: (v: Operand<string>, prefix: Operand<string>): CmpCommand =>
    cmp("starts-with?", v, prefix),
  endsWith: (v: Operand<string>, suffix: Operand<string>): CmpCommand =>
    cmp("ends-with?", v, suffix),
  includes: (v: Operand<string>, needle: Operand<string>): CmpCommand =>
    cmp("includes?", v, needle),
  /** `re-find?` compiles the pattern with no flags — see the nav surface. */
  matches: (v: Operand<string>, re: RegExp | string | AnyParam): CmpCommand =>
    cmp("re-find?", re, v),
  in: <T>(v: Operand<T>, values: readonly T[] | AnyParam): CmpCommand =>
    cmp("in", v, values),

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

  /**
   * Clauses that are part of the query only while the gate is on. The gate
   * is a `Param<boolean>` (on when bound `true`) or a `Ramose.optional`
   * param (on when bound at all — and inside the body that param is bound,
   * so referencing it there is always legal). Never a JS predicate: the
   * query stays one value. Gate on, the body lowers exactly as if written
   * inline; gate off, it lowers to nothing. Top-level clauses only — inside
   * `Q.or` / `Q.not` an off gate would make the branch vacuously true.
   */
  when: (<G extends AnyParam>(gate: G & ValidGate<G>, body: SubBody): WhenCommand => {
    if (typeof gate !== "object" || gate === null || (gate as { _tag?: unknown })._tag !== "Param") {
      throw new Error(
        "ramose/query: Q.when's gate must be a param (a Param<boolean>, or a Ramose.optional param that gates on being bound) — a JS value or predicate would fork the query object, which is the thing `when` exists to avoid",
      );
    }
    return {
      _tag: "when",
      gate: gate as AnyParam,
      body,
      [Symbol.iterator]() {
        return yieldSelf<void>(this);
      },
    };
  }) as <G extends AnyParam>(gate: G & ValidGate<G>, body: SubBody) => WhenCommand,

  // ── projections ──────────────────────────────────────────────────────────

  /** Project one root through a select shape — the closing contract of a
   * single-root body. */
  pull: <const S extends Shape>(
    focus: AnyVar,
    shape: S & ValidShape<S>,
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

  /** Merge extra cells onto a base projection (used by `Query.enrich`). */
  row: <Base extends Projection, const Extra extends CellRecord>(
    base: Base,
    extra: Extra,
  ): RowsSpec<RowOfProjection<Base> & RecordRow<Extra>> => {
    const cells = isRowsSpec(base)
      ? { ...base.cells, ...extra }
      : isPullSpec(base)
        ? { ...extra, ["…"]: base }
        : { ...(base as CellRecord), ...extra };
    return { _tag: "rowsSpec", cells: cells as CellRecord };
  },

  // ── aggregate cells ──────────────────────────────────────────────────────
  count: (v: AnyVar): AggSpec<number> => agg("count", v),
  countDistinct: (v: AnyVar): AggSpec<number> => agg("count-distinct", v),
  sum: (v: Var<number> | AnyVar): AggSpec<number> => agg("sum", v),
  avg: (v: Var<number> | AnyVar): AggSpec<number | null> => agg("avg", v),
  min: <T>(v: Var<T>): AggSpec<T | null> => agg("min", v),
  max: <T>(v: Var<T>): AggSpec<T | null> => agg("max", v),
};
