/**
 * Structured, value-sealed failures for the v1 expression standard library
 * (#507).
 *
 * Sealing rule: a failure may carry the caller's own public function name,
 * the caller's own context, declared parameter names, declared types, the
 * *kind* a runtime value had, and counts. It may never carry a field value,
 * a row, an internal implementation name, an engine symbol, a plan, or any
 * storage detail. {@link sealStdlibFailure} is the projection the public
 * error path uses, and its output is checked by tests to contain nothing but
 * those admitted pieces.
 *
 * Unknown and internal-only names are indistinguishable on purpose: this
 * registry knows public names only, so anything else is `UnknownQueryFunction`
 * and the response never confirms that some other name exists internally.
 */

import * as Data from "effect/Data";
import type { ExpressionContext, ValueType, ValueTypeName } from "./types.ts";

/** The name is not in the public v1 allowlist. */
export class UnknownQueryFunction extends Data.TaggedError(
  "UnknownQueryFunction",
)<{
  /** The caller's own requested name, echoed back verbatim. */
  readonly name: string;
}> {}

/** The call supplied the wrong number of arguments. */
export class QueryFunctionArity extends Data.TaggedError("QueryFunctionArity")<{
  readonly name: string;
  readonly expected: number;
  readonly received: number;
}> {}

/** An argument's runtime kind does not satisfy the declared parameter type. */
export class QueryFunctionArgumentType extends Data.TaggedError(
  "QueryFunctionArgumentType",
)<{
  readonly name: string;
  readonly index: number;
  readonly parameter: string;
  readonly expected: ValueType;
  /** The kind the value had. Never the value. */
  readonly received: ValueTypeName;
}> {}

/** The function is not admitted in the expression context that called it. */
export class QueryFunctionContext extends Data.TaggedError(
  "QueryFunctionContext",
)<{
  readonly name: string;
  readonly context: ExpressionContext;
  readonly allowed: readonly ExpressionContext[];
}> {}

export type StdlibFailure =
  | UnknownQueryFunction
  | QueryFunctionArity
  | QueryFunctionArgumentType
  | QueryFunctionContext;

/** Stable machine-readable codes for the public error path. */
export type StdlibFailureCode =
  | "query_function_unknown"
  | "query_function_arity"
  | "query_function_argument_type"
  | "query_function_context";

/** A sealed failure: only names, declared types, kinds, and counts. */
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
      readonly code: "query_function_context";
      readonly function: string;
      readonly context: ExpressionContext;
      readonly allowed: readonly ExpressionContext[];
    };

/**
 * Project a failure onto the public wire shape. The output is plain JSON and
 * contains no argument value, no field value, and no internal name.
 */
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
    case "QueryFunctionContext":
      return {
        code: "query_function_context",
        function: failure.name,
        context: failure.context,
        allowed: failure.allowed,
      };
  }
};
