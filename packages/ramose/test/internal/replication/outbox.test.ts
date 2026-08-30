/**
 * The durable queue model as ordinary values (#475 slice 1).
 *
 * Everything here is a pure decision: identity formats, strict decoding,
 * per-receiver FIFO order, dependency blocking, and the data-free quarantine.
 * The sealed handles are minted by the real codec against a real identity
 * root — the only thing that proves the client's envelope reader and the
 * server's envelope writer agree.
 */

import { describe, expect, test } from "bun:test";
import {
  allocationSlots,
  allocationPathKey,
  readAllocationPath,
} from "../../../src/db/allocations.ts";
import {
  clientRef,
  entityIdEnvelope,
  ENTITY_ID_CODEC,
  ENTITY_ID_PATTERN,
  invocationId,
  isClientRef,
  isEntityId,
  isInvocationId,
  type EntityId,
} from "../../../src/db/refs.ts";
import type { OperationVersion } from "../../../src/internal/authorization/identities.ts";
import {
  ENTITY_ID_CODEC_VERSION,
  SEALED_ENTITY_ID_PATTERN,
  sealEntityId,
  type EntityIdScope,
} from "../../../src/internal/replication/entity-id.ts";
import {
  buildOutboxRecord,
  decideOutboxEntry,
  decodeOutboxRecord,
  mutationPartitionKey,
  mutationScopePrefix,
  outboxDependencies,
  OutboxRecordInvalid,
  planOutbox,
  sealingEpochOf,
  type OutboxDraft,
  type OutboxRecord,
} from "../../../src/internal/replication/outbox.ts";
import type { ReplicaDatabaseScope } from "../../../src/internal/replication/replica-lifecycle.ts";
import {
  generateServerIdentityRoot,
  sealingKeyOf,
} from "../../../src/internal/replication/server-identity.ts";

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const PRINCIPAL = opaque("p");
const DATABASE = opaque("d");
const OTHER_DATABASE = opaque("e");

const receiver: ReplicaDatabaseScope = {
  server: SERVER,
  principal: PRINCIPAL,
  database: DATABASE,
};
const otherReceiver: ReplicaDatabaseScope = { ...receiver, database: OTHER_DATABASE };

const scopeKey = "ramose-replica-scope-v2:server:principal";

const idScope: EntityIdScope = {
  server: SERVER,
  principal: PRINCIPAL,
  database: DATABASE,
};

const root = generateServerIdentityRoot(1_700_000_000_000);
const sealing = sealingKeyOf(root);
const otherRoot = generateServerIdentityRoot(1_700_000_000_001);

const version = "a".repeat(64) as OperationVersion;

const draft = (overrides: Partial<OutboxDraft> = {}): OutboxDraft => ({
  invocation: invocationId(),
  receiver,
  operation: {
    catalog: "movies" as never,
    owner: { kind: "entity", name: "issue" },
    localName: "create",
  },
  operationVersion: version,
  target: { type: "none" },
  input: { title: "offline" },
  allocations: [],
  inputRefs: [],
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

describe("durable client identities", () => {
  test("client refs and invocation ids are distinct, versioned, and unique", () => {
    const refs = new Set(Array.from({ length: 500 }, () => clientRef() as string));
    expect(refs.size).toBe(500);
    const one = clientRef();
    const invocation = invocationId();
    expect(one.startsWith("cr1_")).toBe(true);
    expect(invocation.startsWith("iv1_")).toBe(true);
    expect(isClientRef(one)).toBe(true);
    expect(isInvocationId(one)).toBe(false);
    expect(isClientRef(invocation)).toBe(false);
    expect(isInvocationId(invocation)).toBe(true);
    // Version 7 and the RFC 9562 variant, so the value is a real UUIDv7 and
    // not a v4 with a relabelled prefix.
    expect(one.slice(4).split("-")[2]![0]).toBe("7");
    expect("89ab").toContain(one.slice(4).split("-")[3]![0]!);
  });

  test("a well-formed handle is not an authorization claim", () => {
    expect(isEntityId("a".repeat(55))).toBe(true);
    expect(isEntityId("a".repeat(54))).toBe(false);
    expect(isEntityId(`${"a".repeat(54)}+`)).toBe(false);
    expect(isEntityId(clientRef())).toBe(false);
  });

  test("the public wire pattern is the engine's sealed envelope pattern", () => {
    expect(ENTITY_ID_PATTERN.source).toBe(SEALED_ENTITY_ID_PATTERN.source);
    expect(ENTITY_ID_CODEC).toBe(ENTITY_ID_CODEC_VERSION);
  });

  test("the client reads the same preamble the server sealed", async () => {
    for (const eid of [0, 1, 4096, Number.MAX_SAFE_INTEGER]) {
      const handle = await sealEntityId(sealing, idScope, eid);
      expect(isEntityId(handle)).toBe(true);
      expect(entityIdEnvelope(handle)).toEqual({
        codecVersion: ENTITY_ID_CODEC_VERSION,
        keyId: root.keyId,
      });
    }
  });

  test("a key epoch is visible without any key material", async () => {
    const mine = await sealEntityId(sealing, idScope, 7);
    const theirs = await sealEntityId(sealingKeyOf(otherRoot), idScope, 7);
    expect(entityIdEnvelope(mine)!.keyId).not.toBe(entityIdEnvelope(theirs)!.keyId);
    expect(sealingEpochOf(mine)).toEqual({
      codecVersion: ENTITY_ID_CODEC_VERSION,
      keyId: root.keyId,
    });
    expect(sealingEpochOf("not a handle")).toBeUndefined();
  });
});

describe("allocation slots", () => {
  test("normalize to a canonical order regardless of author key order", () => {
    expect(allocationSlots({ zebra: ["z"], apple: ["a", 0] })).toEqual([
      { slot: "apple", path: ["a", 0] },
      { slot: "zebra", path: ["z"] },
    ]);
    expect(allocationSlots()).toEqual([]);
  });

  test("two slots may not allocate the same output position", () => {
    expect(() => allocationSlots({ one: ["issue"], two: ["issue"] })).toThrow(
      /same output position/,
    );
  });

  test("slot names and path segments are validated", () => {
    expect(() => allocationSlots({ "9bad": ["a"] })).toThrow(/allocation slot/);
    expect(() => allocationSlots({ ok: ["", "a"] as never })).toThrow(/path segment/);
    expect(() => allocationSlots({ ok: [-1] as never })).toThrow(/path segments/);
    expect(() => allocationSlots({ ok: "issue" as never })).toThrow(/output path array/);
  });

  test("a declared path reads exactly its output position", () => {
    const output = { issues: [{ id: 3 }, { id: 5 }] };
    expect(readAllocationPath(output, ["issues", 1, "id"])).toBe(5);
    expect(readAllocationPath(output, ["issues", 9, "id"])).toBeUndefined();
    expect(readAllocationPath(output, ["issues", "id"])).toBeUndefined();
    expect(allocationPathKey(["issues", 1, "id"])).toBe(".issues#1.id");
  });
});

/** `Data.TaggedError` carries its detail in `reason`, not in `message`. */
const rejection = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof OutboxRecordInvalid) return error.reason;
    throw error;
  }
  throw new Error("expected the draft to be rejected");
};

describe("building one durable queue record", () => {
  test("stamps the stable partition, never the read-view-bearing one", () => {
    const record = buildOutboxRecord(draft(), scopeKey, 1);
    expect(record.partition).toBe(mutationPartitionKey(receiver));
    expect(record.partition.startsWith(mutationScopePrefix(receiver))).toBe(true);
    expect(record.partition).not.toContain("ramose-replica-v");
    expect(record.sequence).toBe(1);
    expect(record.scope).toBe(scopeKey);
  });

  test("persists identity, version, target, and input — and nothing executable", () => {
    const record = buildOutboxRecord(draft(), scopeKey, 1);
    expect(Object.keys(record).sort()).toEqual([
      "allocations",
      "enqueuedAt",
      "input",
      "inputRefs",
      "invocation",
      "operation",
      "operationVersion",
      "partition",
      "receiver",
      "scope",
      "sealing",
      "sequence",
      "target",
    ]);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("function");
    expect(serialized).not.toContain("unitHash");
  });

  test("rejects an input value JSON cannot carry", () => {
    for (
      const input of [
        { fn: (): void => undefined },
        { nan: Number.NaN },
        { deep: { infinite: Number.POSITIVE_INFINITY } },
        { big: 1n },
        { made: new Map() },
      ] as unknown[]
    ) {
      expect(() => buildOutboxRecord(draft({ input: input as never }), scopeKey, 1))
        .toThrow(OutboxRecordInvalid);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(rejection(() => buildOutboxRecord(draft({ input: cyclic as never }), scopeKey, 1)))
      .toMatch(/cyclic/);
  });

  test("a declared input reference must actually be at its declared position", () => {
    const ref = clientRef();
    expect(rejection(() =>
      buildOutboxRecord(
        draft({ input: { author: ref }, inputRefs: [{ path: ["owner"], ref }] }),
        scopeKey,
        1,
      )
    )).toMatch(/does not hold the declared reference/);
    const ok = buildOutboxRecord(
      draft({ input: { author: ref }, inputRefs: [{ path: ["author"], ref }] }),
      scopeKey,
      1,
    );
    expect(ok.inputRefs).toEqual([{ path: ["author"], ref }]);
  });

  test("rejects duplicate slots, reused refs, and duplicate positions", () => {
    const ref = clientRef();
    expect(rejection(() =>
      buildOutboxRecord(
        draft({ allocations: [{ slot: "a", clientRef: ref }, { slot: "a", clientRef: clientRef() }] }),
        scopeKey,
        1,
      )
    )).toMatch(/declared twice/);
    expect(rejection(() =>
      buildOutboxRecord(
        draft({ allocations: [{ slot: "a", clientRef: ref }, { slot: "b", clientRef: ref }] }),
        scopeKey,
        1,
      )
    )).toMatch(/reuses another slot/);
    expect(rejection(() =>
      buildOutboxRecord(
        draft({
          input: { a: ref },
          inputRefs: [{ path: ["a"], ref }, { path: ["a"], ref }],
        }),
        scopeKey,
        1,
      )
    )).toMatch(/declared twice/);
  });

  test("rejects a malformed identity, version, or target", () => {
    expect(rejection(() =>
      buildOutboxRecord(draft({ invocation: "nope" as never }), scopeKey, 1)
    )).toMatch(/invocation id/);
    expect(rejection(() =>
      buildOutboxRecord(draft({ operationVersion: "abc" as never }), scopeKey, 1)
    )).toMatch(/operation version/);
    expect(rejection(() =>
      buildOutboxRecord(
        draft({ target: { type: "entity", entityId: "short" as EntityId } }),
        scopeKey,
        1,
      )
    )).toMatch(/sealed entity handle/);
    expect(rejection(() => buildOutboxRecord(draft(), scopeKey, 0))).toMatch(/sequence/);
  });

  test("one invocation may not mix two server sealing epochs", async () => {
    const mine = await sealEntityId(sealing, idScope, 11);
    const theirs = await sealEntityId(sealingKeyOf(otherRoot), idScope, 12);
    expect(rejection(() =>
      buildOutboxRecord(
        draft({
          target: { type: "entity", entityId: mine as EntityId },
          input: { parent: theirs },
          inputRefs: [{ path: ["parent"], ref: theirs as EntityId }],
        }),
        scopeKey,
        1,
      )
    )).toMatch(/two server sealing epochs/);
  });

  test("adopts the sealing epoch of the handles it embeds", async () => {
    const handle = await sealEntityId(sealing, idScope, 13);
    const record = buildOutboxRecord(
      draft({ target: { type: "entity", entityId: handle as EntityId } }),
      scopeKey,
      1,
    );
    expect(record.sealing).toEqual({
      codecVersion: ENTITY_ID_CODEC_VERSION,
      keyId: root.keyId,
    });
    expect(buildOutboxRecord(draft(), scopeKey, 1).sealing).toBeNull();
  });
});

describe("dependencies and blocking", () => {
  const target = clientRef();
  const author = clientRef();

  const dependent = (sequence = 1): OutboxRecord =>
    buildOutboxRecord(
      draft({
        target: { type: "client-ref", clientRef: target },
        input: { author, again: author },
        inputRefs: [{ path: ["author"], ref: author }, { path: ["again"], ref: author }],
      }),
      scopeKey,
      sequence,
    );

  test("dependencies are the target first, then declared positions, deduplicated", () => {
    expect(outboxDependencies(dependent())).toEqual([target, author]);
    expect(outboxDependencies(buildOutboxRecord(draft(), scopeKey, 1))).toEqual([]);
  });

  test("an unmapped reference blocks and a durable mapping releases", () => {
    const record = dependent();
    expect(decideOutboxEntry(record, { mapped: new Set() })).toEqual({
      type: "blocked",
      missing: [target, author],
    });
    expect(decideOutboxEntry(record, { mapped: new Set([target]) })).toEqual({
      type: "blocked",
      missing: [author],
    });
    expect(decideOutboxEntry(record, { mapped: new Set([target, author]) })).toEqual({
      type: "ready",
    });
  });

  test("a record never blocks on a ref it allocates itself", () => {
    const own = clientRef();
    const record = buildOutboxRecord(
      draft({
        input: { parent: own },
        inputRefs: [{ path: ["parent"], ref: own }],
        allocations: [{ slot: "parent", clientRef: own }],
      }),
      scopeKey,
      1,
    );
    expect(decideOutboxEntry(record, { mapped: new Set() })).toEqual({ type: "ready" });
  });
});

describe("sealing-epoch quarantine", () => {
  const sealed = async (sequence = 1): Promise<OutboxRecord> =>
    buildOutboxRecord(
      draft({
        target: {
          type: "entity",
          entityId: (await sealEntityId(sealing, idScope, 21)) as EntityId,
        },
      }),
      scopeKey,
      sequence,
    );

  test("a replaced key epoch surfaces a data-free update-required", async () => {
    const record = await sealed();
    const state = decideOutboxEntry(record, {
      mapped: new Set(),
      keyId: otherRoot.keyId,
    });
    expect(state).toEqual({ type: "update-required", reason: "key-epoch" });
    // Data-free: the state names the reason and nothing about the entity.
    expect(JSON.stringify(state)).not.toContain(record.target.type === "entity"
      ? record.target.entityId
      : "");
  });

  test("the same epoch is ordinary", async () => {
    const record = await sealed();
    expect(decideOutboxEntry(record, { mapped: new Set(), keyId: root.keyId }))
      .toEqual({ type: "ready" });
  });

  test("an unconfirmed epoch never quarantines", async () => {
    const record = await sealed();
    expect(decideOutboxEntry(record, { mapped: new Set() })).toEqual({ type: "ready" });
  });

  test("an unreadable codec version quarantines without any current epoch", async () => {
    const record = await sealed();
    const future: OutboxRecord = {
      ...record,
      sealing: { codecVersion: ENTITY_ID_CODEC_VERSION + 1, keyId: root.keyId },
    };
    expect(decideOutboxEntry(future, { mapped: new Set() })).toEqual({
      type: "update-required",
      reason: "codec-version",
    });
  });

  test("quarantine outranks blocking, so a rotation is never reported as a missing ref", async () => {
    const missing = clientRef();
    const record = buildOutboxRecord(
      draft({
        target: {
          type: "entity",
          entityId: (await sealEntityId(sealing, idScope, 22)) as EntityId,
        },
        input: { author: missing },
        inputRefs: [{ path: ["author"], ref: missing }],
      }),
      scopeKey,
      1,
    );
    expect(decideOutboxEntry(record, { mapped: new Set(), keyId: otherRoot.keyId }))
      .toEqual({ type: "update-required", reason: "key-epoch" });
  });
});

describe("per-receiver FIFO planning", () => {
  const queued = (
    at: ReplicaDatabaseScope,
    sequence: number,
    overrides: Partial<OutboxDraft> = {},
  ): OutboxRecord =>
    buildOutboxRecord(draft({ receiver: at, ...overrides }), scopeKey, sequence);

  test("order is the durable sequence, not insertion or timestamp order", () => {
    const shuffled = [queued(receiver, 3), queued(receiver, 1), queued(receiver, 2)];
    const [plan] = planOutbox(shuffled, { mapped: new Set() });
    expect(plan!.entries.map((entry) => entry.record.sequence)).toEqual([1, 2, 3]);
    expect(plan!.head).toEqual({ type: "ready", record: plan!.entries[0]!.record });
  });

  test("a blocked head holds its own database and no other", () => {
    const missing = clientRef();
    const blocked = queued(receiver, 1, {
      target: { type: "client-ref", clientRef: missing },
    });
    const behind = queued(receiver, 2);
    const elsewhere = queued(otherReceiver, 1);
    const plans = planOutbox([blocked, behind, elsewhere], { mapped: new Set() });
    expect(plans).toHaveLength(2);
    const held = plans.find((plan) => plan.receiver.database === DATABASE)!;
    const free = plans.find((plan) => plan.receiver.database === OTHER_DATABASE)!;
    expect(held.head).toEqual({ type: "blocked", record: blocked, missing: [missing] });
    // The record behind the blocked head is itself ready, but FIFO means the
    // queue does not skip it forward.
    expect(held.entries[1]!.state).toEqual({ type: "ready" });
    expect(free.head).toEqual({ type: "ready", record: elsewhere });
  });

  test("a quarantined head is reported as update-required, not as an empty queue", async () => {
    const record = buildOutboxRecord(
      draft({
        target: {
          type: "entity",
          entityId: (await sealEntityId(sealing, idScope, 31)) as EntityId,
        },
      }),
      scopeKey,
      1,
    );
    const [plan] = planOutbox([record], { mapped: new Set(), keyId: otherRoot.keyId });
    expect(plan!.head).toEqual({
      type: "update-required",
      record,
      reason: "key-epoch",
    });
  });

  test("no records means no plans at all", () => {
    expect(planOutbox([], { mapped: new Set() })).toEqual([]);
  });
});

describe("strict decoding of a stored record", () => {
  const stored = (record: OutboxRecord): unknown =>
    JSON.parse(JSON.stringify(record)) as unknown;

  test("round-trips a queued invocation exactly", async () => {
    const ref = clientRef();
    const record = buildOutboxRecord(
      draft({
        target: {
          type: "entity",
          entityId: (await sealEntityId(sealing, idScope, 41)) as EntityId,
        },
        input: { author: ref, tags: ["a", "b"], count: 2, flag: true, none: null },
        inputRefs: [{ path: ["author"], ref }],
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      }),
      scopeKey,
      4,
    );
    expect(decodeOutboxRecord(stored(record))).toEqual(record);
  });

  test("refuses anything it cannot fully interpret", async () => {
    const record = buildOutboxRecord(draft(), scopeKey, 1);
    const base = stored(record) as Record<string, unknown>;
    expect(decodeOutboxRecord(base)).toEqual(record);
    for (
      const broken of [
        { ...base, partition: "ramose-replica-v2:s:p:d:v:h" },
        { ...base, sequence: 0 },
        { ...base, invocation: "iv1_not-a-uuid" },
        { ...base, operationVersion: "ABC" },
        { ...base, operation: { ...(base.operation as object), owner: { kind: "graph", name: "x" } } },
        { ...base, target: { type: "entity", entityId: "short" } },
        { ...base, sealing: { codecVersion: 1, keyId: "short" } },
        { ...base, allocations: [{ slot: "a", clientRef: "nope" }] },
        { ...base, inputRefs: [{ path: ["a"], ref: "nope" }] },
        { ...base, input: undefined },
        "not a record",
        null,
      ]
    ) {
      expect(decodeOutboxRecord(broken)).toBeUndefined();
    }
    // A sealed target survives the round trip; only malformed ones do not.
    const sealedRecord = buildOutboxRecord(
      draft({
        target: {
          type: "entity",
          entityId: (await sealEntityId(sealing, idScope, 42)) as EntityId,
        },
      }),
      scopeKey,
      1,
    );
    expect(decodeOutboxRecord(stored(sealedRecord))).toEqual(sealedRecord);
  });
});

describe("mutation partition keys", () => {
  test("a scope prefix selects its own queues and no other realm", () => {
    const mine = mutationPartitionKey(receiver);
    const sibling = mutationPartitionKey(otherReceiver);
    const stranger = mutationPartitionKey({ ...receiver, principal: opaque("q") });
    const prefix = mutationScopePrefix(receiver);
    expect(mine.startsWith(prefix)).toBe(true);
    expect(sibling.startsWith(prefix)).toBe(true);
    expect(stranger.startsWith(prefix)).toBe(false);
  });

  test("the key excludes the read view and the read-compatibility hash", () => {
    expect(mutationPartitionKey(receiver)).toBe(
      ["ramose-mutation-v1", SERVER, PRINCIPAL, DATABASE].join(":"),
    );
  });
});
