/**
 * The durable mutation queue against real IndexedDB (#475 slice 1).
 *
 * Nothing here is simulated: a real Chromium IndexedDB connection, the real
 * transaction/abort semantics, the real sealed entity-id codec over WebCrypto,
 * and the repository's inert runtime boundary armed only to decide where a
 * crash cut lands.
 */

import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
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
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import type { ClientRef } from "../../packages/ramose/src/db/refs.ts";
import {
  mappingKey,
  mutationPartitionKey,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
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

const opaque = (character: string): string => character.repeat(43);

/** `Data.TaggedError` carries no message; the tag is the assertion. */
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
  graphLineage: [],
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

/** Every record of every mutation store, as a comparable value. */
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

    // Not one of the five families kept a fragment: the queue is exactly as
    // empty as it was before the attempt.
    const cut = await dumpMutations(name);
    for (const [store, records] of Object.entries(cut)) {
      expect([store, records]).toEqual([store, []]);
    }
    expect((await outbox.restore(scope)).records).toEqual([]);

    // The retry commits every part together.
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
      updatedAt: record.enqueuedAt,
    }]);
    expect(committed["mutation-receipts-v1"]).toEqual([{
      partition: record.partition,
      invocation: record.invocation,
      scope: record.scope,
      state: "queued",
      observation: null,
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
    // A create that allocates the ref, then work that depends on it, then one
    // unrelated invocation in a different database.
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
    // The allocating invocation is the head and is ready; the dependent one
    // behind it is blocked on exactly the ref it names.
    expect(mine.head.type).toBe("ready");
    expect(mine.entries[1]!.state).toEqual({ type: "blocked", missing: [allocation] });
    // A different database is entirely unaffected by that dependency.
    expect(theirs.head).toEqual({ type: "ready", record: theirs.entries[0]!.record });
    expect(theirs.entries[0]!.record.invocation).toBe(independent.invocation);

    const mapped = (await sealEntityId(sealingKeyOf(root), idScope(receiver), 42)) as EntityId;
    // The *allocating* invocation owns the mapping; the dependent one only
    // consumes it.
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

    // The epoch the record was minted under is still current: ordinary.
    const same = await outbox.plan(scope, root.keyId);
    expect(same[0]!.head.type).toBe("ready");

    // The server has replaced its sealing key. The queue surfaces the typed,
    // data-free update-required state and keeps every record.
    const rotatedPlan = await outbox.plan(scope, rotated.keyId);
    expect(rotatedPlan[0]!.head).toEqual({
      type: "update-required",
      record: rotatedPlan[0]!.entries[0]!.record,
      reason: "key-epoch",
    });
    const stored = await dumpMutations(name);
    expect(stored["mutation-outbox-v1"]).toHaveLength(1);
    expect(stored["mutation-receipts-v1"]).toHaveLength(1);

    // An unconfirmed epoch — offline — is not evidence of a rotation.
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

    // The clearing handle is terminal for that scope: it cannot repopulate the
    // queue it just deleted, through the outbox any more than through the
    // replica paths.
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

    // Hold one enqueue open on the boundary immediately before its commit,
    // with no lease — the case where nothing but the durable generation and
    // the handle's own terminal state can refuse it.
    armCheckpoint("outbox.enqueue", "wait");
    const inFlight = writer.outbox().enqueue(draft(receiver), { scope });
    // Another handle in the same realm clears the scope while that write is
    // still in flight.
    await maintainer.clearScope(scope);
    releaseCheckpoint("outbox.enqueue");
    expect(await rejectedTag(inFlight)).toBe("ReplicaFencedError");
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toEqual([]);

    // The same handle clearing its own scope is terminal from the moment the
    // clear begins, so a concurrent enqueue cannot repopulate it either.
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

    // Another handle in the same realm clears the scope and bumps the durable
    // generation the writer's lease is holding.
    await maintainer.clearScope(scope);

    expect(await rejectedTag(writer.outbox().enqueue(draft(receiver), { scope, lease })))
      .toBe("ReplicaFencedError");
    const after = await dumpMutations(name);
    expect(after["mutation-outbox-v1"]).toEqual([]);

    // A fresh lease may queue again: the clear removed the data, it did not
    // make the scope permanently unusable for a new session.
    const fresh = writer.lease();
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
    // Queueing another principal's database under this scope would file the
    // record where this scope's restore cannot see it and its clear cannot
    // remove it, while it showed up in the other principal's queue.
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

    // The caller lost the completion result and retried the same intent under
    // the same id: the durable record comes back, and nothing is written.
    const again = await outbox.enqueue({ ...intent, enqueuedAt: Date.now() + 1_000 }, {
      scope,
    });
    expect(again).toEqual(first);
    expect((await dumpMutations(name))["mutation-outbox-v1"]).toHaveLength(1);
    expect((await outbox.restore(scope)).records).toHaveLength(1);

    // A different intent under the same id never overwrites the queued one.
    expect(
      await rejectedTag(
        outbox.enqueue({ ...intent, input: { title: "different" } }, { scope }),
      ),
    ).toBe("OutboxInvocationConflict");
    const stored = (await outbox.restore(scope)).records;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.input).toEqual({ title: "once" });

    // An ordinary second invocation still takes the next FIFO position.
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

    // A ref this device never registered as an allocation, and a ref
    // acknowledged by an invocation that does not allocate it, are both refused.
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

    // A timestamp the decoder would refuse must not be written: the mapping is
    // immutable, so it could never release its dependents and never be
    // repaired either. The canonical builder refuses it, so the failure is the
    // same `OutboxRecordInvalid` every unstorable record raises.
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
    // Replaying the identical acknowledgement is accepted and changes nothing.
    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: mapped },
    ]);
    const stored = (await dumpMutations(name))["mutation-client-ref-mappings-v1"] as {
      readonly entityId: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.entityId).toBe(mapped);

    // Redirecting the ref at another entity would move every later dependency.
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

browserTest("an unconfirmed scope cannot hold durable work", async ({ browser }) => {
  const name = `ramose-outbox-unconfirmed-${browser.uniqueId}`;
  const left = identity();
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    // No authenticated response has confirmed this scope, so `clearScope`
    // could never select it — which means nothing may be queued under it.
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

    // A scope confirmed only *after* this enqueue began is refused too: the
    // generation it would adopt could already be a post-clear one.
    const late = identity({ principal: RIGHT });
    const lateScope = replicaScopeOf(late);
    // The rejection is observed from the start, so a refusal that lands while
    // the confirmation is still in flight is still a handled outcome.
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

    // A retry that re-resolved its receiver must not queue the same intent a
    // second time in a sibling database.
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
  // A database exactly as an earlier build of this unreleased version left it:
  // the store family exists, but `by-invocation` is the old compound index and
  // `by-client-ref` does not exist at all.
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
    // The stale compound index was replaced under its own name, not kept.
    expect(outbox.index("by-invocation").keyPath).toBe("invocation");
    const refs = inspected.transaction("mutation-client-refs-v1", "readonly")
      .objectStore("mutation-client-refs-v1");
    expect([...refs.indexNames]).toContain("by-client-ref");
    inspected.close();

    // And the invariants they carry actually hold.
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

    // Retrying the creation under a fresh invocation and a re-resolved
    // receiver would otherwise let one global client identity be bound to two
    // different authoritative entities.
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
    // The same ref in the same database under a new invocation is refused too.
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

    // The ref is allocated in this database, so a sibling database can never
    // resolve it: planning reads only its own partition's mappings, and a
    // mapping cannot be written there without a local allocation. Queueing it
    // would leave that sibling's head permanently unreleasable.
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

    // A ref nobody has allocated is stuck for the same reason: FIFO means no
    // later invocation can supply it.
    expect(
      await rejectedTag(
        outbox.enqueue(
          draft(receiver, { target: { type: "client-ref", clientRef: clientRef() } }),
          { scope },
        ),
      ),
    ).toBe("OutboxRecordInvalid");

    // The legitimate dependent, in the database that owns the ref, is accepted.
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
    // A handle sealed under the *previous* server key epoch.
    const stale = (await sealEntityId(
      sealingKeyOf(rotated),
      idScope(receiver),
      9,
    )) as EntityId;
    await outbox.recordMappings(receiver, create.invocation, [
      { clientRef: allocation, entityId: stale },
    ]);
    storage.close();

    // Relabel the stored mapping with the currently confirmed epoch, exactly
    // as a corrupted or foreign-build row would look.
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
    // The relabelled mapping is dropped, so the dependent stays blocked
    // instead of being released against a handle under the replaced epoch.
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

    // Corrupt the head row in place, exactly as a partial write or a foreign
    // build would leave it. Its primary key stays intact.
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
    // The second record decodes and is ready, and is still not the head.
    expect(held.entries.map((entry) => entry.record.invocation)).toEqual([
      second.invocation,
    ]);
    expect(held.head).toEqual({ type: "unreadable", sequence: 1 });
    // Only this database is held.
    expect(
      plans.find((plan) => plan.receiver.database === OTHER_DATABASE)!.head.type,
    ).toBe("ready");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

/**
 * One adversarial value per durable field, driven through the *public* write
 * paths against real IndexedDB.
 *
 * The property under test is not "this particular value is refused" — it is
 * the boundary invariant: **nothing reaches a store unless the bytes IndexedDB
 * would hold decode back into the same record**. So each case asserts both
 * halves: the write is refused, and the stores are byte-identical afterwards.
 */
browserTest("no adversarial value can reach a mutation store", async ({ browser }) => {
  const name = `ramose-outbox-adversarial-${browser.uniqueId}`;
  const left = identity();
  const receiver = replicaDatabaseScopeOf(left);
  const scope = replicaScopeOf(left);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await confirm(storage, left, "left");
    const outbox = storage.outbox();
    // One healthy record first, so "unchanged" means something.
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
      // ── identity fields ────────────────────────────────────────────────
      ["invocation id", draft(receiver, { invocation: "iv1_nope" as never })],
      ["operation version", draft(receiver, { operationVersion: "ABC" as never })],
      ["operation name", draft(receiver, {
        operation: { catalog: "movies" as never, owner: { kind: "entity", name: "i" }, localName: "" },
      })],
      ["enqueue timestamp", draft(receiver, { enqueuedAt: Number.NaN })],
      ["fractional timestamp", draft(receiver, { enqueuedAt: 1.5 })],
      // ── target ─────────────────────────────────────────────────────────
      ["truncated handle", draft(receiver, {
        target: { type: "entity", entityId: "short" as EntityId },
      })],
      ["respelled handle", draft(receiver, {
        target: { type: "entity", entityId: `${"a".repeat(54)}B` as EntityId },
      })],
      ["forged client ref", draft(receiver, {
        target: { type: "client-ref", clientRef: "cr1_nope" as never },
      })],
      // ── input, as JSON ─────────────────────────────────────────────────
      ["function in input", draft(receiver, { input: { fn: () => undefined } as never })],
      ["NaN in input", draft(receiver, { input: { n: Number.NaN } as never })],
      ["bigint in input", draft(receiver, { input: { big: 1n } as never })],
      ["Map in input", draft(receiver, { input: { made: new Map() } as never })],
      ["Date in input", draft(receiver, { input: { at: new Date() } as never })],
      ["cyclic input", draft(receiver, { input: cyclic as never })],
      ["sparse array input", draft(receiver, { input: { list: [, 1] } as never })],
      ["lone surrogate value", draft(receiver, { input: { title: "\ud800" } })],
      ["lone surrogate key", draft(receiver, { input: { "\udc00": "x" } })],
      // ── declared reference positions ───────────────────────────────────
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
      // ── allocation slots ───────────────────────────────────────────────
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
      // ── cross-realm ────────────────────────────────────────────────────
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

    // `rejectedTag` throws when a write is *not* refused, so reaching the end
    // of this loop is the property: every one of them was refused, and the
    // collected reasons show which rule caught it.
    const refusals: string[] = [];
    for (const [label, attack] of attacks) {
      refusals.push(`${label}: ${await rejectedTag(outbox.enqueue(attack, { scope }))}`);
    }
    expect(refusals).toHaveLength(attacks.length);

    // Nothing moved: no partial row, no bumped cursor, no orphan client ref.
    expect(JSON.stringify(await dumpMutations(name))).toBe(before);
    // And the healthy record still restores exactly, with its queue ready.
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

/**
 * The same property for the mapping store, which is the only other durable
 * family a public call can write.
 */
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

    // An accessor that would answer the owned ref to the ownership check and a
    // ref it does not own to the builder. Each field is read exactly once, so
    // the two can never diverge: the mapping that lands is the one that was
    // checked, and the ref it tried to smuggle in is never bound at all.
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
