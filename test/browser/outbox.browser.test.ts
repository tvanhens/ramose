import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { clientRef, invocationId } from "../../packages/ramose/src/db/refs.ts";
import type { EntityId } from "../../packages/ramose/src/db/refs.ts";
import {
  sealEntityId,
  type EntityIdScope,
} from "../../packages/ramose/src/internal/replication/entity-id.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  OutboxDraft,
  QueuedMapping,
  ReceiptRecord,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import {
  ActivationFence,
  type ActivationFenceSnapshot,
} from "../../packages/ramose/src/internal/replication/activation-fence.ts";
import { ReplicationSession } from "../../packages/ramose/src/internal/replication/session.ts";
import type { ClientRef } from "../../packages/ramose/src/db/refs.ts";
import {
  mappingKey,
  mutationPartitionKey,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  runSubmissionPass,
  substituteMutationRefs,
  type MutationEndpoint,
} from "../../packages/ramose/src/internal/replication/submission.ts";
import { submitMutation } from "../../packages/ramose/src/internal/replication/transport.ts";
import {
  generateServerIdentityRoot,
  sealingKeyOf,
} from "../../packages/ramose/src/internal/replication/server-identity.ts";
import {
  armCheckpoint,
  releaseCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const opaque = (character: string): string => character.repeat(43);

const rejectedTag = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { readonly _tag?: string })._tag ?? String(error);
  }
  throw new Error("expected the enqueue to be refused");
};

const SERVER = opaque("s");
const LEFT = opaque("l");
const RIGHT = opaque("r");
const ROOT_DATABASE = opaque("d");
const OTHER_DATABASE = opaque("e");
const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));

const identity = (overrides: Partial<ReplicationIdentity> = {}): ReplicationIdentity => ({
  version: 1,
  server: SERVER,
  principal: LEFT,
  database: ROOT_DATABASE,
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: READ_COMPATIBILITY,
  authenticator: opaque("a"),
  ...overrides,
});

const root = generateServerIdentityRoot(1_700_000_000_000);
const rotated = generateServerIdentityRoot(1_700_000_000_001);

const idScope = (receiver: ReplicaDatabaseScope): EntityIdScope => ({
  server: receiver.server,
  principal: receiver.principal,
  database: receiver.database,
});

const version = "b".repeat(64) as OperationVersion;

const draft = (
  receiver: ReplicaDatabaseScope,
  overrides: Partial<OutboxDraft> = {},
): OutboxDraft => ({
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
  enqueuedAt: Date.now(),
  ...overrides,
});

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });

const openVersioned = (
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => upgrade(request.result), { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("upgrade blocked")), {
      once: true,
    });
  });

const openNative = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const dumpMutations = async (name: string): Promise<Record<string, unknown[]>> => {
  const database = await openNative(name);
  const stores = [...database.objectStoreNames].filter((store) =>
    store.startsWith("mutation-")
  );
  const transaction = database.transaction(stores, "readonly");
  const contents: Record<string, unknown[]> = {};
  for (const store of stores) {
    contents[store] = await requestResult<unknown[]>(
      transaction.objectStore(store).getAll(),
    );
  }
  await transactionDone(transaction);
  database.close();
  return contents;
};

const REPLICA_ATTRIBUTES: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", index: true },
];

const dropped = (value: { readonly release: () => void } | undefined): void => {
  value?.release();
};

const confirm = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  label: string,
): Promise<void> => {
  await storage.bindAuthenticated({
    fingerprint: `fingerprint-${label}`,
    identity: selected,
    candidateKey: { selector: `selector-${label}`, routeSlot: `slot-${label}` },
  });
  const snapshot = `snapshot-${label}`.padEnd(43, "0");
  const revision = `revision-${label}`.padEnd(43, "0");
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 3, identity: selected, snapshot, revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk",
    protocol: 3,
    identity: selected,
    snapshot,
    index: 0,
    datoms: [{
      entity: `entity-${label}`.padEnd(43, "0"),
      field: ":item/name",
      value: { type: "string", value: label },
      op: "add",
    }],
  }));
  dropped(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 3, identity: selected, snapshot, revision, ordinal: 1, chunks: 1,
  }, REPLICA_ATTRIBUTES));
};

browserTest("one enqueue is all-or-nothing across a crash cut", async ({ browser }) => {
  const name = `ramose-outbox-atomic-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    const allocation = clientRef();

    armCheckpoint("outbox.enqueue", "throw", "cut before the enqueue committed");
    try {
      await expect(
        outbox.enqueue(
          draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
          { scope },
        ),
      ).rejects.toThrow(/cut before the enqueue/);
    } finally {
      resetTestHooks();
    }

    const cut = await dumpMutations(name);
    for (const [store, records] of Object.entries(cut)) {
      expect([store, records]).toEqual([store, []]);
    }
    expect((await outbox.restore(scope)).records).toEqual([]);

    const record = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    const committed = await dumpMutations(name);
    expect(committed["mutation-outbox-v1"]).toHaveLength(1);
    expect(committed["mutation-queues-v1"]).toEqual([{
      partition: mutationPartitionKey(receiver),
      scope: record.scope,
      receiver: { ...receiver },
      nextSequence: 2,
      sealing: null,

      activation: 0,
      updatedAt: record.enqueuedAt,
    }]);
    expect(committed["mutation-receipts-v1"]).toEqual([{
      partition: record.partition,
      invocation: record.invocation,
      scope: record.scope,
      state: "queued",
      observation: null,
      activation: 0,
      output: null,
      mappings: [],
      failure: null,
      updatedAt: record.enqueuedAt,
    }]);
    expect(committed["mutation-client-refs-v1"]).toEqual([{
      partition: record.partition,
      clientRef: allocation,
      invocation: record.invocation,
      slot: "issue",
      createdAt: record.enqueuedAt,
    }]);
    expect(committed["mutation-client-ref-mappings-v1"]).toEqual([]);
  } finally {
    resetTestHooks();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a restart reconstructs the exact per-database order", async ({ browser }) => {
  const name = `ramose-outbox-restart-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const receiver = replicaDatabaseScopeOf(left);
  const otherReceiver = replicaDatabaseScopeOf(other);
  const scope = replicaScopeOf(left);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    const outbox = storage.outbox();
    const first = await outbox.enqueue(draft(receiver, { input: { title: "one" } }), { scope });
    const second = await outbox.enqueue(draft(receiver, { input: { title: "two" } }), { scope });
    const elsewhere = await outbox.enqueue(
      draft(otherReceiver, { input: { title: "elsewhere" } }),
      { scope },
    );
    expect([first.sequence, second.sequence, elsewhere.sequence]).toEqual([1, 2, 1]);

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    const plans = await storage.outbox().plan(scope);
    expect(plans).toHaveLength(2);
    const mine = plans.find((plan) => plan.receiver.database === ROOT_DATABASE)!;
    const theirs = plans.find((plan) => plan.receiver.database === OTHER_DATABASE)!;
    expect(mine.entries.map((entry) => entry.record.invocation)).toEqual([
      first.invocation,
      second.invocation,
    ]);
    expect(mine.entries.map((entry) => entry.record.input)).toEqual([
      { title: "one" },
      { title: "two" },
    ]);
    expect(mine.head).toEqual({ type: "ready", record: mine.entries[0]!.record });
    expect(theirs.head).toEqual({ type: "ready", record: theirs.entries[0]!.record });
    expect((await storage.outbox().restore(scope)).unreadable).toEqual([]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a dependent invocation stays blocked until a durable mapping exists", async ({ browser }) => {
  const name = `ramose-outbox-blocked-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const receiver = replicaDatabaseScopeOf(left);
  const otherReceiver = replicaDatabaseScopeOf(other);
  const scope = replicaScopeOf(left);
  const allocation = clientRef();
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    let outbox = storage.outbox();

    const create = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    await outbox.enqueue(
      draft(receiver, {
        target: { type: "client-ref", clientRef: allocation },
        input: { assignee: allocation },
        inputRefs: [{ path: ["assignee"], ref: allocation }],
      }),
      { scope },
    );
    const independent = await outbox.enqueue(draft(otherReceiver), { scope });

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    outbox = storage.outbox();
    const restored = await outbox.plan(scope);
    const mine = restored.find((plan) => plan.receiver.database === ROOT_DATABASE)!;
    const theirs = restored.find((plan) => plan.receiver.database === OTHER_DATABASE)!;

    expect(mine.head.type).toBe("ready");
    expect(mine.entries[1]!.state).toEqual({ type: "blocked", missing: [allocation] });

    expect(theirs.head).toEqual({ type: "ready", record: theirs.entries[0]!.record });
    expect(theirs.entries[0]!.record.invocation).toBe(independent.invocation);

    const mapped = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 42)) as EntityId;

    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: mapped },
    ]);

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    const released = await storage.outbox().plan(scope);
    const now = released.find((plan) => plan.receiver.database === ROOT_DATABASE)!;
    expect(now.entries.map((entry) => entry.state)).toEqual([
      { type: "ready" },
      { type: "ready" },
    ]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a replaced sealing epoch quarantines the queue without clearing it", async ({ browser }) => {
  const name = `ramose-outbox-epoch-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const handle = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 7)) as EntityId;
    const queued = await storage.outbox().enqueue(
      draft(receiver, { target: { type: "entity", entityId: handle } }),
      { scope },
    );
    expect(queued.sealing).toEqual({ codecVersion: 1, keyId: root.keyId });

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    const outbox = storage.outbox();

    const same = await outbox.plan(scope, root.keyId);
    expect(same[0]!.head.type).toBe("ready");

    const rotatedPlan = await outbox.plan(scope, rotated.keyId);
    expect(rotatedPlan[0]!.head).toEqual({
      type: "update-required",
      record: rotatedPlan[0]!.entries[0]!.record,
      reason: "key-epoch",
    });
    const stored = await dumpMutations(name);
    expect(stored["mutation-outbox-v1"]).toHaveLength(1);
    expect(stored["mutation-receipts-v1"]).toHaveLength(1);

    expect((await outbox.plan(scope))[0]!.head.type).toBe("ready");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a scoped clear removes one principal's queue and preserves the other", async ({ browser }) => {
  const name = `ramose-outbox-clear-${browser.uniqueId}`;
  const left = identity();
  const right = identity({ principal: RIGHT });
  const leftReceiver = replicaDatabaseScopeOf(left);
  const rightReceiver = replicaDatabaseScopeOf(right);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, right, "right");
    const outbox = storage.outbox();
    const leftRef = clientRef();
    await outbox.enqueue(
      draft(leftReceiver, { allocations: [{ slot: "issue", clientRef: leftRef }] }),
      { scope: replicaScopeOf(left) },
    );
    await outbox.enqueue(draft(leftReceiver), { scope: replicaScopeOf(left) });
    const rightRef = clientRef();
    const kept = await outbox.enqueue(
      draft(rightReceiver, { allocations: [{ slot: "issue", clientRef: rightRef }] }),
      { scope: replicaScopeOf(right) },
    );

    const outcome = await storage.clearScope(replicaScopeOf(left));
    expect(outcome.queued).toBe(2);
    expect(outcome.clientRefs).toBe(1);

    const after = await dumpMutations(name);
    const survivors = after["mutation-outbox-v1"] as { readonly partition: string }[];
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.partition).toBe(mutationPartitionKey(rightReceiver));
    expect(after["mutation-queues-v1"]).toHaveLength(1);
    expect(after["mutation-receipts-v1"]).toHaveLength(1);
    expect(after["mutation-client-refs-v1"]).toEqual([{
      partition: mutationPartitionKey(rightReceiver),
      clientRef: rightRef,
      invocation: kept.invocation,
      slot: "issue",
      createdAt: kept.enqueuedAt,
    }]);

    expect(
      await rejectedTag(
        storage.outbox().enqueue(draft(leftReceiver), { scope: replicaScopeOf(left) }),
      ),
    ).toBe("ReplicaScopeClearedError");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an enqueue started before a clear cannot land behind it", async ({ browser }) => {
  const name = `ramose-outbox-clear-race-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const writer = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
  const maintainer = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(writer, left, "left");

    armCheckpoint("outbox.enqueue", "wait");
    const inFlight = writer.outbox().enqueue(draft(receiver), { scope });

    await maintainer.clearScope(scope);
    releaseCheckpoint("outbox.enqueue");
    expect(await rejectedTag(inFlight)).toBe("ReplicaFencedError");
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toEqual([]);

    await confirm(writer, left, "left");
    const clearing = writer.clearScope(scope);
    expect(
      await rejectedTag(writer.outbox().enqueue(draft(receiver), { scope })),
    ).toBe("ReplicaScopeClearedError");
    await clearing;
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toEqual([]);
  } finally {
    resetTestHooks();
    writer.close();
    maintainer.close();
    await deleteDatabase(name);
  }
});

browserTest("a fenced lease cannot queue work into a cleared scope", async ({ browser }) => {
  const name = `ramose-outbox-fence-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const writer = await IndexedDbReplicaStorage.open(name);
  const maintainer = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(writer, left, "left");
    const lease = await writer.leaseFor(left);
    await writer.outbox().enqueue(draft(receiver), { scope, lease });

    await maintainer.clearScope(scope);

    expect(await rejectedTag(writer.outbox().enqueue(draft(receiver), { scope, lease })))
      .toBe("ReplicaFencedError");
    const after = await dumpMutations(name);
    expect(after["mutation-outbox-v1"]).toEqual([]);

    const fresh = await writer.lease();
    const queued = await writer.outbox().enqueue(draft(receiver), { scope, lease: fresh });
    expect(queued.sequence).toBe(1);
  } finally {
    writer.close();
    maintainer.close();
    await deleteDatabase(name);
  }
});

browserTest("a receiver outside the confirmed scope is refused", async ({ browser }) => {
  const name = `ramose-outbox-scope-${browser.uniqueId}`;
  const left = identity();
  const right = identity({ principal: RIGHT });
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, right, "right");

    expect(
      await rejectedTag(
        storage.outbox().enqueue(draft(replicaDatabaseScopeOf(right)), {
          scope: replicaScopeOf(left),
        }),
      ),
    ).toBe("OutboxRecordInvalid");
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toEqual([]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("re-enqueueing one invocation id is idempotent, and reuse is refused", async ({ browser }) => {
  const name = `ramose-outbox-idempotent-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    const intent = draft(receiver, { input: { title: "once" } });
    const first = await outbox.enqueue(intent, { scope });

    const again = await outbox.enqueue({ ...intent, enqueuedAt: Date.now() + 1_000 }, {
      scope,
    });
    expect(again).toEqual(first);
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toHaveLength(1);
    expect((await outbox.restore(scope)).records).toHaveLength(1);

    expect(
      await rejectedTag(
        outbox.enqueue({ ...intent, input: { title: "different" } }, { scope }),
      ),
    ).toBe("OutboxInvocationConflict");
    const stored = (await outbox.restore(scope)).records;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.input).toEqual({ title: "once" });

    const next = await outbox.enqueue(draft(receiver, { input: { title: "two" } }), {
      scope,
    });
    expect(next.sequence).toBe(2);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an authoritative mapping is immutable and belongs to its allocation", async ({ browser }) => {
  const name = `ramose-outbox-mappings-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    const allocation = clientRef();
    const create = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    const other = await outbox.enqueue(draft(receiver), { scope });
    const mapped = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 5)) as EntityId;
    const different = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 6)) as EntityId;

    expect(
      await rejectedTag(
        outbox.recordMappings(receiver, create.invocation, [
          { clientRef: clientRef(), entityId: mapped },
        ]),
      ),
    ).toBe("ClientRefMappingRefused");
    expect(
      await rejectedTag(
        outbox.recordMappings(receiver, other.invocation, [
          { clientRef: allocation, entityId: mapped },
        ]),
      ),
    ).toBe("ClientRefMappingRefused");
    expect((await dumpMutations(name))["mutation-client-ref-mappings-v1"]).toEqual([]);

    for (const mappedAt of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(
        await rejectedTag(
          outbox.recordMappings(
            receiver,
            create.invocation,
            [{ clientRef: allocation, entityId: mapped }],
            mappedAt,
          ),
        ),
      ).toBe("OutboxRecordInvalid");
    }
    expect((await dumpMutations(name))["mutation-client-ref-mappings-v1"]).toEqual([]);

    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: mapped },
    ]);

    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: mapped },
    ]);
    const stored = (await dumpMutations(name))["mutation-client-ref-mappings-v1"] as {
      readonly entityId: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.entityId).toBe(mapped);

    expect(
      await rejectedTag(
        outbox.recordMappings(receiver, create.invocation, [
          { clientRef: allocation, entityId: different },
        ]),
      ),
    ).toBe("ClientRefMappingRefused");
    expect(
      ((await dumpMutations(name))["mutation-client-ref-mappings-v1"] as {
        readonly entityId: string;
      }[])[0]!.entityId,
    ).toBe(mapped);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a compatible read view keeps the mappings and the targets they release",
  async ({ browser }) => {
    const name = `ramose-outbox-read-view-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const allocation = clientRef();
    const mapped = (await sealEntityId(
      sealingKeyOf(root),
      idScope(receiver),
      11,
    )) as EntityId;
    const first = await IndexedDbReplicaStorage.open(name);
    let dependent: string;
    try {
      await confirm(first, left, "left");
      const outbox = first.outbox();
      const create = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
        { scope },
      );
      const queued = await outbox.enqueue(
        draft(receiver, {
          target: { type: "client-ref", clientRef: allocation },
          input: { assignee: allocation },
          inputRefs: [{ path: ["assignee"], ref: allocation }],
        }),
        { scope },
      );
      dependent = queued.invocation;
      await outbox.acknowledge(create, {
        _tag: "Committed",
        output: null,
        mappings: [{ clientRef: allocation, entityId: mapped }],
      });
    } finally {
      first.close();
    }

    const drifted = identity({
      readView: opaque("w"),
      readCompatibilityHash: ReadCompatibilityHash.make(opaque("m")),
    });
    const second = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(second, drifted, "drifted");
      const outbox = second.outbox();
      expect(await outbox.mappedHandles(receiver))
        .toEqual(new Map([[allocation, mapped]]));
      const { plans, handles } = await outbox.submissionPlan(scope);
      expect(handles).toEqual(
        new Map([[mappingKey(mutationPartitionKey(receiver), allocation), mapped]]),
      );
      const head = plans[0]!.head;
      if (head.type !== "ready") throw new Error(`the queue head is ${head.type}`);
      expect(head.record.invocation).toBe(dependent);
      expect(head.record.target).toEqual({
        type: "client-ref",
        clientRef: allocation,
      });
      expect(substituteMutationRefs(head.record, handles))
        .toEqual({ target: mapped, input: { assignee: mapped } });

      const sibling = identity({ database: OTHER_DATABASE });
      await confirm(second, sibling, "sibling");
      expect(await outbox.mappedHandles(replicaDatabaseScopeOf(sibling)))
        .toEqual(new Map());
      expect(
        (await outbox.submissionPlan(scope)).plans.map((plan) => plan.partition),
      ).toEqual([mutationPartitionKey(receiver)]);
    } finally {
      second.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("an unconfirmed scope cannot hold durable work", async ({ browser }) => {
  const name = `ramose-outbox-unconfirmed-${browser.uniqueId}`;
  const left = identity();
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    expect(
      await rejectedTag(
        storage.outbox().enqueue(draft(replicaDatabaseScopeOf(left)), {
          scope: replicaScopeOf(left),
        }),
      ),
    ).toBe("ReplicaScopeUnconfirmedError");
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toEqual([]);

    await confirm(storage, left, "left");
    const queued = await storage.outbox().enqueue(
      draft(replicaDatabaseScopeOf(left)),
      { scope: replicaScopeOf(left) },
    );
    expect(queued.sequence).toBe(1);

    const late = identity({ principal: RIGHT });
    const lateScope = replicaScopeOf(late);

    const pending = rejectedTag(
      storage.outbox().enqueue(draft(replicaDatabaseScopeOf(late)), { scope: lateScope }),
    );
    await confirm(storage, late, "right");
    expect(await pending).toBe("ReplicaScopeUnconfirmedError");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("one invocation id names one queued invocation across every database", async ({ browser }) => {
  const name = `ramose-outbox-unique-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    const outbox = storage.outbox();
    const intent = draft(replicaDatabaseScopeOf(left));
    await outbox.enqueue(intent, { scope });

    expect(
      await rejectedTag(
        outbox.enqueue({ ...intent, receiver: replicaDatabaseScopeOf(other) }, { scope }),
      ),
    ).toBe("OutboxInvocationConflict");
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toHaveLength(1);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an earlier build's mutation indexes are replaced on upgrade", async ({ browser }) => {
  const name = `ramose-outbox-indexes-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);

  const legacy = await openVersioned(name, 7, (database) => {
    database.createObjectStore("mutation-queues-v1", { keyPath: "partition" });
    const outbox = database.createObjectStore("mutation-outbox-v1", {
      keyPath: ["partition", "sequence"],
    });
    outbox.createIndex("by-invocation", ["partition", "invocation"], { unique: true });
    database.createObjectStore("mutation-receipts-v1", {
      keyPath: ["partition", "invocation"],
    });
    database.createObjectStore("mutation-client-refs-v1", {
      keyPath: ["partition", "clientRef"],
    });
    database.createObjectStore("mutation-client-ref-mappings-v1", {
      keyPath: ["partition", "clientRef"],
    });
  });
  legacy.close();

  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const inspected = await openNative(name);
    const outbox = inspected.transaction("mutation-outbox-v1", "readonly")
      .objectStore("mutation-outbox-v1");

    expect(outbox.index("by-invocation").keyPath).toBe("invocation");
    const refs = inspected.transaction("mutation-client-refs-v1", "readonly")
      .objectStore("mutation-client-refs-v1");
    expect([...refs.indexNames]).toContain("by-client-ref");
    inspected.close();

    const allocation = clientRef();
    const first = await storage.outbox().enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    expect(
      await rejectedTag(
        storage.outbox().enqueue(
          draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
          { scope },
        ),
      ),
    ).toBe("ClientRefConflict");
    expect(first.sequence).toBe(1);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("one client ref is claimed by exactly one allocating invocation", async ({ browser }) => {
  const name = `ramose-outbox-refclaim-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    const outbox = storage.outbox();
    const allocation = clientRef();
    await outbox.enqueue(
      draft(replicaDatabaseScopeOf(left), {
        allocations: [{ slot: "issue", clientRef: allocation }],
      }),
      { scope },
    );

    expect(
      await rejectedTag(
        outbox.enqueue(
          draft(replicaDatabaseScopeOf(other), {
            allocations: [{ slot: "issue", clientRef: allocation }],
          }),
          { scope },
        ),
      ),
    ).toBe("ClientRefConflict");

    expect(
      await rejectedTag(
        outbox.enqueue(
          draft(replicaDatabaseScopeOf(left), {
            allocations: [{ slot: "issue", clientRef: allocation }],
          }),
          { scope },
        ),
      ),
    ).toBe("ClientRefConflict");
    const stored = await dumpMutations(name);
    expect(stored["mutation-client-refs-v1"]).toHaveLength(1);
    expect(stored["mutation-outbox-v1"]).toHaveLength(1);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a dependency owned by another database is refused at enqueue", async ({ browser }) => {
  const name = `ramose-outbox-crossref-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const receiver = replicaDatabaseScopeOf(left);
  const otherReceiver = replicaDatabaseScopeOf(other);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    const outbox = storage.outbox();
    const allocation = clientRef();
    await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );

    expect(
      await rejectedTag(
        outbox.enqueue(
          draft(otherReceiver, {
            target: { type: "client-ref", clientRef: allocation },
          }),
          { scope },
        ),
      ),
    ).toBe("ClientRefConflict");

    expect(
      await rejectedTag(
        outbox.enqueue(
          draft(receiver, { target: { type: "client-ref", clientRef: clientRef() } }),
          { scope },
        ),
      ),
    ).toBe("OutboxRecordInvalid");

    const dependent = await outbox.enqueue(
      draft(receiver, { target: { type: "client-ref", clientRef: allocation } }),
      { scope },
    );
    expect(dependent.sequence).toBe(2);
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toHaveLength(2);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a mapping whose epoch was rewritten does not release its queue", async ({ browser }) => {
  const name = `ramose-outbox-forged-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    const allocation = clientRef();
    const create = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    await outbox.enqueue(
      draft(receiver, { target: { type: "client-ref", clientRef: allocation } }),
      { scope },
    );

    const stale = (await sealEntityId(
      sealingKeyOf(rotated),
      idScope(receiver),
      9,
    )) as EntityId;
    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: stale },
    ]);
    storage.close();

    const raw = await openNative(name);
    const forge = raw.transaction("mutation-client-ref-mappings-v1", "readwrite");
    const store = forge.objectStore("mutation-client-ref-mappings-v1");
    const stored = await requestResult<Record<string, unknown>>(
      store.get([mutationPartitionKey(receiver), allocation]) as IDBRequest<
        Record<string, unknown>
      >,
    );
    store.put({ ...stored, sealing: { codecVersion: 1, keyId: root.keyId } });
    await transactionDone(forge);
    raw.close();

    storage = await IndexedDbReplicaStorage.open(name);
    const plans = await storage.outbox().plan(scope, root.keyId);
    const mine = plans.find((plan) => plan.receiver.database === ROOT_DATABASE)!;

    expect(mine.entries[1]!.state).toEqual({ type: "blocked", missing: [allocation] });
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an undecodable stored row holds its queue instead of promoting the next", async ({ browser }) => {
  const name = `ramose-outbox-unreadable-${browser.uniqueId}`;
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    await confirm(storage, other, "left-other");
    const outbox = storage.outbox();
    await outbox.enqueue(draft(receiver, { input: { title: "one" } }), { scope });
    const second = await outbox.enqueue(draft(receiver, { input: { title: "two" } }), {
      scope,
    });
    await outbox.enqueue(draft(replicaDatabaseScopeOf(other)), { scope });
    storage.close();

    const raw = await openNative(name);
    const corrupt = raw.transaction("mutation-outbox-v1", "readwrite");
    const store = corrupt.objectStore("mutation-outbox-v1");
    const head = await requestResult<Record<string, unknown>>(
      store.get([mutationPartitionKey(receiver), 1]) as IDBRequest<Record<string, unknown>>,
    );
    store.put({ ...head, operationVersion: "not-a-digest" });
    await transactionDone(corrupt);
    raw.close();

    storage = await IndexedDbReplicaStorage.open(name);
    const restored = await storage.outbox().restore(scope);
    expect(restored.unreadable).toEqual([
      { partition: mutationPartitionKey(receiver), sequence: 1 },
    ]);
    const plans = await storage.outbox().plan(scope);
    const held = plans.find((plan) => plan.receiver.database === ROOT_DATABASE)!;

    expect(held.entries.map((entry) => entry.record.invocation)).toEqual([
      second.invocation,
    ]);
    expect(held.head).toEqual({ type: "unreadable", sequence: 1 });

    expect(
      plans.find((plan) => plan.receiver.database === OTHER_DATABASE)!.head.type,
    ).toBe("ready");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("no adversarial value can reach a mutation store", async ({ browser }) => {
  const name = `ramose-outbox-adversarial-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();

    const allocation = clientRef();
    const healthy = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    const before = JSON.stringify(await dumpMutations(name));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const dependency = clientRef();
    const attacks: readonly (readonly [string, OutboxDraft])[] = [

      ["invocation id", draft(receiver, { invocation: "iv1_nope" as never })],
      ["operation version", draft(receiver, { operationVersion: "ABC" as never })],
      ["operation name", draft(receiver, {
        operation: { catalog: "movies" as never, owner: { kind: "entity", name: "i" }, localName: "" },
      })],
      ["enqueue timestamp", draft(receiver, { enqueuedAt: Number.NaN })],
      ["fractional timestamp", draft(receiver, { enqueuedAt: 1.5 })],

      ["truncated handle", draft(receiver, {
        target: { type: "entity", entityId: "short" as EntityId },
      })],
      ["respelled handle", draft(receiver, {
        target: { type: "entity", entityId: `${"a".repeat(54)}B` as EntityId },
      })],
      ["forged client ref", draft(receiver, {
        target: { type: "client-ref", clientRef: "cr1_nope" as never },
      })],

      ["function in input", draft(receiver, { input: { fn: () => undefined } as never })],
      ["NaN in input", draft(receiver, { input: { n: Number.NaN } as never })],
      ["bigint in input", draft(receiver, { input: { big: 1n } as never })],
      ["Map in input", draft(receiver, { input: { made: new Map() } as never })],
      ["Date in input", draft(receiver, { input: { at: new Date() } as never })],
      ["cyclic input", draft(receiver, { input: cyclic as never })],
      ["sparse array input", draft(receiver, { input: { list: [, 1] } as never })],
      ["lone surrogate value", draft(receiver, { input: { title: "\ud800" } })],
      ["lone surrogate key", draft(receiver, { input: { "\udc00": "x" } })],

      ["empty path segment", draft(receiver, {
        input: { "": dependency },
        inputRefs: [{ path: [""], ref: dependency }],
      })],
      ["fractional index", draft(receiver, {
        input: { a: [dependency] },
        inputRefs: [{ path: ["a", 1.5], ref: dependency }],
      })],
      ["path that does not hold its ref", draft(receiver, {
        input: { author: dependency },
        inputRefs: [{ path: ["owner"], ref: dependency }],
      })],
      ["inherited path", draft(receiver, {
        input: {},
        inputRefs: [{ path: ["constructor"], ref: dependency }],
      })],

      ["empty slot name", draft(receiver, {
        allocations: [{ slot: "", clientRef: clientRef() }],
      })],
      ["duplicate slot", draft(receiver, {
        allocations: [
          { slot: "issue", clientRef: clientRef() },
          { slot: "issue", clientRef: clientRef() },
        ],
      })],
      ["self-dependent allocation", (() => {
        const own = clientRef();
        return draft(receiver, {
          target: { type: "client-ref", clientRef: own },
          allocations: [{ slot: "issue", clientRef: own }],
        });
      })()],

      ["foreign receiver", draft(
        { ...receiver, principal: RIGHT },
      )],
      ["unallocated dependency", draft(receiver, {
        target: { type: "client-ref", clientRef: clientRef() },
      })],
      ["reused client ref", draft(receiver, {
        allocations: [{ slot: "issue", clientRef: allocation }],
      })],
    ];

    const refusals: string[] = [];
    for (const [label, attack] of attacks) {
      refusals.push(`${label}: ${await rejectedTag(outbox.enqueue(attack, { scope }))}`);
    }
    expect(refusals).toHaveLength(attacks.length);

    expect(JSON.stringify(await dumpMutations(name))).toBe(before);

    const restored = await outbox.restore(scope);
    expect(restored.unreadable).toEqual([]);
    expect(restored.records).toEqual([healthy]);
    expect((await outbox.plan(scope))[0]!.head).toEqual({
      type: "ready",
      record: healthy,
    });
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("no adversarial mapping can reach the mapping store", async ({ browser }) => {
  const name = `ramose-outbox-adversarial-mappings-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    const allocation = clientRef();
    const create = await outbox.enqueue(
      draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
      { scope },
    );
    const handle = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 4)) as EntityId;
    const before = JSON.stringify(await dumpMutations(name));

    const attacks: readonly (readonly [string, QueuedMapping, number])[] = [
      ["forged ref", { clientRef: "cr1_nope" as never, entityId: handle }, 1],
      ["truncated handle", { clientRef: allocation, entityId: "short" as EntityId }, 1],
      [
        "respelled handle",
        { clientRef: allocation, entityId: `${"a".repeat(54)}B` as EntityId },
        1,
      ],
      ["NaN timestamp", { clientRef: allocation, entityId: handle }, Number.NaN],
      ["negative timestamp", { clientRef: allocation, entityId: handle }, -1],
      ["fractional timestamp", { clientRef: allocation, entityId: handle }, 1.5],
      ["unallocated ref", { clientRef: clientRef(), entityId: handle }, 1],
    ];
    const refusals: string[] = [];
    for (const [label, mapping, mappedAt] of attacks) {
      refusals.push(`${label}: ${
        await rejectedTag(
          outbox.recordMappings(receiver, create.invocation, [mapping], mappedAt),
        )
      }`);
    }
    expect(refusals).toHaveLength(attacks.length);
    expect(JSON.stringify(await dumpMutations(name))).toBe(before);

    const foreign = clientRef();
    let reads = 0;
    await outbox.recordMappings(receiver, create.invocation, [{
      get clientRef(): ClientRef {
        reads++;
        return reads === 1 ? allocation : foreign;
      },
      entityId: handle,
    } as QueuedMapping], 1_700_000_000_000);
    expect(reads).toBe(1);
    expect(await outbox.mappedRefs(scope)).toEqual(
      new Map([[
        mappingKey(mutationPartitionKey(receiver), allocation),
        { codecVersion: 1, keyId: root.keyId },
      ]]),
    );
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

const UNREACHABLE: MutationEndpoint = Object.freeze({
  origin: "http://127.0.0.1:1",
  database: "movies",
  credential: "token",
});

browserTest(
  "an acknowledgement is one client transaction across a crash cut",
  async ({ browser }) => {
    const name = `ramose-outbox-acknowledge-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
        { scope },
      );
      const mapped = await sealEntityId(
        sealingKeyOf(root),
        idScope(receiver),
        4242,
      ) as EntityId;
      const committed = {
        _tag: "Committed",
        output: { id: "opaque" },
        mappings: [{ clientRef: allocation, entityId: mapped }],
      } as const;
      const queued = JSON.stringify(await dumpMutations(name));

      armCheckpoint(
        "outbox.acknowledge",
        "throw",
        "cut before the acknowledgement committed",
      );
      try {
        await expect(outbox.acknowledge(record, committed, 1_700_000_000_001))
          .rejects.toThrow(/cut before the acknowledgement/);
      } finally {
        resetTestHooks();
      }

      expect(JSON.stringify(await dumpMutations(name))).toBe(queued);

      const receipt = await outbox.acknowledge(record, committed, 1_700_000_000_002);
      expect(receipt).toEqual({
        partition: record.partition,
        invocation: record.invocation,
        scope: record.scope,
        state: "committed",

        observation: "unobserved",
        activation: 0,
        output: { id: "opaque" },
        mappings: [{ clientRef: allocation, entityId: mapped }],
        failure: null,
        updatedAt: 1_700_000_000_002,
      });
      const after = await dumpMutations(name);
      expect(after["mutation-outbox-v1"]).toEqual([]);
      expect(after["mutation-receipts-v1"]).toEqual([receipt]);
      expect(after["mutation-client-ref-mappings-v1"]).toEqual([{
        partition: record.partition,
        clientRef: allocation,
        entityId: mapped,
        sealing: { codecVersion: 1, keyId: root.keyId },
        invocation: record.invocation,
        mappedAt: 1_700_000_000_002,
      }]);
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a lost acknowledgement converges without a second commit",
  async ({ browser }) => {
    const name = `ramose-outbox-lost-ack-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
        { scope },
      );
      const mapped = await sealEntityId(
        sealingKeyOf(root),
        idScope(receiver),
        4242,
      ) as EntityId;
      const committed = {
        _tag: "Committed",
        output: { id: "opaque" },
        mappings: [{ clientRef: allocation, entityId: mapped }],
      } as const;

      const first = await outbox.acknowledge(record, committed, 1_700_000_000_002);
      const settled = JSON.stringify(await dumpMutations(name));

      expect(await outbox.acknowledge(record, committed, 1_700_000_000_009))
        .toEqual(first);
      expect(JSON.stringify(await dumpMutations(name))).toBe(settled);

      expect(
        await rejectedTag(outbox.acknowledge(record, {
          _tag: "Committed",
          output: { id: "opaque" },
          mappings: [{
            clientRef: allocation,
            entityId: await sealEntityId(
              sealingKeyOf(root),
              idScope(receiver),
              99,
            ) as EntityId,
          }],
        })),
      ).toBe("OutboxInvocationConflict");
      expect(
        await rejectedTag(
          outbox.acknowledge(record, { _tag: "Rejected", code: "unauthorized" }),
        ),
      ).toBe("OutboxInvocationConflict");
      expect(JSON.stringify(await dumpMutations(name))).toBe(settled);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an acknowledgement that leaves an allocated slot unmapped is refused",
  async ({ browser }) => {
    const name = `ramose-outbox-unmapped-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: clientRef() }] }),
        { scope },
      );
      const before = JSON.stringify(await dumpMutations(name));

      expect(
        await rejectedTag(outbox.acknowledge(record, {
          _tag: "Committed",
          output: null,
          mappings: [],
        })),
      ).toBe("ClientRefMappingRefused");
      expect(JSON.stringify(await dumpMutations(name))).toBe(before);
      expect((await outbox.receipt(receiver, record.invocation))?.state)
        .toBe("queued");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an authoritative output the canonicalizer would refuse still commits",
  async ({ browser }) => {
    const name = `ramose-outbox-output-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(draft(receiver), { scope });

      const output = { "\ud800": `lone \udfff surrogate` };
      const receipt = await outbox.acknowledge(
        record,
        { _tag: "Committed", output, mappings: [] },
        1_700_000_000_004,
      );
      expect(receipt.state).toBe("committed");
      expect(receipt.output).toEqual(output);
      expect((await outbox.receipt(receiver, record.invocation))?.output)
        .toEqual(output);
      expect(
        await rejectedTag(
          outbox.enqueue(draft(receiver, { input: { title: "\ud800" } }), { scope }),
        ),
      ).toBe("OutboxRecordInvalid");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a rejection is terminal, typed, and leaves no queued work",
  async ({ browser }) => {
    const name = `ramose-outbox-rejected-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(draft(receiver), { scope });
      const receipt = await outbox.acknowledge(
        record,
        { _tag: "Rejected", code: "invocation_conflict" },
        1_700_000_000_003,
      );
      expect(receipt).toEqual({
        partition: record.partition,
        invocation: record.invocation,
        scope: record.scope,
        state: "rejected",

        observation: null,
        activation: 0,
        output: null,
        mappings: [],
        failure: { code: "invocation_conflict" },
        updatedAt: 1_700_000_000_003,
      });
      const after = await dumpMutations(name);
      expect(after["mutation-outbox-v1"]).toEqual([]);
      expect(after["mutation-client-ref-mappings-v1"]).toEqual([]);

      expect(await outbox.plan(scope)).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a settled invocation id is still owned after its row is gone",
  async ({ browser }) => {
    const name = `ramose-outbox-ownership-${browser.uniqueId}`;
    const left = identity();
    const other = identity({ database: OTHER_DATABASE });
    const receiver = replicaDatabaseScopeOf(left);
    const otherReceiver = replicaDatabaseScopeOf(other);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      await confirm(storage, other, "left-other");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(draft(receiver), { scope });
      await outbox.acknowledge(
        record,
        { _tag: "Committed", output: null, mappings: [] },
        1_700_000_000_007,
      );

      for (const target of [receiver, otherReceiver]) {
        expect(
          await rejectedTag(outbox.enqueue(
            draft(target, { invocation: record.invocation }),
            { scope },
          )),
        ).toBe("OutboxInvocationConflict");
      }
      expect(await outbox.plan(scope)).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a repeated acknowledgement with a different output is never a replay",
  async ({ browser }) => {
    const name = `ramose-outbox-output-conflict-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(draft(receiver), { scope });
      await outbox.acknowledge(
        record,
        {
          _tag: "Committed",
          output: JSON.parse('{"id":"first","tags":["a","b"]}'),
          mappings: [],
        },
        1_700_000_000_008,
      );
      const settled = JSON.stringify(await dumpMutations(name));

      for (const output of [
        { id: "second", tags: ["a", "b"] },
        { id: "first", tags: ["b", "a"] },
        null,
      ]) {
        expect(
          await rejectedTag(outbox.acknowledge(record, {
            _tag: "Committed",
            output,
            mappings: [],
          })),
        ).toBe("OutboxInvocationConflict");
      }
      expect(JSON.stringify(await dumpMutations(name))).toBe(settled);

      await outbox.acknowledge(
        record,
        {
          _tag: "Committed",
          output: JSON.parse('{"tags":["a","b"],"id":"first"}'),
          mappings: [],
        },
        1_700_000_000_009,
      );
      expect(JSON.stringify(await dumpMutations(name))).toBe(settled);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a rejection carries its dependents with it instead of stranding them",
  async ({ browser }) => {
    const name = `ramose-outbox-cascade-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const first = clientRef();
      const second = clientRef();

      const allocator = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: first }] }),
        { scope },
      );
      const middle = await outbox.enqueue(
        draft(receiver, {
          target: { type: "client-ref", clientRef: first },
          allocations: [{ slot: "issue", clientRef: second }],
        }),
        { scope },
      );
      const last = await outbox.enqueue(
        draft(receiver, {
          input: { assignee: second },
          inputRefs: [{ path: ["assignee"], ref: second }],
        }),
        { scope },
      );
      const unrelated = await outbox.enqueue(
        draft(receiver, { input: { title: "independent" } }),
        { scope },
      );

      await outbox.acknowledge(
        allocator,
        { _tag: "Rejected", code: "invocation_conflict" },
        1_700_000_000_005,
      );

      const states = await Promise.all(
        [allocator, middle, last, unrelated].map(async (record) => [
          record.invocation,
          (await outbox.receipt(receiver, record.invocation))?.state,
          (await outbox.receipt(receiver, record.invocation))?.failure?.code,
        ]),
      );
      expect(states).toEqual([
        [allocator.invocation, "rejected", "invocation_conflict"],
        [middle.invocation, "rejected", "dependency_rejected"],
        [last.invocation, "rejected", "dependency_rejected"],

        [unrelated.invocation, "queued", undefined],
      ]);
      const plans = await outbox.plan(scope);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.head).toEqual({ type: "ready", record: unrelated });

      expect(
        await rejectedTag(outbox.enqueue(
          draft(receiver, {
            input: { assignee: first },
            inputRefs: [{ path: ["assignee"], ref: first }],
          }),
          { scope },
        )),
      ).toBe("OutboxRecordInvalid");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an unreadable mapping row is repaired by the authoritative acknowledgement",
  async ({ browser }) => {
    const name = `ramose-outbox-repair-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await outbox.enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
        { scope },
      );
      const mapped = await sealEntityId(
        sealingKeyOf(root),
        idScope(receiver),
        4242,
      ) as EntityId;

      storage.close();
      const raw = await openNative(name);
      const write = raw.transaction("mutation-client-ref-mappings-v1", "readwrite");
      write.objectStore("mutation-client-ref-mappings-v1").put({
        partition: record.partition,
        clientRef: allocation,
        entityId: mapped,
        invocation: record.invocation,
        mappedAt: 1_700_000_000_000,
      });
      await transactionDone(write);
      raw.close();

      const reopened = await IndexedDbReplicaStorage.open(name);
      try {
        expect(await reopened.outbox().mappedRefs(scope)).toEqual(new Map());
        await reopened.outbox().acknowledge(
          record,
          {
            _tag: "Committed",
            output: null,
            mappings: [{ clientRef: allocation, entityId: mapped }],
          },
          1_700_000_000_006,
        );

        expect(await reopened.outbox().mappedRefs(scope)).toEqual(
          new Map([[
            mappingKey(record.partition, allocation),
            { codecVersion: 1, keyId: root.keyId },
          ]]),
        );
      } finally {
        reopened.close();
      }
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a dependent invocation submits only after its mapping persists",
  async ({ browser }) => {
    const name = `ramose-outbox-dependent-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const allocation = clientRef();
      const create = await storage.outbox().enqueue(
        draft(receiver, { allocations: [{ slot: "issue", clientRef: allocation }] }),
        { scope },
      );
      const dependent = await storage.outbox().enqueue(
        draft(receiver, {
          target: { type: "client-ref", clientRef: allocation },
          input: { assignee: allocation },
          inputRefs: [{ path: ["assignee"], ref: allocation }],
        }),
        { scope },
      );

      const blocked = await storage.outbox().submissionPlan(scope);
      expect(blocked.plans[0]!.head).toMatchObject({ type: "ready" });
      expect(blocked.plans[0]!.entries[1]!.state).toEqual({
        type: "blocked",
        missing: [allocation],
      });
      expect(substituteMutationRefs(dependent, blocked.handles)).toBeUndefined();

      const mapped = await sealEntityId(
        sealingKeyOf(root),
        idScope(receiver),
        4242,
      ) as EntityId;
      await storage.outbox().acknowledge(create, {
        _tag: "Committed",
        output: null,
        mappings: [{ clientRef: allocation, entityId: mapped }],
      });

      storage.close();
      storage = await IndexedDbReplicaStorage.open(name);
      const released = await storage.outbox().submissionPlan(scope);
      expect(released.plans[0]!.head).toEqual({
        type: "ready",
        record: released.plans[0]!.entries[0]!.record,
      });
      expect(released.plans[0]!.entries[0]!.record.invocation)
        .toBe(dependent.invocation);

      expect(substituteMutationRefs(
        released.plans[0]!.entries[0]!.record,
        released.handles,
      )).toEqual({ target: mapped, input: { assignee: mapped } });
      expect(released.plans[0]!.entries[0]!.record.input)
        .toEqual({ assignee: allocation });
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "one pass moves one head per database and databases progress independently",
  async ({ browser }) => {
    const name = `ramose-outbox-pass-${browser.uniqueId}`;
    const left = identity();
    const other = identity({ database: OTHER_DATABASE });
    const receiver = replicaDatabaseScopeOf(left);
    const otherReceiver = replicaDatabaseScopeOf(other);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      await confirm(storage, other, "left-other");
      const outbox = storage.outbox();
      const first = await outbox.enqueue(draft(receiver, { input: { n: 1 } }), { scope });
      await outbox.enqueue(draft(receiver, { input: { n: 2 } }), { scope });
      const elsewhere = await outbox.enqueue(
        draft(otherReceiver, { input: { n: 3 } }),
        { scope },
      );
      const before = JSON.stringify(await dumpMutations(name));

      const pass = await runSubmissionPass({
        store: outbox,
        scope,
        endpoints: (target) =>
          target.database === ROOT_DATABASE ? UNREACHABLE : undefined,
        transport: submitMutation,
      });
      const byPartition = new Map(pass.map((entry) => [entry.partition, entry]));
      expect(byPartition.get(first.partition)!.state).toEqual({
        _tag: "Retry",
        invocation: first.invocation,
        reason: "unreachable",
      });

      expect(byPartition.get(elsewhere.partition)!.state).toEqual({
        _tag: "Offline",
      });

      expect(JSON.stringify(await dumpMutations(name))).toBe(before);
      expect((await outbox.plan(scope)).find((plan) =>
        plan.partition === first.partition
      )!.head).toEqual({ type: "ready", record: first });
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

const generator = (seed: number) => {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
};

browserTest("every interleaving of accept and refuse drains the queues", async ({ browser }) => {
  const left = identity();
  const other = identity({ database: OTHER_DATABASE });
  const receivers = [replicaDatabaseScopeOf(left), replicaDatabaseScopeOf(other)];
  const scope = replicaScopeOf(left);

  const observed = new Set<string>();

  for (const seed of [1, 7, 19, 42, 101]) {
    const name = `ramose-outbox-liveness-${browser.uniqueId}-${seed}`;
    const random = generator(seed);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      await confirm(storage, other, "left-other");
      const outbox = storage.outbox();
      const enqueued: { invocation: string; partition: string }[] = [];

      const allocatedBy = new Map<string, ClientRef[]>();

      for (let index = 0; index < 12; index++) {
        const receiver = receivers[Math.floor(random() * receivers.length)]!;
        const partition = mutationPartitionKey(receiver);
        const available = allocatedBy.get(partition) ?? [];
        const dependent = available.length > 0 && random() < 0.5;
        const allocates = random() < 0.6;
        const mine = allocates ? clientRef() : undefined;
        const on = dependent
          ? available[Math.floor(random() * available.length)]!
          : undefined;
        const record = await outbox.enqueue(
          draft(receiver, {
            ...(mine === undefined
              ? {}
              : { allocations: [{ slot: "issue", clientRef: mine }] }),
            ...(on === undefined ? {} : {
              input: { assignee: on },
              inputRefs: [{ path: ["assignee"], ref: on }],
            }),
          }),
          { scope },
        );
        enqueued.push({ invocation: record.invocation, partition });
        if (mine !== undefined) {
          allocatedBy.set(partition, [...available, mine]);
        }
      }

      for (let pass = 0; pass < 200; pass++) {
        const { plans } = await outbox.submissionPlan(scope);
        const ready = plans.flatMap((plan) =>
          plan.head.type === "ready" ? [{ plan, record: plan.head.record }] : []
        );
        if (ready.length === 0) break;
        for (const { plan, record } of ready) {
          if (random() < 0.35) {
            await outbox.acknowledge(record, {
              _tag: "Rejected",
              code: "invocation_conflict",
            });
            continue;
          }
          const mappings = await Promise.all(
            record.allocations.map(async (allocation) => ({
              clientRef: allocation.clientRef,
              entityId: await sealEntityId(
                sealingKeyOf(root),
                idScope(plan.receiver),
                1000 + Math.floor(random() * 100_000),
              ) as EntityId,
            })),
          );
          await outbox.acknowledge(record, {
            _tag: "Committed",
            output: null,
            mappings,
          });
        }
      }

      const drained = await outbox.plan(scope);
      expect([seed, drained]).toEqual([seed, []]);
      const states = await Promise.all(enqueued.map(async (entry) => {
        const receiver = receivers.find((candidate) =>
          mutationPartitionKey(candidate) === entry.partition
        )!;
        const receipt = await outbox.receipt(receiver, entry.invocation as never);
        observed.add(`${receipt?.state}:${receipt?.failure?.code ?? ""}`);
        return receipt?.state;
      }));
      expect([seed, states.filter((state) => state !== "committed" && state !== "rejected")])
        .toEqual([seed, []]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  }

  expect([...observed].sort()).toEqual([
    "committed:",
    "rejected:dependency_rejected",
    "rejected:invocation_conflict",
  ]);
});

const commitOne = async (
  outbox: ReturnType<IndexedDbReplicaStorage["outbox"]>,
  receiver: ReplicaDatabaseScope,
  scope: ReplicaScope,
  at: number,
): Promise<ReceiptRecord> => {
  const record = await outbox.enqueue(draft(receiver, { enqueuedAt: at }), { scope });
  return outbox.acknowledge(
    record,
    { _tag: "Committed", output: { id: record.invocation }, mappings: [] },
    at,
  );
};

browserTest(
  "one fresh activation fences exactly the markers durable before it began",
  async ({ browser }) => {
    const name = `ramose-fence-window-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();

      const first = await commitOne(outbox, receiver, scope, 1_700_000_000_001);
      const second = await commitOne(outbox, receiver, scope, 1_700_000_000_002);
      expect(await outbox.observationState(receiver)).toEqual({
        partition: mutationPartitionKey(receiver),
        receiver,
        activation: 0,
        unobserved: [
          { invocation: first.invocation, activation: 0, committedAt: 1_700_000_000_001 },
          { invocation: second.invocation, activation: 0, committedAt: 1_700_000_000_002 },
        ].sort((left, right) => (left.invocation < right.invocation ? -1 : 1)),
      });

      expect(await outbox.beginActivation(receiver)).toBe(1);

      const late = await commitOne(outbox, receiver, scope, 1_700_000_000_003);
      expect((await outbox.receipt(receiver, late.invocation))?.activation).toBe(1);

      const fenced = (await outbox.fenceActivation(receiver, 1, 1_700_000_000_010)).fenced;
      expect([...fenced].sort()).toEqual(
        [first.invocation, second.invocation].sort(),
      );
      const afterFirst = await outbox.observationState(receiver);
      expect(afterFirst.activation).toBe(1);
      expect(afterFirst.unobserved).toEqual([
        { invocation: late.invocation, activation: 1, committedAt: 1_700_000_000_003 },
      ]);

      expect((await outbox.fenceActivation(receiver, 1)).fenced).toEqual([]);

      expect(await outbox.beginActivation(receiver)).toBe(2);
      expect((await outbox.fenceActivation(receiver, 2, 1_700_000_000_020)).fenced)
        .toEqual([late.invocation]);
      expect(await outbox.observationState(receiver)).toEqual({
        partition: mutationPartitionKey(receiver),
        receiver,
        activation: 2,
        unobserved: [],
      });
      expect(await outbox.receipt(receiver, first.invocation)).toMatchObject({
        state: "committed",
        observation: "observed",
        activation: 0,
        updatedAt: 1_700_000_000_010,
      });
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a rejection is never fenced and needs no activation",
  async ({ browser }) => {
    const name = `ramose-fence-rejection-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const record = await outbox.enqueue(draft(receiver), { scope });
      await outbox.acknowledge(
        record,
        { _tag: "Rejected", code: "operation_rejected" },
        1_700_000_000_001,
      );
      expect(await outbox.beginActivation(receiver)).toBe(1);
      expect((await outbox.fenceActivation(receiver, 1)).fenced).toEqual([]);
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBeNull();
      expect((await outbox.observationState(receiver)).unobserved).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "every crash cut between the commit and the fence converges",
  async ({ browser }) => {
    const name = `ramose-fence-crash-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    let storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await confirm(storage, left, "left");
      const committed = await commitOne(
        storage.outbox(),
        receiver,
        scope,
        1_700_000_000_001,
      );

      armCheckpoint("outbox.activation", "throw", "cut before the activation committed");
      try {
        await expect(storage.outbox().beginActivation(receiver))
          .rejects.toThrow(/cut before the activation/);
      } finally {
        resetTestHooks();
      }

      storage.close();
      storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
      let state = await storage.outbox().observationState(receiver);
      expect(state.activation).toBe(0);
      expect(state.unobserved).toEqual([
        { invocation: committed.invocation, activation: 0, committedAt: 1_700_000_000_001 },
      ]);

      expect(await storage.outbox().beginActivation(receiver)).toBe(1);
      storage.close();
      storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
      expect((await storage.outbox().observationState(receiver)).unobserved)
        .toHaveLength(1);
      expect(await storage.outbox().beginActivation(receiver)).toBe(2);

      armCheckpoint("outbox.fence", "throw", "cut before the fence committed");
      try {
        await expect(storage.outbox().fenceActivation(receiver, 2))
          .rejects.toThrow(/cut before the fence/);
      } finally {
        resetTestHooks();
      }
      storage.close();
      storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
      state = await storage.outbox().observationState(receiver);
      expect(state.activation).toBe(2);
      expect(state.unobserved).toHaveLength(1);

      expect(await storage.outbox().beginActivation(receiver)).toBe(3);
      expect((await storage.outbox().fenceActivation(receiver, 3)).fenced)
        .toEqual([committed.invocation]);
      expect((await storage.outbox().observationState(receiver)).unobserved)
        .toEqual([]);
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "one fence is one transaction over every receipt it covers",
  async ({ browser }) => {
    const name = `ramose-fence-atomic-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const outbox = storage.outbox();
      const committed = [
        await commitOne(outbox, receiver, scope, 1_700_000_000_001),
        await commitOne(outbox, receiver, scope, 1_700_000_000_002),
        await commitOne(outbox, receiver, scope, 1_700_000_000_003),
      ];
      expect(await outbox.beginActivation(receiver)).toBe(1);

      const writes: string[][] = [];
      const databasePrototype = IDBDatabase.prototype;
      const nativeTransaction = databasePrototype.transaction;
      databasePrototype.transaction = function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ): IDBTransaction {
        const named = typeof storeNames === "string" ? [storeNames] : [...storeNames];
        if (this.name === name && mode === "readwrite") writes.push(named);
        return nativeTransaction.call(this, storeNames, mode, options);
      } as IDBDatabase["transaction"];
      let fenced: readonly string[];
      try {
        fenced = (await outbox.fenceActivation(receiver, 1)).fenced;
      } finally {
        databasePrototype.transaction = nativeTransaction;
      }
      expect([...fenced].sort()).toEqual(
        committed.map((receipt) => receipt.invocation).sort(),
      );

      expect(writes).toEqual([[
        "mutation-receipts-v1",
        "mutation-layers-v1",
        "replica-committed-heads-v1",
        "replica-generations-v1",
      ]]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an activation and its fence cannot land behind a scoped clear",
  async ({ browser }) => {
    const name = `ramose-fence-cleared-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      await commitOne(storage.outbox(), receiver, scope, 1_700_000_000_001);
      const held = storage.outbox();
      expect(await held.beginActivation(receiver)).toBe(1);
      await storage.clearScope(scope);
      expect(await rejectedTag(held.beginActivation(receiver)))
        .toBe("ReplicaScopeClearedError");
      expect(await rejectedTag(held.fenceActivation(receiver, 1)))
        .toBe("ReplicaScopeClearedError");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "the fence exposes its transition as durable, restartable state",
  async ({ browser }) => {
    const name = `ramose-fence-transition-${browser.uniqueId}`;
    const left = identity();
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(storage, left, "left");
      const committed = await commitOne(
        storage.outbox(),
        receiver,
        scope,
        1_700_000_000_001,
      );

      storage.close();
      storage = await IndexedDbReplicaStorage.open(name);
      const fence = new ActivationFence(storage.outbox(), receiver);
      const seen: ActivationFenceSnapshot[] = [];
      const stop = fence.observe((snapshot) => seen.push(snapshot));
      expect(await fence.refresh()).toMatchObject({
        activation: 0,
        unobserved: [{ invocation: committed.invocation, activation: 0 }],
        fenced: [],
      });

      const prior = await ReplicationSession.open({
        activation: { server: "http://127.0.0.1:1", root: "root" },
        credential: "queued-credential",
        attributes: [{ ident: ":item/name", valueType: ":db.type/string", index: true }],
        readCompatibilityHash: left.readCompatibilityHash,
        storage,
      });
      const activation = await fence.restart(prior);
      expect(prior.snapshot().status).toBe("closed");
      expect(activation).toBe(1);

      await fence.outcome(activation)();
      expect(fence.snapshot()).toMatchObject({
        activation: 1,
        unobserved: [],
        fenced: [committed.invocation],
      });

      const transitions = seen.length;
      await fence.outcome(activation)();
      expect(seen).toHaveLength(transitions);
      stop();
      expect((await storage.outbox().receipt(receiver, committed.invocation))
        ?.observation).toBe("observed");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);
