/**
 * Replica request-boundary error mapping. The 413 body is a documented part of
 * the read contract (the client's `QueryBudgetExceeded` and test/e2e assert on
 * it): the query budget guard must keep answering
 * { error, code, clause, cells, limit }.
 */
import { describe, expect, test } from "bun:test";
import { QueryBudgetError } from "../../../src/internal/core/index.ts";
import { BadRequest, Internal, QueryBudget, replicaErrorResponse, statusOf, toReplicaError } from "../../../src/internal/replica/errors.ts";

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("replica errors: classification", () => {
  test("QueryBudgetError → QueryBudget carrying clause/cells/limit", () => {
    const src = new QueryBudgetError("[?e :p/friend ?f]", 5_000_000, 1_000_000);
    const e = toReplicaError(src);
    expect(e._tag).toBe("QueryBudget");
    const q = e as QueryBudget;
    expect(q.code).toBe("query/budget-exceeded");
    expect(q.clause).toBe("[?e :p/friend ?f]");
    expect(q.cells).toBe(5_000_000);
    expect(q.limit).toBe(1_000_000);
    expect(q.spentBy).toBe("caller");
    expect(q.message).toBe(src.message);
  });

  test("client-shaped query errors → BadRequest, everything else → Internal", () => {
    for (const msg of ["unknown attribute :p/nope", "variable ?x is not bound", "insufficient bindings", "parse error near )", "bad EDN", "QueryError: nope"]) {
      expect(toReplicaError(new Error(msg))._tag).toBe("BadRequest");
    }
    expect(toReplicaError(new Error("R2 get failed"))._tag).toBe("Internal");
    expect(toReplicaError("kaboom")).toEqual(new Internal({ message: "kaboom" }));
    const tagged = new BadRequest({ message: "already tagged" });
    expect(toReplicaError(tagged)).toBe(tagged);
  });
});

describe("replica errors: tag → status/body", () => {
  test("statuses match the pre-Effect handler", () => {
    expect(statusOf(new QueryBudget({ message: "m", code: "c", clause: "x", cells: 2, limit: 1 }))).toBe(413);
    expect(statusOf(new BadRequest({ message: "m" }))).toBe(400);
    expect(statusOf(new Internal({ message: "m" }))).toBe(500);
  });

  test("QueryBudget → 413 with the exact fields the client reads", async () => {
    const r = replicaErrorResponse(toReplicaError(new QueryBudgetError("[?e :p/friend ?f]", 5_000_000, 1_000_000)));
    expect(r.status).toBe(413);
    expect(r.headers.get("content-type")).toBe("application/json");
    const b = await body(r);
    expect(b.code).toBe("query/budget-exceeded");
    expect(b.clause).toBe("[?e :p/friend ?f]");
    expect(b.cells).toBe(5_000_000);
    expect(b.limit).toBe(1_000_000);
    expect(b.spentBy).toBe("caller");
    expect(b.tag).toBe("QueryBudget");
    expect(String(b.error)).toMatch(/query aborted/);
    expect(b.message).toBe(b.error);
  });

  test("BadRequest → 400, Internal → 500, no budget fields leak in", async () => {
    const b400 = replicaErrorResponse(new BadRequest({ message: "unknown attribute :p/nope" }));
    expect(b400.status).toBe(400);
    expect(await body(b400)).toEqual({ error: "unknown attribute :p/nope", tag: "BadRequest", message: "unknown attribute :p/nope" });
    const b500 = replicaErrorResponse(new Internal({ message: "R2 get failed" }));
    expect(b500.status).toBe(500);
    expect(await body(b500)).toEqual({ error: "R2 get failed", tag: "Internal", message: "R2 get failed" });
  });
});
