import { describe, expect, test } from "bun:test";
import {
  PUBLIC_HEALTH,
  PUBLIC_OBSERVATION_ALLOWLIST,
  publicCorsHeaders,
  publicErrorBody,
  publicResponseHeaders,
} from "../../src/worker/public-observation.ts";
import { runFetch } from "../../src/worker/handle.ts";

describe("public observation allowlist", () => {
  test("health is minimal and contains no inventory or deployment metadata", () => {
    expect(PUBLIC_HEALTH).toEqual({ ok: true, service: "ramose" });
    expect(Object.keys(PUBLIC_HEALTH)).toEqual(
      [...PUBLIC_OBSERVATION_ALLOWLIST.healthFields],
    );
  });

  test("deployment identity is visible only to the internal capability", async () => {
    const env = {
      RAMOSE_INTERNAL_SECRET: "deployment-owned-capability",
      CF_VERSION_METADATA: { id: "version-17", tag: "", timestamp: "" },
    } as never;
    const ordinary = await runFetch(
      new Request("https://peer.example/health"),
      env,
      {},
    );
    const internal = await runFetch(
      new Request("https://peer.example/health", {
        headers: { "x-ramose-internal": "deployment-owned-capability" },
      }),
      env,
      {},
    );
    expect(ordinary.headers.get("x-ramose-deployment")).toBeNull();
    expect(internal.headers.get("x-ramose-deployment")).toBe("version-17");
    expect(JSON.stringify(await ordinary.json())).toBe(JSON.stringify(PUBLIC_HEALTH));
    expect(JSON.stringify(await internal.json())).toBe(JSON.stringify(PUBLIC_HEALTH));
  });

  test("framework error fields drop policy, storage, count, and stack detail", () => {
    expect(publicErrorBody({
      error: "invalid request",
      code: "safe-code",
      stack: "secret stack",
      attr: ":hidden/value",
      clause: "[?e :hidden/value ?v]",
      cells: 42,
      limit: 10,
      transaction: 17,
      receipt: {
        version: 2,
        invocationId: "invocation-1",
        status: "failed",
        scopeDigest: "private",
        operationVersion: "private",
        committedT: 17,
      },
    })).toEqual({
      error: "invalid request",
      code: "safe-code",
      receipt: {
        version: 2,
        invocationId: "invocation-1",
        status: "failed",
      },
    });
  });

  test("internal, timing, cache, and deployment headers are never public", () => {
    expect(publicResponseHeaders({
      "content-type": "application/json",
      "retry-after": "2",
      "x-ramose-ms": "3",
      "x-ramose-basis-t": "7",
      "x-ramose-deployment": "secret-version",
      "x-ramose-internal": "secret-capability",
    })).toEqual({
      "content-type": "application/json",
      "retry-after": "2",
    });
  });

  test("CORS admits only data-plane request fields and exposes Retry-After", () => {
    const headers = publicCorsHeaders(
      new Request("https://peer.example/health", {
        headers: { origin: "https://app.example" },
      }),
      { RAMOSE_ALLOWED_ORIGINS: "https://app.example" },
    );
    expect(headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(headers["access-control-allow-headers"]).toBe(
      "content-type,authorization,x-ramose-catalog,x-ramose-unit-hash",
    );
    expect(headers["access-control-expose-headers"]).toBe("retry-after");
    expect(JSON.stringify(headers)).not.toContain("replica");
    expect(JSON.stringify(headers)).not.toContain("basis");
    expect(JSON.stringify(headers)).not.toContain("internal");
  });
});
