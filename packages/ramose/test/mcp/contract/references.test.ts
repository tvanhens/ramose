/** Public typed references and the projected operation version (#485). */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  hashOperationVersion,
  operationVersionMaterial,
  type OperationVersionDescriptor,
} from "../../../src/internal/authorization/operation-version.ts";
import {
  CatalogId,
  OperationVersion,
} from "../../../src/internal/authorization/identities.ts";
import {
  decodeOperationVersionToken,
  encodeOperationVersionToken,
  functionRefName,
  sameOperationRef,
  OPERATION_VERSION_PREFIX,
} from "../../../src/mcp/contract/index.ts";
import { closeIssue, closeIssueVersion } from "./examples.ts";

const descriptor = (
  overrides: Partial<OperationVersionDescriptor> = {},
): OperationVersionDescriptor => ({
  catalog: CatalogId.make("app"),
  owner: { kind: "entity", name: "issue" },
  localName: "close",
  target: "required",
  revision: 1,
  input: { representation: { schema: { type: "object" } }, shape: { _tag: "opaque" } },
  output: { representation: { schema: { type: "object" } }, shape: { _tag: "opaque" } },
  composers: [],
  writes: ["issue"],
  ...overrides,
});

describe("operation version projection", () => {
  test("is a bijection with the merged OperationVersion primitive", () => {
    const token = encodeOperationVersionToken(closeIssueVersion);
    expect(decodeOperationVersionToken(token)).toBe(closeIssueVersion);
  });

  test("round-trips every byte value, not just the fixture", () => {
    for (let byte = 0; byte < 256; byte++) {
      const version = OperationVersion.make(
        byte.toString(16).padStart(2, "0").repeat(32),
      );
      expect(decodeOperationVersionToken(encodeOperationVersionToken(version)))
        .toBe(version);
    }
  });

  test("never puts the raw digest on the wire", () => {
    const token = encodeOperationVersionToken(closeIssueVersion);
    expect(token.includes(closeIssueVersion)).toBe(false);
    expect(token).not.toMatch(/[0-9a-f]{64}/);
    expect(token.startsWith(OPERATION_VERSION_PREFIX)).toBe(true);
    // Unpadded base64url of 32 bytes, behind the family prefix.
    expect(token).toMatch(/^ov_[A-Za-z0-9_-]{43}$/);
  });

  test("distinct operation versions project to distinct tokens", () => {
    const a = encodeOperationVersionToken(OperationVersion.make("1f".repeat(32)));
    const b = encodeOperationVersionToken(OperationVersion.make("1e".repeat(32)));
    expect(a).not.toBe(b);
  });

  test("refuses anything that is not a canonical operation version", () => {
    expect(() => encodeOperationVersionToken("nope" as OperationVersion))
      .toThrow(/canonical operation-scoped version/);
    expect(() =>
      encodeOperationVersionToken("AB".repeat(32) as OperationVersion)
    ).toThrow(/canonical operation-scoped version/);
  });

  test("a malformed token decodes to nothing, so it is invalid_input not operation_changed", () => {
    expect(decodeOperationVersionToken("ov_short")).toBeUndefined();
    expect(decodeOperationVersionToken(closeIssueVersion)).toBeUndefined();
    expect(decodeOperationVersionToken(`ov_${"!".repeat(43)}`)).toBeUndefined();
    expect(decodeOperationVersionToken("cat_9dQwErTyUiOp-1")).toBeUndefined();
  });

  test("tracks the deployed operation version and nothing else", async () => {
    const base = await Effect.runPromise(hashOperationVersion(descriptor()));
    const same = await Effect.runPromise(hashOperationVersion(descriptor()));
    const bumped = await Effect.runPromise(
      hashOperationVersion(descriptor({ revision: 2 })),
    );
    expect(encodeOperationVersionToken(same)).toBe(
      encodeOperationVersionToken(base),
    );
    expect(encodeOperationVersionToken(bumped)).not.toBe(
      encodeOperationVersionToken(base),
    );
  });

  test("a documentation-only edit does not rotate the public token", async () => {
    const documented = descriptor({
      input: {
        representation: {
          schema: { type: "object", description: "now documented" },
        },
        shape: { _tag: "opaque" },
      },
    });
    const before = await Effect.runPromise(hashOperationVersion(descriptor()));
    const after = await Effect.runPromise(hashOperationVersion(documented));
    expect(encodeOperationVersionToken(after)).toBe(
      encodeOperationVersionToken(before),
    );
  });

  test("is computed from one operation's descriptor and nothing deployment-wide", () => {
    // Structural, not incidental: an unrelated definition, a redeploy, or a
    // grant change cannot rotate this token because none of them can reach
    // the material the version is computed over.
    const material = operationVersionMaterial(descriptor()) as {
      readonly [key: string]: unknown;
    };
    expect(Object.keys(material).sort()).toEqual([
      "behavior",
      "contract",
      "operation",
      "revision",
      "version",
    ]);
    const serialized = JSON.stringify(material);
    for (const forbidden of ["unitHash", "deployment", "catalogUnit", "policy"]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});

describe("reference identity", () => {
  test("two references match only when operation and version match", () => {
    expect(sameOperationRef(closeIssue, { ...closeIssue })).toBe(true);
    expect(sameOperationRef(closeIssue, { ...closeIssue, name: "reopen" }))
      .toBe(false);
    expect(
      sameOperationRef(closeIssue, {
        ...closeIssue,
        version: encodeOperationVersionToken(
          OperationVersion.make("2e".repeat(32)),
        ),
      }),
    ).toBe(false);
    expect(
      sameOperationRef(closeIssue, {
        ...closeIssue,
        owner: { kind: "trait", name: "issue" },
      }),
    ).toBe(false);
  });

  test("function references spell out as namespace.name", () => {
    expect(functionRefName({ namespace: "text", name: "lower" }))
      .toBe("text.lower");
    expect(functionRefName({ namespace: "logic", name: "eq" }))
      .toBe("logic.eq");
  });
});
