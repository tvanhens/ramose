import * as Data from "effect/Data";
import { QueryBudgetError } from "../core/index.ts";

export class QueryBudget extends Data.TaggedError("QueryBudget")<{ message: string; code: string; clause: string; cells: number; limit: number; spentBy?: "caller" }> {}
export class BadRequest extends Data.TaggedError("BadRequest")<{ message: string }> {}
export class Internal extends Data.TaggedError("Internal")<{ message: string }> {}

export type ReplicaHttpError = QueryBudget | BadRequest | Internal;

const CLIENT_ERROR = /unknown attribute|not bound|insufficient|parse|EDN|QueryError/i;

export function toReplicaError(err: unknown): ReplicaHttpError {
  if (err instanceof QueryBudget || err instanceof BadRequest || err instanceof Internal) return err;
  if (err instanceof QueryBudgetError) return new QueryBudget({ message: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit, spentBy: err.spentBy });
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
    body.spentBy = e.spentBy ?? "caller";
  }
  return new Response(JSON.stringify(body), { status: statusOf(e), headers: { "content-type": "application/json" } });
}
