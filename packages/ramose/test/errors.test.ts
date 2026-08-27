/**
 * Error classification: every status / `tag` combination the peer Worker, the
 * Transactor and the QueryReplica can produce must land on exactly one tagged
 * failure — that is the whole point of the capability's error channel.
 */

import { describe, expect, test } from "bun:test";
import {
  InvalidRequest,
  fromResponse,
  InternalError,
  isDatabaseError,
  NetworkError,
  DatabaseNotFound,
  QueryBudgetExceeded,
  Unavailable,
  TxRejected,
  Unauthorized,
  OperationRejected,
} from "../src/db/Errors.ts";
import {
  IncompatibleSchema,
  isDatabaseError as isDatabaseErrorFromBarrel,
} from "../src/db/index.ts";

const headers = (h: Record<string, string> = {}) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe("fromResponse — the peer's own errors (no tag)", () => {
  test("400 → InvalidRequest, message from `error`", () => {
    const e = fromResponse(400, { error: "invalid database name" });
    expect(e._tag).toBe("InvalidRequest");
    expect(e.message).toBe("invalid database name");
  });

  test("401 and 403 → Unauthorized", () => {
    expect(fromResponse(401, { error: "unauthorized" })._tag).toBe(
      "Unauthorized",
    );
    expect(fromResponse(403, {})._tag).toBe("Unauthorized");
  });

  test("404 → DatabaseNotFound", () => {
    expect(fromResponse(404, { error: "not found" })._tag).toBe("DatabaseNotFound");
  });

  test("404 HTML (workers.dev edge) → Unavailable, not DatabaseNotFound", () => {
    const e = fromResponse(404, {
      error: "<!DOCTYPE html><title>Page not found</title>",
    });
    expect(e._tag).toBe("Unavailable");
  });

  test("500 error code 1104 → Unavailable (fresh workers.dev)", () => {
    const e = fromResponse(500, { error: "error code: 1104" });
    expect(e._tag).toBe("Unavailable");
  });

  test("500 Worker not found → Unavailable (DO namespace not bound yet)", () => {
    const e = fromResponse(500, { error: "Worker not found." });
    expect(e._tag).toBe("Unavailable");
  });

  test("500 'Handler does not export a fetch()' → Unavailable (deploy not converged)", () => {
    const e = fromResponse(500, {
      error: "Handler does not export a fetch() function.",
    });
    expect(e._tag).toBe("Unavailable");
  });

  test("413 → QueryBudgetExceeded with the guard's fields", () => {
    const e = fromResponse(413, {
      error: "query budget exceeded",
      code: "query/budget-exceeded",
      clause: "[?e :user/name ?n]",
      cells: 1_000_001,
      limit: 1_000_000,
    }) as QueryBudgetExceeded;
    expect(e._tag).toBe("QueryBudgetExceeded");
    expect(e.code).toBe("query/budget-exceeded");
    expect(e.clause).toBe("[?e :user/name ?n]");
    expect(e.cells).toBe(1_000_001);
    expect(e.limit).toBe(1_000_000);
    expect(e.spentBy).toBeUndefined();
  });

  test("413 carries spentBy when the server attributed the budget", () => {
    const e = fromResponse(413, {
      error: "query budget exceeded",
      code: "query/budget-exceeded",
      clause: "[?e :doc/title ?t]",
      cells: 9,
      limit: 8,
      spentBy: "caller",
    }) as QueryBudgetExceeded;
    expect(e.spentBy).toBe("caller");
  });

  test("500 → InternalError", () => {
    expect(fromResponse(500, { error: "boom" })._tag).toBe("InternalError");
  });

  test("an unmapped status falls back to InternalError", () => {
    expect(fromResponse(418, { error: "teapot" })._tag).toBe("InternalError");
  });

  test("a body with no `error` keeps a useful message", () => {
    expect(fromResponse(500, null).message).toBe("HTTP 500");
    expect(fromResponse(500, "not json at all").message).toBe("HTTP 500");
  });
});

describe("fromResponse — DO errors passed through (tagged)", () => {
  test("409 OperationRejected keeps operation / reason", () => {
    const e = fromResponse(409, {
      error: "OperationRejected",
      tag: "OperationRejected",
      message: "entity 1 does not exist",
      operation: "issue/close",
      reason: "dangling",
    }) as OperationRejected;
    expect(e._tag).toBe("OperationRejected");
    expect(e.operation).toBe("issue/close");
    expect(e.name).toBe("OperationRejected");
    expect(e.reason).toBe("dangling");
    expect(e.message).toBe("entity 1 does not exist");
  });

  test("409 OperationRejected still reads a legacy `name` body field", () => {
    const e = fromResponse(409, {
      error: "OperationRejected",
      tag: "OperationRejected",
      name: "issue/close",
    }) as OperationRejected;
    expect(e.operation).toBe("issue/close");
  });

  test("409 TxRejected keeps the TxError code", () => {
    const e = fromResponse(409, {
      error: ":user/email is unique and already asserted",
      tag: "TxRejected",
      message: ":user/email is unique and already asserted",
      code: "tx/unique-conflict",
    }) as TxRejected;
    expect(e._tag).toBe("TxRejected");
    expect(e.code).toBe("tx/unique-conflict");
    expect(e.message).toBe(":user/email is unique and already asserted");
  });

  test("503 Unavailable keeps retryAfterMs", () => {
    const e = fromResponse(
      503,
      { error: "transactor aborted: oom", tag: "TransactorDead", retryAfterMs: 250 },
      headers({ "retry-after": "1" }),
    ) as Unavailable;
    expect(e._tag).toBe("Unavailable");
    expect(e.retryAfterMs).toBe(250);
  });

  test("503 Unavailable falls back to the retry-after header", () => {
    const e = fromResponse(
      503,
      { error: "transactor aborted", tag: "TransactorDead" },
      headers({ "retry-after": "2" }),
    ) as Unavailable;
    expect(e.retryAfterMs).toBe(2000);
  });

  test("the replica's 413 QueryBudget maps onto QueryBudgetExceeded", () => {
    const e = fromResponse(413, {
      error: "query budget exceeded",
      tag: "QueryBudget",
      code: "query/budget-exceeded",
      clause: "[?e ?a ?v]",
      cells: 5,
      limit: 4,
    }) as QueryBudgetExceeded;
    expect(e._tag).toBe("QueryBudgetExceeded");
    expect(e.cells).toBe(5);
  });

  test("the tag wins over the status code", () => {
    // A DO answered 500 but tagged the failure InvalidRequest: trust the tag.
    expect(fromResponse(500, { error: "x", tag: "BadRequest" })._tag).toBe(
      "InvalidRequest",
    );
    expect(fromResponse(200, { error: "x", tag: "NotFound" })._tag).toBe(
      "DatabaseNotFound",
    );
    expect(fromResponse(400, { error: "x", tag: "Internal" })._tag).toBe(
      "InternalError",
    );
  });

  test("an unknown tag falls through to the status", () => {
    expect(fromResponse(400, { error: "x", tag: "Martian" })._tag).toBe(
      "InvalidRequest",
    );
  });
});

describe("fromResponse — TxRejected attr", () => {
  test("409 TxRejected keeps a policy attr", () => {
    const e = fromResponse(409, {
      error: "set denied on :doc/owner",
      tag: "TxRejected",
      code: "policy",
      attr: ":doc/owner",
    }) as TxRejected;
    expect(e).toBeInstanceOf(TxRejected);
    expect(e.code).toBe("policy");
    expect(e.attr).toBe(":doc/owner");
  });
});

describe("isDatabaseError", () => {
  test("accepts every member of the union", () => {
    const all = [
      new TxRejected({ message: "", code: "" }),
      new Unavailable({ message: "", retryAfterMs: 0 }),
      new InvalidRequest({ message: "" }),
      new DatabaseNotFound({ message: "" }),
      new Unauthorized({ message: "" }),
      new QueryBudgetExceeded({ message: "", code: "", clause: "", cells: 0, limit: 0 }),
      new InternalError({ message: "" }),
      new NetworkError({ message: "" }),
      new OperationRejected({ message: "", operation: "x" }),
    ];
    for (const e of all) expect(isDatabaseError(e)).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isDatabaseError(new Error("nope"))).toBe(false);
    expect(isDatabaseError({ _tag: "SomethingElse" })).toBe(false);
    expect(isDatabaseError(null)).toBe(false);
    expect(isDatabaseError("TxRejected")).toBe(false);
  });

  test("isDatabaseError is on the ramose/db barrel", () => {
    expect(isDatabaseErrorFromBarrel).toBe(isDatabaseError);
  });

  test("IncompatibleSchema is on the barrel and is not a DbError", () => {
    const e = new IncompatibleSchema({
      message: "flip",
      changes: [{ ident: ":note/title", kind: "valueType" }],
    });
    expect(e._tag).toBe("IncompatibleSchema");
    expect(isDatabaseError(e)).toBe(false);
  });
});
