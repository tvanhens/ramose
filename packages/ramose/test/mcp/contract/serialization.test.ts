/** Canonical serialization and the public seal (#485). */

import { describe, expect, test } from "bun:test";
import {
  CONTRACT_CANONICAL_JSON_VERSION,
  KERNEL_TOOLS,
  RESERVED_MRTR_ARGUMENT_NAMES,
  APPLICATION_OWNED_MEMBERS,
  assertSealedPublicJson,
  canonicalizeContractJson,
  sealPublicJson,
} from "../../../src/mcp/contract/index.ts";
import {
  closeIssue,
  closeIssueVersion,
  describeCard,
  describeListing,
  mutateResult,
  queryResult,
} from "./examples.ts";

const publishedResults = [
  ["describe listing", describeListing],
  ["describe card", describeCard],
  ["query result", queryResult],
  ["mutate result", mutateResult],
] as const;

describe("canonical form", () => {
  test("is the engine's one RFC 8785 profile, not a second one", () => {
    expect(CONTRACT_CANONICAL_JSON_VERSION).toBe("rfc8785-jcs/1");
  });

  test("orders members so the same result always serializes identically", () => {
    expect(canonicalizeContractJson({ b: 1, a: 2 }))
      .toBe(canonicalizeContractJson({ a: 2, b: 1 }));
    expect(canonicalizeContractJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("refuses a value that is not JSON", () => {
    expect(() =>
      canonicalizeContractJson(Number.NaN as unknown as never)
    ).toThrow();
  });
});

describe("the public seal", () => {
  for (const [label, result] of publishedResults) {
    test(`${label} carries no internal identity`, () => {
      expect(() => assertSealedPublicJson(result as never, label)).not.toThrow();
    });
  }

  test("rejects a raw internal digest in a contract-owned position", () => {
    expect(() =>
      assertSealedPublicJson({ ok: true, catalogToken: closeIssueVersion })
    ).toThrow(/raw internal digest/);
    expect(() =>
      assertSealedPublicJson({
        rows: [{ ref: { entity: "issue", id: closeIssueVersion } }],
      })
    ).toThrow(/raw internal digest at rows\.0\.ref\.id/);
  });

  test("rejects an internal identifier in author-written prose", () => {
    // message and hint are contract-owned positions that carry an author's
    // words. Prose naming an internal identifier is the leak, not a false
    // positive — receipts.ts normalizes that prose before it reaches here.
    expect(() =>
      assertSealedPublicJson({
        ok: false,
        error: {
          code: "operation_rejected",
          path: [],
          message: `refused by ${closeIssueVersion}`,
          retryable: false,
        },
      })
    ).toThrow(/raw internal digest at error\.message/);
  });

  test("rejects engine identity by property name", () => {
    const leaks: readonly [string, unknown][] = [
      ["eid", 12],
      ["databaseId", "support"],
      ["catalogKey", "app"],
      ["unitHash", "abc"],
      ["committedT", 42],
      ["scopeDigest", "abc"],
      ["invocationDigest", "abc"],
      ["principalId", "user-1"],
      ["replayFence", { version: 1 }],
      ["storageKey", "r2/object"],
      ["policyHash", "abc"],
    ];
    for (const [name, value] of leaks) {
      expect(() => assertSealedPublicJson({ ok: true, [name]: value } as never))
        .toThrow(new RegExp(`internal property "${name}"`));
    }
  });

  test("rejects an executable payload", () => {
    for (const name of ["source", "ast", "bytecode", "run", "executable"]) {
      expect(() =>
        assertSealedPublicJson({ card: { [name]: "anything" } } as never)
      ).toThrow(/internal property/);
    }
  });

  test("rejects a reserved MCP argument name in a contract-owned position", () => {
    for (const reserved of RESERVED_MRTR_ARGUMENT_NAMES) {
      expect(() =>
        assertSealedPublicJson({ card: { [reserved]: "x" } } as never)
      ).toThrow(new RegExp(reserved));
    }
  });

  test("names the exact path of the leak, so a projection bug is findable", () => {
    expect(() =>
      assertSealedPublicJson({ items: [{ card: { eid: 1 } }] } as never)
    ).toThrow(/at items\.0\.card/);
  });

  test("sealPublicJson refuses rather than quietly stripping", () => {
    expect(() => sealPublicJson({ eid: 1 } as never)).toThrow();
    expect(sealPublicJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("the seal stops at application-owned members", () => {
  test("covers exactly the members the projection forwards rather than builds", () => {
    expect([...APPLICATION_OWNED_MEMBERS].sort()).toEqual([
      "input",
      "inputSchema",
      "output",
      "outputSchema",
      "schema",
      "values",
    ]);
  });

  test("an operation card may declare application fields the engine also names", () => {
    // An ordinary domain model has a `database` entity, a `source` column, a
    // `bucket`. None of that is Ramose internals, and a card must be able to
    // describe it.
    const card = {
      kind: "operation",
      ref: closeIssue,
      target: "none",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" },
          source: { type: "string" },
          entityId: { type: "string" },
          bucket: { type: "string" },
          run: { type: "boolean" },
        },
        required: ["database"],
      },
      outputSchema: {
        type: "object",
        properties: { unitHash: { type: "string" } },
      },
    };
    expect(() => assertSealedPublicJson(card as never)).not.toThrow();
  });

  test("a field card's application schema is opaque too", () => {
    expect(() =>
      assertSealedPublicJson({
        kind: "definition",
        fields: [
          { name: "origin", required: true, schema: { properties: { source: {} } } },
        ],
      } as never)
    ).not.toThrow();
  });

  test("a query row may select application columns with engine-ish names", () => {
    expect(() =>
      assertSealedPublicJson({
        ok: true,
        rows: [{
          values: {
            database: "primary",
            eid: "not-ours",
            checksum: closeIssueVersion,
          },
        }],
      } as never)
    ).not.toThrow();
  });

  test("a mutation output is the operation's own data, not the contract's", () => {
    expect(() =>
      assertSealedPublicJson({
        ok: true,
        receipt: { invocationId: "01K", status: "completed" },
        output: { storageKey: "app-owned", digest: closeIssueVersion },
      } as never)
    ).not.toThrow();
  });

  test("but the contract-owned positions around them are still sealed", () => {
    expect(() =>
      assertSealedPublicJson({
        ok: true,
        unitHash: "leaked",
        rows: [{ values: { fine: true } }],
      } as never)
    ).toThrow(/internal property "unitHash"/);
    expect(() =>
      assertSealedPublicJson({
        card: { inputSchema: { properties: { source: {} } }, committedT: 42 },
      } as never)
    ).toThrow(/internal property "committedT"/);
    expect(() =>
      assertSealedPublicJson({
        rows: [{ values: { fine: true }, at: [closeIssueVersion] }],
      } as never)
    ).toThrow(/raw internal digest at rows\.0\.at\.0/);
  });
});

describe("the published schemas themselves", () => {
  test("name no internal identifier and carry no raw digest", () => {
    for (const tool of KERNEL_TOOLS) {
      for (const which of ["inputSchema", "outputSchema"] as const) {
        const serialized = JSON.stringify(tool[which]);
        expect(serialized).not.toMatch(/[0-9a-f]{64}/);
        for (
          const forbidden of [
            "eid",
            "catalogKey",
            "unitHash",
            "committedT",
            "scopeDigest",
            "invocationDigest",
            "principalId",
            "replayFence",
            "storageKey",
            "policyHash",
            "ruleId",
            "schemaFingerprint",
          ]
        ) {
          expect({ tool: tool.name, which, forbidden, found: serialized.includes(`"${forbidden}"`) })
            .toEqual({ tool: tool.name, which, forbidden, found: false });
        }
      }
    }
  });
});
