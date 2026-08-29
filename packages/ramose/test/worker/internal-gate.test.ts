import { describe, expect, test } from "bun:test";
import {
  INTERNAL_HEADER,
  internalGate,
  internalHeaders,
  isInternal,
} from "../../src/internal/transactor/internal.ts";

describe("Worker-to-DO capability", () => {
  test("a missing binding fails closed", async () => {
    const env = { RAMOSE_INTERNAL_SECRET: undefined } as never;
    const request = new Request("https://transactor/info");
    expect(internalHeaders(env)).toEqual({});
    expect(isInternal(env, request)).toBe(false);
    const refusal = internalGate(env, request);
    if (refusal === undefined) throw new Error("missing internal refusal");
    expect(refusal.status).toBe(404);
    expect(JSON.stringify(await refusal.json())).toBe('{"error":"not found"}');
  });

  test("only the exact deployment capability opens the internal route", () => {
    const env = { RAMOSE_INTERNAL_SECRET: "deployment-owned-capability" };
    expect(isInternal(env, new Request("https://transactor/info"))).toBe(false);
    expect(isInternal(env, new Request("https://transactor/info", {
      headers: { [INTERNAL_HEADER]: "caller-controlled" },
    }))).toBe(false);
    const request = new Request("https://transactor/info", {
      headers: internalHeaders(env),
    });
    expect(isInternal(env, request)).toBe(true);
    expect(internalGate(env, request)).toBeUndefined();
  });
});
