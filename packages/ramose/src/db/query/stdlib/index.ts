/**
 * The v1 deterministic expression standard library for `QueryDocumentV1`
 * (#507, tracker #484).
 *
 * This module is self-contained and internal: it is not re-exported from
 * `ramose/db` yet. The compiler integration — lowering a validated call to
 * the existing `Q.call` function-binding machinery — lands after the
 * `QueryDocumentV1` grammar in #486, and this barrel is what it will import.
 *
 * What ships here:
 *
 * - `standardLibraryV1`, the versioned manifest, as the single source of
 *   truth for validation, capability cards, documentation, and (next)
 *   compiler dispatch. It is plain JSON data with no implementation values
 *   in it, so a card can be projected mechanically and cannot leak a symbol.
 * - Pure, total implementations over plain JSON values with defined
 *   boundary behaviour: null propagation, empty text and empty collections,
 *   non-finite guards, and clamped indices.
 * - An explicit public allowlist with arity, argument-type, and expression
 *   context checking, reporting structured failures that carry only public
 *   names, declared types, value *kinds*, and counts — never a value.
 *
 * Four commitments hold the totality and determinism claims up. Text is
 * well-formed Unicode and nesting is bounded, so the published code-point
 * indices are total and comparison work is bounded; both conditions are
 * checked over the whole argument, and the traversals that check and use them
 * run on explicit stacks so no path depends on the host's call-stack depth.
 * Case mapping and whitespace are pinned in this module instead
 * of read from the host, whose Unicode tables move with its version. And a
 * call that could produce more text than the sum of its inputs sizes the
 * result first and refuses before allocating, so one expression cannot ask a
 * Worker for a hundred megabytes; milestone 2's runtime budget accounting
 * subsumes that static floor.
 *
 * What is out of the language by construction: `now`, `rand`, any clock or
 * randomness, caller-supplied regular expressions, lambdas or other
 * higher-order functions, recursion, environment/filesystem/network access,
 * database- or catalog-aware functions, and row-producing functions. A
 * function may return a collection as one value; none can fan a row out.
 *
 * The implementation table is intentionally absent from this barrel: a
 * caller resolves a public name to a card, and only the registry can reach
 * the code behind it.
 */

export {
  QueryFunctionArgumentDomain,
  QueryFunctionArgumentType,
  QueryFunctionArity,
  QueryFunctionContext,
  QueryFunctionOutputSize,
  UnknownQueryFunction,
  sealStdlibFailure,
  type SealedStdlibFailure,
  type StdlibFailure,
  type StdlibFailureCode,
} from "./failures.ts";

export { standardLibraryManifestV1 } from "./manifest.ts";

export {
  checkQueryCallArguments,
  evaluateQueryCall,
  isQueryFunctionName,
  lookupQueryFunction,
  queryFunctionNames,
  standardLibraryV1,
  stdlibIntegrityProblems,
  validateQueryCall,
  type QueryCall,
  type QueryCallShape,
} from "./registry.ts";

export {
  EXPRESSION_CONTEXTS,
  MAX_VALUE_DEPTH,
  QUERY_STDLIB_VERSION,
  STDLIB_NAMESPACES,
  type Cardinality,
  type CostClass,
  type DomainViolation,
  type ExpressionContext,
  type FunctionCard,
  type FunctionExample,
  type FunctionSignature,
  type NullBehavior,
  type ParameterSpec,
  type StdlibManifest,
  type StdlibNamespace,
  type StdlibScalar,
  type StdlibValue,
  type ValueType,
  type ValueTypeName,
} from "./types.ts";

export {
  MAX_PRODUCED_TEXT_UNITS,
  MAX_TIMESTAMP_MILLIS,
  asciiLower,
  asciiUpper,
  canonicalKey,
  classify,
  deepEquals,
  domainViolation,
  isFiniteNumber,
  isTimestamp,
  isWellFormedText,
  matchesValueType,
  trimPinned,
} from "./values.ts";
