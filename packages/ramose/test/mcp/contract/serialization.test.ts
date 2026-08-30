/** Canonical serialization and the public seal (#485). */

import { describe, expect, test } from "bun:test";
import {
  CONTRACT_CANONICAL_JSON_VERSION,
  KERNEL_TOOLS,
  RESERVED_MRTR_ARGUMENT_NAMES,
  assertSealedPublicJson,
  canonicalizeContractJson,
  sealPublicJson,
} from "../../../src/mcp/contract/index.ts";
import {
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

  test("rejects a raw internal digest anywhere in a result", () => {
    expect(() =>
      assertSealedPublicJson({ ok: true, note: closeIssueVersion })
    ).toThrow(/raw internal digest/);
    expect(() =>
      assertSealedPublicJson({ rows: [{ values: { x: closeIssueVersion } }] })
    ).toThrow(/raw internal digest at rows\.0\.values\.x/);
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

  test("rejects a reserved MCP argument name", () => {
    for (const reserved of RESERVED_MRTR_ARGUMENT_NAMES) {
      expect(() =>
        assertSealedPublicJson({ input: { [reserved]: "x" } } as never)
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
