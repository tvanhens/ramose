/** Literate pull map: keys are result names, values are attr refs / `.optional` / `.select`. */

import type { PullElemOrder, PullElemPred } from "../internal/core/query/ast.ts";
import type * as Schema from "effect/Schema";
import type { AnyAttribute } from "./Attribute.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnyCatalog } from "./Catalog.ts";
import type { CatalogIdent, ReadAtIdent } from "./idents.ts";
import type { AttributeMap } from "./Namespace.ts";

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

export const isPullOptional = (value: unknown): value is PullOptional =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "optional" &&
  "field" in value;

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

type FieldResult<F> = F extends PullOptional<infer Inner>
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

export type IdentPullResult<
  C extends AnyCatalog,
  P extends IdentPullPattern<C>,
> = "*" extends IdentPullIdents<C, P>
  ? {
      readonly ":db/id": number;
    } & {
      readonly [I in CatalogIdent<C>]?: ReadAtIdent<C, I>;
    }
  : {
      readonly ":db/id"?: number;
    } & {
      readonly [I in IdentPullIdents<C, P> & CatalogIdent<C>]?: ReadAtIdent<
        C,
        I
      >;
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
 */
export type ValidatePull<C extends AnyCatalog, P> = [IdentsIn<P>] extends [
  CatalogIdent<C> | "*",
]
  ? P
  : "unknown attribute in pull pattern";

/**
 * Inferred result of `eid.pull(pattern)`. Fields object → caller
 * keys, required vs optional honored. Array → ident keys, all optional.
 */
export type Pull<C extends AnyCatalog, P> = [P] extends [
  readonly unknown[],
]
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

/** Inspect a literate pull field: optional / many / nested pattern. */
export const inspectPullField = (
  field: unknown,
): {
  readonly optional: boolean;
  readonly many: boolean;
  readonly reverse: boolean;
  readonly nestedPattern: unknown | undefined;
  readonly constraints: PullNestedConstraints | undefined;
  readonly attr: unknown;
} => {
  let optional = false;
  let current = field;
  if (isPullOptional(current)) {
    optional = true;
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
      many: cardinalityOf(current.attr) === "many",
      reverse: isReverseCarrier(current.attr),
      nestedPattern: current.shape,
      constraints: current.constraints,
      attr: current.attr,
    };
  }
  return {
    optional,
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

const lowerField = (as: string, field: unknown): unknown => {
  const info = inspectPullField(field);
  assertDirectField(as, info.attr, info.nestedPattern !== undefined);
  if (info.nestedPattern !== undefined) {
    return {
      kind: "attr",
      attr: identOf(info.attr),
      reverse: info.reverse,
      as,
      ...constraintFields(info.constraints),
      sub: lowerLiterateMap(info.nestedPattern),
    };
  }
  if (info.reverse) {
    // the peer answers a bare backlink with `{":db/id": n}` objects, which is
    // neither a scalar nor the selected shape — ask for the shape you want
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
 */
export const lowerPullPattern = (pattern: unknown): unknown[] => {
  if (Array.isArray(pattern)) return lowerIdentPull(pattern);
  return lowerLiterateMap(pattern);
};

/**
 * Enforce required vs optional so the TypeScript type matches the value.
 *
 * A bare attr is required: missing / null / undefined drops the entity
 * (`null` at the top level). `.optional` may be missing (`undefined`).
 * Required `.select` drops the parent when the ref is missing or the nested
 * object fails *its* required fields. Cardinality-many `.select` filters the
 * array (empty `[]` is still a valid many). Ident-keyed arrays are left as
 * the peer returned them (all optional in the type).
 */
export const reshapePullResult = (pattern: unknown, result: unknown): unknown => {
  if (result === null || result === undefined) return null;
  if (Array.isArray(pattern)) return result;
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
  if (Array.isArray(pattern)) return result;
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
