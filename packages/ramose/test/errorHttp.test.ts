/**
 * App-path DbError → HTTP mapping. The peer Worker's `toHttp` is a separate
 * contract (worker-only tags, stacks); this helper is what a route imports.
 */

import { describe, expect, test } from "bun:test";
import {
  DatabaseNotFound,
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
    expect(statusOf(new NetworkError({ message: "m" }))).toBe(502);
    expect(statusOf(new OperationRejected({ message: "m", name: "x" }))).toBe(409);
  });

  test("Unavailable carries retry-after", () => {
    const http = errorToHttp(new Unavailable({ message: "restarting", retryAfterMs: 1500 }));
    expect(http.headers?.["retry-after"]).toBe("2");
    expect(http.body.retryAfterMs).toBe(1500);
  });

  test("errorResponse is JSON with the mapped status", async () => {
    const r = errorResponse(new TxRejected({ message: "bad", code: "tx/invalid" }));
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ error: "bad", tag: "TxRejected", code: "tx/invalid" });
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
