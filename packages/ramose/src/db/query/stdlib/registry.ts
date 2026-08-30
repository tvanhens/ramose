/**
 * The public v1 expression registry (#507).
 *
 * This registry is an explicit allowlist over the manifest in
 * `./manifest.ts`. It is deliberately *not* the internal engine registry:
 * only names published in the manifest resolve, lookups go through a `Map`
 * built from own entries (so `constructor`, `__proto__` and other inherited
 * keys resolve to nothing), and nothing it returns names, describes, or
 * exposes an engine symbol or an implementation reference.
 *
 * Validation is layered so a compiler can reject as much as possible before
 * any row is touched:
 *
 * 1. {@link validateQueryCall} — static: allowlist, arity, context.
 * 2. {@link checkQueryCallArguments} — per-value: declared argument types.
 * 3. {@link evaluateQueryCall} — both, then a total pure evaluation.
 *
 * Evaluation itself never fails: an undefined case is `null`. The only
 * failures are the four structured, value-sealed ones in `./failures.ts`.
 */

import * as Result from "effect/Result";
import {
  QueryFunctionArgumentType,
  QueryFunctionArity,
  QueryFunctionContext,
  UnknownQueryFunction,
  type StdlibFailure,
} from "./failures.ts";
import { standardLibraryImplementationsV1 } from "./implementations.ts";
import { standardLibraryManifestV1 } from "./manifest.ts";
import type {
  ExpressionContext,
  FunctionCard,
  StdlibManifest,
  StdlibValue,
} from "./types.ts";
import { classify, matchesValueType } from "./values.ts";

/** The versioned manifest, re-exported as the registry's source of truth. */
export const standardLibraryV1: StdlibManifest = standardLibraryManifestV1;

/**
 * Own-entry lookup tables. Built from `Object.entries` / the manifest array,
 * never by property access on an object literal, so no inherited member of
 * `Object.prototype` is reachable as a "function".
 */
const cardsByName: ReadonlyMap<string, FunctionCard> = new Map(
  standardLibraryV1.functions.map((card) => [card.name, card] as const),
);

const implementationsByName = new Map(
  Object.entries(standardLibraryImplementationsV1),
);

/** Every public name, sorted. Stable across releases; additive only. */
export const queryFunctionNames = (): readonly string[] =>
  [...cardsByName.keys()].sort();

/** Is this exact public name allowlisted? Anything else is unknown. */
export const isQueryFunctionName = (name: string): boolean => cardsByName.has(name);

/**
 * The card for a public name, or `undefined`.
 *
 * A card is plain JSON and carries no implementation reference, so handing
 * one to a caller cannot leak engine internals.
 */
export const lookupQueryFunction = (name: string): FunctionCard | undefined =>
  cardsByName.get(name);

/** A call as a compiler presents it, before any argument has been evaluated. */
export interface QueryCallShape {
  readonly name: string;
  readonly context: ExpressionContext;
  readonly argumentCount: number;
}

/** A call with its evaluated argument values. */
export interface QueryCall {
  readonly name: string;
  readonly context: ExpressionContext;
  readonly args: readonly StdlibValue[];
}

/**
 * Static validation: allowlist membership, arity, and expression context.
 * Everything checkable without a row is checked here.
 */
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

/**
 * Per-value validation against the declared parameter types. `null` satisfies
 * every declared type; what a function does with it is its declared null
 * behaviour, not a type error.
 */
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
  }

  return Result.succeed(undefined);
};

/**
 * Constrain a result to its declared type. In practice this only fires for
 * arithmetic that overflowed to a non-finite number or an instant that left
 * the representable range; either way the answer is absence, never a
 * poisoned `Infinity` or an out-of-range instant leaking into a result set.
 */
const sealResult = (card: FunctionCard, value: StdlibValue): StdlibValue =>
  matchesValueType(value, card.signature.result) ? value : null;

/**
 * Validate and evaluate one call. Pure and total: identical inputs always
 * produce an identical result, because nothing here reads a clock, a random
 * source, the environment, or any state outside `args`.
 */
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
      // Unreachable while the integrity check passes; failing closed as
      // "unknown" keeps the gap from ever becoming an execution path.
      return yield* Result.fail(new UnknownQueryFunction({ name: card.name }));
    }

    return sealResult(card, implementation(call.args));
  });

/**
 * Manifest/implementation integrity, as a list of human-readable problems.
 * An empty list is the invariant; tests assert it.
 *
 * This is a check, not a repair: it never mutates the manifest, and it is
 * exported so the correspondence is proven rather than assumed.
 */
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
  }

  for (const name of implementationsByName.keys()) {
    if (!seen.has(name)) {
      problems.push(`implementation without a manifest entry: ${name}`);
    }
  }

  return problems;
};
