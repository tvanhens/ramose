import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { AuthoritativeOperationInvocation } from "../../src/internal/authorization/index.ts";
import {
  parseOperationRequest,
  serializeOperationInvocation,
} from "../../src/worker/authorized-operation.ts";

describe("operation invocation transport", () => {
  test("encodes only target metadata and preserves exact input and caller claims", () => {
    const ownProto = JSON.parse('{"__proto__":"claim-owned","kept":true}');
    const invocation = {
      database: "operation-transport",
      catalogKey: "catalog",
      unitHash: "unit",
      owner: { kind: "entity", name: "item" },
      localName: "inspect",
      invocationId: "invocation-transport",
      target: [":item/when", new Date(0)],
      input: {
        tagged: { vt: 1, v: "input-owned" },
        ownProto: JSON.parse('{"__proto__":"input-owned","kept":true}'),
      },
      caller: {
        claims: {
          tagged: { vt: 2, v: "claim-owned" },
          ownProto,
        },
        classes: ["member"],
        exp: 1_700_000_000,
      },
    } as unknown as AuthoritativeOperationInvocation;

    const parsed = JSON.parse(serializeOperationInvocation(invocation)) as {
      invocation: Record<string, unknown>;
    };
    expect(parsed.invocation.target).toEqual([":item/when", { $inst: 0 }]);
    expect((parsed.invocation.input as Record<string, unknown>).tagged).toEqual({
      vt: 1,
      v: "input-owned",
    });
    const claims = (parsed.invocation.caller as {
      claims: Record<string, unknown>;
    }).claims;
    expect(claims.tagged).toEqual({ vt: 2, v: "claim-owned" });
    expect(Object.hasOwn(claims.ownProto as object, "__proto__")).toBe(true);
    expect((claims.ownProto as Record<string, unknown>).__proto__).toBe("claim-owned");
  });

  test("rejects database selectors", async () => {
    const parsed = Effect.runPromise(parseOperationRequest(new Request(
      "https://peer.test/db/root/op",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          at: ["acme", "design"],
          operation: {
            owner: { kind: "entity", name: "pathNote" },
            localName: "create",
          },
          invocationId: "nested-invocation",
          input: { text: "hello" },
        }),
      },
    )));
    await expect(parsed).rejects.toThrow("database selector 'at' is not supported");
  });

  test("refuses a caller-supplied catalog proof at every depth", async () => {
    const supplied: readonly (readonly [string, Record<string, unknown>, HeadersInit])[] = [
      ["root, in the body", { catalog: "root", unitHash: "a".repeat(64) }, {}],
      ["root, in the headers", {}, {
        "x-ramose-catalog": "root",
        "x-ramose-unit-hash": "a".repeat(64),
      }],
      ["root, malformed", { catalog: 7, unitHash: null }, {}],
      ["root, half of one", { catalog: "root" }, {}],
    ];
    for (const [label, extra, headers] of supplied) {
      const parsed = Effect.runPromise(parseOperationRequest(new Request(
        "https://peer.test/db/root/op",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            ...extra,
            operation: {
              owner: { kind: "entity", name: "item" },
              localName: "create",
            },
            invocationId: "root-invocation",
            input: {},
          }),
        },
      )));
      await expect(parsed).rejects.toMatchObject({ status: 403 });
      expect(label).toBeTruthy();
    }
  });

  test("parses a configured-root operation that supplies no proof", async () => {
    const parsed = await Effect.runPromise(parseOperationRequest(new Request(
      "https://peer.test/db/root/op",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: {
            owner: { kind: "entity", name: "item" },
            localName: "create",
          },
          invocationId: "root-invocation",
          input: {},
        }),
      },
    )));
    expect(parsed.invocationId).toBe("root-invocation");
  });

  test("requires one bounded caller invocation id", async () => {
    const request = (invocationId?: string) => new Request(
      "https://peer.test/db/root/op",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: {
            owner: { kind: "entity", name: "item" },
            localName: "create",
          },
          ...(invocationId === undefined ? {} : { invocationId }),
          input: {},
        }),
      },
    );
    for (const invocationId of [undefined, "", "x".repeat(257)]) {
      await expect(
        Effect.runPromise(parseOperationRequest(request(invocationId))),
      ).rejects.toThrow("invocationId must be a non-empty string");
    }
  });
});
