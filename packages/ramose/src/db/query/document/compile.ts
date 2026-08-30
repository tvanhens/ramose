/**
 * The public door: one document in, one compiled query out.
 *
 * `compileQueryDocument` is a pure, total function of its inputs — the
 * document, the catalog it resolves names through, the function registry
 * that owns `{ call }`, and the budget. No clock, no randomness, no
 * environment, no ambient lookup; the same four inputs always produce the
 * same normalized document, the same plan, the same result shape, the same
 * complexity, and the same failure.
 *
 * Failure is a value, not a throw: `Result.fail` carrying a
 * {@link QueryDocumentInvalid} whose issues keep "your document is
 * malformed" and "no such definition (or none you can see)" apart without
 * ever telling the caller which of those two the latter was.
 */

import * as Data from "effect/Data";
import * as Result from "effect/Result";
import type { AnyComposer } from "../../Composer.ts";
import type { AnyQueryObject } from "../query.ts";
import type { QueryCatalogV1 } from "./catalog.ts";
import { LoweringFailure, lowerResolvedDocument } from "./lower.ts";
import type { FunctionRegistryV1 } from "./registry.ts";
import { resultShapeOf } from "./result-shape.ts";
import { serializeQueryDocument } from "./serialize.ts";
import {
  DEFAULT_QUERY_LIMITS,
  type NormalizedQueryDocumentV1,
  type QueryComplexityV1,
  type QueryDocumentIssueV1,
  type QueryLimitsV1,
  type QueryResultShapeV1,
} from "./types.ts";
import {
  issueOf,
  validateQueryDocumentUnsafe,
  type FieldStepV1,
  type ResolvedQueryDocumentV1,
} from "./validate.ts";

/** Why a document did not compile. Always at least one issue. */
export class QueryDocumentInvalid extends Data.TaggedError("QueryDocumentInvalid")<{
  readonly issues: readonly QueryDocumentIssueV1[];
}> {
  override get message(): string {
    const first = this.issues[0]!;
    const at = first.path.length === 0 ? "" : ` at ${first.path.join(".")}`;
    return `ramose/query: ${first.message}${at}`;
  }
}

export interface CompileQueryDocumentOptions {
  readonly catalog: QueryCatalogV1;
  readonly registry: FunctionRegistryV1;
  readonly limits?: QueryLimitsV1;
}

export interface CompiledQueryDocumentV1 {
  /** The canonical form of what the caller sent. */
  readonly document: NormalizedQueryDocumentV1;
  /** Its stable text — a cache key, a live-query identity, a fixture. */
  readonly serialized: string;
  /** The authoritative query value: the same `QueryObject` the fluent
   * builder produces, runnable by `db.query` and lowerable to the wire. */
  readonly query: AnyQueryObject;
  readonly resultShape: QueryResultShapeV1;
  readonly complexity: QueryComplexityV1;
  readonly limits: QueryLimitsV1;
}

/**
 * Validate, normalize, price, and lower one document.
 *
 * Budgets are charged before anything is lowered, and the accounting walks
 * every nested projection and expression, so nesting cannot smuggle work
 * past the bound.
 */
export const compileQueryDocument = (
  input: unknown,
  options: CompileQueryDocumentOptions,
): Result.Result<CompiledQueryDocumentV1, QueryDocumentInvalid> => {
  const limits = options.limits ?? DEFAULT_QUERY_LIMITS;
  let validated;
  try {
    validated = validateQueryDocumentUnsafe(input, { ...options, limits });
  } catch (error) {
    const issue = issueOf(error);
    if (issue === undefined) throw error;
    return Result.fail(new QueryDocumentInvalid({ issues: [issue] }));
  }
  const { resolved } = validated;
  const targetOf = (owner: AnyComposer, step: FieldStepV1): AnyComposer | undefined =>
    options.catalog.target(owner, step.field);
  const describe = (owner: AnyComposer, key: string): FieldStepV1 | undefined => {
    const field = options.catalog.field(owner, key);
    return field === undefined ? undefined : { owner, field };
  };
  let query: AnyQueryObject;
  try {
    query = lowerResolvedDocument(resolved, targetOf);
  } catch (error) {
    return Result.fail(
      new QueryDocumentInvalid({
        issues: [
          {
            code: "malformed",
            path: error instanceof LoweringFailure && error.reason === "cursor" ? ["page", "after"] : [],
            message:
              error instanceof LoweringFailure && error.reason === "cursor"
                ? "this cursor does not continue this query"
                : "this document does not compile against the current schema",
          },
        ],
      }),
    );
  }
  return Result.succeed({
    document: validated.document,
    serialized: serializeQueryDocument(validated.document),
    query,
    resultShape: resultShapeOf(resolved, targetOf, describe),
    complexity: validated.complexity,
    limits,
  });
};

/**
 * Normalize and price a document without lowering it — what a validating
 * front door (or a capability card) needs when it is not about to execute.
 */
export const validateQueryDocument = (
  input: unknown,
  options: CompileQueryDocumentOptions,
): Result.Result<
  {
    readonly document: NormalizedQueryDocumentV1;
    readonly serialized: string;
    readonly complexity: QueryComplexityV1;
    readonly resolved: ResolvedQueryDocumentV1;
  },
  QueryDocumentInvalid
> => {
  const limits = options.limits ?? DEFAULT_QUERY_LIMITS;
  try {
    const validated = validateQueryDocumentUnsafe(input, { ...options, limits });
    return Result.succeed({
      document: validated.document,
      serialized: serializeQueryDocument(validated.document),
      complexity: validated.complexity,
      resolved: validated.resolved,
    });
  } catch (error) {
    const issue = issueOf(error);
    if (issue === undefined) throw error;
    return Result.fail(new QueryDocumentInvalid({ issues: [issue] }));
  }
};
