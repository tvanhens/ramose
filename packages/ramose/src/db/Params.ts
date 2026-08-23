/**
 * `Ramose.params` — declared value holes for a query that never changes
 * identity.
 *
 * A query is a stable value. `useLive` keys its subscription on the lowered
 * AST (plus {@link paramsKey} when bindings are present), so two hook sites
 * with the same query + params share one standing subscription. A param is
 * the hole for the changing **value**: declared up front, referenced inline
 * as an expression-tree leaf, carried in the query value, and bound at the
 * terminal — `db.query(q, { issueId })` / `useLive(db, q, { issueId })`.
 *
 * ```ts
 * const p = Ramose.params({
 *   issueId: Issue.id,                       // Param<Eid<typeof Issue>>
 *   term:    Schema.String,                  // Param<string>
 *   owner:   Ramose.optional(User.id),       // may be unbound
 * });
 * const q = Query.from(Comment).where({ issue: p.issueId });
 * ```
 *
 * Substitution happens at lowering time (`lowerQueryObject`), never via the
 * wire's `:in` / `inputs` channel — the peer sees exactly the query the same
 * literals would have produced. Value holes only: no param may stand in a
 * structural position (an attribute, a namespace, a shape, an `orderBy` key).
 */

import { stringifyJson } from "../internal/core/json.ts";
import { ParamError } from "./Errors.ts";
import type { Eid } from "./Eid.ts";
import type { AnyEntity } from "./Entity.ts";

// ── the hole ────────────────────────────────────────────────────────────────

/**
 * One declared hole. `T` is the value it stands for; `B` is the whole set's
 * bindings record (what `db.query(q, bindings)` takes), which is how a hole from
 * one set is a type error in a query scoped to another; `Opt` says whether
 * the hole may be unbound (`Ramose.optional`).
 *
 * The phantoms are never present at runtime — a param is `{ _tag, key,
 * optional, set }` and nothing else.
 */
export interface Param<T, B = unknown, Opt extends boolean = false> {
  readonly _tag: "Param";
  /** The key this hole is declared (and bound) under. */
  readonly key: string;
  /** `true` for a `Ramose.optional(...)` declaration. */
  readonly optional: Opt;
  /** @internal Identity of the set this hole was declared in. */
  readonly set: object;
  /** Phantom — the value this hole stands for. Never present at runtime. */
  readonly _type?: T;
  /** Phantom — the set's bindings record. Never present at runtime. */
  readonly _scope?: B;
}

/** A hole of any value, set and optionality — what the runtime walks. */
export type AnyParam = Param<any, any, boolean>;

export const isParam = (x: unknown): x is AnyParam =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === "Param";

/**
 * A param left in a lowered AST when keying a subscription — `{ $param: key }`
 * instead of the bound value. Not a wire form: only {@link lowerQueryAst}
 * emits these so a params query can key as `astKey + paramsKey`.
 */
export const isParamHole = (
  v: unknown,
): v is { readonly $param: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { $param?: unknown }).$param === "string" &&
  Object.keys(v).length === 1;

/** @internal Binder that leaves holes as `{$param}` tokens for subscription keys. */
export const holesBinder = (): ParamBinder => ({
  resolve: (p) => ({ $param: p.key }),
  gateOn: () => true,
});

/** What a predicate method takes in a value position: a hole for `T`. */
export type ParamIn<T> = Param<T, any, boolean>;

/** The bindings record a value resolves against: `never` for a literal. */
export type ScopeOf<V> = V extends Param<any, infer B, boolean> ? B : never;

// ── declaration ─────────────────────────────────────────────────────────────

/**
 * What a param may be declared from: an attribute reference (`Issue.id`,
 * `Todo.title` — anything carrying a value `schema`) or a bare Effect Schema
 * (`Schema.String`).
 */
export type ParamDecl =
  | { readonly schema: { readonly Type: unknown } }
  | { readonly Type: unknown }
  | { readonly ast: unknown };

/**
 * `Ramose.EidOf(User)` — a param declared to hold an entity of one
 * namespace: the branded cell a `select({ id: N.id })` row carries, or the
 * catalog-branded `{ id }` a bare query yields. Both bind with no cast, and
 * both lower to the raw id number wherever the hole stands.
 */
export interface EidOfDecl<N extends AnyEntity = AnyEntity> {
  readonly _tag: "EidOfDecl";
  readonly ns: N;
  readonly schema: {
    readonly Type: Eid<N> | { readonly id: number };
  };
}

export const EidOf = <const N extends AnyEntity>(ns: N): EidOfDecl<N> => {
  if (typeof ns !== "object" || ns === null || (ns as { _tag?: unknown })._tag !== "Entity") {
    throw new Error("ramose/params: EidOf(...) takes an entity (Ramose.EidOf(User))");
  }
  return { _tag: "EidOfDecl", ns, schema: { Type: undefined as never } };
};

/** A declaration marked "may be unbound" — see {@link optional}. */
export interface OptionalDecl<D extends ParamDecl = ParamDecl> {
  readonly _tag: "OptionalParamDecl";
  readonly decl: D;
}

export type ParamsSpec = Record<string, ParamDecl | OptionalDecl>;

/**
 * `Ramose.optional(decl)` — declare a param that may be unbound. Binding it
 * to `undefined` (or leaving it out) is legal for this declaration **only**;
 * an unbound optional turns off every `Ramose.when` gated on it, and is a
 * {@link ParamError} anywhere else. This is optionality in the hole's type,
 * never an `undefined`-means-skip sentinel.
 */
export const optional = <const D extends ParamDecl>(decl: D): OptionalDecl<D> => {
  assertDecl(decl, "optional(...)");
  return { _tag: "OptionalParamDecl", decl };
};

const isOptionalDecl = (d: unknown): d is OptionalDecl =>
  typeof d === "object" &&
  d !== null &&
  (d as { _tag?: unknown })._tag === "OptionalParamDecl";

/**
 * An attribute ref is a plain object with `schema`. An Effect Schema (Effect
 * 4) is a function carrying `ast` — `typeof === "function"`, so a
 * `typeof === "object"` check would reject `Schema.String`.
 */
const isDeclShape = (x: unknown): boolean => {
  if (x === null || (typeof x !== "object" && typeof x !== "function")) {
    return false;
  }
  return "schema" in x || "Type" in x || "ast" in x;
};

const assertDecl = (decl: unknown, where: string): void => {
  const inner = isOptionalDecl(decl) ? decl.decl : decl;
  if (!isDeclShape(inner)) {
    throw new Error(
      `ramose/params: ${where} takes an attribute reference (Issue.id, Todo.title) or an Effect Schema, got ${String(decl)}`,
    );
  }
};

/**
 * The value a declaration stands for: `Eid<N>` for a namespace's `:db/id`
 * (the branded row cell `select({ id: N.id })` yields — so the cell binds
 * with no cast), the schema's `Type` otherwise.
 */
export type ParamValue<D> = D extends {
  readonly _tag: "OptionalParamDecl";
  readonly decl: infer Inner;
}
  ? ParamValue<Inner>
  : D extends { readonly ident: ":db/id"; readonly _ns?: infer N }
    ? NonNullable<N> extends AnyEntity
      ? Eid<NonNullable<N>>
      : number
    : D extends { readonly schema: { readonly Type: infer T } }
      ? T
      : D extends { readonly Type: infer T }
        ? T
        : never;

type IsOptionalDecl<D> = D extends { readonly _tag: "OptionalParamDecl" }
  ? true
  : false;

/**
 * The bindings record one declaration spec takes: required keys for required
 * params, optional (`| undefined`) keys for `Ramose.optional` ones. This is
 * the `B` every hole of the set carries, and the second positional argument
 * `db.query` / `db.live` / `useQuery` / `useLive` take.
 */
export type ParamBindings<Spec extends ParamsSpec> = {
  readonly [K in keyof Spec as IsOptionalDecl<Spec[K]> extends true
    ? never
    : K]: ParamValue<Spec[K]>;
} & {
  readonly [K in keyof Spec as IsOptionalDecl<Spec[K]> extends true
    ? K
    : never]?: ParamValue<Spec[K]> | undefined;
};

/** The set `Ramose.params({...})` returns: one {@link Param} per key. */
export type ParamsOf<Spec extends ParamsSpec> = {
  readonly [K in keyof Spec]: Param<
    ParamValue<Spec[K]>,
    ParamBindings<Spec>,
    IsOptionalDecl<Spec[K]>
  >;
};

/** A set of declared holes, as the runtime sees it. */
export type AnyParamSet = Readonly<Record<string, AnyParam>>;

/** The bindings record a set's holes resolve against. */
export type BindingsOfSet<P extends AnyParamSet> = ScopeOf<P[keyof P]>;

/**
 * The trailing arguments a read takes for a query scoped to bindings `B`:
 * none for an unscoped query, a required positional `B` otherwise (optional
 * when every param is `Ramose.optional`).
 */
export type ParamArgs<B> = [B] extends [never]
  ? []
  : Record<never, never> extends B
    ? [params?: B]
    : [params: B];

/**
 * `Ramose.params({...})` — declare a query's value holes, by attribute
 * reference or Effect Schema. Declared, not inferred-from-use: the set is
 * what a fluent chain accumulates via `ScopeOf`, what `Query.q(params, body)`
 * declares as its head, what the terminal binds, and what a mistyped
 * binding is checked against.
 */
export const params = <const Spec extends ParamsSpec>(
  spec: Spec,
): ParamsOf<Spec> => {
  const set: Record<string, AnyParam> = {};
  const out: Record<string, AnyParam> = {};
  for (const [key, decl] of Object.entries(spec)) {
    assertDecl(decl, `params({ ${key}: … })`);
    out[key] = {
      _tag: "Param",
      key,
      optional: isOptionalDecl(decl),
      set,
    } as AnyParam;
  }
  // The identity object *is* the full set, so a single token (`p.issueId`)
  // still types and binds the whole record — accepted looseness of #208.
  Object.assign(set, out);
  return out as ParamsOf<Spec>;
};

// ── binding (runtime) ───────────────────────────────────────────────────────

/** @internal Resolves each hole of one lowering pass. See {@link bindParams}. */
export interface ParamBinder {
  /** The bound value. Never `undefined`: an unbound optional is an error here. */
  readonly resolve: (p: AnyParam, use: string) => unknown;
  /**
   * A `Ramose.when` gate: a required `Param<boolean>` gates on its value, an
   * optional param gates on being bound.
   */
  readonly gateOn: (p: AnyParam) => boolean;
}

const notScoped = (key: string): Error =>
  new Error(
    `ramose/params: the param "${key}" is used in a query that is not scoped to its set — declare the set in the query's head (Query.q(params, body))`,
  );

/**
 * @internal Validate `bindings` against the query's declared set and hand
 * back the resolver a lowering pass substitutes with. Validation is eager
 * and total: an unknown key, or a required param missing (or bound to
 * `undefined`), is a {@link ParamError} whether or not the hole is reached.
 */
export const bindParams = (
  set: AnyParamSet | undefined,
  bindings: Readonly<Record<string, unknown>> | undefined,
): ParamBinder => {
  if (set === undefined) {
    if (bindings !== undefined && Object.keys(bindings).length > 0) {
      throw new Error(
        "ramose/params: this query declares no params — declare them in the query's head (Query.q(params, body))",
      );
    }
    return {
      resolve: (p) => {
        throw notScoped(p.key);
      },
      gateOn: (p) => {
        throw notScoped(p.key);
      },
    };
  }
  const bound = bindings ?? {};
  for (const key of Object.keys(bound)) {
    if (!(key in set)) {
      throw new ParamError({
        message: `ramose/params: unknown param "${key}" — the query's set declares { ${Object.keys(set).join(", ")} }`,
        key,
      });
    }
  }
  for (const [key, p] of Object.entries(set)) {
    if (!p.optional && bound[key] === undefined) {
      throw new ParamError({
        message: `ramose/params: required param "${key}" is ${key in bound ? "bound to undefined" : "missing"} — only a Ramose.optional param may be unbound`,
        key,
      });
    }
  }
  const own = (p: AnyParam): void => {
    if (set[p.key] !== p) {
      throw new ParamError({
        message: `ramose/params: the param "${p.key}" belongs to a different set than the one this query is scoped to`,
        key: p.key,
      });
    }
  };
  return {
    resolve: (p, use) => {
      own(p);
      const value = bound[p.key];
      if (value === undefined) {
        // only an optional param can get here — required ones failed above
        throw new ParamError({
          message: `ramose/params: optional param "${p.key}" is unbound but used in ${use} — reference an optional param inside Ramose.when(P.${p.key}, …) so the clause turns off with it, or bind it`,
          key: p.key,
        });
      }
      return value;
    },
    gateOn: (p) => {
      own(p);
      const value = bound[p.key];
      if (p.optional) return value !== undefined;
      if (typeof value !== "boolean") {
        throw new ParamError({
          message: `ramose/params: the gate "${p.key}" must be a Param<boolean> or a Ramose.optional param — it is bound to ${String(value)}`,
          key: p.key,
        });
      }
      return value;
    },
  };
};

/**
 * @internal Run a deferred normalization (the check a literal gets at
 * builder-call time — `regexSource`, `eidValue`, `in`'s array check) against
 * a bound value, surfacing the failure as a {@link ParamError} that names
 * the hole.
 */
/**
 * Structural identity of a bindings record: a canonical JSON key so an
 * inline `{ issueId }` literal compares equal across renders. `undefined`
 * (an unbound optional) is an explicit marker — `JSON.stringify` would
 * drop it, and `toJson` would turn it into `null`.
 */
export const paramsKey = (params: unknown): string => {
  if (params === undefined || params === null) return "";
  if (typeof params !== "object" || Array.isArray(params)) {
    return stringifyJson(params);
  }
  const rec = params as Record<string, unknown>;
  const canon: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) {
    canon[k] = rec[k] === undefined ? { $unbound: true } : rec[k];
  }
  return stringifyJson(canon);
};

export const normalizeBound = <A>(p: AnyParam, run: () => A): A => {
  try {
    return run();
  } catch (e) {
    if (e instanceof ParamError) throw e;
    throw new ParamError({
      message: `ramose/params: param "${p.key}": ${e instanceof Error ? e.message : String(e)}`,
      key: p.key,
    });
  }
};
