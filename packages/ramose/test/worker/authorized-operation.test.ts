import { describe, expect, test } from "bun:test";
import type { OperationInvocation } from "../../src/internal/authorization/index.ts";
import { serializeOperationInvocation } from "../../src/worker/authorized-operation.ts";

describe("operation invocation transport", () => {
  test("encodes only target metadata and preserves exact input and caller claims", () => {
    const ownProto = JSON.parse('{"__proto__":"claim-owned","kept":true}');
    const invocation = {
      database: "operation-transport",
      catalogKey: "catalog",
      unitHash: "unit",
      owner: { kind: "entity", name: "item" },
      localName: "inspect",
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
    } as unknown as OperationInvocation;

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
});
