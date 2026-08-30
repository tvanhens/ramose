export const QUERY_STDLIB_VERSION = 1 as const;

export type StdlibScalar = string | number | boolean | null;

export type StdlibValue =
  | StdlibScalar
  | ReadonlyArray<StdlibValue>
  | { readonly [key: string]: StdlibValue };

export type ValueTypeName =
  | "null"
  | "boolean"
  | "number"
  | "text"
  | "malformedText"
  | "collection"
  | "object";

export const MAX_VALUE_DEPTH = 64;

export type DomainViolation = "malformedText" | "tooDeep";

export type ValueType =
  | "any"
  | "boolean"
  | "number"
  | "timestamp"
  | "text"
  | "collection";

export type ExpressionContext = "let" | "where" | "select" | "orderBy";

export const EXPRESSION_CONTEXTS: readonly ExpressionContext[] = [
  "let",
  "where",
  "select",
  "orderBy",
];

export type CostClass = "constant" | "linear" | "superlinear";

export type Cardinality = "one" | "collection";

export type NullBehavior = "propagate" | "explicit";

export type StdlibNamespace = "logic" | "number" | "text" | "collection" | "time";

export const STDLIB_NAMESPACES: readonly StdlibNamespace[] = [
  "logic",
  "number",
  "text",
  "collection",
  "time",
];

export interface ParameterSpec {
  readonly name: string;
  readonly type: ValueType;
  readonly doc: string;
}

export interface FunctionExample {
  readonly args: readonly StdlibValue[];
  readonly result: StdlibValue;
  readonly note?: string;
}

export interface FunctionSignature {
  readonly parameters: readonly ParameterSpec[];
  readonly result: ValueType;
}

export interface FunctionCard {
  readonly name: string;
  readonly namespace: StdlibNamespace;
  readonly signature: FunctionSignature;
  readonly contexts: readonly ExpressionContext[];
  readonly deterministic: boolean;
  readonly cardinality: Cardinality;
  readonly cost: CostClass;
  readonly nulls: NullBehavior;
  readonly doc: string;
  readonly examples: readonly FunctionExample[];
  readonly outputLimit?: number;
}

export interface StdlibManifest {
  readonly version: typeof QUERY_STDLIB_VERSION;
  readonly functions: readonly FunctionCard[];
}

export const OUTPUT_TOO_LARGE = Symbol("ramose/db/query/stdlib/output-too-large");

export type StdlibImplementation = (
  args: readonly StdlibValue[],
) => StdlibValue | typeof OUTPUT_TOO_LARGE;
