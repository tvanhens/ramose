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
  QueryFunctionArgumentType,
  QueryFunctionArity,
  QueryFunctionContext,
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
  QUERY_STDLIB_VERSION,
  STDLIB_NAMESPACES,
  type Cardinality,
  type CostClass,
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
  MAX_TIMESTAMP_MILLIS,
  canonicalKey,
  classify,
  deepEquals,
  isFiniteNumber,
  isTimestamp,
  matchesValueType,
} from "./values.ts";
