/**
 * Types for the versioned v1 query expression standard library (#507).
 *
 * The manifest in {@link ./manifest.ts} is plain data: every field here is
 * JSON-projectable so capability cards, `describe` output and documentation
 * can be derived mechanically from one source of truth rather than restated
 * by hand. Implementations live in a separate module and are never reachable
 * from a card, so a public name can never leak an engine symbol.
 *
 * Stability contract: within `QueryDocumentV1` a published function keeps its
 * name, arity, parameter types, result type and semantics forever. Growth is
 * additive — a new function may be added, an existing one may not change.
 * Changing behaviour requires a new query-language version.
 */

/** The library version these cards describe. Bumping it is a language break. */
export const QUERY_STDLIB_VERSION = 1 as const;

/** A JSON scalar admitted as an expression value. */
export type StdlibScalar = string | number | boolean | null;

/**
 * The value domain expressions compute over: plain JSON. There is no date
 * object, no bigint, no `undefined`, and no non-finite number — a timestamp
 * is epoch milliseconds and a collection is a JSON array.
 */
export type StdlibValue =
  | StdlibScalar
  | ReadonlyArray<StdlibValue>
  | { readonly [key: string]: StdlibValue };

/**
 * What a runtime value actually is. Used only to explain a type mismatch:
 * failures report the *kind* a value had, never the value itself.
 */
export type ValueTypeName =
  | "null"
  | "boolean"
  | "number"
  | "text"
  | "collection"
  | "object";

/**
 * A declared parameter or result type.
 *
 * - `timestamp` is a safe-integer count of epoch milliseconds within the
 *   representable instant range; it is a refinement of `number`, not a
 *   separate runtime representation.
 * - `any` accepts every {@link StdlibValue}.
 * - `null` is admitted wherever any type is declared; see {@link NullBehavior}.
 */
export type ValueType =
  | "any"
  | "boolean"
  | "number"
  | "timestamp"
  | "text"
  | "collection";

/** Positions in a query document where an expression may appear. */
export type ExpressionContext = "let" | "where" | "select" | "orderBy";

/** Every context, in document order. Stable. */
export const EXPRESSION_CONTEXTS: readonly ExpressionContext[] = [
  "let",
  "where",
  "select",
  "orderBy",
];

/**
 * Work a call does relative to the size of its inputs. Used later by budget
 * accounting; no v1 function is `superlinear`, and the variant exists so a
 * future addition does not have to widen the union incompatibly.
 */
export type CostClass = "constant" | "linear" | "superlinear";

/**
 * How many values one call produces. `collection` means the single result
 * value is a JSON array — never that the call produces query rows. There are
 * no row-producing or table functions in v1.
 */
export type Cardinality = "one" | "collection";

/**
 * How a function treats a `null` argument.
 *
 * - `propagate`: the call short-circuits to `null` when any argument is
 *   `null`; the implementation never observes one.
 * - `explicit`: the implementation defines the behaviour itself. Only the
 *   handful of functions whose whole purpose is reasoning about absence
 *   (`logic.isNull`, `logic.coalesce`, `logic.if`, the Kleene connectives,
 *   `collection.contains`) use this.
 */
export type NullBehavior = "propagate" | "explicit";

/** The five v1 namespaces. */
export type StdlibNamespace = "logic" | "number" | "text" | "collection" | "time";

/** Every namespace, in card order. Stable. */
export const STDLIB_NAMESPACES: readonly StdlibNamespace[] = [
  "logic",
  "number",
  "text",
  "collection",
  "time",
];

/** One declared argument. `name` is public documentation, not a keyword. */
export interface ParameterSpec {
  readonly name: string;
  readonly type: ValueType;
  readonly doc: string;
}

/**
 * A worked example. Every example is checked against the implementation by
 * the manifest-integrity tests, so published documentation cannot drift.
 */
export interface FunctionExample {
  readonly args: readonly StdlibValue[];
  readonly result: StdlibValue;
  readonly note?: string;
}

/** Argument list and result type. Arity is `parameters.length`. */
export interface FunctionSignature {
  readonly parameters: readonly ParameterSpec[];
  readonly result: ValueType;
}

/**
 * The public card for one function: everything validation, `describe`, and
 * the docs need, and nothing that could identify an internal implementation.
 */
export interface FunctionCard {
  /** Stable public name, always `namespace.function`. */
  readonly name: string;
  readonly namespace: StdlibNamespace;
  readonly signature: FunctionSignature;
  /** Contexts the call is admitted in. Never empty. */
  readonly contexts: readonly ExpressionContext[];
  /** Always `true` in v1: no clock, no randomness, no ambient input. */
  readonly deterministic: boolean;
  readonly cardinality: Cardinality;
  readonly cost: CostClass;
  readonly nulls: NullBehavior;
  /** One line, imperative, safe to show to an untrusted caller. */
  readonly doc: string;
  /** At least one, and every one is executable. */
  readonly examples: readonly FunctionExample[];
}

/** The whole versioned library as data. */
export interface StdlibManifest {
  readonly version: typeof QUERY_STDLIB_VERSION;
  readonly functions: readonly FunctionCard[];
}

/**
 * A pure implementation over plain JSON values.
 *
 * Total by construction: an undefined case returns `null` rather than
 * throwing. Arity, declared argument types, and `propagate` null handling are
 * enforced before the implementation runs, and the result is re-checked
 * against the declared result type after it returns.
 */
export type StdlibImplementation = (args: readonly StdlibValue[]) => StdlibValue;
