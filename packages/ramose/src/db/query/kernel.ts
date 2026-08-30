import { FUNCTIONS } from "../../internal/core/query/builtins.ts";
import type { Eid } from "../Eid.ts";
import type { AnyComposer } from "../Composer.ts";
import type { InFocus } from "./focus.ts";
import type { FocusShape, Shape, ValidShape, SelectResult, AttrValue } from "../shapes.ts";

export type VarKind = "entity" | "value" | "id" | "t" | "tx" | "op";

export type VarNs<T> = T extends { readonly _ns: infer E }
  ? E extends AnyComposer
    ? E
    : AnyComposer
  : AnyComposer;

/**
 * A query variable — an *identity*, not a name. Two mentions of one `Var`
 * are the same variable wherever they appear; a typo is a compile error
 * because there is no string to mistype. `T` is the value the var binds
 * (phantom); `N` is the focus namespace an entity var is branded with
 * (the same brand {@link Eid} carries — not a fourth vocabulary).
 */
export interface Var<T = unknown, N extends AnyComposer = VarNs<T>> {
  readonly _tag: "QVar";
  readonly id: number;
  kind: VarKind;
  ns?: string | undefined;
  readonly _type?: T;
  readonly _ns?: N;
}

export type AnyVar = Var<any, any>;

export type FocusOf<V> = V extends Var<any, infer N> ? N : AnyComposer;

let nextVarId = 1;

export const mkVar = <T = unknown, N extends AnyComposer = VarNs<T>>(
  kind: VarKind = "value",
  ns?: string,
): Var<T, N> => ({ _tag: "QVar", id: nextVarId++, kind, ns }) as Var<T, N>;

export const isVar = (x: unknown): x is AnyVar =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "QVar";

export interface Blank {
  readonly _tag: "QBlank";
}
const BLANK: Blank = { _tag: "QBlank" };

export const isBlank = (x: unknown): x is Blank =>
  typeof x === "object" && x !== null && (x as { _tag?: unknown })._tag === "QBlank";

/**
 * The body of a query, rule or fragment: a generator whose yields are
 * kernel commands and whose return is the binding (a handle, a projection,
 * or nothing). Fragments compose by native delegation — `yield* frag(e)` —
 * typed by TS's own Generator types.
 */
export type QueryGen<R = void> = Generator<AnyCommand, R, any>;

export type EidCell = { readonly id: number };

/** A fragment: a rule with modes — bound vars are arguments, the free var
 * is its return. `void` keeps the pipeline's focus; a handle refocuses. */
export type Fragment<In = AnyVar, R = void> = (focus: In) => QueryGen<R>;

interface Yieldable<R> {
  [Symbol.iterator](): Iterator<AnyCommand, R, any>;
}

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

export interface AttrLike {
  readonly ident: string;
}

export type Position = AnyVar | Blank | unknown;

export interface FactHandle<T = unknown> {
  readonly e: Var<EidCell>;
  readonly v: Var<T>;
  readonly t: Var<number>;
  readonly tx: Var<EidCell>;
  readonly op: Var<boolean>;
}

export interface FactCommand<T = unknown> extends Yieldable<FactHandle<T>> {
  readonly _tag: "fact";
  readonly e0: Position | undefined;
  readonly attr: AttrLike | undefined;
  readonly v0: Position | undefined;
  eVar?: AnyVar;
  vVar?: AnyVar;
  txVar?: AnyVar;
  txKind?: "t" | "tx";
  opVar?: AnyVar;
  readonly handle: FactHandle<T>;
}

export interface CmpCommand extends Yieldable<void> {
  readonly _tag: "cmp";
  readonly op: string;
  readonly args: readonly Position[];
  readonly ignoreCase?: boolean;
}

export interface FnBindCommand extends Yieldable<AnyVar> {
  readonly _tag: "fnBind";
  readonly fn: string;
  readonly args: readonly Position[];
  readonly ret: AnyVar;
}

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

export type SubBody =
  | QueryGen<unknown>
  | (() => QueryGen<unknown>)
  | CmpCommand
  | FactCommand<any>
  | OrCommand
  | NotCommand;

export interface MemberCommand<N extends AnyComposer = AnyComposer> extends Yieldable<Var<Eid<N>>> {
  readonly _tag: "member";
  readonly ns: N;
}

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

export interface MemberClause {
  readonly _tag: "memberOf";
  readonly ns: AnyComposer;
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

export interface BuildCtx {
  readonly clauses: BClause[];
}

const toGen = (b: SubBody): QueryGen<unknown> => {
  if (typeof b === "function") return b();
  if (typeof (b as Partial<Iterator<unknown>>).next !== "function") {
    return (b as Iterable<unknown>)[Symbol.iterator]() as QueryGen<unknown>;
  }
  return b as QueryGen<unknown>;
};

export const runBody = <R>(gen: QueryGen<R>, ctx: BuildCtx): R => {
  let step = gen.next();
  while (!step.done) {
    step = gen.next(dispatch(step.value, ctx));
  }
  return step.value;
};

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
      const v = mkVar<Eid<AnyComposer>>("entity", cmd.ns.ns);
      ctx.clauses.push({ _tag: "memberOf", ns: cmd.ns, v });
      return v;
    }
    case "splice":
      return cmd.splice(ctx);
  }
};

export interface PullSpec<Row = unknown> {
  readonly _tag: "pullSpec";
  readonly focus: AnyVar;
  readonly shape: Shape;
  readonly _row?: Row;
}

export interface AggSpec<T = unknown> {
  readonly _tag: "aggSpec";
  readonly fn: "count" | "count-distinct" | "sum" | "avg" | "min" | "max";
  readonly v: AnyVar;
  readonly _out?: T;
}

export type Cell = AnyVar | PullSpec<any> | AggSpec<any> | CellRecord;
export interface CellRecord {
  readonly [key: string]: Cell;
}

export interface RowsSpec<Row = unknown> {
  readonly _tag: "rowsSpec";
  readonly cells: CellRecord;
  readonly _row?: Row;
}

export interface ValueSpec<T = unknown> {
  readonly _tag: "valueSpec";
  readonly cell: AggSpec<T> | AnyVar | PullSpec<any>;
  readonly _out?: T;
}

export interface DistinctSpec<Row = unknown> {
  readonly _tag: "distinctSpec";
  readonly inner: PullSpec<any> | RowsSpec<any> | CellRecord;
  readonly _row?: Row;
}

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

export const FOCUS: AnyVar = Object.freeze({
  _tag: "QVar",
  id: -1,
  kind: "entity",
}) as AnyVar;

export const isFocusSentinel = (v: unknown): v is AnyVar => isVar(v) && v.id === -1;

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

type FactAttr<E, A> = [E] extends [Var<any, infer N>]
  ? [AnyComposer] extends [N]
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
  if (isVar(e) && a !== undefined && e.ns === undefined) e.ns = nsOfIdent(a.ident);
  return cmd as FactCommand<AttrValue<A>>;
};

const fact = <E extends Position | undefined, A extends AttrLike = AttrLike>(
  e?: E,
  attr?: FactAttr<E, A> | Blank,
  v?: Position,
): FactCommand<AttrValue<A>> => factImpl(e, attr as A | Blank | undefined, v);

export type Operand<T = unknown> = Var<T> | AggSpec<T> | T;

const agg = <T>(fn: AggSpec["fn"], v: AnyVar): AggSpec<T> => {
  if (!isVar(v)) {
    throw new Error(`ramose/query: Q.${fn === "count-distinct" ? "countDistinct" : fn}(...) aggregates a bound var`);
  }
  return { _tag: "aggSpec", fn, v };
};

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
  fact,

  var: <T = unknown>(): Var<T> => mkVar<T>("value"),

  _: BLANK,

  eq: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("=", [a, b]),
  ne: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("not=", [a, b]),
  lt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<", [a, b]),
  lte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp("<=", [a, b]),
  gt: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">", [a, b]),
  gte: <T>(a: Operand<T>, b: Operand<T>): CmpCommand => cmp(">=", [a, b]),
  startsWith: stringPred("starts-with?"),
  endsWith: stringPred("ends-with?"),
  includes: stringPred("includes?"),
  matches: (v: Operand<string>, re: RegExp | string): CmpCommand =>
    cmp("re-find?", [re, v]),
  in: <T>(v: Operand<T>, values: readonly T[]): CmpCommand =>
    cmp("in", [v, values]),

  call: (fn: string, ...args: Position[]): FnBindCommand => fnBind(fn, args),

  or: (...branches: readonly SubBody[]): OrCommand => ({
    _tag: "or",
    branches,
    [Symbol.iterator]() {
      return yieldSelf<void>(this);
    },
  }),

  not: (body: SubBody): NotCommand => ({
    _tag: "not",
    body,
    [Symbol.iterator]() {
      return yieldSelf<void>(this);
    },
  }),

  pull: <V extends AnyVar, const S extends Shape>(
    focus: V,
    shape: S & ValidShape<S> & FocusShape<FocusOf<V>, S>,
  ): PullSpec<SelectResult<S>> => {
    if (!isVar(focus)) {
      throw new Error("ramose/query: Q.pull's first argument is the bound focus var");
    }
    return { _tag: "pullSpec", focus, shape: shape as Shape };
  },

  rows: <const R extends CellRecord>(cells: R): RowsSpec<RecordRow<R>> => ({
    _tag: "rowsSpec",
    cells,
  }),

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

  distinct: <const P extends Distinctable>(proj: P): DistinctSpec<RowOfProjection<P>> => ({
    _tag: "distinctSpec",
    inner: distinctInner(proj),
  }),

  focus: FOCUS,

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

  count: (v: AnyVar): AggSpec<number> => agg("count", v),
  countDistinct: (v: AnyVar): AggSpec<number> => agg("count-distinct", v),
  sum: (v: Var<number> | AnyVar): AggSpec<number> => agg("sum", v),
  avg: (v: Var<number> | AnyVar): AggSpec<number | null> => agg("avg", v),
  min: <T>(v: Var<T>): AggSpec<T | null> => agg("min", v),
  max: <T>(v: Var<T>): AggSpec<T | null> => agg("max", v),
};
