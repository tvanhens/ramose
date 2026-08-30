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
