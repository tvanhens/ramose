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
 *
 * The domain has two membership conditions beyond being JSON, and an
 * argument that fails either is rejected with a sealed failure before any
 * implementation runs.
 *
 * Text is *well-formed* Unicode. JSON can carry an escaped unpaired
 * surrogate (`"\ud800"`), and such a string has no meaning as a sequence of
 * code points: `text.indexOf` could report an index that `text.slice` cannot
 * cut at. Rather than publish a semantics with a hole in it, a string
 * containing an unpaired surrogate is not a value of this domain.
 *
 * Nesting is bounded by {@link MAX_VALUE_DEPTH}. Depth is a property of the
 * value, so it belongs to the domain rather than to any one function: a
 * deeply nested argument would otherwise make comparison and canonicalization
 * unbounded work, and adding the bound after v1 published an unrestricted
 * domain would be a compatibility change. Real application data does not come
 * close to the limit.
 *
 * Both conditions are checked over the whole argument, collection contents
 * included, which is why every function taking a `collection` or an `any`
 * argument declares at least linear cost.
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
  | "malformedText"
  | "collection"
  | "object";

/**
 * Maximum nesting depth of a value in the domain. A scalar is depth 0, `[]`
 * and `{}` are depth 1, and each further container adds one.
 *
 * Generous on purpose: application data nests a handful of levels, so the
 * limit is invisible in practice and exists to keep traversal work bounded
 * and to keep an adversarial sub-megabyte document from asking for unbounded
 * comparison or canonicalization.
 */
export const MAX_VALUE_DEPTH = 64;

/**
 * Why a value is outside the domain. Reported as a reason, never with the
 * offending value or its position inside the argument.
 */
export type DomainViolation = "malformedText" | "tooDeep";

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
  /**
   * Maximum produced text length in UTF-16 code units, where a call can
   * produce more than the sum of its inputs. Declared only on functions that
   * amplify, and enforced *before* the output is allocated, so a small
   * document cannot ask for a large allocation.
   *
   * This is a static, per-call floor, not the query's budget: milestone 2's
   * runtime accounting (expression depth, call count, candidate rows,
   * produced bytes) subsumes it. It is budget policy rather than function
   * semantics, so tightening it later is not a language break.
   */
  readonly outputLimit?: number;
}

/** The whole versioned library as data. */
export interface StdlibManifest {
  readonly version: typeof QUERY_STDLIB_VERSION;
  readonly functions: readonly FunctionCard[];
}

/**
 * Returned by an implementation that computed how large its output would be
 * and declined to allocate it. The registry turns this into a sealed
 * output-size failure; it is never a value and never escapes the module.
 */
export const OUTPUT_TOO_LARGE = Symbol("ramose/db/query/stdlib/output-too-large");

/**
 * A pure implementation over plain JSON values.
 *
 * Total by construction: an undefined case returns `null` rather than
 * throwing, and an output that would exceed the declared limit returns
 * {@link OUTPUT_TOO_LARGE} rather than allocating. Arity, declared argument
 * types, and `propagate` null handling are enforced before the
 * implementation runs, and the result is re-checked against the declared
 * result type after it returns.
 */
export type StdlibImplementation = (
  args: readonly StdlibValue[],
) => StdlibValue | typeof OUTPUT_TOO_LARGE;
