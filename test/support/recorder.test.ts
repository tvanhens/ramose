import { describe, expect, test } from "bun:test";
import { recordingFetch, recordingTransport } from "./recorder.ts";

describe("recording fetch", () => {
  test("forwards to the inner implementation and records the exchange", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        return new Response(JSON.stringify({ echo: body, path: new URL(req.url).pathname }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const rec = recordingFetch();
      const res = await rec.fetch(`${server.url}hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      });
      expect(res.status).toBe(201);
      const echoed = (await res.json()) as { echo: string; path: string };
      expect(echoed).toEqual({ echo: '{"n":1}', path: "/hello" });
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.method).toBe("POST");
      expect(rec.calls[0]?.status).toBe(201);
      expect(rec.calls[0]?.body).toEqual({ n: 1 });
      expect(rec.calls[0]?.url).toContain("/hello");
    } finally {
      server.stop(true);
    }
  });

  test("does not invent a response when the inner implementation fails", async () => {
    const rec = recordingTransport({
      fetch: (async () => {
        throw new Error("upstream down");
      }) as unknown as typeof fetch,
    });
    await expect(rec.fetch("https://peer.example/health")).rejects.toThrow("upstream down");
    expect(rec.calls).toEqual([]);
  });
});
