import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { clientRef, ENTITY_ID_CODEC } from "../../../src/db/refs.ts";
import { sealEntityId } from "../../../src/internal/replication/entity-id.ts";
import { base64Url } from "../../../src/internal/replication/server-identity.ts";
import {
  allocationMappingsResolvable,
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  decideInvocationReceipt,
  OperationVersion,
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
const allocatedRef = clientRef();
const idScope = Object.freeze({
  server: "srv",
  principal: "prn",
  database: "dbs",
});

const fixtureEpoch = Object.freeze({
  keyId: "AAECAwQFBgcICQoLDA0ODw",
  material: "c2VhbGluZy1tYXRlcmlhbC1mb3ItcmVjZWlwdC1maXh0dXJlcw",
});
const otherEpoch = Object.freeze({
  keyId: "EBESExQVFhcYGRobHB0eHw",
  material: "YW5vdGhlci1zZWFsaW5nLXJvb3QtZm9yLXJlY2VpcHQtdGVzdHM",
});
const otherAllocatedRef = clientRef();

const sealedEntityId = await sealEntityId(fixtureEpoch, idScope, 4242);
const operationVersion = OperationVersion.make("1f".repeat(32));
const otherOperationVersion = OperationVersion.make("2e".repeat(32));

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

const prepare = (
  value: AuthoritativeOperationInvocation,
  version = operationVersion,
) => Effect.runPromise(prepareInvocationReceipt(value, version));

const digest = (byte: string): string => byte.repeat(64);

const preparedFixture = (
  overrides: Partial<PreparedInvocationReceipt> = {},
): PreparedInvocationReceipt => ({
  version: 2,
  principalId: "user-1",
  invocationId: "invocation-01",
  scopeDigest: digest("a"),
  operationVersion,
  invocationDigest: digest("b"),
  ...overrides,
});

const replayFence = Object.freeze({
  version: 1 as const,
  target: Object.freeze({
    eid: 1001,
    type: "issue",
    referenceEid: null,
    postCommit: Object.freeze({
      kind: "absent" as const,
      authorizationDigest: "c".repeat(64),
      authorizationReadSet: Object.freeze([]),
    }),
  }),
  consumedRefs: Object.freeze([
    Object.freeze({
      path: Object.freeze(["assignee"]),
      eid: 1002,
      type: "user",
    }),
  ]),
});

describe("authoritative invocation receipt identity", () => {
  test("canonical digests ignore JSON key and renewable token metadata but preserve class order", async () => {
    const left = await prepare(invocation());
    const right = await prepare(invocation({
      input: { metadata: { a: 1, z: 2 }, reason: "duplicate" },
      caller: {
        claims: { org: "acme", sub: "user-1" },
        classes: ["member", "operator"],
        exp: 2_100_000_000,
      },
    }));
    expect(right).toEqual(left);

    const reordered = await prepare(invocation({
      caller: {
        claims: { org: "acme", sub: "user-1" },
        classes: ["operator", "member"],
        exp: 2_100_000_000,
      },
    }));
    expect(reordered.scopeDigest).not.toBe(left.scopeDigest);
    expect(reordered.invocationDigest).toBe(left.invocationDigest);
  });

  test("operation version, identity, target, input, and scope changes are distinct", async () => {
    const base = await prepare(invocation());
    const changed = await Promise.all([
      prepare(invocation({ localName: "reopen" })),
      prepare(invocation({ owner: { kind: "trait", name: "issue" } })),
      prepare(invocation({ target: [":issue/key", "ISSUE-2"] })),
      prepare(invocation({ input: { reason: "other" } })),
      prepare(invocation(), otherOperationVersion),
    ]);
    for (const candidate of changed) {
      expect(candidate.scopeDigest).toBe(base.scopeDigest);
      expect(candidate.invocationDigest).not.toBe(base.invocationDigest);
    }

    const redeployed = await Promise.all([
      prepare(invocation({ unitHash: CatalogUnitHash.make("cd".repeat(32)) })),
      prepare(invocation({ catalogKey: CatalogId.make("other-catalog") })),
    ]);
    for (const candidate of redeployed) {
      expect(candidate).toEqual(base);
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

  test("canonical material contains data and the operation version but no executable or deployment", () => {
    const value = invocation();
    expect(invocationDigestMaterial(value, operationVersion)).toEqual({
      version: 2,
      operation: {
        version: operationVersion,
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
      version: 2,
      database: "receipts",
      principal: {
        claims: { sub: "user-1", org: "acme" },
        classes: ["member", "operator"],
      },
      graph: null,
    });
    const material = JSON.stringify(invocationDigestMaterial(value, operationVersion));
    expect(material).not.toMatch(/source|callback|bytecode|function|run/);
    expect(material).not.toContain(unitHash);
    expect(material).not.toContain("catalogKey");
  });

  test("the allocation binding is covered, and an empty one leaves the digest untouched", async () => {
    const base = await prepare(invocation());

    expect((await prepare(invocation({ allocations: [] }))).invocationDigest)
      .toBe(base.invocationDigest);
    expect(
      invocationDigestMaterial(invocation({ allocations: [] }), operationVersion),
    ).not.toHaveProperty("allocations");

    const bound = invocation({
      allocations: [{ slot: "item", clientRef: allocatedRef }],
    });
    const withBinding = await prepare(bound);
    expect(withBinding.invocationDigest).not.toBe(base.invocationDigest);
    expect(invocationDigestMaterial(bound, operationVersion)).toMatchObject({
      allocations: [{ slot: "item", clientRef: allocatedRef }],
    });

    const rebound = await prepare(invocation({
      allocations: [{ slot: "item", clientRef: otherAllocatedRef }],
    }));
    expect(rebound.invocationDigest).not.toBe(withBinding.invocationDigest);
    expect(decideInvocationReceipt(
      { ...withBinding, status: "failed" },
      rebound,
    )._tag).toBe("Conflict");
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
      replayFence,
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
      {
        _tag: "Complete",
        committedT: 8,
        output: { ok: true },
        replayFence,
      } as const,
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
        replayFence,
      })).toBe(terminal);
    }
  });

  test("a stored row from another operation version is a changed operation, not a conflict", () => {
    const prepared = preparedFixture();
    const claim = decideInvocationReceipt(undefined, prepared);
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 12,
      output: { id: 7 },
      replayFence,
    });

    expect(decideInvocationReceipt(completed, preparedFixture({
      operationVersion: otherOperationVersion,
      invocationDigest: digest("e"),
    }))).toEqual({ _tag: "OperationChanged" });

    expect(decideInvocationReceipt(completed, preparedFixture({
      invocationDigest: digest("e"),
    }))).toEqual({ _tag: "Conflict" });
  });

  test("a pre-correction row is update-required: never replayed, re-executed, or cleared", () => {
    const legacy = parseStoredInvocationReceipt({
      version: 1,
      principalId: "user-1",
      invocationId: "invocation-01",
      scopeDigest: digest("a"),
      invocationDigest: digest("b"),
      status: "completed",
      committedT: 3,
      output: { id: 1 },
      replayFence,
    });
    expect(legacy).toEqual({ _tag: "LegacyInvocationReceipt", version: 1 });
    expect(decideInvocationReceipt(legacy, preparedFixture()))
      .toEqual({ _tag: "UpdateRequired" });

    expect(decideInvocationReceipt(legacy, preparedFixture({
      invocationDigest: digest("f"),
    }))).toEqual({ _tag: "UpdateRequired" });
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
      replayFence,
    });
    if (completed.status !== "completed") throw new Error("expected completion");
    expect(publicInvocationReceipt(completed)).toEqual({
      version: 2,
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
    expect(publicText).not.toContain("replayFence");
    expect(publicText).not.toContain("receipts");
  });

  test("output entity-reference positions round-trip, and an unaddressable one is refused", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 42,
      output: { id: 1001, rows: [1002] },
      replayFence,
    });
    if (completed.status !== "completed") throw new Error("expected completion");

    const outcome = {
      ...invocationReceiptOutcome(completed),
      outputRefPaths: [["id"], ["rows", 0]],
    };
    const wire = JSON.parse(JSON.stringify(outcome));
    expect(parseAuthoritativeInvocationResult(wire, "invocation-01"))
      .toEqual(outcome);

    expect(
      parseAuthoritativeInvocationResult(
        { ...wire, outputRefPaths: [[]] },
        "invocation-01",
      ),
    ).toMatchObject({ outputRefPaths: [[]] });
    for (const bad of [[], [[""]], [[-1]], [[1.5]], [[{}]], "id"]) {
      expect(() =>
        parseAuthoritativeInvocationResult(
          { ...wire, outputRefPaths: bad },
          "invocation-01",
        )
      ).toThrow(TypeError);
    }
  });

  test("the mapping extension round-trips, projects sealed handles, and never admits an eid", async () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const allocations = {
      version: 1 as const,
      keyId: fixtureEpoch.keyId,
      scope: idScope,
      entries: [{
        slot: "item",
        clientRef: allocatedRef,
        entityId: sealedEntityId,
      }],
    };
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 42,
      output: { id: 1001 },
      replayFence,
      allocations,
    });
    if (completed.status !== "completed") throw new Error("expected completion");

    expect(completed.allocations).toEqual(allocations);
    expect(parseStoredInvocationReceipt(JSON.parse(JSON.stringify(completed))))
      .toEqual(completed);

    const outcome = invocationReceiptOutcome(completed);
    if (outcome._tag !== "Completed") throw new Error("expected completion");

    expect(outcome.mappings).toEqual([
      { clientRef: allocatedRef, entityId: sealedEntityId },
    ]);
    expect(JSON.stringify(outcome.mappings)).not.toContain("item");
    expect(parseAuthoritativeInvocationResult(
      JSON.parse(JSON.stringify(outcome)),
      "invocation-01",
    )).toEqual(outcome);

    expect(() => parseStoredInvocationReceipt({
      ...completed,
      allocations: { ...allocations, entries: [{
        slot: "item",
        clientRef: allocatedRef,
        entityId: 1001,
      }] },
    })).toThrow("invalid durable invocation receipt");

    expect(() => parseStoredInvocationReceipt({
      ...completed,
      allocations: { version: 1, entries: allocations.entries },
    })).toThrow("invalid durable invocation receipt");
    expect(() => parseAuthoritativeInvocationResult({
      ...JSON.parse(JSON.stringify(outcome)),
      mappings: [{ clientRef: allocatedRef, entityId: 1001 }],
    }, "invocation-01")).toThrow("invalid authoritative invocation result");

    expect(() => parseStoredInvocationReceipt({
      ...completed,
      allocations: {
        ...allocations,
        entries: [
          { slot: "one", clientRef: allocatedRef, entityId: sealedEntityId },
          { slot: "two", clientRef: allocatedRef, entityId: sealedEntityId },
        ],
      },
    })).toThrow("invalid durable invocation receipt");

    const bound = { keyId: allocations.keyId, scope: allocations.scope };
    expect(allocationMappingsResolvable(allocations, bound)).toBe(true);

    expect(allocationMappingsResolvable({
      ...allocations,
      entries: [{
        ...allocations.entries[0]!,
        entityId: await sealEntityId(otherEpoch, idScope, 4242),
      }],
    }, bound)).toBe(false);

    const futureEnvelope = new Uint8Array(41);
    futureEnvelope[0] = ENTITY_ID_CODEC + 1;
    expect(allocationMappingsResolvable({
      ...allocations,
      entries: [{
        ...allocations.entries[0]!,
        entityId: base64Url(futureEnvelope),
      }],
    }, bound)).toBe(false);
    expect(allocationMappingsResolvable(allocations, {
      ...bound,
      keyId: "another-key-epoch",
    })).toBe(false);
    for (const component of ["server", "principal", "database"] as const) {
      expect(allocationMappingsResolvable(allocations, {
        ...bound,
        scope: { ...bound.scope, [component]: "elsewhere" },
      })).toBe(false);
    }
  });

  test("a receipt whose handles a newer codec wrote is recognized, not corruption", () => {

    const future = "Z".repeat(80);
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const rolled = {
      ...transitionInvocationReceipt(claim.receipt, {
        _tag: "Complete",
        committedT: 42,
        output: null,
        replayFence,
      }),
      allocations: {
        version: 1 as const,
        keyId: fixtureEpoch.keyId,
        scope: idScope,
        entries: [{ slot: "item", clientRef: allocatedRef, entityId: future }],
      },
    };
    const decoded = parseStoredInvocationReceipt(JSON.parse(JSON.stringify(rolled)));
    expect(decoded).toEqual(rolled as never);

    const stored = decoded as typeof rolled;
    expect(allocationMappingsResolvable(stored.allocations, {
      keyId: stored.allocations.keyId,
      scope: stored.allocations.scope,
    })).toBe(false);

    expect(() => parseStoredInvocationReceipt({
      ...rolled,
      allocations: {
        ...rolled.allocations,
        entries: [{ slot: "item", clientRef: allocatedRef, entityId: 1001 }],
      },
    })).toThrow("invalid durable invocation receipt");
  });

  test("a completed receipt written before the mapping extension stays replayable", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 42,
      output: { id: 1001 },
      replayFence,
    });
    expect(Object.hasOwn(completed, "allocations")).toBe(false);
    const decoded = parseStoredInvocationReceipt(
      JSON.parse(JSON.stringify(completed)),
    );
    expect(decoded).toEqual(completed);
    const replay = decideInvocationReceipt(decoded, preparedFixture());
    expect(replay._tag).toBe("Replay");
    if (replay._tag !== "Replay") throw new Error("expected replay");
    expect(replay.receipt).toEqual(decoded as never);
    const outcome = invocationReceiptOutcome(completed);
    if (outcome._tag !== "Completed") throw new Error("expected completion");
    expect(Object.hasOwn(outcome, "mappings")).toBe(false);
  });

  test("durable decode preserves exact terminal output and rejects corruption", () => {
    const claim = decideInvocationReceipt(undefined, preparedFixture());
    if (claim._tag !== "Claim") throw new Error("expected claim");
    const completed = transitionInvocationReceipt(claim.receipt, {
      _tag: "Complete",
      committedT: 7,
      output: JSON.parse('{"__proto__":"owned","kept":true}'),
      replayFence,
    });
    if (completed.status !== "completed") throw new Error("expected completion");
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

    const { operationVersion: _dropped, ...withoutVersion } = completed;
    expect(() => parseStoredInvocationReceipt(withoutVersion))
      .toThrow("invalid durable invocation receipt");
    expect(() => parseStoredInvocationReceipt({
      ...completed,
      replayFence: {
        ...completed.replayFence,
        consumedRefs: [{ path: ["assignee"], eid: 1002, type: "user", run: "code" }],
      },
    })).toThrow("invalid durable invocation receipt");
    expect(() => parseAuthoritativeInvocationResult({
      _tag: "Conflict",
      scopeDigest: "private",
    }, "invocation-01")).toThrow("invalid authoritative invocation result");
    for (const tag of ["OperationChanged", "UpdateRequired"] as const) {

      expect(parseAuthoritativeInvocationResult({ _tag: tag }, "invocation-01"))
        .toEqual({ _tag: tag });
      expect(() => parseAuthoritativeInvocationResult({
        _tag: tag,
        operationVersion: digest("a"),
      }, "invocation-01")).toThrow("invalid authoritative invocation result");
    }
  });
});
