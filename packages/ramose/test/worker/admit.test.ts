import { describe, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { requestCredential } from "../../src/worker/admit.ts";

describe("request credential transport", () => {
  test("HTTP accepts one Bearer credential with a case-insensitive scheme", () => {
    for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
      const credential = requestCredential(
        new Request("https://peer.example.test/db/acme/info", {
          headers: { authorization: `${scheme} signed.jwt.value` },
        }),
      );
      expect(credential._tag).toBe("Success");
      if (credential._tag === "Success") {
        expect(Redacted.value(credential.success)).toBe("signed.jwt.value");
      }
    }
  });

  test("HTTP rejects missing, non-Bearer, multiple, and query credentials", () => {
    const requests = [
      new Request("https://peer.example.test/db/acme/info"),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Basic abc" },
      }),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Bearer one two" },
      }),
      new Request("https://peer.example.test/db/acme/info", {
        headers: { authorization: "Bearer one,Bearer two" },
      }),
      new Request(
        "https://peer.example.test/db/acme/info?token=signed.jwt.value",
      ),
      new Request(
        "https://peer.example.test/db/acme/info?token=signed.jwt.value",
        { headers: { upgrade: "websocket" } },
      ),
      new Request(
        "https://peer.example.test/db/acme/query?token=signed.jwt.value",
        { method: "POST", headers: { upgrade: "websocket" } },
      ),
      new Request(
        "https://peer.example.test/db/acme/session?token=signed.jwt.value",
      ),
    ];
    for (const request of requests) {
      expect(requestCredential(request)._tag).toBe("Failure");
    }
  });

  test("WebSocket admission accepts query or Bearer transport and prefers Bearer", () => {
    const query = requestCredential(
      new Request(
        "https://peer.example.test/db/acme/session?token=query.jwt.value",
        { headers: { upgrade: "WebSocket" } },
      ),
    );
    expect(query._tag).toBe("Success");
    if (query._tag === "Success") {
      expect(Redacted.value(query.success)).toBe("query.jwt.value");
    }

    const bearer = requestCredential(
      new Request(
        "https://peer.example.test/db/acme/session?token=query.jwt.value",
        {
          headers: {
            upgrade: "websocket",
            authorization: "Bearer header.jwt.value",
          },
        },
      ),
    );
    expect(bearer._tag).toBe("Success");
    if (bearer._tag === "Success") {
      expect(Redacted.value(bearer.success)).toBe("header.jwt.value");
    }
  });

  test("WebSocket query transport requires exactly one non-empty token", () => {
    for (const search of [
      "",
      "?token=",
      "?token=one&token=two",
      "?token=has%20space",
    ]) {
      const request = new Request(
        `https://peer.example.test/db/acme/session${search}`,
        { headers: { upgrade: "websocket" } },
      );
      expect(requestCredential(request)._tag).toBe("Failure");
    }
  });
});
