/**
 * App-path DbError → the same allowlisted public vocabulary as the peer.
 */

import { describe, expect, test } from "bun:test";
import {
  DatabaseNotFound,
  fromResponse,
  InternalError,
  InvalidRequest,
  NetworkError,
  OperationRejected,
  QueryBudgetExceeded,
  TxRejected,
  Unauthorized,
  Unavailable,
} from "../src/db/Errors.ts";
import { errorResponse, errorToHttp, statusOf, toDbError } from "../src/errorHttp.ts";
import { Unauthorized as WorkerUnauthorized } from "../src/worker/errors.ts";

describe("errorToHttp", () => {
  test("every DbError tag has a status", () => {
    expect(statusOf(new TxRejected({ message: "m", code: "tx/invalid" }))).toBe(409);
    expect(statusOf(new Unavailable({ message: "m", retryAfterMs: 1500 }))).toBe(503);
    expect(statusOf(new InvalidRequest({ message: "m" }))).toBe(400);
    expect(statusOf(new DatabaseNotFound({ message: "m" }))).toBe(404);
    expect(statusOf(new Unauthorized({ message: "m" }))).toBe(401);
    expect(statusOf(new Unauthorized({ message: "denied", code: "policy" }))).toBe(403);
    expect(
      statusOf(
        new QueryBudgetExceeded({
          message: "m",
          code: "query/budget-exceeded",
          clause: "c",
          cells: 2,
          limit: 1,
        }),
      ),
    ).toBe(413);
    expect(statusOf(new InternalError({ message: "m" }))).toBe(500);
    expect(statusOf(new NetworkError({ message: "m" }))).toBe(500);
    expect(statusOf(new OperationRejected({ message: "m", operation: "x" }))).toBe(409);
  });

  test("Unavailable carries retry-after", () => {
    const http = errorToHttp(new Unavailable({ message: "restarting", retryAfterMs: 1500 }));
    expect(http.headers?.["retry-after"]).toBe("2");
    expect(http.body).toEqual({ error: "unavailable" });
  });

  test("errorResponse is JSON with the mapped status", async () => {
    const r = errorResponse(new TxRejected({ message: "bad", code: "tx/invalid" }));
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect((await r.json()) as Record<string, unknown>).toEqual({
      error: "request rejected",
    });
  });

  test("403 non-policy, 403 policy, and 401 keep their status through errorToHttp", () => {
    const forbidden = fromResponse(403, { error: "admin only", code: "admin" }) as Unauthorized;
    expect(forbidden.status).toBe(403);
    expect(errorToHttp(forbidden).status).toBe(403);

    const policy = fromResponse(403, {
      error: "denied",
      code: "policy",
      attr: ":doc/owner",
    }) as Unauthorized;
    expect(policy.status).toBe(403);
    expect(errorToHttp(policy).status).toBe(403);

    const unauth = fromResponse(401, { error: "unauthorized" }) as Unauthorized;
    expect(unauth.status).toBe(401);
    expect(errorToHttp(unauth).status).toBe(401);
    expect(errorToHttp(policy).body).toEqual({ error: "unauthorized" });
  });

  test("toDbError keeps a tagged error and wraps anything else", () => {
    const denied = new Unauthorized({ message: "nope", code: "policy" });
    expect(toDbError(denied)).toBe(denied);
    expect(toDbError(new Error("boom"))).toBeInstanceOf(InternalError);
  });
});

describe("shared error classes", () => {
  test("worker Unauthorized is the ramose/db class", () => {
    expect(WorkerUnauthorized).toBe(Unauthorized);
    const e = new WorkerUnauthorized({ message: "x", status: 403, code: "policy" });
    expect(e).toBeInstanceOf(Unauthorized);
    expect(e._tag).toBe("Unauthorized");
  });
});
