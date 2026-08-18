/**
 * Navigational query values — the read surface from docs/QUERY.md.
 *
 * `Ripple.query(Todo).where(...).select(...).orderBy(...).limit(n)` builds a
 * {@link NavQuery} value. `db.q` / `db.live` run it. Datalog is the IR: we
 * lower to `{ find: [["pull", "?e", pattern]], where, order, limit, offset }`
 * so the peer does pull-in-query (no client N+1) and sorts and pages the row
 * set itself — the client never sees the rows a page dropped.
 *
 * Everything that changes the row count is lowered: `.orderBy` binds a sort
 * variable, and a required (non-`.optional`) selected field becomes a `where`
 * clause, so `:limit 20` really is twenty rows the client keeps.
 */

import { lowerAttr } from "./attrRef.ts";
import type { AnyAttribute, Cardinality } from "./Attribute.ts";
import { type Eid, makeEid } from "./Eid.ts";
import type { AnyNamespace } from "./Namespace.ts";
import {
  inspectPullField,
  isPullNested,
  isPullOptional,
  lowerPullPattern,
  nested,
  optional,
  reshapePullResult,
} from "./Pull.ts";

// ── markers ────────────────────────────────────────────────────────────────

export type PredTag =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "startsWith"
  | "endsWith"
  | "includes"
  | "matches"
  | "in"
  | "is"
  | "exists"
  | "missing";

/** A closed predicate over a path of attribute idents from the query root. */
export interface Predicate {
  readonly _tag: "Predicate";
  readonly op: PredTag;
  /** Idents from the root entity, e.g. `[":todo/owner", ":user/name"]`. */
  readonly path: readonly string[];
  readonly value?: unknown;
}

export type ShapeField =
  | AnyAttribute
  | PathCarrier
  | { readonly _tag: "optional"; readonly field: unknown }
  | { readonly _tag: "nested"; readonly attr: unknown; readonly pattern: unknown }
  | { readonly _tag: "select"; readonly attr: unknown; readonly shape: Shape };

export type Shape = { readonly [key: string]: ShapeField };

export type OrderEmpty = "first" | "last";
export type OrderDir = "asc" | "desc";

/**
 * One sort key, as a path of idents from the query root. Lowering binds it to
 * an order variable the peer sorts on; `empty` places rows whose path has no
 * value, in both directions, and defaults to `"last"`.
 *
 * Multi-hop paths keep such rows: the order variable is bound through an
 * `or-join` whose second branch grounds `null` when the path is absent.
 */
export interface OrderBy {
  readonly path: readonly string[];
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

export interface NavQuerySpec {
  readonly ns: string;
  /** Attribute idents that define membership in `ns` (for bare scope). */
  readonly nsIdents: readonly string[];
  readonly where: readonly Predicate[];
  readonly shape: Shape | undefined;
  readonly orderBy: readonly OrderBy[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/**
 * A navigational query value. Phantom `R` is the row element type inferred
 * from `.select`.
 */
export interface NavQuery<R = unknown> {
  readonly _tag: "NavQuery";
  readonly spec: NavQuerySpec;
  readonly _result?: R;
}

export const isNavQuery = (x: unknown): x is NavQuery =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "NavQuery";

// ── path / predicate helpers (stamped onto attrs by Namespace) ─────────────

export type PathCarrier = {
  readonly ident: string;
  readonly cardinality?: Cardinality;
  readonly __path?: readonly string[];
  /** Cardinality of each hop in `__path` — parallel to it. */
  readonly __cards?: readonly Cardinality[];
};

export const pathOf = (attr: PathCarrier): readonly string[] =>
  attr.__path ?? [attr.ident];

export const cardsOf = (attr: PathCarrier): readonly Cardinality[] =>
  attr.__cards ?? [attr.cardinality ?? "one"];

const pred = (
  op: PredTag,
  attr: PathCarrier,
  value?: unknown,
): Predicate => ({
  _tag: "Predicate",
  op,
  path: pathOf(attr),
  value,
});

/** The value an attr compares against: its Schema's type, `unknown` if untyped. */
export type AttrValue<A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

/** What names an entity in a predicate: a raw eid, or an {@link Eid} row cell. */
export type EidLike = number | { readonly id: number };

/**
 * The element type of `in(...)`. A ref (including the `:db/id`
 * pseudo-attribute) takes entities; anything else takes its Schema's type.
 */
export type InValue<A> = A extends { readonly valueType: ":db.type/ref" }
  ? EidLike
  : AttrValue<A>;

/** Predicate / shape methods attached to every stamped attr. */
export type AttrNav<A extends PathCarrier> = A & {
  readonly eq: (value: AttrValue<A>) => Predicate;
  readonly ne: (value: AttrValue<A>) => Predicate;
  readonly lt: (value: AttrValue<A>) => Predicate;
  readonly lte: (value: AttrValue<A>) => Predicate;
  readonly gt: (value: AttrValue<A>) => Predicate;
  readonly gte: (value: AttrValue<A>) => Predicate;
  readonly in: (values: readonly InValue<A>[]) => Predicate;
  readonly startsWith: (prefix: string) => Predicate;
  readonly endsWith: (suffix: string) => Predicate;
  readonly includes: (needle: string) => Predicate;
  readonly matches: (re: RegExp | string) => Predicate;
  readonly exists: () => Predicate;
  readonly missing: () => Predicate;
  /** Ref-only: the entity this ref points at. */
  readonly is: A extends { readonly valueType: ":db.type/ref" }
    ? (ref: EidLike) => Predicate
    : never;
  readonly optional: ReturnType<typeof optional<A>>;
  readonly select: A extends { readonly valueType: ":db.type/ref" }
    ? <const S extends Shape>(shape: S) => SelectNested<A, S>
    : never;
};

/**
 * The peer compiles a `matches` pattern with `new RegExp(source)` — no flags,
 * because the pattern travels as a string and the engine's `re-find?` takes
 * one argument. A flagged `RegExp` is rejected here rather than lowered to
 * something that quietly means something else.
 */
const regexSource = (re: RegExp | string): string => {
  if (typeof re === "string") return re;
  if (re.flags !== "") {
    throw new Error(
      `ripple/query: matches(/${re.source}/${re.flags}) — the peer compiles the pattern with no flags, so \`${re.flags}\` cannot be lowered. Express it in the pattern instead (e.g. \`[aA]da\` for case-insensitivity).`,
    );
  }
  return re.source;
};

/** `Eid` row cells and raw ids are the same entity to a predicate. */
const eidValue = (ref: unknown): number => {
  if (typeof ref === "number") return ref;
  if (
    typeof ref === "object" &&
    ref !== null &&
    typeof (ref as { id?: unknown }).id === "number"
  ) {
    return (ref as { id: number }).id;
  }
  throw new Error(
    `ripple/query: is(...) takes an entity id or an Eid, got ${String(ref)}`,
  );
};

/** Refs compare by id, so an `Eid` in an `in(...)` list is its number. */
const inValue = (v: unknown): unknown =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { id?: unknown }).id === "number" &&
  Object.keys(v).length === 1
    ? (v as { id: number }).id
    : v;

export interface SelectNested<A = unknown, S = unknown> {
  readonly _tag: "select";
  readonly attr: A;
  readonly shape: S;
  readonly optional: {
    readonly _tag: "optional";
    readonly field: SelectNested<A, S>;
  };
}

const NAV_METHODS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "startsWith",
  "endsWith",
  "includes",
  "matches",
  "exists",
  "missing",
  "is",
  "optional",
  "select",
]);

export const attachAttrNav = <A extends PathCarrier>(attr: A): AttrNav<A> => {
  const api = {
    eq(this: PathCarrier, value: unknown) {
      return pred("eq", this, value);
    },
    ne(this: PathCarrier, value: unknown) {
      return pred("ne", this, value);
    },
    lt(this: PathCarrier, value: unknown) {
      return pred("lt", this, value);
    },
    lte(this: PathCarrier, value: unknown) {
      return pred("lte", this, value);
    },
    gt(this: PathCarrier, value: unknown) {
      return pred("gt", this, value);
    },
    gte(this: PathCarrier, value: unknown) {
      return pred("gte", this, value);
    },
    in(this: PathCarrier, values: readonly unknown[]) {
      if (!Array.isArray(values)) {
        throw new Error(
          `ripple/query: in(...) takes an array of values, got ${String(values)}`,
        );
      }
      return pred("in", this, values.map(inValue));
    },
    startsWith(this: PathCarrier, prefix: string) {
      return pred("startsWith", this, prefix);
    },
    endsWith(this: PathCarrier, suffix: string) {
      return pred("endsWith", this, suffix);
    },
    includes(this: PathCarrier, needle: string) {
      return pred("includes", this, needle);
    },
    matches(this: PathCarrier, re: RegExp | string) {
      return pred("matches", this, regexSource(re));
    },
    is(this: PathCarrier, ref: unknown) {
      return pred("is", this, eidValue(ref));
    },
    exists(this: PathCarrier) {
      return pred("exists", this);
    },
    missing(this: PathCarrier) {
      return pred("missing", this);
    },
    get optional() {
      return optional(attr);
    },
    select(this: PathCarrier, shape: Shape) {
      const nestedSelect: SelectNested<PathCarrier, Shape> = {
        _tag: "select",
        attr: this,
        shape,
        get optional() {
          return { _tag: "optional" as const, field: nestedSelect };
        },
      };
      return nestedSelect;
    },
  };

  return new Proxy(attr, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in api) {
        const v = (api as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as Function).bind(receiver) : v;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AttrNav<A>;
};

export const withPath = <A extends PathCarrier>(
  attr: A,
  path: readonly string[],
  cards: readonly Cardinality[],
): A => {
  if (attr.__path === path) return attr;
  return new Proxy(attr, {
    get(target, prop, receiver) {
      if (prop === "__path") return path;
      if (prop === "__cards") return cards;
      const v = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        NAV_METHODS.has(prop) &&
        typeof v === "function"
      ) {
        return (v as Function).bind(receiver);
      }
      return v;
    },
  }) as A;
};

export const isSelectNested = (x: unknown): x is SelectNested =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "select";

/** Convert a navigational shape into the literate pull map `lowerPullPattern` knows. */
export const shapeToPullMap = (shape: Shape): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = shapeFieldToPull(field);
  }
  return out;
};

const shapeFieldToPull = (field: unknown): unknown => {
  if (isPullOptional(field)) {
    return optional(shapeFieldToPull(field.field));
  }
  if (isSelectNested(field)) {
    return nested(
      field.attr as { readonly valueType: ":db.type/ref" },
      shapeToPullMap(field.shape as Shape),
    );
  }
  if (isPullNested(field)) {
    return field;
  }
  return field;
};

// ── builder ────────────────────────────────────────────────────────────────

export type SelectResult<S> = {
  readonly [K in keyof S]: SelectFieldResult<S[K]>;
};

type SchemaType<S> = S extends { readonly Type: infer T }
  ? T
  : S extends { readonly schema: { readonly Type: infer T } }
    ? T
    : never;

type SelectFieldResult<F> = F extends {
  readonly _tag: "optional";
  readonly field: infer Inner;
}
  ? SelectFieldResult<Inner> | undefined
  : F extends {
        readonly _tag: "select";
        readonly attr: infer A;
        readonly shape: infer S;
      }
    ? A extends { readonly cardinality: "many" }
      ? readonly SelectResult<S & object>[]
      : SelectResult<S & object>
    : F extends {
          readonly _tag: "nested";
          readonly attr: infer A;
          readonly pattern: infer P;
        }
      ? A extends { readonly cardinality: "many" }
        ? readonly SelectResult<P & object>[]
        : SelectResult<P & object>
      : F extends {
            readonly schema: infer S;
            readonly cardinality: infer Card;
          }
        ? F extends { readonly ident: ":db/id" }
          ? number
          : Card extends "many"
            ? readonly SchemaType<F>[]
            : SchemaType<F>
        : F extends { readonly ident: ":db/id" }
          ? number
          : never;

/** `R` defaults to the matched entity ids — what a query with no `.select` yields. */
export interface NavQueryBuilder<
  N extends AnyNamespace,
  R = readonly Eid[],
> {
  readonly ns: N;
  readonly spec: NavQuerySpec;

  where(...preds: Predicate[]): NavQueryBuilder<N, R>;
  select<const S extends Shape>(
    shape: S,
  ): NavQueryBuilder<N, readonly SelectResult<S>[]>;
  orderBy(
    attr: PathCarrier,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): NavQueryBuilder<N, R>;
  limit(n: number): NavQueryBuilder<N, R>;
  offset(n: number): NavQueryBuilder<N, R>;

  /** Freeze into a runnable query value. */
  build(): NavQuery<R>;
}

const freeze = <R>(spec: NavQuerySpec): NavQuery<R> => ({
  _tag: "NavQuery",
  spec,
});

const builder = <N extends AnyNamespace, R>(
  ns: N,
  spec: NavQuerySpec,
): NavQueryBuilder<N, R> => {
  const self: NavQueryBuilder<N, R> = {
    ns,
    spec,
    where: (...preds) =>
      builder(ns, { ...spec, where: [...spec.where, ...preds] }),
    select: (shape) =>
      builder(ns, { ...spec, shape }) as unknown as NavQueryBuilder<
        N,
        readonly SelectResult<typeof shape>[]
      >,
    orderBy: (attr, dir = "asc", opts) => {
      const path = pathOf(attr);
      if (cardsOf(attr).includes("many")) {
        throw new Error(
          `ripple/query: orderBy(${path.join(" → ")}) crosses a cardinality-many attribute — the sort key would be a set, not a value`,
        );
      }
      return builder(ns, {
        ...spec,
        orderBy: [
          ...spec.orderBy,
          { path, dir, empty: opts?.empty ?? "last" },
        ],
      });
    },
    limit: (n) => builder(ns, { ...spec, limit: n }),
    offset: (n) => builder(ns, { ...spec, offset: n }),
    build: () => freeze<R>(spec),
  };
  return self;
};

/**
 * Start a navigational query scoped to namespace `N`.
 *
 * Calling `.where` / `.select` / … returns a builder; pass the builder (or
 * `.build()`) to `db.q` / `db.live`. Builders are accepted directly so
 * `db.q(Ripple.query(Todo).where(...).select(...))` works without `.build()`.
 */
export const query = <N extends AnyNamespace>(ns: N): NavQueryBuilder<N> => {
  const nsIdents = Object.values(ns.attributes).map(
    (a) => (a as { ident: string }).ident,
  );
  return builder(ns, {
    ns: ns.ns,
    nsIdents,
    where: [],
    shape: undefined,
    orderBy: [],
    limit: undefined,
    offset: undefined,
  });
};

/** Accept a builder or a frozen {@link NavQuery}. */
export const asNavQuery = <R>(
  q: NavQuery<R> | NavQueryBuilder<AnyNamespace, R>,
): NavQuery<R> =>
  isNavQuery(q) ? q : (q as NavQueryBuilder<AnyNamespace, R>).build();

// ── lower to peer query object ─────────────────────────────────────────────

let fresh = 0;
const gensym = (prefix: string) => `?${prefix}${fresh++}`;

const resetGensym = () => {
  fresh = 0;
};

/** The pseudo-attribute: the entity variable itself, never a datom. */
const ID = ":db/id";

/** One sort key on the wire — `empty` is always explicit. */
interface OrderClause {
  readonly var: string;
  readonly dir: OrderDir;
  readonly empty: OrderEmpty;
}

export interface LoweredQuery {
  readonly find: unknown[];
  readonly where: unknown[];
  readonly order?: readonly OrderClause[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Lower predicates, namespace scope, required fields and sort keys. */
export const lowerNavQuery = (
  q: NavQuery,
): {
  readonly query: LoweredQuery;
  readonly pullMap: Record<string, unknown> | undefined;
} => {
  resetGensym();
  const root = "?e";
  const where: unknown[] = [];

  // Namespace scope: entity has at least one attr in the ns (or-join).
  if (q.spec.nsIdents.length > 0) {
    where.push([
      "or",
      ...q.spec.nsIdents.map((ident) => [root, ident, "_"]),
    ]);
  }

  for (const p of q.spec.where) {
    where.push(...lowerPredicate(root, p));
  }

  const pullMap =
    q.spec.shape !== undefined ? shapeToPullMap(q.spec.shape) : undefined;
  if (pullMap !== undefined) where.push(...requiredClauses(root, pullMap));

  const order: OrderClause[] = [];
  for (const o of q.spec.orderBy) {
    const bound = lowerOrderPath(root, o.path);
    where.push(...bound.clauses);
    order.push({ var: bound.var, dir: o.dir, empty: o.empty });
  }

  const find =
    pullMap !== undefined
      ? [["pull", root, lowerPullPattern(pullMap)]]
      : [root];

  return {
    query: {
      find,
      where,
      ...(order.length > 0 ? { order } : {}),
      ...(q.spec.limit !== undefined ? { limit: q.spec.limit } : {}),
      ...(q.spec.offset !== undefined ? { offset: q.spec.offset } : {}),
    },
    pullMap,
  };
};

/** `[?e :a ?j] [?j :b <value>]` — the join chain a path of idents walks. */
const hopClauses = (
  root: string,
  path: readonly string[],
  value: unknown,
): unknown[] => {
  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push([e, path[i], next]);
    e = next;
  }
  return [...clauses, [e, path[path.length - 1], value]];
};

/**
 * Bind a sort variable to the value at `path` **without dropping rows**: one
 * or-join branch walks the path, the other proves it is absent and grounds
 * `null`, which the engine places per the key's `empty`. (`get-else` cannot
 * stand in: a function binding of `null` drops the row.)
 */
const lowerOrderPath = (
  root: string,
  path: readonly string[],
): { readonly var: string; readonly clauses: unknown[] } => {
  if (path.length === 1 && path[0] === ID) return { var: root, clauses: [] };
  const bound = gensym("o");
  return {
    var: bound,
    clauses: [
      [
        "or-join",
        [root, bound],
        ["and", ...hopClauses(root, path, bound)],
        [
          "and",
          ["not", ...hopClauses(root, path, "_")],
          [["ground", [null]], [bound, "..."]],
        ],
      ],
    ],
  };
};

/**
 * The row-dropping half of `filterPull`, as `where` clauses — so the peer's
 * row set is already the one the client keeps and `:limit` pages it honestly.
 *
 * A required cardinality-one field must be present (a nested one recursively,
 * through the ref); `.optional` and cardinality-many fields never drop the
 * row (a missing many is `[]`), and `:db/id` is always there.
 */
const requiredClauses = (e: string, pattern: unknown): unknown[] => {
  if (Array.isArray(pattern)) return [];
  const out: unknown[] = [];
  for (const field of Object.values(fieldsOf(pattern))) {
    const info = inspectPullField(field);
    if (info.optional || info.many) continue;
    const ident = lowerAttr(info.attr);
    if (ident === ID) continue;
    if (info.nestedPattern === undefined) {
      out.push([e, ident, "_"]);
      continue;
    }
    const target = gensym("r");
    const sub = requiredClauses(target, info.nestedPattern);
    out.push([e, ident, sub.length > 0 ? target : "_"], ...sub);
  }
  return out;
};

const fieldsOf = (pattern: unknown): Record<string, unknown> =>
  typeof pattern === "object" && pattern !== null && !Array.isArray(pattern)
    ? (pattern as Record<string, unknown>)
    : {};

/**
 * A clause that binds nothing and matches nothing: an empty collection binding
 * yields no rows. `in([])`, `or()` and `not(<always true>)` all mean "no rows",
 * and they mean it on the peer, so a `:limit` still counts kept rows.
 */
const neverClause = (): unknown[] => [["ground", []], [gensym("n"), "..."]];

const lowerPredicate = (root: string, p: Predicate): unknown[] => {
  const { path, op, value } = p;
  if (path.length === 0) return [];
  if (path[path.length - 1] === ID) return lowerIdPredicate(root, path, p);

  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push([e, path[i], next]);
    e = next;
  }
  const attr = path[path.length - 1]!;

  switch (op) {
    case "eq":
    case "is":
      clauses.push([e, attr, value]);
      break;
    case "in": {
      const values = value as readonly unknown[];
      if (values.length === 0) return [neverClause()];
      const v = gensym("v");
      // `?v` is bound by the pattern, so the collection binding filters it
      // rather than generating: the peer keeps one row per match, not per value
      clauses.push([e, attr, v], [["ground", [...values]], [v, "..."]]);
      break;
    }
    case "ne": {
      const v = gensym("v");
      clauses.push([e, attr, v], [["not=", v, value]]);
      break;
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const v = gensym("v");
      const fn =
        op === "lt"
          ? "<"
          : op === "lte"
            ? "<="
            : op === "gt"
              ? ">"
              : ">=";
      clauses.push([e, attr, v], [[fn, v, value]]);
      break;
    }
    case "startsWith": {
      const v = gensym("v");
      clauses.push([e, attr, v], [["starts-with?", v, value]]);
      break;
    }
    case "endsWith": {
      const v = gensym("v");
      clauses.push([e, attr, v], [["ends-with?", v, value]]);
      break;
    }
    case "includes": {
      const v = gensym("v");
      clauses.push([e, attr, v], [["includes?", v, value]]);
      break;
    }
    case "matches": {
      const v = gensym("v");
      // `re-find?` takes the pattern first, then the string
      clauses.push([e, attr, v], [["re-find?", value, v]]);
      break;
    }
    case "exists":
      clauses.push([e, attr, "_"]);
      break;
    case "missing":
      clauses.push(["not", [e, attr, "_"]]);
      break;
  }
  return clauses;
};

/**
 * `:db/id` is the entity variable, not a datom: `eq` unifies it with the
 * constant so the planner starts there, and the ordering predicates compare
 * it as the number it is. Every entity has one, so `exists` costs no clause.
 */
const lowerIdPredicate = (
  root: string,
  path: readonly string[],
  p: Predicate,
): unknown[] => {
  const clauses: unknown[] = [];
  let e = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = gensym("j");
    clauses.push([e, path[i], next]);
    e = next;
  }
  switch (p.op) {
    case "eq":
    case "is":
      clauses.push([["ground", eidValue(p.value)], e]);
      break;
    case "in": {
      const values = (p.value as readonly unknown[]).map(eidValue);
      if (values.length === 0) return [neverClause()];
      clauses.push([["ground", values], [e, "..."]]);
      break;
    }
    case "ne":
      clauses.push([["not=", e, p.value]]);
      break;
    case "lt":
      clauses.push([["<", e, p.value]]);
      break;
    case "lte":
      clauses.push([["<=", e, p.value]]);
      break;
    case "gt":
      clauses.push([[">", e, p.value]]);
      break;
    case "gte":
      clauses.push([[">=", e, p.value]]);
      break;
    case "exists":
      break;
    default:
      throw new Error(
        `ripple/query: ${p.op} is not defined on :db/id — an entity id is a number`,
      );
  }
  return clauses;
};

/**
 * Reshape the peer's rows: pull maps into the selected shape, bare ids into
 * `Eid`s. Order, paging and every row-dropping constraint already happened on
 * the peer (`requiredClauses` put each required field in `:where`), so this
 * changes the shape of a row and never the number of them — a `[null]` cell,
 * unreachable on a well-lowered query, comes back as a `null` row rather than
 * a quietly shorter page.
 */
export const finalizeNavResult = (
  raw: unknown,
  pullMap: Record<string, unknown> | undefined,
): unknown => {
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  // find-pull → [[map], ...]; bare find → [[eid], ...]. Unwrap the one cell.
  const cellOf = (row: unknown): unknown => (Array.isArray(row) ? row[0] : row);
  if (pullMap !== undefined) {
    return rows.map((row) => reshapePullResult(pullMap, cellOf(row)));
  }
  return rows.map((row) => {
    const cell = cellOf(row);
    return typeof cell === "number" ? makeEid(cell) : cell;
  });
};
