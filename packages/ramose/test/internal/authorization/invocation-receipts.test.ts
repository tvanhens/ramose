import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  decideInvocationReceipt,
  invocationDigestMaterial,
  invocationReceiptOutcome,
  invocationScopeMaterial,
  parseAuthoritativeInvocationResult,
  parseStoredInvocationReceipt,
  prepareInvocationReceipt,
  publicInvocationReceipt,
  transitionInvocationReceipt,
  type AuthoritativeOperationInvocation,
  type PreparedInvocationReceipt,
} from "../../../src/internal/authorization/index.ts";

const unitHash = CatalogUnitHash.make("ab".repeat(32));

const invocation = (
  overrides: Partial<AuthoritativeOperationInvocation> = {},
): AuthoritativeOperationInvocation => ({
  database: DatabaseId.make("receipts"),
  catalogKey: CatalogId.make("app"),
  unitHash,
  owner: { kind: "entity", name: "issue" },
  localName: "close",
  invocationId: "invocation-01",
  target: [":issue/key", "ISSUE-1"],
  input: { reason: "duplicate", metadata: { z: 2, a: 1 } },
  caller: {
    claims: { sub: "user-1", org: "acme" },
    classes: ["member", "operator"],
    exp: 2_000_000_000,
  },
  ...overrides,
});

const prepare = (value: AuthoritativeOperationInvocation) =>
  Effect.runPromise(prepareInvocationReceipt(value));

const digest = (byte: string): string => byte.repeat(64);

const preparedFixture = (
  overrides: Partial<PreparedInvocationReceipt> = {},
): PreparedInvocationReceipt => ({
  version: 1,
  principalId: "user-1",
  invocationId: "invocation-01",
  scopeDigest: digest("a"),
  invocationDigest: digest("b"),
  ...overrides,
});

describe("authoritative invocation receipt identity", () => {
  test("canonical digests ignore JSON key, class, and token-renewal order", async () => {
    const left = await prepare(invocation());
    const right = await prepare(invocation({
      input: { metadata: { a: 1, z: 2 }, reason: "duplicate" },
      caller: {
        claims: { org: "acme", sub: "user-1" },
        classes: ["operator", "member", "operator"],
        exp: 2_100_000_000,
      },
    }));
    expect(right).toEqual(left);
  });

  test("operation identity, version, target, input, and scope changes are distinct", async () => {
    const base = await prepare(invocation());
    const changed = await Promise.all([
      prepare(invocation({ localName: "reopen" })),
      prepare(invocation({ unitHash: CatalogUnitHash.make("cd".repeat(32)) })),
      prepare(invocation({ target: [":issue/key", "ISSUE-2"] })),
      prepare(invocation({ input: { reason: "other" } })),
    ]);
    for (const candidate of changed) {
      expect(candidate.scopeDigest).toBe(base.scopeDigest);
      expect(candidate.invocationDigest).not.toBe(base.invocationDigest);
    }

    const authorizationChanged = await prepare(invocation({
      caller: {
        claims: { sub: "user-1", org: "other" },
        classes: ["member"],
        exp: 2_000_000_000,
      },
    }));
    expect(authorizationChanged.scopeDigest).not.toBe(base.scopeDigest);
    expect(authorizationChanged.invocationDigest).toBe(base.invocationDigest);
  });

  test("canonical material contains data and deployment identity but no executable", () => {
    const value = invocation();
    expect(invocationDigestMaterial(value)).toEqual({
      version: 1,
      operation: {
        catalogKey: "app",
        unitHash,
        owner: { kind: "entity", name: "issue" },
        localName: "close",
      },
      target: [":issue/key", "ISSUE-1"],
      input: {
        present: true,
        value: { reason: "duplicate", metadata: { z: 2, a: 1 } },
      },
    });
    expect(invocationScopeMaterial(value)).toEqual({
      version: 1,
      database: "receipts",
      principal: {
        claims: { sub: "user-1", org: "acme" },
        classes: ["member", "operator"],
      },
      graph: null,
    });
    expect(JSON.stringify(invocationDigestMaterial(value))).not.toMatch(
      /source|callback|bytecode|function|run/,
    );
  });
});

describe("authoritative invocation receipt state machine", () => {
  test("claims once, replays exact terminals, and conflicts on either digest", () => {
    const prepared = preparedFixture();
    const claimed = decideInvocationReceipt(undefined, prepared);
    expect(claimed._tag).toBe("Claim");
    if (claimed._tag !== "Claim") throw new Error("expected claim");

    const completed = transitionInvocationReceipt(claimed.receipt, {
      _tag: "Complete",
      committedT: 42,
      output: { id: 1001 },
    });
    expect(decideInvocationReceipt(completed, prepared)).toEqual({
      _tag: "Replay",
      receipt: completed,
    });
    expect(decideInvocationReceipt(completed, preparedFixture({
      invocationDigest: digest("c"),
    }))).toEqual({ _tag: "Conflict" });
    expect(decideInvocationReceipt(completed, preparedFixture({
      scopeDigest: digest("d"),
    }))).toEqual({ _tag: "Conflict" });
  });

  test("completed, rejected, failed, and indeterminate receipts are sealed", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const events = [
      { _tag: "Complete", committedT: 8, output: { ok: true } } as const,
      {
        _tag: "Reject",
        rejection: { kind: "invalid_request" },
      } as const,
      { _tag: "Fail" } as const,
      { _tag: "Recover" } as const,
    ];
    expect(events.map((event) =>
      transitionInvocationReceipt(claim.receipt, event).status
    )).toEqual(["completed", "rejected", "failed", "indeterminate"]);

    for (const event of events) {
      const terminal = transitionInvocationReceipt(claim.receipt, event);
      expect(transitionInvocationReceipt(terminal, {
        _tag: "Complete",
        committedT: 99,
        output: "changed",
      })).toBe(terminal);
    }
  });

  test("an abandoned claim recovers once to an indeterminate replay", () => {
    const prepared = preparedFixture();
    const claim = decideInvocationReceipt(undefined, prepared);
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const recovered = decideInvocationReceipt(claim.receipt, prepared);
    expect(recovered._tag).toBe("Recover");
    if (recovered._tag !== "Recover") throw new Error("expected recovery");
    expect(decideInvocationReceipt(recovered.receipt, prepared)).toEqual({
      _tag: "Replay",
      receipt: recovered.receipt,
    });
  });
});

describe("authoritative invocation receipt serialization", () => {
  test("public completed receipts and results omit all private receipt metadata", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 42,
      output: { id: 1001 },
    });
    expect(publicInvocationReceipt(completed)).toEqual({
      version: 1,
      invocationId: "invocation-01",
      status: "completed",
    });
    const outcome = invocationReceiptOutcome(completed);
    const wire = JSON.parse(JSON.stringify(outcome));
    expect(parseAuthoritativeInvocationResult(wire, "invocation-01"))
      .toEqual(outcome);
    const publicText = JSON.stringify(outcome.receipt);
    expect(publicText).not.toContain("scopeDigest");
    expect(publicText).not.toContain("invocationDigest");
    expect(publicText).not.toContain("principalId");
    expect(publicText).not.toContain("committedT");
    expect(publicText).not.toContain("receipts");
  });

  test("durable decode preserves exact terminal output and rejects corruption", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 7,
      output: JSON.parse('{"__proto__":"owned","kept":true}'),
    });
    const decoded = parseStoredInvocationReceipt(
      JSON.parse(JSON.stringify(completed)),
    );
    expect(decoded).toEqual(completed);
    expect(() => parseStoredInvocationReceipt({
      ...completed,
      invocationDigest: "not-a-digest",
    })).toThrow("invalid durable invocation receipt");
    expect(() => parseStoredInvocationReceipt({
      ...completed,
      executableSource: "return destroyEverything()",
    })).toThrow("invalid durable invocation receipt");
    expect(() => parseAuthoritativeInvocationResult({
      _tag: "Conflict",
      scopeDigest: "private",
    }, "invocation-01")).toThrow("invalid authoritative invocation result");
  });
});
