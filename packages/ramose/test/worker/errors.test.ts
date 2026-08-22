/**
 * The Worker's HTTP boundary is one Effect per request whose failures are
 * tagged (src/errors.ts). These tests pin the tag → status/body mapping to
 * exactly what the Worker returned before it was an Effect (the client parses
 * `error`/`code`; the 413 body carries the budget fields), and check that
 * `Effect.catchTags` dispatches on those tags.
 *
 * index.ts itself cannot be imported here (it re-exports the DO classes, which
 * import `cloudflare:workers`), so the pure mapping is tested directly.
 */
import { describe, expect, test } from "bun:test";
import { PolicyBudgetError, QueryBudgetError } from "../../src/internal/core/index.ts";
import * as Effect from "effect/Effect";
import { BadRequest, Internal, NotFound, QueryBudgetExceeded, type RamoseError, Unauthorized, UpstreamError, fromThrown, isRamoseError, toHttp } from "../../src/worker/errors.ts";

describe("tagged failure → status/body", () => {
  test("NotFound → 404 { error }", () => {
    expect(toHttp(new NotFound({}))).toEqual({ status: 404, body: { error: "not found" } });
    expect(toHttp(new NotFound({ message: "no such route" })).body).toEqual({ error: "no such route" });
  });

  test("BadRequest → 400, stack only when carried", () => {
    expect(toHttp(new BadRequest({ message: "invalid database name" }))).toEqual({ status: 400, body: { error: "invalid database name", stack: undefined } });
    expect(toHttp(new BadRequest({ message: "boom", trace: "at x" })).body?.stack).toBe("at x");
  });

  test("Unauthorized → 401 { error: unauthorized }", () => {
    expect(toHttp(new Unauthorized({}))).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  test("QueryBudgetExceeded → 413 with code/clause/cells/limit", () => {
    const err = fromThrown(new QueryBudgetError("[?e :p/friend ?f]", 900, 500));
    expect(err._tag).toBe("QueryBudgetExceeded");
    const http = toHttp(err);
    expect(http.status).toBe(413);
    expect(http.body?.code).toBe("query/budget-exceeded");
    expect(http.body?.clause).toBe("[?e :p/friend ?f]");
    expect(http.body?.cells).toBe(900);
    expect(http.body?.limit).toBe(500);
    expect(String(http.body?.error)).toContain("query aborted");
  });

  test("PolicyBudgetError → 413 with policy/budget-exceeded", () => {
    const err = fromThrown(new PolicyBudgetError("policy/doc/owner", new QueryBudgetError("[?e :doc/owner ?me]", 900, 500)));
    expect(err._tag).toBe("QueryBudgetExceeded");
    const http = toHttp(err);
    expect(http.status).toBe(413);
    expect(http.body?.code).toBe("policy/budget-exceeded");
    expect(String(http.body?.clause)).toContain("policy/doc/owner");
  });

  test("Internal → 500 { error, stack? }", () => {
    expect(toHttp(new Internal({ message: "kaboom" }))).toEqual({ status: 500, body: { error: "kaboom", stack: undefined } });
  });

  test("UpstreamError passes the DO response through verbatim", () => {
    const headers = { "content-type": "application/json", "x-ramose-ms": "3" };
    expect(toHttp(new UpstreamError({ status: 409, body: '{"error":"cas failed"}', headers }))).toEqual({ status: 409, raw: '{"error":"cas failed"}', headers });
  });
});

describe("fromThrown", () => {
  test("client-fault messages → 400, everything else → 500 (same regex as before)", () => {
    for (const msg of ["unknown attribute :p/nope", "?x is not bound", "insufficient bindings", "EDN parse error", "QueryError: bad find"]) {
      expect(fromThrown(new Error(msg))._tag).toBe("BadRequest");
    }
    expect(fromThrown(new Error("R2 unavailable"))._tag).toBe("Internal");
    expect(fromThrown("string thrown")._tag).toBe("Internal");
    expect(toHttp(fromThrown("string thrown")).body?.error).toBe("string thrown");
  });

  test("stacks only when asked (off-prod), for both 400 and 500", () => {
    expect(toHttp(fromThrown(new Error("EDN parse"), { stacks: true })).body?.stack).toBeString();
    expect(toHttp(fromThrown(new Error("EDN parse"), { stacks: false })).body?.stack).toBeUndefined();
    expect(toHttp(fromThrown(new Error("nope"), { stacks: true })).body?.stack).toBeString();
    expect(toHttp(fromThrown(new Error("nope"))).body?.stack).toBeUndefined();
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
  };
  const run = (e: RamoseError) => Effect.runPromise(Effect.fail(e).pipe(Effect.catchTags(recover)));

  test("every tag is handled and keeps its status", async () => {
    expect((await run(new NotFound({}))).status).toBe(404);
    expect((await run(new BadRequest({ message: "x" }))).status).toBe(400);
    expect((await run(new Unauthorized({}))).status).toBe(401);
    expect((await run(new UpstreamError({ status: 503, body: "down" }))).status).toBe(503);
    expect((await run(new QueryBudgetExceeded({ message: "m", code: "query/budget-exceeded", clause: "c", cells: 2, limit: 1 }))).status).toBe(413);
    expect((await run(new Internal({ message: "m" }))).status).toBe(500);
  });
});
