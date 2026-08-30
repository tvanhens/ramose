import type { PullElemOrder, PullElemPred } from "../internal/core/query/ast.ts";
import type * as Schema from "effect/Schema";
import type { AnyField } from "./Field.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnySchema } from "./Schema.ts";
import type { Eid } from "./Eid.ts";
import type { AttrAtIdent, CatalogIdent, Ident } from "./idents.ts";
import type { AnyEntity, FieldMap } from "./Entity.ts";
import type { AnyComposer } from "./Composer.ts";
import { isSelfRefSchema, refTargetOf, type SelfMarker } from "./valueTypes.ts";

export interface PullNestedConstraints {
  readonly where?: readonly PullElemPred[];
  readonly order?: readonly PullElemOrder[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface PullOptional<F = unknown> {
  readonly _tag: "optional";
  readonly field: F;
  readonly select: F extends { readonly valueType: "ref" }
    ? {
        <const N extends AnyEntity>(
          pattern: AllShape<N>,
        ): PullOptional<PullNested<F, AllShape<N>>>;
        <const P extends Record<string, unknown>>(
          pattern: P,
        ): PullOptional<PullNested<F, P>>;
      }
    : never;
}

export interface PullDefault<F = unknown> {
  readonly _tag: "default";
  readonly field: F;
  readonly value: unknown;
}

export interface PullNested<A = unknown, P = unknown> {
  readonly _tag: "nested";
  readonly attr: A;
  readonly pattern: P;
  readonly constraints?: PullNestedConstraints;
  readonly optional: PullOptional<PullNested<A, P>>;
}

export type AttrPull<A> = {
  readonly optional: PullOptional<A>;
};

export const optional = <const F>(field: F): PullOptional<F> => ({
  _tag: "optional",
  field,
  select: ((pattern: Record<string, unknown>) =>
    optional(nested(field as never, pattern))) as unknown as PullOptional<F>["select"],
});

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

export const nested = <
  const A extends { readonly valueType: "ref" },
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
  const N extends { readonly fields: FieldMap },
  const Keys extends readonly (keyof N["fields"] & string)[],
>(
  ns: N,
  ...keys: Keys
): {
  readonly [K in Keys[number]]: N["fields"][K];
} => {
  const fields = {} as Record<string, AnyField>;
  for (const key of keys) fields[key] = ns.fields[key]!;
  return fields as {
    readonly [K in Keys[number]]: N["fields"][K];
  };
};

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
 * runtime. The same term nests under a ref `.select`:
 * `Todo.owner.select(all(User))` lowers to the peer's `{:todo/owner [*]}`.
 */
export interface AllShape<N extends AnyEntity = AnyEntity> {
  readonly _tag: "all";
  readonly ns: N;
}

/**
 * Every attribute of the matched entity: `query(Todo).select(all(Todo))`,
 * `Todo.owner.select(all(User))` under a ref, or `db.pull(eid, all(Todo))`.
 * The same wildcard `db.pull(eid, ["*"])` asks for, with the namespace's
 * idents typed.
 */
export const all = <const N extends AnyEntity>(ns: N): AllShape<N> => ({
  _tag: "all",
  ns,
});

export const isAllShape = (value: unknown): value is AllShape =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "all" &&
  "ns" in value;

/** Hop bound `again` accepts: a positive integer literal, 1 through 16. */
export type RecurDepth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

export const AGAIN_MAX_DEPTH = 16 as const;

export type ValidAgainDepth<D> = number extends D
  ? "Ramose.again(n) takes a positive integer literal 1..16 — not a number, a param, or \"...\""
  : D extends RecurDepth
    ? unknown
    : "Ramose.again(n) takes a positive integer literal 1..16";

/**
 * `Ramose.again(n)` — re-apply the enclosing select on this edge, `n`
 * full-shape hops, then identity stubs. A shape term in the `.select` slot,
 * parallel to {@link all}: not a field, not a top-level builder method.
 */
export interface Again<D extends RecurDepth = RecurDepth> {
  readonly _tag: "again";
  readonly depth: D;
}

export const again = <const D extends number>(
  depth: D & ValidAgainDepth<D>,
): Again<D & RecurDepth> => {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
    throw new Error(
      `ramose/query: Ramose.again(n) takes a positive integer hop bound, got ${String(depth)}`,
    );
  }
  if (depth > AGAIN_MAX_DEPTH) {
    throw new Error(
      `ramose/query: Ramose.again(${depth}) exceeds the hop bound of ${AGAIN_MAX_DEPTH}`,
    );
  }
  return { _tag: "again", depth: depth as D & RecurDepth };
};

export const isAgain = (value: unknown): value is Again =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "again" &&
  typeof (value as { depth?: unknown }).depth === "number";

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
  readonly [K in keyof F]: FieldResult<F[K], F>;
};

export type IdCell<F> = F extends { readonly _ns?: infer N }
  ? [NonNullable<N>] extends [AnyComposer]
    ? Eid<NonNullable<N>>
    : number
  : number;

type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

type UnwrapField<F> = F extends {
  readonly _tag: "optional" | "default";
  readonly field: infer I;
}
  ? UnwrapField<I>
  : F;

export type IdKey<S> = {
  [K in keyof S]-?: UnwrapField<S[K]> extends { readonly ident: ":db/id" }
    ? K
    : never;
}[keyof S];

/**
 * Identity only — what the engine emits when the hop budget or a cycle
 * stops us. The key is the shape's `:db/id` alias; the cell is branded.
 */
export type RecurStub<S> = {
  readonly [K in IdKey<S>]: IdCell<UnwrapField<S[K]>>;
};

type CardOf<A, T> = A extends { readonly cardinality: "many" }
  ? readonly T[]
  : T;

type IsAgainSelect<F> = UnwrapField<F> extends {
  readonly _tag: "select";
  readonly shape: { readonly _tag: "again" };
}
  ? true
  : UnwrapField<F> extends {
        readonly _tag: "nested";
        readonly pattern: { readonly _tag: "again" };
      }
    ? true
    : false;

type AgainUnrollField<F, S, D extends number> = F extends {
  readonly _tag: "optional";
  readonly field: infer I;
}
  ? AgainUnrollField<I, S, D> | undefined
  : F extends { readonly _tag: "select" | "nested"; readonly attr: infer A }
    ? CardOf<
        A,
        D extends 1 ? RecurStub<S> : Unroll<S, Prev[D & keyof Prev]>
      >
    : never;

export type Unroll<S, D extends number> = {
  readonly [K in keyof S]: [IsAgainSelect<S[K]>] extends [true]
    ? AgainUnrollField<S[K], S, D>
    : FieldResult<S[K], S>;
};

type NestedResult<A, P, Enclosing = unknown> = [P] extends [
  { readonly _tag: "again"; readonly depth: infer D extends number },
]
  ? CardOf<A, Unroll<Enclosing, D>>
  : [P] extends [
        { readonly _tag: "all"; readonly ns: infer N extends AnyEntity },
      ]
    ? A extends { readonly cardinality: "many" }
      ? readonly AllRow<N>[]
      : AllRow<N>
    : A extends { readonly cardinality: "many" }
      ? readonly FieldsResult<P>[]
      : FieldsResult<P>;

type FieldResult<F, Enclosing = unknown> = F extends {
  readonly _tag: "default";
  readonly field: infer Inner;
}
  ?
    FieldResult<Inner, Enclosing>
  : F extends {
        readonly _tag: "optional";
        readonly field: infer Inner;
      }
    ? FieldResult<Inner, Enclosing> | undefined
    : F extends PullNested<infer A, infer P>
      ? NestedResult<A, P, Enclosing>
      : F extends {
            readonly _tag: "select";
            readonly attr: infer A;
            readonly shape: infer P;
          }
        ? NestedResult<A, P, Enclosing>
        :
          F extends { readonly _tag: "collection"; readonly attr: infer A }
          ? A extends { readonly schema: infer S }
            ? readonly SchemaType<S>[]
            : never
          : F extends { readonly ident: ":db/id" }
            ? IdCell<F>
            : ScalarResult<F>;

export type StructPullResult<P> = FieldsResult<P>;

export type IsAgainTerm<F> = F extends { readonly _tag: "again" }
  ? true
  : F extends { readonly _tag: "optional" | "default"; readonly field: infer I }
    ? IsAgainTerm<I>
    : false;

export type IsAgainSelectField<F> = IsAgainSelect<F>;

export type HasIdField<S> = true extends {
  [K in keyof S]: UnwrapField<S[K]> extends { readonly ident: ":db/id" }
    ? true
    : false;
}[keyof S]
  ? true
  : false;

export type HasAgainSelect<S> = true extends {
  [K in keyof S]: IsAgainSelect<S[K]>;
}[keyof S]
  ? true
  : false;

type FieldIdentNs<F> = UnwrapField<F> extends {
  readonly ident: `:${infer Ns}/${string}`;
}
  ? Ns
  : UnwrapField<F> extends {
        readonly ident: ":db/id";
        readonly _ns?: infer N;
      }
    ? N extends { readonly ns: infer Ns extends string }
      ? Ns
      : never
    : UnwrapField<F> extends {
          readonly _tag: "select" | "nested";
          readonly attr: infer A;
        }
      ? FieldIdentNs<A>
      : never;

export type ShapeNs<S> = { [K in keyof S]: FieldIdentNs<S[K]> }[keyof S];

type AgainAttr<F> = F extends {
  readonly _tag: "optional" | "default";
  readonly field: infer I;
}
  ? AgainAttr<I>
  : F extends { readonly _tag: "select" | "nested"; readonly attr: infer A }
    ? A
    : never;

export type AgainTargetNs<F> = AgainAttr<F> extends {
  readonly ident: `:${infer Own}/${string}`;
}
  ? AgainAttr<F> extends {
      readonly schema: { readonly _resolve?: () => { readonly fields: infer T } };
    }
    ? unknown extends T
      ? Own
      : [T] extends [SelfMarker]
        ? Own
        : AgainAttr<F> extends {
              readonly schema: { readonly _resolve?: () => { readonly ns: infer Ns } };
            }
          ? Ns extends string
            ? Ns
            : Own
          : Own
    : Own
  : never;

export type AgainAsField<K extends string> =
  `select field "${K}" is again: again is a shape, not a field — write \`ref.select(Ramose.again(n))\``;

export type AgainNsMismatch<K extends string, Ns extends string> =
  `select field "${K}" is again on a different namespace — again re-applies this shape, which is a :${Ns}/… row`;

export type AgainMissingId =
  "a shape that contains again must select N.id — the stub is that branded id cell";

export type TopLevelAgain =
  "again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))";

export type IdentPullAttr<C extends AnySchema> =
  | CatalogIdent<C>
  | { readonly ident: CatalogIdent<C> }
  | "*";

export type IdentPullPattern<C extends AnySchema> = readonly IdentPullAttr<C>[];

type IdentOfPull<C extends AnySchema, A> = A extends "*"
  ? "*"
  : A extends { readonly ident: infer I extends string }
    ? I
    : A extends CatalogIdent<C>
      ? A
      : never;

export type IdentPullIdents<
  C extends AnySchema,
  P extends IdentPullPattern<C>,
> = IdentOfPull<C, P[number]>;

type PullValue<A> = A extends { readonly cardinality: "many" }
  ? readonly PullValueOne<A>[]
  : PullValueOne<A>;

type PullValueOne<A> = A extends { readonly valueType: "ref" }
  ? { readonly ":db/id": number }
  : A extends { readonly schema: infer S }
    ? SchemaType<S>
    : never;

type PullReadAtIdent<C extends AnySchema, I extends string> = PullValue<
  AttrAtIdent<C, I>
>;

export type IdentPullResult<
  C extends AnySchema,
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
export type AllRow<N extends AnyEntity> = {
  readonly ":db/id": number;
} & {
  readonly [A in keyof N["fields"] & string as Ident<
    N["ns"],
    A
  >]?: PullValue<N["fields"][A]>;
};

type IdentsIn<P> = [P] extends [PullOptional<infer I>]
  ? IdentsIn<I>
  : [P] extends [PullDefault<infer I>]
  ? IdentsIn<I>
  : [P] extends [{ readonly _tag: "again" }]
    ? never
    : [P] extends [
          { readonly _tag: "all"; readonly ns: { readonly fields: infer A } },
        ]
      ? IdentsIn<A>
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
export type ValidatePull<C extends AnySchema, P> = [P] extends [
  { readonly _tag: "again" },
]
  ? TopLevelAgain
  : [P] extends [
        { readonly _tag: "all"; readonly ns: { readonly fields: infer A } },
      ]
    ? [IdentsIn<A>] extends [CatalogIdent<C>]
      ? P
      : "namespace is not in this database's catalog"
    : [P] extends [readonly unknown[]]
      ? ValidatePullIdents<C, P>
      : [P] extends [object]
        ? ValidatePullShape<C, P>
        : ValidatePullIdents<C, P>;

type HasAgainTermIn<S> = true extends {
  [K in keyof S]: IsAgainTerm<S[K]>;
}[keyof S]
  ? true
  : false;

type ValidatePullShape<C extends AnySchema, P> = HasAgainTermIn<P> extends true
  ? {
      readonly [K in keyof P]: IsAgainTerm<P[K]> extends true
        ? "again is a shape, not a field — write `ref.select(Ramose.again(n))`"
        : P[K];
    }
  : HasAgainSelect<P> extends true
    ? HasIdField<P> extends true
      ? ValidatePullIdents<C, P>
      : {
          readonly [K in keyof P]: IsAgainSelectField<P[K]> extends true
            ? AgainMissingId
            : P[K];
        }
    : ValidatePullIdents<C, P>;

type ValidatePullIdents<C extends AnySchema, P> = [IdentsIn<P>] extends [
  CatalogIdent<C> | "*" | ":db/id",
]
  ? P
  : "unknown attribute in pull pattern";

/**
 * Inferred result of `eid.pull(pattern)`. Fields object → caller
 * keys, required vs optional honored. Array → ident keys, all optional.
 * `all(N)` → the wildcard map, keyed by `N`'s idents ({@link AllRow}).
 */
export type Pull<C extends AnySchema, P> = [P] extends [
  { readonly _tag: "all"; readonly ns: infer N extends AnyEntity },
]
  ? AllRow<N>
  : [P] extends [readonly unknown[]]
    ? P extends IdentPullPattern<C>
      ? IdentPullResult<C, P>
      : never
    : StructPullResult<P>;

const identOf = (field: unknown): string => {
  if (typeof field === "string") return field;
  if (isAttrRef(field)) return field.ident;
  throw new Error(`ramose/schema: pull field is not an attr ref: ${String(field)}`);
};

const nsOfIdent = (ident: string): string | undefined =>
  /^:([^/]+)\//.exec(ident)?.[1];

const unwrapAgainField = (field: unknown): unknown => {
  let current = field;
  if (isPullOptional(current)) current = current.field;
  else if (isPullDefault(current)) current = current.field;
  return current;
};

export const refTargetNs = (attr: unknown): string | undefined => {
  if (isReverseCarrier(attr)) return nsOfIdent(identOf(attr));
  const schema = (attr as { schema?: unknown } | null)?.schema;
  if (isSelfRefSchema(schema)) return nsOfIdent(identOf(attr));
  const ns = (refTargetOf(schema)?.() as { ns?: unknown } | undefined)?.ns;
  return typeof ns === "string" ? ns : undefined;
};

const tryIdentOf = (field: unknown): string | undefined => {
  try {
    return identOf(inspectPullField(field).attr);
  } catch {
    return undefined;
  }
};

export const idKeyOf = (pattern: unknown): string | undefined => {
  if (isAgain(pattern) || isAllShape(pattern) || Array.isArray(pattern)) {
    return undefined;
  }
  for (const [key, field] of Object.entries(fieldsOf(pattern))) {
    if (tryIdentOf(field) === ":db/id") return key;
  }
  return undefined;
};

const shapeNsOf = (shape: Record<string, unknown>): string | undefined => {
  for (const field of Object.values(shape)) {
    const ident = tryIdentOf(field);
    if (ident !== undefined && ident !== ":db/id") {
      const ns = nsOfIdent(ident);
      if (ns !== undefined) return ns;
    }
  }
  return undefined;
};

export const assertAgainDepth = (depth: unknown): number => {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
    throw new Error(
      `ramose/query: Ramose.again(n) takes a positive integer hop bound, got ${String(depth)}`,
    );
  }
  if (depth > AGAIN_MAX_DEPTH) {
    throw new Error(
      `ramose/query: Ramose.again(${depth}) exceeds the hop bound of ${AGAIN_MAX_DEPTH}`,
    );
  }
  return depth;
};

export const assertNotAgain = (shape: unknown, key?: string): void => {
  if (!isAgain(unwrapAgainField(shape))) return;
  throw new Error(
    key === undefined
      ? "ramose/query: again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))"
      : `ramose/query: select field "${key}": again is a shape, not a field — write \`ref.select(Ramose.again(n))\``,
  );
};

export const assertAgainInShape = (shape: Record<string, unknown>): void => {
  let hasAgain = false;
  let hasId = false;
  const enclosingNs = shapeNsOf(shape);
  for (const [key, field] of Object.entries(shape)) {
    assertNotAgain(field, key);
    const ident = tryIdentOf(field);
    if (ident === ":db/id") hasId = true;
    const info = inspectPullField(field);
    if (!isAgain(info.nestedPattern)) continue;
    hasAgain = true;
    const depth = assertAgainDepth((info.nestedPattern as Again).depth);
    const target = refTargetNs(info.attr);
    if (
      target !== undefined &&
      enclosingNs !== undefined &&
      target !== enclosingNs
    ) {
      throw new Error(
        `ramose/query: select field "${key}": ${spellAttr(identOf(info.attr))}.select(Ramose.again(${depth})) is a :${target}/… edge — again re-applies this shape, which is a :${enclosingNs}/… row`,
      );
    }
  }
  if (hasAgain && !hasId) {
    throw new Error(
      "ramose/query: a shape that contains again must select N.id — the stub is that branded id cell",
    );
  }
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

const spellAttr = (ident: string): string => {
  const m = /^:([^/]+)\/(.+)$/.exec(ident);
  if (m === null) return ident;
  const ns = m[1]!;
  return `${ns.charAt(0).toUpperCase()}${ns.slice(1)}.${m[2]}`;
};

const attrNameOf = (ident: string): string =>
  /^:[^/]+\/(.+)$/.exec(ident)?.[1] ?? ident;

const spellPath = (path: readonly string[], revs: readonly boolean[]): string =>
  path
    .map(
      (ident, i) =>
        `${i === 0 ? spellAttr(ident) : attrNameOf(ident)}${revs[i] ? ".reverse" : ""}`,
    )
    .join(".");

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

export const assertDirectField = (
  as: string,
  attr: unknown,
  leafSelects = false,
): void => {
  const { path, revs } = hopsOf(attr);
  if (path.length < 2) return;
  throw new Error(
    `ramose/query: select field "${as}": ${spellPath(path, revs)} is a multi-hop path (${path.join(" → ")}) — a select field must be a direct field of the queried entity. Use a nested select: ${spellNested(path, revs, leafSelects)}`,
  );
};

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

const isElementCarrier = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { __each?: unknown }).__each === "string";

export const inspectPullField = (
  field: unknown,
): {
  readonly optional: boolean;
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
    if ((current.attr as { valueType?: unknown })?.valueType === "ref") {
      throw new Error(
        "ramose/schema: a filtered reference collection needs a shape — write `.select({ … }, { where: [ … ] })`",
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

const defaultField = (info: {
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}): Record<string, unknown> =>
  info.hasDefault ? { default: info.defaultValue } : {};

const lowerField = (as: string, field: unknown): unknown => {
  const info = inspectPullField(field);
  assertDirectField(as, info.attr, info.nestedPattern !== undefined);
  if (isAgain(info.nestedPattern)) {
    const recursion = assertAgainDepth(info.nestedPattern.depth);
    return {
      kind: "attr",
      attr: identOf(info.attr),
      reverse: info.reverse,
      as,
      ...defaultField(info),
      ...constraintFields(info.constraints),
      recursion,
    };
  }
  if (info.nestedPattern !== undefined) {
    return {
      kind: "attr",
      attr: identOf(info.attr),
      reverse: info.reverse,
      as,
      ...defaultField(info),
      ...constraintFields(info.constraints),
      sub: lowerPullPattern(info.nestedPattern),
    };
  }
  if (info.reverse) {
    throw new Error(
      `ramose/schema: ${identOf(info.attr)} backlinks need a shape — write \`.reverse.select({ … })\` for the key \`${as}\``,
    );
  }
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
  assertAgainInShape(fields);
  return Object.entries(fields).map(([key, field]) => lowerField(key, field));
};

const lowerIdentPull = (pattern: readonly unknown[]): unknown[] =>
  pattern.map((a) => {
    if (a === "*") return "*";
    if (isAttrRef(a)) return a.ident;
    return a;
  });

export const lowerPullPattern = (pattern: unknown): unknown[] => {
  if (isAgain(pattern)) {
    throw new Error(
      "ramose/query: again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))",
    );
  }
  if (isAllShape(pattern)) return ["*"];
  if (Array.isArray(pattern)) return lowerIdentPull(pattern);
  return lowerLiterateMap(pattern);
};

export const pullReshapeIdentity = (pattern: unknown): unknown => {
  if (isAllShape(pattern)) return "*";
  if (isAgain(pattern)) return "again";
  if (Array.isArray(pattern)) return "idents";
  const fields = fieldsOf(pattern);
  return Object.entries(fields).map(([key, field]) => {
    const info = inspectPullField(field);
    const nested = info.nestedPattern === undefined
      ? null
      : isAgain(info.nestedPattern)
        ? "again"
        : pullReshapeIdentity(info.nestedPattern);
    return [
      key,
      info.optional,
      info.hasDefault,
      info.hasDefault ? [typeof info.defaultValue, info.defaultValue] : null,
      info.many,
      info.reverse,
      nested,
    ];
  });
};

const mapWildcardEntityIds = (
  value: unknown,
  map: (eid: number) => unknown,
): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => mapWildcardEntityIds(item, map));
  }
  const row = value as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const [key, cell] of Object.entries(row)) {
    const mapped = key === ":db/id" && typeof cell === "number"
      ? map(cell)
      : mapWildcardEntityIds(cell, map);
    if (mapped === cell) continue;
    out ??= { ...row };
    out[key] = mapped;
  }
  return out ?? row;
};

export const mapPullEntityIds = (
  pattern: unknown,
  result: unknown,
  map: (eid: number) => unknown,
): unknown => {
  if (result === null || result === undefined) return result;
  if (Array.isArray(result)) {
    return result.map((item) => mapPullEntityIds(pattern, item, map));
  }
  if (typeof result !== "object") return result;
  if (isAllShape(pattern) || Array.isArray(pattern) || isAgain(pattern)) {
    return mapWildcardEntityIds(result, map);
  }
  const row = result as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  const write = (key: string, value: unknown): void => {
    out ??= { ...row };
    out[key] = value;
  };
  const idKey = idKeyOf(pattern);
  if (idKey !== undefined && typeof row[idKey] === "number") {
    write(idKey, map(row[idKey] as number));
  }
  for (const [key, field] of Object.entries(fieldsOf(pattern))) {
    if (key === idKey || !Object.hasOwn(row, key)) continue;
    const nested = inspectPullField(field).nestedPattern;
    const child = isAgain(nested) ? pattern : nested;
    const mapped = child === undefined
      ? mapWildcardEntityIds(row[key], map)
      : mapPullEntityIds(child, row[key], map);
    if (mapped !== row[key]) write(key, mapped);
  }
  return out ?? row;
};

export const reshapePullResult = (pattern: unknown, result: unknown): unknown => {
  if (result === null || result === undefined) return null;
  if (isAllShape(pattern) || Array.isArray(pattern)) return result;
  const filtered = filterPull(pattern, result);
  return filtered === undefined ? null : filtered;
};

const isPresent = (value: unknown): boolean =>
  value !== undefined && value !== null;

const isIrStub = (value: unknown): value is { readonly ":db/id": number } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === ":db/id" &&
    typeof (value as { ":db/id": unknown })[":db/id"] === "number"
  );
};

const remapStub = (
  pattern: unknown,
  stub: { readonly ":db/id": number },
): Record<string, number> | undefined => {
  const key = idKeyOf(pattern);
  if (key === undefined) return undefined;
  return { [key]: stub[":db/id"] };
};

const filterPull = (pattern: unknown, result: unknown): unknown => {
  if (!isPresent(result)) return undefined;
  if (isAllShape(pattern) || Array.isArray(pattern) || isAgain(pattern)) {
    return result;
  }
  if (typeof result !== "object") return undefined;
  if (isIrStub(result)) {
    return remapStub(pattern, result);
  }

  const fields = fieldsOf(pattern);
  const rec = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(fields)) {
    const info = inspectPullField(field);
    const raw = rec[key];
    const missing = !isPresent(raw);
    const recur = isAgain(info.nestedPattern);
    const childPattern = recur ? pattern : info.nestedPattern;

    if (childPattern !== undefined) {
      if (info.many) {
        if (missing) {
          out[key] = info.optional ? undefined : [];
          continue;
        }
        const arr = Array.isArray(raw) ? raw : [raw];
        const kept: unknown[] = [];
        for (const item of arr) {
          const child = filterPull(childPattern, item);
          if (child !== undefined) kept.push(child);
        }
        out[key] = kept;
        continue;
      }
      if (missing) {
        if (info.optional || recur) {
          out[key] = undefined;
          continue;
        }
        return undefined;
      }
      const child = filterPull(childPattern, raw);
      if (child === undefined) {
        if (info.optional || recur) {
          out[key] = undefined;
          continue;
        }
        return undefined;
      }
      out[key] = child;
      continue;
    }

    if (missing) {
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
