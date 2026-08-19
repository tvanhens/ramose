/**
 * Tagged errors + HTTP mapping for the QueryReplica's request boundary.
 *
 * Same contract as before the refactor: the query budget guard answers 413
 * with { error, code, clause, cells, limit }, client-shaped query errors
 * answer 400, everything else 500. A stable `tag` is added alongside.
 */

import * as Data from "effect/Data";
import { QueryBudgetError } from "../core/index.ts";

/** Intermediate relation would blow the memory budget → 413. */
export class QueryBudget extends Data.TaggedError("QueryBudget")<{ message: string; code: string; clause: string; cells: number; limit: number }> {}
/** Malformed query / unknown attribute / unbound variable → 400. */
export class BadRequest extends Data.TaggedError("BadRequest")<{ message: string }> {}
/** Anything else → 500. */
export class Internal extends Data.TaggedError("Internal")<{ message: string }> {}

export type ReplicaHttpError = QueryBudget | BadRequest | Internal;

/** The client-error shape the Worker also applies, so forwarded reads keep their status codes. */
const CLIENT_ERROR = /unknown attribute|not bound|insufficient|parse|EDN|QueryError/i;

export function toReplicaError(err: unknown): ReplicaHttpError {
  if (err instanceof QueryBudget || err instanceof BadRequest || err instanceof Internal) return err;
  if (err instanceof QueryBudgetError) return new QueryBudget({ message: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit });
  const message = err instanceof Error ? err.message : String(err);
  return CLIENT_ERROR.test(message) ? new BadRequest({ message }) : new Internal({ message });
}

export const statusOf = (e: ReplicaHttpError): number => (e._tag === "QueryBudget" ? 413 : e._tag === "BadRequest" ? 400 : 500);

export function replicaErrorResponse(e: ReplicaHttpError): Response {
  const body: Record<string, unknown> = { error: e.message, tag: e._tag, message: e.message };
  if (e._tag === "QueryBudget") {
    body.code = e.code;
    body.clause = e.clause;
    body.cells = e.cells;
    body.limit = e.limit;
  }
  return new Response(JSON.stringify(body), { status: statusOf(e), headers: { "content-type": "application/json" } });
}
