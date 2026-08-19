/** Literate pull map: keys are result names, values are attr refs / `.optional` / `.select`. */

import type { PullElemOrder, PullElemPred } from "../internal/core/query/ast.ts";
import type * as Schema from "effect/Schema";
import type { AnyAttribute } from "./Attribute.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnyCatalog } from "./Catalog.ts";
import type { AttrAtIdent, CatalogIdent, Ident } from "./idents.ts";
import type { AnyNamespace, AttributeMap } from "./Namespace.ts";

// ── markers ────────────────────────────────────────────────────────────────

/**
 * Pull-phase constraints on one nested collection, already lowered to the
 * engine's IR (`PullAttrSpec`'s `:where` / `:order` / `:offset` / `:limit`).
 *
 * The client builds them with `.where` / `.orderBy` / `.limit` / `.offset` on
 * a card-many ref or backlink nav (see `CollectionNav` in NavQuery.ts) and
 * lowers them there, eagerly — this module only carries them onto the spec.
 * They are evaluated *inside* the pull, after the outer `:order` / `:offset` /
 * `:limit` slice, so they never change the row set.
 */
export interface PullNestedConstraints {
  readonly where?: readonly PullElemPred[];
  readonly order?: readonly PullElemOrder[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface PullOptional<F = unknown> {
  readonly _tag: "optional";
  readonly field: F;
  /**
   * Nested pull, then maybe. Only on refs
   * (`valueType: ":db.type/ref"`). Prefer `attr.select(shape).optional`.
   */
  readonly select: F extends { readonly valueType: ":db.type/ref" }
    ? <const P extends Record<string, unknown>>(
        pattern: P,
      ) => PullOptional<PullNested<F, P>>
    : never;
}

/**
 * A card-one scalar with a stand-in for "no datom": the field reads as `value`
 * when the entity has none. It lowers to the pull-phase `:default`, so the
 * substitution is the *peer's* — the row is neither dropped nor invented, and
 * no datom is written. The result type is the attribute's, never `| undefined`.
 */
export interface PullDefault<F = unknown> {
  readonly _tag: "default";
  readonly field: F;
  readonly value: unknown;
}

export interface PullNested<A = unknown, P = unknown> {
  readonly _tag: "nested";
  readonly attr: A;
  readonly pattern: P;
  /** Pull-phase `where` / `order` / `offset` / `limit` on a collection. */
  readonly constraints?: PullNestedConstraints;
  /** The whole nested value is maybe (`T | undefined`). */
  readonly optional: PullOptional<PullNested<A, P>>;
}

/**
 * Literate pull methods stamped onto every attr ref (`User.name`).
 * Nested shapes use {@link AttrNav.select} from NavQuery (same grammar as
 * `Ramose.query(…).select`); this type only carries `.optional`.
 */
export type AttrPull<A> = {
  readonly optional: PullOptional<A>;
};

/** Internal: implements `attr.optional`. The result type is `T | undefined`. */
export const optional = <const F>(field: F): PullOptional<F> => ({
  _tag: "optional",
  field,
  select: ((pattern: Record<string, unknown>) =>
    optional(nested(field as never, pattern))) as unknown as PullOptional<F>["select"],
});

/**
 * Internal: implements `attr.orDefault(value)`. The value travels verbatim —
 * `null` is a default like any other, which is why lowering asks *whether*
 * there is one rather than comparing against `undefined`.
 *
 * `undefined` is the one value that cannot be a default: it does not survive
 * the JSON the spec travels as (`{default: undefined}` is dropped) and the
 * peer's own gate is `spec.default !== undefined`, so the field would read as
 * `undefined` while its type promised a value. That is `.optional`, spelled
 * wrong — so it is an error rather than a silent lie.
 */
export const pullDefault = <const F>(field: F, value: unknown): PullDefault<F> => {
  if (value === undefined) {
    throw new Error(
      "ramose/query: .orDefault(undefined) is not a default — the peer would read the field as missing anyway. Use `.optional` for a field that may be absent.",
    );
  }
  return {
    _tag: "default",
    field,
    value,
  };
};

/**
 * Internal: nested pull field. Prefer `attr.select({ … })` on stamped attrs;
 * that returns a select-marker which {@link inspectPullField} understands.
 */
export const nested = <
  const A extends { readonly valueType: ":db.type/ref" },
  const P extends Record<string, unknown>,
>(
  attr: A,
  pattern: P,
  constraints?: PullNestedConstraints,
): PullNested<A, P> => {
  const result: PullNested<A, P> = {
    _tag: "nested",
    attr,
    pattern,
    ...(constraints !== undefined ? { constraints } : {}),
    get optional() {
      return optional(result);
    },
  };
  return result;
};

/** Same-namespace shortcut: `pick(User, "name", "age")`. */
export const pick = <
  const N extends { readonly attributes: AttributeMap },
  const Keys extends readonly (keyof N["attributes"] & string)[],
>(
  ns: N,
  ...keys: Keys
): {
  readonly [K in Keys[number]]: N["attributes"][K];
} => {
  const fields = {} as Record<string, AnyAttribute>;
  for (const key of keys) fields[key] = ns.attributes[key]!;
  return fields as {
    readonly [K in Keys[number]]: N["attributes"][K];
  };
};

// ── the wildcard ───────────────────────────────────────────────────────────

/**
 * `Ramose.all(Todo)` — the peer's wildcard pull (`[*]`), as a client term.
 *
 * It is **not** a shape the client expands into a map of every attribute:
 * lowering emits the literal `["*"]` and the peer answers it, so what comes
 * back is every datom the entity carries, keyed by ident (`":todo/title"`),
 * refs as `{":db/id": n}` and cardinality-many attributes as arrays.
 *
 * The namespace is what the *type* is read against — see {@link AllRow} — and
 * what the query is already scoped to; the value it carries is unused at
 * runtime.
 */
export interface AllShape<N extends AnyNamespace = AnyNamespace> {
  readonly _tag: "all";
  readonly ns: N;
}

/**
 * Every attribute of the matched entity: `query(Todo).select(all(Todo))`, or
 * `db.pull(eid, all(Todo))`. The same wildcard `db.pull(eid, ["*"])` asks for,
 * with the namespace's idents typed.
 */
export const all = <const N extends AnyNamespace>(ns: N): AllShape<N> => ({
  _tag: "all",
  ns,
});

export const isAllShape = (value: unknown): value is AllShape =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "all" &&
  "ns" in value;

export const isPullOptional = (value: unknown): value is PullOptional =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "optional" &&
  "field" in value;

export const isPullDefault = (value: unknown): value is PullDefault =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "default" &&
  "field" in value &&
  "value" in value;

export const isPullNested = (value: unknown): value is PullNested =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "nested" &&
  "attr" in value &&
  "pattern" in value;

// ── result types ───────────────────────────────────────────────────────────

type SchemaType<S> = S extends Schema.Top ? Schema.Schema.Type<S> : never;

type ScalarResult<F> = F extends {
  readonly schema: infer S;
  readonly cardinality: infer Card;
}
  ? Card extends "many"
    ? readonly SchemaType<S>[]
    : SchemaType<S>
  : never;

type FieldsResult<F> = {
  readonly [K in keyof F]: FieldResult<F[K]>;
};

type NestedResult<A, P> = A extends { readonly cardinality: "many" }
  ? readonly FieldsResult<P>[]
  : FieldsResult<P>;

type FieldResult<F> = F extends PullDefault<infer Inner>
  ? // a default stands in for the missing datom, so the field always reads
    FieldResult<Inner>
  : F extends PullOptional<infer Inner>
  ? FieldResult<Inner> | undefined
  : F extends PullNested<infer A, infer P>
    ? NestedResult<A, P>
    : F extends {
          readonly _tag: "select";
          readonly attr: infer A;
          readonly shape: infer P;
        }
      ? NestedResult<A, P>
      : F extends { readonly ident: ":db/id" }
        ? number
        : ScalarResult<F>;

/** Result shape of a fields object. */
export type StructPullResult<P> = FieldsResult<P>;

// ── ident-keyed escape ─────────────────────────────────────────────────────

/**
 * One slot in the keyword-soup pull. Attr ref (`User.name`), catalog
 * ident (`":user/name"`), or wildcard.
 */
export type IdentPullAttr<C extends AnyCatalog> =
  | CatalogIdent<C>
  | { readonly ident: CatalogIdent<C> }
  | "*";

export type IdentPullPattern<C extends AnyCatalog> = readonly IdentPullAttr<C>[];

type IdentOfPull<C extends AnyCatalog, A> = A extends "*"
  ? "*"
  : A extends { readonly ident: infer I extends string }
    ? I
    : A extends CatalogIdent<C>
      ? A
      : never;

export type IdentPullIdents<
  C extends AnyCatalog,
  P extends IdentPullPattern<C>,
> = IdentOfPull<C, P[number]>;

/**
 * One value in a pull result, from the attribute that carries it.
 *
 * A ref reads as the entity it points at — `{":db/id": n}` — not as the
 * number a `:db.type/ref` datom stores: with no nested pattern to expand, the
 * engine answers a ref (wildcard or named) with a one-key map. That is why
 * this is not `ReadAtIdent`, which is the *write* value of the same ident.
 */
type PullValue<A> = A extends { readonly cardinality: "many" }
  ? readonly PullValueOne<A>[]
  : PullValueOne<A>;

type PullValueOne<A> = A extends { readonly valueType: ":db.type/ref" }
  ? { readonly ":db/id": number }
  : A extends { readonly schema: infer S }
    ? SchemaType<S>
    : never;

/** {@link PullValue} at one catalog ident. */
type PullReadAtIdent<C extends AnyCatalog, I extends string> = PullValue<
  AttrAtIdent<C, I>
>;

export type IdentPullResult<
  C extends AnyCatalog,
  P extends IdentPullPattern<C>,
> = "*" extends IdentPullIdents<C, P>
  ? {
      readonly ":db/id": number;
    } & {
      readonly [I in CatalogIdent<C>]?: PullReadAtIdent<C, I>;
    }
  : {
      readonly ":db/id"?: number;
    } & {
      readonly [I in IdentPullIdents<C, P> & CatalogIdent<C>]?: PullReadAtIdent<
        C,
        I
      >;
    };

/**
 * A wildcard row, read against one namespace: `:db/id` — the wildcard always
 * carries it — and every `:ns/attr` of `N`, each optional, because a datom the
 * entity does not have is a key the map does not have.
 *
 * **A lower bound, not an exact type.** The runtime map is a superset: query
 * scope is "at least one `:ns/*` datom", so a matched entity may carry any
 * other namespace's attributes too, and the peer returns those keys as well.
 * Typing them would mean naming a catalog, which a namespace-scoped query
 * does not have — so the keys named here are the ones you may rely on.
 */
export type AllRow<N extends AnyNamespace> = {
  readonly ":db/id": number;
} & {
  readonly [A in keyof N["attributes"] & string as Ident<
    N["ns"],
    A
  >]?: PullValue<N["attributes"][A]>;
};

// ── catalog constraint ─────────────────────────────────────────────────────

/**
 * Walk a pull pattern and collect every ident it names (attr refs,
 * ident strings, nested / optional wrappers). Used to reject attrs
 * that are not in the catalog without a recursive field union —
 * those blow the client type (`Type instantiation is excessively deep`).
 */
type IdentsIn<P> = [P] extends [PullOptional<infer I>]
  ? IdentsIn<I>
  : [P] extends [PullDefault<infer I>]
  ? IdentsIn<I>
  : [P] extends [PullNested<infer A, infer Inner>]
    ? IdentsIn<A> | IdentsIn<Inner>
    : [P] extends [
          {
            readonly _tag: "select";
            readonly attr: infer A;
            readonly shape: infer Inner;
          },
        ]
      ? IdentsIn<A> | IdentsIn<Inner>
      : [P] extends [{ readonly ident: infer I extends string }]
        ? I
        : [P] extends [readonly unknown[]]
          ? IdentsInArray<P[number]>
          : [P] extends [object]
            ? IdentsInFields<P>
            : never;

/** Ident strings are only idents in the array escape, not on attr objects. */
type IdentsInArray<E> = [E] extends [string] ? E : IdentsIn<E>;

type IdentsInFields<F> = F extends object
  ? { [K in keyof F]: IdentsIn<F[K]> }[keyof F]
  : never;

/**
 * `P` when every named ident is in the catalog (or `*`); otherwise a
 * string literal so the call is a type error.
 *
 * {@link AllShape} names a whole namespace rather than fields, so it is
 * checked the same way, against the idents that namespace stamps.
 */
export type ValidatePull<C extends AnyCatalog, P> = [P] extends [
  { readonly _tag: "all"; readonly ns: { readonly attributes: infer A } },
]
  ? [IdentsIn<A>] extends [CatalogIdent<C>]
    ? P
    : "namespace is not in this database's catalog"
  : [IdentsIn<P>] extends [CatalogIdent<C> | "*"]
    ? P
    : "unknown attribute in pull pattern";

/**
 * Inferred result of `eid.pull(pattern)`. Fields object → caller
 * keys, required vs optional honored. Array → ident keys, all optional.
 * `all(N)` → the wildcard map, keyed by `N`'s idents ({@link AllRow}).
 */
export type Pull<C extends AnyCatalog, P> = [P] extends [
  { readonly _tag: "all"; readonly ns: infer N extends AnyNamespace },
]
  ? AllRow<N>
  : [P] extends [readonly unknown[]]
    ? P extends IdentPullPattern<C>
      ? IdentPullResult<C, P>
      : never
    : StructPullResult<P>;

// ── wire lowering ──────────────────────────────────────────────────────────

const identOf = (field: unknown): string => {
  if (typeof field === "string") return field;
  if (isAttrRef(field)) return field.ident;
  throw new Error(`ramose/schema: pull field is not an attr ref: ${String(field)}`);
};

const fieldsOf = (pattern: unknown): Record<string, unknown> => {
  if (typeof pattern === "object" && pattern !== null && !Array.isArray(pattern)) {
    return pattern as Record<string, unknown>;
  }
  return {};
};

const cardinalityOf = (field: unknown): "one" | "many" => {
  const card = (field as { cardinality?: unknown } | null)?.cardinality;
  return card === "many" ? "many" : "one";
};

/**
 * A backlink node (`Todo.owner.reverse`). The marker is a plain property so
 * this module stays free of a NavQuery import — pull is the lower layer.
 */
const isReverseCarrier = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { __reverse?: unknown }).__reverse === true;

const isSelectNestedField = (
  value: unknown,
): value is {
  readonly _tag: "select";
  readonly attr: unknown;
  readonly shape: unknown;
  readonly constraints?: PullNestedConstraints;
} =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "select" &&
  "attr" in value &&
  "shape" in value;

/**
 * The hop chain a nav carries: `Todo.owner.name` is `[":todo/owner",
 * ":user/name"]`, a bare `User.name` is one ident (or none, for an ident
 * string). Structural, like {@link isReverseCarrier} — pull stays free of
 * NavQuery.
 */
const hopsOf = (
  attr: unknown,
): { readonly path: readonly string[]; readonly revs: readonly boolean[] } => {
  const carrier = attr as
    | { __path?: unknown; __revs?: unknown }
    | null
    | undefined;
  const path = Array.isArray(carrier?.__path)
    ? (carrier.__path as readonly string[])
    : [];
  const revs = Array.isArray(carrier?.__revs)
    ? (carrier.__revs as readonly boolean[])
    : path.map(() => false);
  return { path, revs };
};

/** `:todo/owner` → `Todo.owner` — the attr spelled the way the caller wrote it. */
const spellAttr = (ident: string): string => {
  const m = /^:([^/]+)\/(.+)$/.exec(ident);
  if (m === null) return ident;
  const ns = m[1]!;
  return `${ns.charAt(0).toUpperCase()}${ns.slice(1)}.${m[2]}`;
};

const attrNameOf = (ident: string): string =>
  /^:[^/]+\/(.+)$/.exec(ident)?.[1] ?? ident;

/** The whole path as one expression: `Todo.owner.reverse.title`. */
const spellPath = (path: readonly string[], revs: readonly boolean[]): string =>
  path
    .map(
      (ident, i) =>
        `${i === 0 ? spellAttr(ident) : attrNameOf(ident)}${revs[i] ? ".reverse" : ""}`,
    )
    .join(".");

/** The same path as the nested select that does mean it. */
const spellNested = (
  path: readonly string[],
  revs: readonly boolean[],
  leafSelects: boolean,
): string => {
  const last = path.length - 1;
  const leaf = path[last]!;
  let out = `${attrNameOf(leaf)}: ${spellAttr(leaf)}${
    revs[last] ? ".reverse" : ""
  }${revs[last] || leafSelects ? ".select({ … })" : ""}`;
  for (let i = last - 1; i >= 0; i--) {
    const hop = path[i]!;
    out = `${attrNameOf(hop)}: ${spellAttr(hop)}${
      revs[i] ? ".reverse" : ""
    }.select({ ${out} })`;
  }
  return `{ ${out} }`;
};

/**
 * A select field names one attribute of the entity being pulled, so a nav
 * that walked a ref first (`Todo.owner.name`) cannot be one: the pull would
 * ask the *todo* for `:user/name` and the row would carry a value it never
 * had — or be dropped for a datom it was never meant to have. The nested
 * select is the shape that means what the path reads like, so say so instead
 * of quietly attaching the leaf ident to the parent.
 */
export const assertDirectField = (
  as: string,
  attr: unknown,
  /** The field carries a shape of its own, so the suggestion keeps one. */
  leafSelects = false,
): void => {
  const { path, revs } = hopsOf(attr);
  if (path.length < 2) return;
  throw new Error(
    `ramose/query: select field "${as}": ${spellPath(path, revs)} is a multi-hop path (${path.join(" → ")}) — a select field must be a direct attribute of the queried namespace. Use a nested select: ${spellNested(path, revs, leafSelects)}`,
  );
};

/**
 * A constrained collection nav (`Todo.owner.reverse.where(…)`, or
 * `User.tags.where(…)`). Structural, like {@link isReverseCarrier} — pull
 * stays free of NavQuery.
 */
const isCollectionCarrier = (
  value: unknown,
): value is {
  readonly _tag: "collection";
  readonly attr: unknown;
  readonly constraints?: PullNestedConstraints;
} =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "collection";

/**
 * An element cursor (`User.tags.each`). It names one value of a collection
 * inside that collection's own constraints; as a *field* it would pull the
 * whole attribute under a name that promises one value.
 */
const isElementCarrier = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { __each?: unknown }).__each === "string";

/** Inspect a literate pull field: optional / default / many / nested pattern. */
export const inspectPullField = (
  field: unknown,
): {
  readonly optional: boolean;
  /**
   * The field carries a stand-in for the missing datom. Separate from
   * {@link defaultValue} so `null` — a perfectly good default — is one.
   */
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  readonly many: boolean;
  readonly reverse: boolean;
  readonly nestedPattern: unknown | undefined;
  readonly constraints: PullNestedConstraints | undefined;
  readonly attr: unknown;
} => {
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let current = field;
  if (isPullOptional(current)) {
    optional = true;
    current = current.field;
  } else if (isPullDefault(current)) {
    hasDefault = true;
    defaultValue = current.value;
    current = current.field;
  }
  if (isElementCarrier(current)) {
    throw new Error(
      `ramose/query: ${identOf(current)}.each is an element cursor, not a select field — it names one value of the collection inside its own every / none / some / where / orderBy. Select the attribute itself.`,
    );
  }
  if (isCollectionCarrier(current)) {
    // a scalar collection *is* the field: its elements are values, and a
    // value has no shape to ask for. A ref one still needs its `.select`.
    if ((current.attr as { valueType?: unknown })?.valueType === ":db.type/ref") {
      throw new Error(
        "ramose/schema: a filtered collection needs a shape — write `.where(…).select({ … })`",
      );
    }
    return {
      optional,
      hasDefault,
      defaultValue,
      many: true,
      reverse: false,
      nestedPattern: undefined,
      constraints: current.constraints,
      attr: current.attr,
    };
  }
  if (isPullNested(current)) {
    return {
      optional,
      hasDefault,
      defaultValue,
      many: cardinalityOf(current.attr) === "many",
      reverse: isReverseCarrier(current.attr),
      nestedPattern: current.pattern,
      constraints: current.constraints,
      attr: current.attr,
    };
  }
  if (isSelectNestedField(current)) {
    return {
      optional,
      hasDefault,
      defaultValue,
      many: cardinalityOf(current.attr) === "many",
      reverse: isReverseCarrier(current.attr),
      nestedPattern: current.shape,
      constraints: current.constraints,
      attr: current.attr,
    };
  }
  return {
    optional,
    hasDefault,
    defaultValue,
    many: cardinalityOf(current) === "many",
    reverse: isReverseCarrier(current),
    nestedPattern: undefined,
    constraints: undefined,
    attr: current,
  };
};

/** The `PullAttrSpec` fields a nested collection's constraints occupy. */
const constraintFields = (
  c: PullNestedConstraints | undefined,
): Record<string, unknown> =>
  c === undefined
    ? {}
    : {
        ...(c.where !== undefined && c.where.length > 0 ? { where: [...c.where] } : {}),
        ...(c.order !== undefined && c.order.length > 0 ? { order: [...c.order] } : {}),
        ...(c.offset !== undefined ? { offset: c.offset } : {}),
        ...(c.limit !== undefined ? { limit: c.limit } : {}),
      };

/** `.orDefault(v)` is the pull-phase `:default` — the peer's substitution. */
const defaultField = (info: {
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}): Record<string, unknown> =>
  info.hasDefault ? { default: info.defaultValue } : {};

const lowerField = (as: string, field: unknown): unknown => {
  const info = inspectPullField(field);
  assertDirectField(as, info.attr, info.nestedPattern !== undefined);
  if (info.nestedPattern !== undefined) {
    return {
      kind: "attr",
      attr: identOf(info.attr),
      reverse: info.reverse,
      as,
      ...defaultField(info),
      ...constraintFields(info.constraints),
      sub: lowerLiterateMap(info.nestedPattern),
    };
  }
  if (info.reverse) {
    // the peer answers a bare backlink with `{":db/id": n}` — one of them for
    // a component ref, an array of them otherwise — which is neither a scalar
    // nor the selected shape, so ask for the shape you want
    throw new Error(
      `ramose/schema: ${identOf(info.attr)} backlinks need a shape — write \`.reverse.select({ … })\` for the key \`${as}\``,
    );
  }
  // a card-many scalar carries its own `where` / `order` / `offset` / `limit`
  return {
    kind: "attr",
    attr: identOf(info.attr),
    reverse: false,
    as,
    ...defaultField(info),
    ...constraintFields(info.constraints),
  };
};

const lowerLiterateMap = (pattern: unknown): unknown[] => {
  const fields = fieldsOf(pattern);
  return Object.entries(fields).map(([key, field]) => lowerField(key, field));
};

const lowerIdentPull = (pattern: readonly unknown[]): unknown[] =>
  pattern.map((a) => {
    if (a === "*") return "*";
    if (isAttrRef(a)) return a.ident;
    return a;
  });

/**
 * Lower a literate pull map (or ident-keyed array escape) to a peer pull
 * pattern. Literate maps become AST specs with `:as` / nested `sub`.
 *
 * `all(N)` is the peer's own wildcard, so it lowers to exactly that — the
 * client never expands it into a map of the namespace's attributes.
 */
export const lowerPullPattern = (pattern: unknown): unknown[] => {
  if (isAllShape(pattern)) return ["*"];
  if (Array.isArray(pattern)) return lowerIdentPull(pattern);
  return lowerLiterateMap(pattern);
};

/**
 * Enforce required vs optional so the TypeScript type matches the value.
 *
 * A bare attr is required: missing / null / undefined drops the entity
 * (`null` at the top level). `.optional` may be missing (`undefined`), and
 * `.orDefault(v)` reads as `v` (the peer already substituted it; this is the
 * same answer for a result that arrived without one).
 * Required `.select` drops the parent when the ref is missing or the nested
 * object fails *its* required fields. Cardinality-many `.select` filters the
 * array (empty `[]` is still a valid many). Ident-keyed arrays and the
 * wildcard are left as the peer returned them (all optional in the type).
 */
export const reshapePullResult = (pattern: unknown, result: unknown): unknown => {
  if (result === null || result === undefined) return null;
  if (isAllShape(pattern) || Array.isArray(pattern)) return result;
  const filtered = filterPull(pattern, result);
  return filtered === undefined ? null : filtered;
};

const isPresent = (value: unknown): boolean =>
  value !== undefined && value !== null;

/**
 * `undefined` means this entity failed a required field and should be dropped.
 *
 * For a query, `lowerNavQuery` lowers every top-level required field into a
 * `where` clause, so the drop is the peer's and the top-level `undefined` is
 * unreachable; what stays here is per-element work that cannot change the row
 * count — filtering a cardinality-many array, and `db.pull` of one subject.
 */
const filterPull = (pattern: unknown, result: unknown): unknown => {
  if (!isPresent(result)) return undefined;
  // a wildcard row has no required field to fail: every key is optional
  if (isAllShape(pattern) || Array.isArray(pattern)) return result;
  if (typeof result !== "object") return undefined;

  const fields = fieldsOf(pattern);
  const rec = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(fields)) {
    const info = inspectPullField(field);
    const raw = rec[key];
    const missing = !isPresent(raw);

    if (info.nestedPattern !== undefined) {
      if (info.many) {
        if (missing) {
          out[key] = info.optional ? undefined : [];
          continue;
        }
        const arr = Array.isArray(raw) ? raw : [raw];
        const kept: unknown[] = [];
        for (const item of arr) {
          const child = filterPull(info.nestedPattern, item);
          if (child !== undefined) kept.push(child);
        }
        out[key] = kept;
        continue;
      }
      if (missing) {
        if (info.optional) {
          out[key] = undefined;
          continue;
        }
        return undefined;
      }
      const child = filterPull(info.nestedPattern, raw);
      if (child === undefined) {
        if (info.optional) {
          out[key] = undefined;
          continue;
        }
        return undefined;
      }
      out[key] = child;
      continue;
    }

    if (missing) {
      // the peer already substituted the default; this is the same answer for
      // a result that reached here without one (`db.pull` of a stale cache,
      // an ident-keyed reply reshaped by hand)
      if (info.hasDefault) {
        out[key] = info.defaultValue;
        continue;
      }
      if (info.optional) {
        out[key] = undefined;
        continue;
      }
      if (info.many) {
        out[key] = [];
        continue;
      }
      return undefined;
    }
    out[key] = info.many && !Array.isArray(raw) ? [raw] : raw;
  }
  return out;
};
