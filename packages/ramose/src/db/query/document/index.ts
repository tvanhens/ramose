/**
 * `QueryDocumentV1` — the canonical plain-data query representation.
 *
 * One public data syntax shared by every non-TypeScript caller: a
 * versioned tagged-object grammar, array field paths, ordered `let`
 * bindings, and plain-data parameters, compiled deterministically onto the
 * existing query engine. Nothing in this module knows about MCP, HTTP, or
 * any other transport — a wire envelope `$ref`s
 * {@link queryDocumentJsonSchema} and calls {@link compileQueryDocument}.
 *
 * The expression standard library is *not* here: `{ call }` resolves
 * through a {@link FunctionRegistryV1}, the typed seam #507 implements.
 */

export {
  DEFAULT_QUERY_LIMITS,
  EXPRESSION_TAGS,
  QUERY_DOCUMENT_SCHEMA_ID,
  QUERY_DOCUMENT_VERSION,
  type BindingV1,
  type CardinalityV1,
  type ExpressionContextV1,
  type ExpressionTag,
  type ExpressionV1,
  type NestedSelectionV1,
  type NormalizedOrderV1,
  type NormalizedPageV1,
  type NormalizedQueryDocumentV1,
  type OrderDirectionV1,
  type OrderEmptyV1,
  type OrderV1,
  type PageV1,
  type ProjectionV1,
  type QueryComplexityV1,
  type QueryDocumentIssueCode,
  type QueryDocumentIssueV1,
  type QueryDocumentPath,
  type QueryDocumentV1,
  type QueryJsonValue,
  type QueryLimitsV1,
  type QueryResultShapeV1,
  type QueryRootV1,
  type ResultShapeV1,
  type SelectionV1,
  type ValueTypeV1,
} from "./types.ts";

export {
  EMPTY_FUNCTION_REGISTRY,
  makeFunctionRegistry,
  type FieldRefV1,
  type FunctionDefinitionV1,
  type FunctionLoweringV1,
  type FunctionParameterV1,
  type FunctionRegistryV1,
  type FunctionSignatureV1,
  type LoweringApiV1,
  type OperandV1,
  type PredicateLoweringV1,
  type ScalarLoweringV1,
} from "./registry.ts";

export {
  catalogFromSchema,
  describeField,
  referenceTarget,
  valueTypeOf,
  type QueryCatalogV1,
} from "./catalog.ts";

export {
  compileQueryDocument,
  validateQueryDocument,
  QueryDocumentInvalid,
  type CompiledQueryDocumentV1,
  type CompileQueryDocumentOptions,
} from "./compile.ts";

export { serializeQueryDocument } from "./serialize.ts";
export { queryDocumentJsonSchema, type QueryDocumentJsonSchema } from "./json-schema.ts";

export type {
  FieldStepV1,
  ResolvedBindingV1,
  ResolvedExprV1,
  ResolvedOrderV1,
  ResolvedQueryDocumentV1,
  ResolvedSelectionV1,
} from "./validate.ts";
