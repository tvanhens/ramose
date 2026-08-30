import * as Result from "effect/Result";
import {
  QueryFunctionArgumentDomain,
  QueryFunctionArgumentType,
  QueryFunctionArity,
  QueryFunctionContext,
  QueryFunctionOutputSize,
  UnknownQueryFunction,
  type StdlibFailure,
} from "./failures.ts";
import { standardLibraryImplementationsV1 } from "./implementations.ts";
import { standardLibraryManifestV1 } from "./manifest.ts";
import { OUTPUT_TOO_LARGE } from "./types.ts";
import type {
  ExpressionContext,
  FunctionCard,
  StdlibManifest,
  StdlibValue,
} from "./types.ts";
import {
  MAX_PRODUCED_TEXT_UNITS,
  classify,
  domainViolation,
  matchesValueType,
} from "./values.ts";

export const standardLibraryV1: StdlibManifest = standardLibraryManifestV1;

const cardsByName: ReadonlyMap<string, FunctionCard> = new Map(
  standardLibraryV1.functions.map((card) => [card.name, card] as const),
);

const implementationsByName = new Map(
  Object.entries(standardLibraryImplementationsV1),
);

const NESTING_PARAMETER_TYPES: ReadonlySet<string> = new Set(["collection", "any"]);

const ORDERABLE_RESULTS: ReadonlySet<string> = new Set([
  "boolean",
  "number",
  "timestamp",
  "text",
]);

export const queryFunctionNames = (): readonly string[] =>
  [...cardsByName.keys()].sort();

export const isQueryFunctionName = (name: string): boolean => cardsByName.has(name);

export const lookupQueryFunction = (name: string): FunctionCard | undefined =>
  cardsByName.get(name);

export interface QueryCallShape {
  readonly name: string;
  readonly context: ExpressionContext;
  readonly argumentCount: number;
}

export interface QueryCall {
  readonly name: string;
  readonly context: ExpressionContext;
  readonly args: readonly StdlibValue[];
}

export const validateQueryCall = (
  call: QueryCallShape,
): Result.Result<FunctionCard, StdlibFailure> => {
  const card = cardsByName.get(call.name);
  if (card === undefined) {
    return Result.fail(new UnknownQueryFunction({ name: call.name }));
  }

  const expected = card.signature.parameters.length;
  if (call.argumentCount !== expected) {
    return Result.fail(
      new QueryFunctionArity({
        name: card.name,
        expected,
        received: call.argumentCount,
      }),
    );
  }

  if (!card.contexts.includes(call.context)) {
    return Result.fail(
      new QueryFunctionContext({
        name: card.name,
        context: call.context,
        allowed: card.contexts,
      }),
    );
  }

  return Result.succeed(card);
};

export const checkQueryCallArguments = (
  card: FunctionCard,
  args: readonly StdlibValue[],
): Result.Result<void, StdlibFailure> => {
  const parameters = card.signature.parameters;
  if (args.length !== parameters.length) {
    return Result.fail(
      new QueryFunctionArity({
        name: card.name,
        expected: parameters.length,
        received: args.length,
      }),
    );
  }

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    const value = args[index];
    if (!matchesValueType(value, parameter.type)) {
      return Result.fail(
        new QueryFunctionArgumentType({
          name: card.name,
          index,
          parameter: parameter.name,
          expected: parameter.type,
          received: classify(value),
        }),
      );
    }
    const violation = domainViolation(value);
    if (violation !== undefined) {
      return Result.fail(
        new QueryFunctionArgumentDomain({
          name: card.name,
          index,
          parameter: parameter.name,
          violation,
        }),
      );
    }
  }

  return Result.succeed(undefined);
};

const sealResult = (card: FunctionCard, value: StdlibValue): StdlibValue =>
  matchesValueType(value, card.signature.result) ? value : null;

export const evaluateQueryCall = (
  call: QueryCall,
): Result.Result<StdlibValue, StdlibFailure> =>
  Result.gen(function* () {
    const card = yield* validateQueryCall({
      name: call.name,
      context: call.context,
      argumentCount: call.args.length,
    });
    yield* checkQueryCallArguments(card, call.args);

    if (card.nulls === "propagate" && call.args.some((arg) => arg === null)) {
      return null;
    }

    const implementation = implementationsByName.get(card.name);
    if (implementation === undefined) {
      return yield* Result.fail(new UnknownQueryFunction({ name: card.name }));
    }

    const produced = implementation(call.args);
    if (produced === OUTPUT_TOO_LARGE) {
      return yield* Result.fail(
        new QueryFunctionOutputSize({
          name: card.name,
          limit: card.outputLimit ?? MAX_PRODUCED_TEXT_UNITS,
        }),
      );
    }

    return sealResult(card, produced);
  });

export const stdlibIntegrityProblems = (): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const card of standardLibraryV1.functions) {
    if (seen.has(card.name)) problems.push(`duplicate manifest entry: ${card.name}`);
    seen.add(card.name);

    if (!implementationsByName.has(card.name)) {
      problems.push(`manifest entry without an implementation: ${card.name}`);
    }
    const segments = card.name.split(".");
    if (
      segments.length !== 2 ||
      segments[0] !== card.namespace ||
      segments[1].length === 0
    ) {
      problems.push(`name is not a namespaced public name: ${card.name}`);
    }
    if (card.contexts.length === 0) {
      problems.push(`no admitted context: ${card.name}`);
    }
    if (card.examples.length === 0) {
      problems.push(`no example: ${card.name}`);
    }
    if (card.outputLimit !== undefined) {
      if (card.signature.result !== "text") {
        problems.push(`output limit on a non-text result: ${card.name}`);
      }
      if (card.outputLimit !== MAX_PRODUCED_TEXT_UNITS) {
        problems.push(`output limit is not the declared cap: ${card.name}`);
      }
    }
    const nests = card.signature.parameters.some((parameter) =>
      NESTING_PARAMETER_TYPES.has(parameter.type),
    );
    if (nests && card.cost === "constant") {
      problems.push(`constant cost with a nestable parameter: ${card.name}`);
    }
    if (card.contexts.includes("orderBy") && !ORDERABLE_RESULTS.has(card.signature.result)) {
      problems.push(`unorderable result admitted in orderBy: ${card.name}`);
    }
  }

  for (const name of implementationsByName.keys()) {
    if (!seen.has(name)) {
      problems.push(`implementation without a manifest entry: ${name}`);
    }
  }

  return problems;
};
