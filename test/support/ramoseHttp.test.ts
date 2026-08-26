/**
 * Ops HTTP harness: transient Cloudflare platform errors retry within the
 * `retryTransientMs` budget; application errors propagate immediately; and
 * the workers.dev HTML placeholder never lands verbatim in a test reporter.
 */
import { describe, expect, test } from "bun:test";
import {
  HttpError,
  isTransientCf,
  Peer,
} from "./ramoseHttp.ts";

const html404 = `<!DOCTYPE html><html><head><title>Page not found</title></head>
<body><h1>There is nothing here yet</h1>${"<svg></svg>".repeat(200)}</body></html>`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Peer — Cloudflare platform retries", () => {
  test("retries workers.dev HTML 404 within the budget, then succeeds", async () => {
    let n = 0;
    const connectionHeaders: (string | undefined)[] = [];
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        n++;
        connectionHeaders.push((init?.headers as Record<string, string>)?.connection);
        if (n < 3) return new Response(html404, { status: 404 });
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(3);
    // first attempt pools; retries evict the suspect socket
    expect(connectionHeaders).toEqual([undefined, "close", "close"]);
  });

  test("retries Durable Object storage timeout reset then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) {
          return json(500, {
            error:
              "Durable Object storage operation exceeded timeout which caused object to be reset.",
          });
        }
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("retries error 1104 then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) return new Response("error code: 1104", { status: 500 });
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("retries Worker not found JSON 500 then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) {
          return json(500, { error: "Worker not found.", stack: "Error: Worker not found." });
        }
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("retries 'Handler does not export a fetch()' 500 then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) {
          return json(500, { error: "Handler does not export a fetch() function." });
        }
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("gives up when the budget is exhausted", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 400,
      fetch: (async () => {
        n++;
        return new Response(html404, { status: 404 });
      }) as unknown as typeof fetch,
    });
    await expect(peer.health()).rejects.toBeInstanceOf(HttpError);
    expect(n).toBeGreaterThan(1); // it did retry
  });

  test("retries replica 503 no root yet then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) return json(503, { error: "database has no root yet" });
        return json(200, { db: "x", t: 1, principal: { eid: null, class: "admin" } });
      }) as unknown as typeof fetch,
    });
    expect((await peer.db("x").info()).t).toBe(1);
    expect(n).toBe(2);
  });

  test("retries empty HTTP 502 then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) return new Response("", { status: 502 });
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("retries non-JSON gateway 502 then succeeds", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        if (n === 1) return new Response("Bad Gateway", { status: 502 });
        return json(200, { ok: true, stage: "e2e" });
      }) as unknown as typeof fetch,
    });
    expect((await peer.health()).ok).toBe(true);
    expect(n).toBe(2);
  });

  test("does not retry an application NetworkError 502", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        return json(502, { error: "upstream reset", tag: "NetworkError" });
      }) as unknown as typeof fetch,
    });
    try {
      await peer.health();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(502);
      expect((e as HttpError).tag).toBe("NetworkError");
      expect((e as HttpError).message).toBe("upstream reset");
    }
    expect(n).toBe(1);
  });

  test("does not retry an application 409", async () => {
    let n = 0;
    const peer = new Peer("https://example.workers.dev", {
      retryTransientMs: 10_000,
      fetch: (async () => {
        n++;
        return json(409, { error: "unique conflict", code: "tx/unique-conflict" });
      }) as unknown as typeof fetch,
    });
    try {
      await peer.db("x").transact([{ ":user/name": "a" }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(409);
      expect((e as HttpError).code).toBe("tx/unique-conflict");
    }
    expect(n).toBe(1);
  });

  test("truncates workers.dev HTML so the reporter stays readable", async () => {
    const peer = new Peer("https://example.workers.dev", {
      fetch: (async () => new Response(html404, { status: 404 })) as unknown as typeof fetch,
    });
    try {
      await peer.health();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const err = e as HttpError;
      expect(err.status).toBe(404);
      expect(err.message.length).toBeLessThan(120);
      expect(err.message).toContain("workers.dev edge");
      expect(isTransientCf(err)).toBe(true);
    }
  });
});

/**
 * M7 on PR #218 called the envelope method then `toBeGreaterThan(0)`.
 * `queryEnvelope` is the HTTP envelope; `q` unwraps the find scalar.
 */
const FIND_COUNT = `[:find (count ?e) . :where [?e :user/email]]`;

describe("PeerDb EDN query shapes", () => {
  test("queryEnvelope is the envelope; q is the find scalar", async () => {
    const peer = new Peer("http://peer.test", {
      fetch: (async () =>
        new Response(JSON.stringify({ t: 42, root: 7, result: 67 }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ramose-ms": "3" },
        })) as unknown as typeof fetch,
    });
    const db = peer.db("e2e");

    const envelope = await db.queryEnvelope<number>(FIND_COUNT);
    expect(envelope).toMatchObject({ t: 42, root: 7, result: 67 });
    expect(typeof envelope).toBe("object");
    expect(typeof envelope.result).toBe("number");

    const scalar = await db.q<number>(FIND_COUNT);
    expect(scalar).toBe(67);
    expect(scalar).toBeGreaterThan(0);
  });

  test("queryEnvelope forwards x-ramose-min-t when fenced", async () => {
    let seen: string | undefined;
    const peer = new Peer("http://peer.test", {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seen = headers?.["x-ramose-min-t"];
        return new Response(JSON.stringify({ t: 71, root: 7, result: 67 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const db = peer.db("e2e");
    const envelope = await db.queryEnvelope<number>(FIND_COUNT, [], { minT: 71 });
    expect(seen).toBe("71");
    expect(envelope.t).toBe(71);
  });
});
