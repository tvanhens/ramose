/**
 * Request-boundary error mapping (Effect tagged errors → HTTP).
 *
 * The wire contract is what the Worker parses on the client's behalf: `error`
 * (human message), `code`, and the `retry-after` header on 503. `tag` is on top as a
 * stable discriminator; statuses are unchanged from the pre-Effect handler.
 */
import { describe, expect, test } from "bun:test";
import { TxError } from "../../../src/internal/core/index.ts";
import {
  BadRequest,
  Internal,
  NotFound,
  TransactorDead,
  TransactorDeadError,
  TxRejected,
  errorResponse,
  statusOf,
  toHttpError,
} from "../../../src/internal/transactor/errors.ts";
import { Harness, attribute } from "./harness.ts";

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("transactor errors: classification", () => {
  test("core TxError → TxRejected (keeps code and message)", () => {
    const e = toHttpError(new TxError("unknown attribute :k/nope", "tx/unknown-attribute"));
    expect(e._tag).toBe("TxRejected");
    expect((e as TxRejected).code).toBe("tx/unknown-attribute");
    expect(e.message).toBe("unknown attribute :k/nope");
  });

  test("TransactorDeadError → TransactorDead with retryAfterMs", () => {
    const e = toHttpError(new TransactorDeadError("log write failed"));
    expect(e._tag).toBe("TransactorDead");
    expect((e as TransactorDead).retryAfterMs).toBe(0);
    expect(e.message).toBe("transactor aborted: log write failed");
  });

  test("already-tagged errors pass through; anything else is Internal", () => {
    const bad = new BadRequest({ message: "nope" });
    expect(toHttpError(bad)).toBe(bad);
    const nf = new NotFound({ message: "not found" });
    expect(toHttpError(nf)).toBe(nf);
    expect(toHttpError(new Error("boom"))._tag).toBe("Internal");
    expect(toHttpError("boom")).toEqual(new Internal({ message: "boom" }));
  });
});

describe("transactor errors: tag → status/body", () => {
  test("statuses match the pre-Effect handler", () => {
    expect(statusOf(new TxRejected({ message: "m", code: "c" }))).toBe(409);
    expect(statusOf(new TransactorDead({ message: "m", retryAfterMs: 0 }))).toBe(503);
    expect(statusOf(new BadRequest({ message: "m" }))).toBe(400);
    expect(statusOf(new NotFound({ message: "m" }))).toBe(404);
    expect(statusOf(new Internal({ message: "m" }))).toBe(500);
  });

  test("TxRejected → 409 { error, tag, message, code }", async () => {
    const r = errorResponse(new TxRejected({ message: "bad tx", code: "tx/invalid" }));
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await body(r)).toEqual({ error: "bad tx", tag: "TxRejected", message: "bad tx", code: "tx/invalid" });
  });

  test("TransactorDead → 503 with retry-after header and retryAfterMs", async () => {
    const r = errorResponse(new TransactorDead({ message: "aborted", retryAfterMs: 0 }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("0");
    expect(await body(r)).toEqual({ error: "aborted", tag: "TransactorDead", message: "aborted", retryAfterMs: 0 });
    // non-zero budgets round up to whole seconds for the header
    expect(errorResponse(new TransactorDead({ message: "x", retryAfterMs: 1500 })).headers.get("retry-after")).toBe("2");
  });

  test("BadRequest → 400, NotFound → 404, Internal → 500", async () => {
    const b = errorResponse(new BadRequest({ message: "body must be { tx: [...] }" }));
    expect(b.status).toBe(400);
    expect(await body(b)).toEqual({ error: "body must be { tx: [...] }", tag: "BadRequest", message: "body must be { tx: [...] }" });
    expect(errorResponse(new NotFound({ message: "not found" })).status).toBe(404);
    const i = errorResponse(new Internal({ message: "boom" }));
    expect(i.status).toBe(500);
    expect((await body(i)).error).toBe("boom");
  });
});

describe("transactor errors: handleRequest keeps the HTTP contract", () => {
  const SCHEMA = [attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" })];
  async function fresh() {
    const h = new Harness();
    await h.transactor.init();
    await h.transactor.transact(SCHEMA);
    return h;
  }
  const req = (path: string, init?: RequestInit) => new Request(`https://t${path}`, init);

  test("happy path is untouched", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(req("/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":k/id": 1 }] }) }));
    expect(r.status).toBe(200);
    expect((await body(r)).t).toBe(h.transactor.t);
  });

  test("malformed body → 400", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(req("/transact", { method: "POST", body: JSON.stringify({ nope: 1 }) }));
    expect(r.status).toBe(400);
    const b = await body(r);
    expect(b.error).toBe("body must be { tx: [...] }");
    expect(b.tag).toBe("BadRequest");
  });

  test("rejected tx → 409 with the core error code the client reads", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(req("/transact", { method: "POST", body: JSON.stringify({ tx: [[":db/add", 1, ":k/nope", 1]] }) }));
    expect(r.status).toBe(409);
    const b = await body(r);
    expect(b.tag).toBe("TxRejected");
    expect(typeof b.code).toBe("string");
    expect(String(b.error)).toMatch(/:k\/nope/);
  });

  test("unknown route → 404", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(req("/nope"));
    expect(r.status).toBe(404);
    expect((await body(r)).error).toBe("not found");
  });

  test("dead transactor → 503 + retry-after (storage fault aborts the instance)", async () => {
    const h = new Harness({ failWriteAt: 3 });
    await h.transactor.init();
    await h.transactor.transact(SCHEMA).catch(() => undefined);
    await h.transactor.transact([{ ":k/id": 1 }]).catch(() => undefined);
    expect(h.transactor.isDead).toBe(true);
    const r = await h.transactor.handleRequest(req("/transact", { method: "POST", body: JSON.stringify({ tx: [{ ":k/id": 2 }] }) }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("0");
    const b = await body(r);
    expect(b.tag).toBe("TransactorDead");
    expect(String(b.error)).toMatch(/transactor aborted/);
  });

  test("internal failures → 500 with the message", async () => {
    const h = await fresh();
    const r = await h.transactor.handleRequest(req("/transact", { method: "POST", body: "{not json" }));
    expect(r.status).toBe(500);
    expect((await body(r)).tag).toBe("Internal");
  });
});
