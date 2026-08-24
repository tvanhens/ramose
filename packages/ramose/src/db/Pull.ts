/** Literate pull map: keys are result names, values are attr refs / `.optional` / `.select`. */

import type { PullElemOrder, PullElemPred } from "../internal/core/query/ast.ts";
import type * as Schema from "effect/Schema";
import type { AnyField } from "./Field.ts";
import { isAttrRef } from "./attrRef.ts";
import type { AnySchema } from "./Schema.ts";
import type { Eid } from "./Eid.ts";
import type { AttrAtIdent, CatalogIdent, Ident } from "./idents.ts";
import type { AnyEntity, FieldMap } from "./Entity.ts";
import { isSelfRefSchema, refTargetOf, type SelfMarker } from "./valueTypes.ts";

// ── markers ────────────────────────────────────────────────────────────────

/**
 * Pull-phase constraints on one nested collection, already lowered to the
 * engine's IR (`PullAttrSpec`'s `:where` / `:order` / `:offset` / `:limit`).
 *
 * The client builds them from the `{ where, orderBy, limit, offset }` options
 * record on a card-many ref's `.select(shape, opts)` — or `values(attr, opts)`
 * for a card-many scalar (see shapes.ts) — and lowers them there, eagerly;
 * this module only carries them onto the spec.
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
   * (`valueType: "ref"`). Prefer `attr.select(shape).optional`.
   */
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
 * Nested shapes use {@link AttrNav.select} from shapes.ts (same grammar as
 * `Query.select` / `Q.pull`); this type only carries `.optional`.
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

// ── recursive trees: `Ramose.again(n)` ─────────────────────────────────────

/** Hop bound `again` accepts: a positive integer literal, 1 through 16. */
export type RecurDepth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

/** Named so a runtime assert that somehow sees 17 can say what the cap is. */
export const AGAIN_MAX_DEPTH = 16 as const;

/**
 * `n` must be a positive integer literal `1..16`. A `number`, a param,
 * `"..."`, `0`, a negative, a non-integer, or `17+` is a type error.
 */
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
  readonly [K in keyof F]: FieldResult<F[K], F>;
};

/**
 * The `:db/id` select cell. `N.id` carries its namespace as a phantom, so the
 * cell is the branded number `Eid<N>` — the raw id the peer answered, typed
 * as belonging to `N`, and a `db.pull` subject or `N.id.is(cell)` value with
 * no cast. An id attr without the phantom stays a plain `number`.
 */
export type IdCell<F> = F extends { readonly _ns?: infer N }
  ? [NonNullable<N>] extends [AnyEntity]
    ? Eid<NonNullable<N>>
    : number
  : number;

/** Decrement a literal hop bound. `Prev[1]` is unused: `again(1)` stubs the next hop. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

type UnwrapField<F> = F extends {
  readonly _tag: "optional" | "default";
  readonly field: infer I;
}
  ? UnwrapField<I>
  : F;

/** The key in `S` that selected `N.id` — the stub's only cell. */
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

/**
 * The enclosing shape with `again` edges unrolled `D` hops: `Unroll<S, 1>`
 * is {@link FieldsResult} with those edges as {@link RecurStub} — one
 * full-shape hop, then stubs. Matches the engine (`recursion: N` applies
 * the parent pattern once, then `{":db/id"}`).
 */
export type Unroll<S, D extends number> = {
  readonly [K in keyof S]: [IsAgainSelect<S[K]>] extends [true]
    ? AgainUnrollField<S[K], S, D>
    : FieldResult<S[K], S>;
};

/**
 * A nested `.select`: a named shape, `all(N)`, or `again(n)` — the
 * enclosing shape unrolled `n` hops. An array when the hop is
 * cardinality-many.
 */
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
  ? // a default stands in for the missing datom, so the field always reads
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
        : // a filtered scalar collection reads as the attribute's own array
          F extends { readonly _tag: "collection"; readonly attr: infer A }
          ? A extends { readonly schema: infer S }
            ? readonly SchemaType<S>[]
            : never
          : F extends { readonly ident: ":db/id" }
            ? IdCell<F>
            : ScalarResult<F>;

/** Result shape of a fields object. */
export type StructPullResult<P> = FieldsResult<P>;

/** Is this field the `again` term itself (not `ref.select(again)`)? */
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

/**
 * The namespace the recur edge lands on: self-ref / reverse → the attr's
 * own prefix; `Ref(() => N)` → `N.ns`.
 */
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

// ── ident-keyed escape ─────────────────────────────────────────────────────

/**
 * One slot in the keyword-soup pull. Attr ref (`User.name`), catalog
 * ident (`":user/name"`), or wildcard.
 */
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

type PullValueOne<A> = A extends { readonly valueType: "ref" }
  ? { readonly ":db/id": number }
  : A extends { readonly schema: infer S }
    ? SchemaType<S>
    : never;

/** {@link PullValue} at one catalog ident. */
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

// ── wire lowering ──────────────────────────────────────────────────────────

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

/** The hop-target namespace of a ref attr (self / reverse / `Ref(() => N)`). */
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

/** The result key that selected `:db/id`, if the shape has one. */
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

/**
 * `again` is a shape, not a field: there is no attribute to hang a recur
 * edge on. `ref.select(again(n))` is the nested form.
 */
export const assertNotAgain = (shape: unknown, key?: string): void => {
  if (!isAgain(unwrapAgainField(shape))) return;
  throw new Error(
    key === undefined
      ? "ramose/query: again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))"
      : `ramose/query: select field "${key}": again is a shape, not a field — write \`ref.select(Ramose.again(n))\``,
  );
};

/**
 * A field map that contains `ref.select(again(n))` must select `N.id` and
 * the recur edge must land in the same namespace.
 */
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

/**
 * A backlink node (`Todo.owner.reverse`). The marker is a plain property so
 * this module stays free of a shapes.ts import — pull is the lower layer.
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
 * shapes.ts.
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
    `ramose/query: select field "${as}": ${spellPath(path, revs)} is a multi-hop path (${path.join(" → ")}) — a select field must be a direct field of the queried entity. Use a nested select: ${spellNested(path, revs, leafSelects)}`,
  );
};

/**
 * A constrained scalar collection (`values(User.tags, { where: [ … ] })`).
 * Structural, like {@link isReverseCarrier} — pull stays free of shapes.ts.
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
      // AllShape, an ident array, or a literate map — the same three
      // `lowerPullPattern` already answers at the top of a pull
      sub: lowerPullPattern(info.nestedPattern),
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
  assertAgainInShape(fields);
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
  if (isAgain(pattern)) {
    throw new Error(
      "ramose/query: again is not a top-level shape — write it on a self-ref: ref.select(Ramose.again(n))",
    );
  }
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
 * The engine's cycle / budget stub: a one-key `{":db/id": n}` map. Nav
 * remaps it to the shape's id alias so the stub survives required-field
 * filtering and the row key is the one the author wrote.
 */
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

/**
 * `undefined` means this entity failed a required field and should be dropped.
 *
 * For a query, `requiredClauses` lowers every top-level required field into a
 * `where` clause, so the drop is the peer's and the top-level `undefined` is
 * unreachable; what stays here is per-element work that cannot change the row
 * count — filtering a cardinality-many array, and `db.pull` of one subject.
 */
const filterPull = (pattern: unknown, result: unknown): unknown => {
  if (!isPresent(result)) return undefined;
  // a wildcard row has no required field to fail: every key is optional
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
    // `again` re-applies this enclosing shape — the engine's parent pattern
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
        // a tree can end before the hop bound; missing card-one again
        // must not delete the parent the way a required nested select would
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
