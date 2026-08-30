import { describe, expect, test } from "bun:test";
import {
  QueryBudgetError,
  QueryError,
  QueryParseError,
} from "../../src/internal/core/index.ts";
import { fromResponse, Unavailable } from "../../src/db/Errors.ts";
import * as Effect from "effect/Effect";
import { BadRequest, Internal, NotFound, OperationRejected, QueryBudgetExceeded, type RamoseError, Unauthorized, UpstreamError, fromThrown, isRamoseError, toHttp } from "../../src/worker/errors.ts";
import { respond } from "../../src/worker/handle.ts";
import { operationFailureFromResponse } from "../../src/worker/authorized-operation.ts";

describe("tagged failure → status/body", () => {
  test("NotFound → 404 { error }", () => {
    expect(toHttp(new NotFound({}))).toEqual({ status: 404, body: { error: "not found" } });
    expect(toHttp(new NotFound({ message: "secret route name" })).body).toEqual({ error: "not found" });
  });

  test("BadRequest → an opaque 400", () => {
    expect(toHttp(new BadRequest({ message: "invalid secret attribute" }))).toEqual({
      status: 400,
      body: { error: "invalid request" },
    });
    expect(toHttp(new BadRequest({ message: "boom", trace: "at x" })).body).toEqual({
      error: "invalid request",
    });
  });

  test("Unauthorized → 401 { error: unauthorized }", () => {
    expect(toHttp(new Unauthorized({}))).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  test("QueryBudgetExceeded → 413 without clause/count/limit diagnostics", () => {
    const err = fromThrown(new QueryBudgetError("[?e :p/friend ?f]", 900, 500));
    expect(err._tag).toBe("QueryBudgetExceeded");
    const http = toHttp(err);
    expect(http.status).toBe(413);
    expect(http.body?.code).toBe("query/budget-exceeded");
    expect(http.body).toEqual({
      error: "query budget exceeded",
      code: "query/budget-exceeded",
    });
  });

  test("Internal → an opaque 500", () => {
    expect(toHttp(new Internal({ message: "postgres://secret" }))).toEqual({
      status: 500,
      body: { error: "internal error" },
    });
  });

  test("OperationRejected → 409 { tag, operation, step?, reason? }", () => {
    expect(
      toHttp(new OperationRejected({ message: "gone", operation: "issue/close", reason: "dangling" })),
    ).toEqual({
      status: 409,
      body: {
        error: "gone",
        tag: "OperationRejected",
        message: "gone",
        operation: "issue/close",
        reason: "dangling",
      },
    });
  });

  test("UpstreamError preserves safe status semantics without DO detail", () => {
    const headers = { "content-type": "application/json", "x-ramose-ms": "3" };
    expect(toHttp(new UpstreamError({ status: 409, body: '{"error":"cas failed"}', headers }))).toEqual({
      status: 409,
      body: { error: "request rejected" },
    });
    expect(toHttp(new UpstreamError({ status: 400, body: '{"error":"secret attr"}' }))).toEqual({
      status: 400,
      body: { error: "invalid request" },
    });
  });

  test("Worker restatement adds public CORS to Transactor errors", async () => {
    const response = respond(new UpstreamError({
      status: 409,
      body: '{"error":"operation failed"}',
      headers: { "content-type": "application/json", "x-ramose-ms": "3" },
    }));
    expect(response.status).toBe(409);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("x-ramose-ms")).toBeNull();
    expect(await response.text()).toBe('{"error":"request rejected"}');
  });
});

describe("operation Transactor failure restatement", () => {
  test("preserves intentional OperationRejected and restates engine conflicts", async () => {
    const intentionalBody = JSON.stringify({
      error: "domain refused",
      tag: "OperationRejected",
      message: "domain refused",
      operation: "item/reject",
      reason: "intentional",
    });
    const intentional = respond(operationFailureFromResponse(
      new Response(intentionalBody, { status: 409 }),
      intentionalBody,
    ));
    expect(intentional.status).toBe(409);
    const intentionalJson = await intentional.json() as Record<string, unknown>;
    expect(intentionalJson).toEqual({
      error: "domain refused",
      tag: "OperationRejected",
      message: "domain refused",
      operation: "item/reject",
      reason: "intentional",
    });
    expect(fromResponse(
      intentional.status,
      intentionalJson,
      intentional.headers,
    )).toBeInstanceOf(OperationRejected);

    const engineBody = JSON.stringify({
      error: "unique conflict on row 42",
      tag: "TxRejected",
      code: "tx/unique-conflict",
    });
    const engine = respond(operationFailureFromResponse(
      new Response(engineBody, { status: 409 }),
      engineBody,
    ));
    expect(engine.status).toBe(409);
    expect(await engine.json() as Record<string, unknown>).toEqual({
      error: "request rejected",
    });
  });

  test("keeps retryable status and Retry-After while scrubbing private detail", async () => {
    const upstream = new Response(JSON.stringify({
      error: "durable storage recovery for database secret-db",
      tag: "TransactorDead",
    }), {
      status: 503,
      headers: { "retry-after": "2", "x-private-detail": "secret-db" },
    });
    const text = await upstream.text();
    const response = respond(operationFailureFromResponse(upstream, text));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-private-detail")).toBeNull();
    const responseJson = await response.json() as Record<string, unknown>;
    expect(responseJson).toEqual({
      error: "unavailable",
    });
    const clientError = fromResponse(response.status, responseJson, response.headers);
    expect(clientError).toBeInstanceOf(Unavailable);
    expect((clientError as Unavailable).retryAfterMs).toBe(2_000);
  });

  test("scrubs unexpected 5xx operation faults", async () => {
    const body = JSON.stringify({ error: "postgres://secret@internal/operation" });
    const response = respond(operationFailureFromResponse(
      new Response(body, { status: 500 }),
      body,
    ));
    expect(response.status).toBe(500);
    expect(await response.json() as Record<string, unknown>).toEqual({
      error: "internal error",
    });
  });
});

describe("fromThrown", () => {
  test("typed query failures preserve an opaque client-error status", () => {
    for (const error of [
      new QueryParseError("query is missing :find"),
      new QueryError("unknown attribute :hidden/value"),
    ]) {
      const classified = fromThrown(error, { stacks: true });
      expect(classified).toBeInstanceOf(BadRequest);
      expect(toHttp(classified)).toEqual({
        status: 400,
        body: { error: "invalid request" },
      });
    }
  });

  test("private message text never selects a public status", () => {
    for (const msg of ["unknown attribute :p/nope", "?x is not bound", "insufficient bindings", "EDN parse error", "QueryError: bad find"]) {
      expect(fromThrown(new Error(msg))._tag).toBe("Internal");
    }
    expect(fromThrown(new Error("R2 unavailable"))._tag).toBe("Internal");
    expect(fromThrown("string thrown")._tag).toBe("Internal");
    expect(toHttp(fromThrown("string thrown")).body?.error).toBe("internal error");
  });

  test("stacks never cross the public mapping", () => {
    expect(toHttp(fromThrown(new Error("EDN parse"), { stacks: true })).body).toEqual({
      error: "internal error",
    });
    expect(toHttp(fromThrown(new Error("nope"))).body).toEqual({
      error: "internal error",
    });
  });

  test("a tagged failure thrown inside a route body is passed through unchanged", () => {
    const thrown = new BadRequest({ message: "body must be { query, inputs? }" });
    expect(fromThrown(thrown)).toBe(thrown);
    expect(isRamoseError(thrown)).toBe(true);
    expect(isRamoseError(new Error("x"))).toBe(false);
  });
});

describe("Effect.catchTags dispatch", () => {
  const recover = {
    NotFound: (e: NotFound) => Effect.succeed(toHttp(e)),
    BadRequest: (e: BadRequest) => Effect.succeed(toHttp(e)),
    Unauthorized: (e: Unauthorized) => Effect.succeed(toHttp(e)),
    UpstreamError: (e: UpstreamError) => Effect.succeed(toHttp(e)),
    QueryBudgetExceeded: (e: QueryBudgetExceeded) => Effect.succeed(toHttp(e)),
    Internal: (e: Internal) => Effect.succeed(toHttp(e)),
    OperationRejected: (e: OperationRejected) => Effect.succeed(toHttp(e)),
  };
  const run = (e: RamoseError) => Effect.runPromise(Effect.fail(e).pipe(Effect.catchTags(recover)));

  test("every tag is handled and keeps its status", async () => {
    expect((await run(new NotFound({}))).status).toBe(404);
    expect((await run(new BadRequest({ message: "x" }))).status).toBe(400);
    expect((await run(new Unauthorized({}))).status).toBe(401);
    expect((await run(new UpstreamError({ status: 503, body: "down" }))).status).toBe(503);
    expect((await run(new QueryBudgetExceeded({ message: "m", code: "query/budget-exceeded", clause: "c", cells: 2, limit: 1 }))).status).toBe(413);
    expect((await run(new Internal({ message: "m" }))).status).toBe(500);
    expect((await run(new OperationRejected({ message: "m", operation: "x" }))).status).toBe(409);
  });
});
