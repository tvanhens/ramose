import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  type OperationInvocation,
} from "../../src/internal/authorization/index.ts";
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
      routeDerivation: {
        rootDatabase: DatabaseId.make("operation-root"),
        graphs: [{ graphEntity: 1000, catalogKey: CatalogId.make("child") }],
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
    expect(parsed.invocation.routeDerivation).toEqual({
      rootDatabase: "operation-root",
      graphs: [{ graphEntity: 1000, catalogKey: "child" }],
    });
  });

  test("parses nested operation addresses without a caller catalog proof", async () => {
    const parsed = await Effect.runPromise(parseOperationRequest(new Request(
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
          input: { text: "hello" },
        }),
      },
    )));
    expect(parsed.path).toEqual(["acme", "design"]);
    expect(parsed.catalogKey).toBeUndefined();
    expect(parsed.unitHash).toBeUndefined();
  });

  test("retains exact proof for configured-root operations", async () => {
    const catalogKey = CatalogId.make("root");
    const unitHash = CatalogUnitHash.make("a".repeat(64));
    const parsed = await Effect.runPromise(parseOperationRequest(new Request(
      "https://peer.test/db/root/op",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalog: catalogKey,
          unitHash,
          operation: {
            owner: { kind: "entity", name: "item" },
            localName: "create",
          },
          input: {},
        }),
      },
    )));
    expect(parsed.path).toEqual([]);
    expect(parsed.catalogKey).toBe(catalogKey);
    expect(parsed.unitHash).toBe(unitHash);
  });
});
