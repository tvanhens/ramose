import * as Data from "effect/Data";
import type {
  DomainViolation,
  ExpressionContext,
  ValueType,
  ValueTypeName,
} from "./types.ts";

export class UnknownQueryFunction extends Data.TaggedError(
  "UnknownQueryFunction",
)<{
  readonly name: string;
}> {}

export class QueryFunctionArity extends Data.TaggedError("QueryFunctionArity")<{
  readonly name: string;
  readonly expected: number;
  readonly received: number;
}> {}

export class QueryFunctionArgumentType extends Data.TaggedError(
  "QueryFunctionArgumentType",
)<{
  readonly name: string;
  readonly index: number;
  readonly parameter: string;
  readonly expected: ValueType;
  readonly received: ValueTypeName;
}> {}

export class QueryFunctionArgumentDomain extends Data.TaggedError(
  "QueryFunctionArgumentDomain",
)<{
  readonly name: string;
  readonly index: number;
  readonly parameter: string;
  readonly violation: DomainViolation;
}> {}

export class QueryFunctionContext extends Data.TaggedError(
  "QueryFunctionContext",
)<{
  readonly name: string;
  readonly context: ExpressionContext;
  readonly allowed: readonly ExpressionContext[];
}> {}

export class QueryFunctionOutputSize extends Data.TaggedError(
  "QueryFunctionOutputSize",
)<{
  readonly name: string;
  readonly limit: number;
}> {}

export type StdlibFailure =
  | UnknownQueryFunction
  | QueryFunctionArity
  | QueryFunctionArgumentType
  | QueryFunctionArgumentDomain
  | QueryFunctionContext
  | QueryFunctionOutputSize;

export type StdlibFailureCode =
  | "query_function_unknown"
  | "query_function_arity"
  | "query_function_argument_type"
  | "query_function_argument_domain"
  | "query_function_context"
  | "query_function_output_size";

export type SealedStdlibFailure =
  | {
      readonly code: "query_function_unknown";
      readonly function: string;
    }
  | {
      readonly code: "query_function_arity";
      readonly function: string;
      readonly expected: number;
      readonly received: number;
    }
  | {
      readonly code: "query_function_argument_type";
      readonly function: string;
      readonly index: number;
      readonly parameter: string;
      readonly expected: ValueType;
      readonly received: ValueTypeName;
    }
  | {
      readonly code: "query_function_argument_domain";
      readonly function: string;
      readonly index: number;
      readonly parameter: string;
      readonly violation: DomainViolation;
    }
  | {
      readonly code: "query_function_context";
      readonly function: string;
      readonly context: ExpressionContext;
      readonly allowed: readonly ExpressionContext[];
    }
  | {
      readonly code: "query_function_output_size";
      readonly function: string;
      readonly limit: number;
    };

export const sealStdlibFailure = (failure: StdlibFailure): SealedStdlibFailure => {
  switch (failure._tag) {
    case "UnknownQueryFunction":
      return { code: "query_function_unknown", function: failure.name };
    case "QueryFunctionArity":
      return {
        code: "query_function_arity",
        function: failure.name,
        expected: failure.expected,
        received: failure.received,
      };
    case "QueryFunctionArgumentType":
      return {
        code: "query_function_argument_type",
        function: failure.name,
        index: failure.index,
        parameter: failure.parameter,
        expected: failure.expected,
        received: failure.received,
      };
    case "QueryFunctionArgumentDomain":
      return {
        code: "query_function_argument_domain",
        function: failure.name,
        index: failure.index,
        parameter: failure.parameter,
        violation: failure.violation,
      };
    case "QueryFunctionContext":
      return {
        code: "query_function_context",
        function: failure.name,
        context: failure.context,
        allowed: failure.allowed,
      };
    case "QueryFunctionOutputSize":
      return {
        code: "query_function_output_size",
        function: failure.name,
        limit: failure.limit,
      };
  }
};
