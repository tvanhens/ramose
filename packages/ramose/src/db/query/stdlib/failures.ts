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
import type {
  DomainViolation,
  ExpressionContext,
  ValueType,
  ValueTypeName,
} from "./types.ts";

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

/**
 * An argument is the right kind but is not a value of the domain: it carries
 * ill-formed text, or it nests deeper than the domain allows.
 *
 * Reports the reason only. Neither the offending value nor its position
 * inside the argument is a public fact.
 */
export class QueryFunctionArgumentDomain extends Data.TaggedError(
  "QueryFunctionArgumentDomain",
)<{
  readonly name: string;
  readonly index: number;
  readonly parameter: string;
  readonly violation: DomainViolation;
}> {}

/** The function is not admitted in the expression context that called it. */
export class QueryFunctionContext extends Data.TaggedError(
  "QueryFunctionContext",
)<{
  readonly name: string;
  readonly context: ExpressionContext;
  readonly allowed: readonly ExpressionContext[];
}> {}

/**
 * The call would have produced more text than one call may produce.
 *
 * Carries the limit but never the requested size: a size derived from a field
 * value is still a fact about that value, and this contract does not leak
 * one. Milestone 2's runtime budget accounting owns richer reporting under
 * the sealed `query_budget_exceeded` contract.
 */
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

/** Stable machine-readable codes for the public error path. */
export type StdlibFailureCode =
  | "query_function_unknown"
  | "query_function_arity"
  | "query_function_argument_type"
  | "query_function_argument_domain"
  | "query_function_context"
  | "query_function_output_size";

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
