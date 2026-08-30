/**
 * Real-Chromium reachability GC and bounded quota recovery (#474 slice 11).
 *
 * Every sweep below runs against records the production adapter really wrote
 * into the browser's own IndexedDB, and every assertion about what a pass
 * removed or rewrote comes either from the pass's own outcome or from the
 * adapter's write counters. Nothing here fakes storage, and the one place a
 * native failure is simulated — quota exhaustion, which cannot be provoked
 * honestly inside a test budget — is an armed boundary inside the real install
 * transaction that fails with the real `DOMException` the platform raises.
 */

import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
  replicaSweepKey,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { ReplicationSession } from "../../packages/ramose/src/internal/replication/session.ts";
import {
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  armCheckpoint,
  armCheckpointThrow,
  checkpointStatus,
  releaseCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk, changeFrame } from "../../packages/ramose/test/replication-fixtures.ts";

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const PRINCIPAL = opaque("l");
const ROOT_DATABASE = opaque("d");
const CHILD_DATABASE = opaque("e");
const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));

const COMMITTED = "replica-committed-v1";
const COMMITTED_HEADS = "replica-committed-heads-v1";
const NODES = "replica-nodes-v1";
const STAGING = "replica-staging-v1";
const STAGING_CHUNKS = "replica-staging-chunks-v1";
const GENERATIONS = "replica-generations-v1";

const identity = (overrides: Partial<ReplicationIdentity> = {}): ReplicationIdentity => ({
  version: 1,
  server: SERVER,
  principal: PRINCIPAL,
  database: ROOT_DATABASE,
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: READ_COMPATIBILITY,
  graphLineage: [],
  authenticator: opaque("a"),
  ...overrides,
});

const attributes: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", cardinality: "one", index: true },
];

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

const openNative = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("upgrade blocked")), { once: true });
  });

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const dump = async (name: string): Promise<Record<string, unknown[]>> => {
  const database = await openNative(name);
  const stores = [...database.objectStoreNames];
  const transaction = database.transaction(stores, "readonly");
  const contents: Record<string, unknown[]> = {};
  for (const store of stores) {
    contents[store] = await requestResult<unknown[]>(transaction.objectStore(store).getAll());
  }
  await transactionDone(transaction);
  database.close();
  return contents;
};

const bytes = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry instanceof Uint8Array ? [...entry] : entry as unknown);

const nodeRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, ""], [partition, "￿"]);

const nodeHashes = async (name: string, partition: string): Promise<string[]> => {
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readonly");
  const keys = await requestResult<IDBValidKey[]>(
    transaction.objectStore(NODES).getAllKeys(nodeRange(partition)),
  );
  await transactionDone(transaction);
  database.close();
  return keys.map((key) => (key as [string, string])[1]).sort();
};

type StoredManifest = {
  readonly partition: string;
  readonly roots: Record<"eavt" | "aevt" | "avet" | "vaet", { readonly hash: string }>;
};

const committedOf = async (name: string, partition: string): Promise<StoredManifest> => {
  const database = await openNative(name);
  const transaction = database.transaction(COMMITTED, "readonly");
  const record = await requestResult<StoredManifest>(
    transaction.objectStore(COMMITTED).get(partition),
  );
  await transactionDone(transaction);
  database.close();
  return record;
};

const writeCommitted = async (name: string, record: unknown): Promise<void> => {
  const database = await openNative(name);
  const transaction = database.transaction(COMMITTED, "readwrite");
  transaction.objectStore(COMMITTED).put(record);
  await transactionDone(transaction);
  database.close();
};

/**
 * A stored node that is a real EAVT root of a superseded value: it decodes, it
 * hashes to its own address, and it is the same index and shape as the root it
 * will stand in for. Only the manifest's own claim separates the two.
 */
const supersededRoot = async (
  name: string,
  partition: string,
  current: StoredManifest,
): Promise<string> => {
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readonly");
  const records = await requestResult<{ hash: string; body: Uint8Array }[]>(
    transaction.objectStore(NODES).getAll(nodeRange(partition)),
  );
  await transactionDone(transaction);
  database.close();
  const live = new Set(Object.values(current.roots).map((root) => root.hash));
  const orphan = records.find((record) => !live.has(record.hash));
  if (orphan === undefined) throw new Error("no superseded node to swap in");
  return orphan.hash;
};

/**
 * Every record of the five #475 mutation families. The sweep transaction never
 * names these stores, so IndexedDB itself would refuse a write to one; this
 * reads them back to say so from the outside.
 */
const dumpMutations = async (name: string): Promise<Record<string, unknown[]>> => {
  const database = await openNative(name);
  const stores = [...database.objectStoreNames].filter((store) =>
    store.startsWith("mutation-")
  );
  const transaction = database.transaction(stores, "readonly");
  const contents: Record<string, unknown[]> = {};
  for (const store of stores) {
    contents[store] = await requestResult<unknown[]>(transaction.objectStore(store).getAll());
  }
  await transactionDone(transaction);
  database.close();
  return contents;
};

const sweepGeneration = async (name: string, partition: string): Promise<number> => {
  const database = await openNative(name);
  const transaction = database.transaction(GENERATIONS, "readonly");
  const record = await requestResult<{ generation: number } | undefined>(
    transaction.objectStore(GENERATIONS).get(replicaSweepKey(partition)),
  );
  await transactionDone(transaction);
  database.close();
  return record?.generation ?? 0;
};

/**
 * The one durable trace a sweep in another tab leaves behind. Written directly
 * because a second handle in this realm shares the materialization mark and so
 * could not produce the situation being tested.
 */
const bumpSweepGeneration = async (name: string, partition: string): Promise<void> => {
  const key = replicaSweepKey(partition);
  const database = await openNative(name);
  const transaction = database.transaction(GENERATIONS, "readwrite");
  const store = transaction.objectStore(GENERATIONS);
  const record = await requestResult<{ generation: number } | undefined>(store.get(key));
  store.put({
    key,
    kind: "partition",
    scope: "",
    generation: (record?.generation ?? 0) + 1,
    confirmedAt: Date.now(),
    fencedAt: Date.now(),
  });
  await transactionDone(transaction);
  database.close();
};

/** Wait until an armed `wait` checkpoint has actually been reached. */
const reachedCheckpoint = async (name: string): Promise<void> => {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (checkpointStatus()[name]?.pending === true) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`checkpoint ${name} was never reached`);
};

/**
 * Read a value's revision and release its retention immediately.
 *
 * Every value the storage hands out arrives retained, and the caller owns the
 * release whether it keeps the value or only glances at it. A test that leaked
 * one would pin exactly the nodes the next sweep is asserted to reclaim, so
 * these suites release as explicitly as a real holder does.
 */
const revisionOf = async (
  pending: Promise<{ readonly revision: string; readonly release: () => void } | undefined>,
): Promise<string | undefined> => {
  const value = await pending;
  value?.release();
  return value?.revision;
};

/** Release a value this test is done with. */
const dropped = (value: { readonly release: () => void } | undefined): void => {
  value?.release();
};

/**
 * Let queued microtasks run without yielding to the task queue.
 *
 * This is what puts a released restore's fence transaction in flight while a
 * parked sweep has not yet reached its synchronous block: IndexedDB requests
 * settle in a later task, so nothing the fence issued can complete here.
 */
const drainMicrotasks = async (turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const snapshotDatom = (entity: string, value: string): SnapshotDatom => ({
  entity,
  field: ":item/name",
  value: { type: "string", value },
  op: "add",
});

const installSnapshot = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  revision: string,
  datoms: readonly SnapshotDatom[],
): Promise<void> => {
  const snapshot = `${revision}-snapshot`.padEnd(43, "q").slice(0, 43);
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 1, identity: selected, snapshot, revision,
  });
  let index = 0;
  for (let offset = 0; offset < datoms.length; offset += 16) {
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected, snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + 16),
    }));
  }
  const committed = await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 1, identity: selected, snapshot, revision,
    chunks: index,
  }, attributes);
  expect(committed).toBeDefined();
  dropped(committed);
};

/** A replica wide enough that one changed datom really orphans interior nodes. */
const wideDatoms = (count: number, value: string): readonly SnapshotDatom[] =>
  Array.from({ length: count }, (_unused, index) =>
    snapshotDatom(`entity-${String(index).padStart(6, "0")}`.padEnd(43, "z"), `${value}-${index}`));

const changeOne = (
  selected: ReplicationIdentity,
  from: string,
  revision: string,
  entity: string,
  value: string,
) => (changeFrame({
  type: "Change" as const,
  protocol: 1 as const,
  identity: selected,
  from,
  revision,
  datoms: [{
    entity,
    field: ":item/name",
    value: { type: "string" as const, value },
    op: "add" as const,
  }],
}));

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

const names = async (db: Db): Promise<string[]> => {
  const attribute = db.attr(":item/name")!;
  return (await db.datomsArray(Index.AEVT, { a: attribute.id })).map((datom) => datom.v as string);
};

browserTest(
  "one pass reclaims the roots a change superseded and rewrites no manifest",
  async ({ browser }) => {
    const name = `ramose-gc-supersede-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      // Wide enough that each index really is a directory over several leaves,
      // so the change below orphans interior nodes and not just four roots.
      const seed = wideDatoms(4000, "seed");
      await installSnapshot(storage, selected, opaque("1"), seed);
      const afterSnapshot = await nodeHashes(name, partition);
      expect(afterSnapshot.length).toBeGreaterThan(4);

      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), seed[7].entity, "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);
      const afterChange = await nodeHashes(name, partition);
      // One datom rewrote a whole root-to-leaf path per index, so the store now
      // holds both the current value and everything the change superseded.
      expect(afterChange.length).toBeGreaterThan(afterSnapshot.length);

      storage.resetWriteCounts();
      const outcome = await storage.collectGarbage();
      // A sweep is not an install: it writes no manifest, no head, and no node.
      expect(storage.writeCounts()).toEqual({
        nodes: 0, manifests: 0, heads: 0, staging: 0, stagingChunks: 0,
      });
      expect(outcome.partitions).toBe(1);
      expect(outcome.swept).toBe(1);
      expect(outcome.skipped).toBe(0);
      expect(outcome.staging).toBe(0);
      expect(outcome.nodes).toBeGreaterThan(0);
      expect(outcome.nodes + outcome.retained).toBe(afterChange.length);

      const survivors = await nodeHashes(name, partition);
      expect(survivors.length).toBe(outcome.retained);
      // Nothing the current value depends on was touched, so it still restores
      // and reads exactly what the change left behind.
      const restored = await storage.restore(selected, attributes, READ_COMPATIBILITY);
      expect(restored?.revision).toBe(opaque("2"));
      expect((await names(restored!.db)).includes("changed")).toBe(true);
      expect(await sweepGeneration(name, partition)).toBe(1);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("a second pass over settled storage removes nothing", async ({ browser }) => {
  const name = `ramose-gc-idempotent-${browser.uniqueId}`;
  const selected = identity();
  const partition = replicaPartitionKey(selected);
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, selected, opaque("1"), wideDatoms(80, "seed"));
    dropped(await storage.applyChange(
      changeOne(selected, opaque("1"), opaque("2"), "entity-000003".padEnd(43, "z"), "changed"),
    ));
    const first = await storage.collectGarbage();
    expect(first.nodes).toBeGreaterThan(0);
    const settled = bytes(await dump(name));

    const second = await storage.collectGarbage();
    expect(second).toEqual({
      partitions: 1,
      swept: 0,
      skipped: 0,
      nodes: 0,
      retained: first.retained,
      staging: 0,
    });
    // Byte-identical storage, including the sweep generation: an idempotent
    // pass must not even bump the record the publish fence watches.
    expect(bytes(await dump(name))).toBe(settled);
    expect(await sweepGeneration(name, partition)).toBe(1);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a quarantined partition's leftover nodes and staging are swept once nothing pins them",
  async ({ browser }) => {
    const name = `ramose-gc-quarantine-${browser.uniqueId}`;
    const selected = identity();
    const sibling = identity({ database: CHILD_DATABASE });
    const partition = replicaPartitionKey(selected);
    const siblingPartition = replicaPartitionKey(sibling);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(40, "left"));
      await installSnapshot(storage, sibling, opaque("3"), wideDatoms(8, "right"));
      await confirm(storage, selected, "left");
      await confirm(storage, sibling, "right");
      // Leave staging behind whose base can never be the committed revision
      // again, which is what a connection interrupted mid-snapshot leaves.
      await storage.startSnapshot({
        type: "SnapshotStart", protocol: 1, identity: selected,
        snapshot: opaque("y"), revision: opaque("9"),
      });
      await storage.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 1, identity: selected, snapshot: opaque("y"),
        index: 0, datoms: [snapshotDatom(opaque("x"), "abandoned")],
      }));

      const before = await nodeHashes(name, partition);
      const siblingBefore = await nodeHashes(name, siblingPartition);
      storage.close();

      // Damage one node body so the next restore refuses and quarantines.
      const database = await openNative(name);
      const damage = database.transaction(NODES, "readwrite");
      const store = damage.objectStore(NODES);
      const record = await requestResult<{ partition: string; hash: string; body: Uint8Array }>(
        store.get([partition, before[0]]),
      );
      const body = new Uint8Array(record.body);
      body[body.length - 1] ^= 0x01;
      store.put({ partition, hash: before[0], body });
      await transactionDone(damage);
      database.close();

      storage = await IndexedDbReplicaStorage.open(name);
      const outcome = await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      expect(outcome._tag).toBe("replacement-required");
      // Quarantine is withdrawal: the manifest is gone but the nodes and the
      // orphaned staging are still there for the sweep to reclaim.
      expect((await dump(name))[COMMITTED]).toHaveLength(1);
      expect(await nodeHashes(name, partition)).toHaveLength(before.length);

      const swept = await storage.collectGarbage();
      expect(await nodeHashes(name, partition)).toEqual([]);
      expect(swept.nodes).toBe(before.length);
      expect(swept.staging).toBe(1);
      // The sibling database is a different partition and keeps every node.
      expect(await nodeHashes(name, siblingPartition)).toEqual(siblingBefore);
      const dumped = await dump(name);
      expect(dumped[STAGING]).toEqual([]);
      expect(dumped[STAGING_CHUNKS]).toEqual([]);
      expect(dumped[COMMITTED_HEADS]).toHaveLength(1);
      expect(
        await revisionOf(storage.restore(sibling, attributes, READ_COMPATIBILITY)),
      ).toBe(opaque("3"));
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a sweep planned before the publish fence but transacted after it still cannot take the value",
  async ({ browser }) => {
    const name = `ramose-gc-fence-ordering-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(120, "seed"));
      const original = await nodeHashes(name, partition);

      // A restore walks the committed manifest and parks immediately before its
      // publish fence.
      armCheckpoint("replica.validated", "wait");
      const walking = storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      // An install supersedes exactly what that walk validated.
      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000009".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      const beforeSweep = await nodeHashes(name, partition);
      expect(beforeSweep.length).toBeGreaterThan(original.length);

      // A sweep plans its live set from the new manifest — the superseded roots
      // are claimed by nobody at that instant — and parks before acting.
      armCheckpoint("replica.gc.planned", "wait");
      const sweeping = storage.collectGarbage();
      await reachedCheckpoint("replica.gc.planned");

      // Release the walk first, so its fence transaction is created in the
      // microtasks that follow and is still in flight — IndexedDB requests
      // settle in a later task, never in a microtask. Only then does the
      // sweep's synchronous block run, creating its transaction after the
      // fence's. Neither the fence's generation read nor the sweep's CAS can
      // see the other: the retention taken before the fence is what composes
      // them, forcing the sweep to skip.
      releaseCheckpoint("replica.validated");
      await drainMicrotasks(50);
      releaseCheckpoint("replica.gc.planned");

      const outcome = await walking;
      const swept = await sweeping;
      expect(outcome._tag).toBe("restored");
      const restored = outcome._tag === "restored" ? outcome.replica : undefined;
      try {
        // The published value reads. Without the retention the sweep would have
        // deleted these nodes and this would throw "missing replica node".
        expect((await names(restored!.db)).length).toBe(120);
        expect(swept.nodes).toBe(0);
        expect(swept.skipped).toBe(1);
        // Nothing at all was removed: not the roots this value reads, and not
        // the ones the pass had written off before the retention appeared.
        expect(await nodeHashes(name, partition)).toEqual(beforeSweep);
      } finally {
        dropped(restored);
      }

      // Once the holder lets go, the superseded roots really are reclaimable.
      const after = await storage.collectGarbage();
      expect(after.nodes).toBeGreaterThan(0);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("2"));
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "quota recovery's own pass cannot take a concurrent restore's nodes",
  async ({ browser }) => {
    const name = `ramose-gc-quota-race-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(120, "seed"));
      const original = await nodeHashes(name, partition);

      armCheckpoint("replica.validated", "wait");
      const walking = storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000009".padEnd(43, "z"), "one"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      // Nobody calls `collectGarbage` here. The next install exhausts storage
      // at the real boundary, and its own bounded recovery is the sweep that
      // races the parked restore — the same hazard, reached the way production
      // reaches it.
      armCheckpointThrow("replica.install", {
        errorName: "QuotaExceededError",
        error: "storage is full",
        times: 1,
      });
      armCheckpoint("replica.gc.planned", "wait");
      const installing = storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000010".padEnd(43, "z"), "two"),
      );
      await reachedCheckpoint("replica.gc.planned");

      releaseCheckpoint("replica.validated");
      await drainMicrotasks(50);
      releaseCheckpoint("replica.gc.planned");

      const outcome = await walking;
      const installed = await installing;
      expect(outcome._tag).toBe("restored");
      const restored = outcome._tag === "restored" ? outcome.replica : undefined;
      try {
        expect((await names(restored!.db)).length).toBe(120);
        expect(await nodeHashes(name, partition)).toEqual(
          expect.arrayContaining(original),
        );
      } finally {
        dropped(restored);
        dropped(installed);
      }
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a walk parked mid-validation cannot publish after a sweep removed its nodes",
  async ({ browser }) => {
    const name = `ramose-gc-parked-walk-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const reader = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    const writer = await IndexedDbReplicaStorage.open(name);
    try {
      await installSnapshot(writer, selected, opaque("1"), wideDatoms(120, "seed"));
      const original = await nodeHashes(name, partition);

      // The walk validates the manifest committed right now and then parks on
      // the boundary between a completed walk and the fence that publishes it.
      armCheckpoint("replica.validated", "wait");
      const walking = reader.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      // An ordinary install supersedes everything that walk just validated —
      // this alone leaves the old value intact, which is why the fence used to
      // permit it — and then a sweep reclaims the roots it superseded.
      const applied = await writer.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000009".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);
      const sweep = await writer.collectGarbage();
      expect(sweep.nodes).toBeGreaterThan(0);
      const survivors = new Set(await nodeHashes(name, partition));
      // The very roots the parked walk validated are gone from storage now.
      expect(original.some((hash) => !survivors.has(hash))).toBe(true);
      expect(await sweepGeneration(name, partition)).toBe(1);

      releaseCheckpoint("replica.validated");
      const outcome = await walking;
      // The value the parked walk read is never published. It re-reads the
      // stored record instead, so the restore succeeds — with the revision that
      // is actually committed, over nodes that actually exist.
      expect(outcome._tag).toBe("restored");
      const restored = outcome._tag === "restored" ? outcome.replica : undefined;
      expect(restored?.revision).toBe(opaque("2"));
      // A `Db` built over the swept roots would throw here instead of reading.
      expect((await names(restored!.db)).includes("changed")).toBe(true);
      // And no spurious quarantine: the partition was intact the whole time.
      expect((await dump(name))[COMMITTED]).toHaveLength(1);
    } finally {
      resetTestHooks();
      reader.close();
      writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a decodable body under the wrong address stops the sweep instead of orphaning a subtree",
  async ({ browser }) => {
    const name = `ramose-gc-misfiled-node-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      // Wide enough for real directories, so a misbelieved body really would
      // hide a subtree rather than one leaf.
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(4000, "seed"));
      const before = await nodeHashes(name, partition);
      expect(before.length).toBeGreaterThan(4);
      storage.close();

      // Refile one real, perfectly decodable node body under another node's
      // address. Nothing here is malformed: every body still decompresses and
      // decodes, so only the content address can tell the two apart.
      const database = await openNative(name);
      const swap = database.transaction(NODES, "readwrite");
      const store = swap.objectStore(NODES);
      const donor = await requestResult<{ body: Uint8Array }>(
        store.get([partition, before[before.length - 1]]),
      );
      store.put({ partition, hash: before[0], body: donor.body });
      await transactionDone(swap);
      database.close();

      const reopened = await IndexedDbReplicaStorage.open(name);
      try {
        const outcome = await reopened.collectGarbage();
        // The walk could not authenticate a node, so it knows nothing about
        // what this partition may lose and takes nothing.
        expect(outcome.skipped).toBe(1);
        expect(outcome.swept).toBe(0);
        expect(outcome.nodes).toBe(0);
        expect(await nodeHashes(name, partition)).toEqual(before);
        expect(await sweepGeneration(name, partition)).toBe(0);
        // Classification is still the restore walk's job, and it happens on the
        // ordinary path with every node the sweep declined to delete in place.
        const restored = await reopened.restoreOutcome(
          selected,
          attributes,
          READ_COMPATIBILITY,
        );
        expect(restored._tag).toBe("replacement-required");
      } finally {
        reopened.close();
      }
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a manifest root swapped for another real node stops the sweep instead of deleting the live one",
  async ({ browser }) => {
    const name = `ramose-gc-swapped-root-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(4000, "seed"));
      // A change leaves the superseded roots in the store, so the swap below
      // can point the manifest at a real, correctly stored node of the same
      // index — every content address still checks out.
      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000008".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);
      const before = await nodeHashes(name, partition);
      const current = await committedOf(name, partition);
      storage.close();

      // Damage the manifest, not a node: point one root at the superseded root
      // of the same index. Nothing is missing, nothing is misfiled, and the
      // swept set computed from it would be the *current* subtree.
      const superseded = await supersededRoot(name, partition, current);
      await writeCommitted(name, {
        ...current,
        roots: { ...current.roots, eavt: { ...current.roots.eavt, hash: superseded } },
      });

      const reopened = await IndexedDbReplicaStorage.open(name);
      try {
        const outcome = await reopened.collectGarbage();
        expect(outcome.skipped).toBe(1);
        expect(outcome.nodes).toBe(0);
        expect(await nodeHashes(name, partition)).toEqual(before);
        expect(await sweepGeneration(name, partition)).toBe(0);
        // The restore path is what classifies it, with every node still there.
        const restored = await reopened.restoreOutcome(
          selected,
          attributes,
          READ_COMPATIBILITY,
        );
        expect(restored._tag).toBe("replacement-required");
      } finally {
        reopened.close();
      }
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a retention taken after the live set is computed skips the sweep instead of losing it",
  async ({ browser }) => {
    const name = `ramose-gc-late-retention-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(120, "seed"));
      const superseded = await storage.restore(selected, attributes, READ_COMPATIBILITY);
      expect(superseded?.revision).toBe(opaque("1"));
      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000004".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      // Drop the retention the restore handed out, so the pass below really
      // does plan a live set with nothing claiming these roots. That is the
      // state the sweep's own re-check exists for; the restore path reaches it
      // by a different route, which its own test covers.
      dropped(superseded);

      // Park the pass after it has computed a live set that does not include
      // the superseded roots, and only then retain them — exactly the shape of
      // a holder claiming a superseded value the pass has already written off.
      // The manifest never moves, so the CAS alone would not notice.
      armCheckpoint("replica.gc.planned", "wait");
      const sweeping = storage.collectGarbage();
      await reachedCheckpoint("replica.gc.planned");
      const retention = storage.retainRoots(selected, superseded!.db.roots);
      releaseCheckpoint("replica.gc.planned");
      const outcome = await sweeping;

      // The pass that raced the retention deleted nothing and said so.
      expect(outcome.nodes).toBe(0);
      expect(outcome.skipped).toBe(1);
      expect(outcome.swept).toBe(0);
      expect(await sweepGeneration(name, partition)).toBe(0);
      // The value that retention protects still reads.
      expect((await names(superseded!.db)).length).toBe(120);

      // The next pass computes a live set that covers the retention, so it
      // reclaims only what neither value reaches — and once the retention goes,
      // the superseded roots go with it.
      const covered = await storage.collectGarbage();
      expect(covered.skipped).toBe(0);
      expect((await names(superseded!.db)).length).toBe(120);
      retention();
      const final = await storage.collectGarbage();
      expect(final.nodes).toBeGreaterThan(0);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("2"));
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a sweep leaves a live session's published value readable and its writes running",
  async ({ browser }) => {
    const name = `ramose-gc-live-session-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name);
    let session: ReplicationSession | undefined;
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(80, "seed"));
      const address = replicationActivationAddress({
        server: "http://127.0.0.1:1",
        root: "root",
        graphPath: [],
      });
      await storage.bindAuthenticated({
        fingerprint: await replicationCredentialFingerprint(
          "known-credential",
          address,
          await rootReplicaRouteSlot(),
        ),
        identity: selected,
      });

      // The session restores the committed replica and publishes it stale; its
      // network attempt fails against a closed port, which leaves the value
      // published and the session alive as a holder of those roots.
      session = await ReplicationSession.open({
        activation: { server: "http://127.0.0.1:1", root: "root", graphPath: [] },
        credential: "known-credential",
        attributes,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const published = session.snapshot().value;
      expect(published?.revision).toBe(opaque("1"));

      // Another writer supersedes the value this session still publishes.
      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000005".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      const outcome = await storage.collectGarbage();
      // Both root sets are live, so only what neither reaches is reclaimed and
      // the retained set covers the union rather than just the manifest.
      expect(outcome.skipped).toBe(0);
      expect(outcome.retained).toBe((await nodeHashes(name, partition)).length);

      // The session's own value still reads: its roots were retained.
      expect((await names(published!.db)).length).toBe(80);
      // And the session is not fenced — an ordinary install still lands.
      const next = await storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000006".padEnd(43, "z"), "later"),
      );
      expect(next?.revision).toBe(opaque("3"));
      dropped(next);

      // Closing the session releases the retention, so the next pass reclaims
      // exactly the roots that session had been keeping alive.
      await session.close();
      session = undefined;
      const after = await storage.collectGarbage();
      expect(after.nodes).toBeGreaterThan(0);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("3"));
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("a crash cut during a sweep leaves the partition untouched", async ({ browser }) => {
  const name = `ramose-gc-crash-${browser.uniqueId}`;
  const selected = identity();
  const partition = replicaPartitionKey(selected);
  let storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
  try {
    await installSnapshot(storage, selected, opaque("1"), wideDatoms(60, "seed"));
    dropped(await storage.applyChange(
      changeOne(selected, opaque("1"), opaque("2"), "entity-000002".padEnd(43, "z"), "changed"),
    ));
    const before = bytes(await dump(name));
    const beforeHashes = await nodeHashes(name, partition);

    // Cut the process at the last boundary before the sweep becomes durable.
    armCheckpoint("replica.sweep", "throw", "simulated crash cut");
    await expect(storage.collectGarbage()).rejects.toThrow("simulated crash cut");
    // Either swept or not: the aborted transaction rolled the deletes back, so
    // storage is byte-identical and the sweep generation never moved.
    expect(bytes(await dump(name))).toBe(before);
    expect(await sweepGeneration(name, partition)).toBe(0);
    resetTestHooks();

    // A later walk accepts the partition exactly as it stands, and a retried
    // pass completes it.
    storage.close();
    storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
      .toBe(opaque("2"));
    const retried = await storage.collectGarbage();
    expect(retried.nodes).toBe(beforeHashes.length - retried.retained);
    expect(retried.nodes).toBeGreaterThan(0);
    expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
      .toBe(opaque("2"));
  } finally {
    resetTestHooks();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "an exhausted quota reclaims once and the retry installs",
  async ({ browser }) => {
    const name = `ramose-gc-quota-recovered-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(80, "seed"));
      dropped(await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000001".padEnd(43, "z"), "one"),
      ));
      // Nothing has swept this partition yet, so any advance below is the one
      // recovery pass and nothing else.
      expect(await sweepGeneration(name, partition)).toBe(0);

      // The real install transaction fails with the real native exception the
      // platform raises when the origin's storage is full.
      armCheckpointThrow("replica.install", {
        error: "storage is full",
        errorName: "QuotaExceededError",
        times: 1,
      });
      const applied = await storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000002".padEnd(43, "z"), "two"),
      );
      // One pass, one retry, and the retry installed.
      expect(applied?.revision).toBe(opaque("3"));
      expect(await sweepGeneration(name, partition)).toBe(1);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("3"));
      // The arm fired exactly once: the retry ran through the real boundary.
      expect(checkpointStatus()["replica.install"]).toBeUndefined();
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a second exhaustion is a typed outcome and preserves the old manifest exactly",
  async ({ browser }) => {
    const name = `ramose-gc-quota-exhausted-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(40, "seed"));
      const manifestBefore = bytes((await dump(name))[COMMITTED]);
      const headBefore = bytes((await dump(name))[COMMITTED_HEADS]);

      armCheckpointThrow("replica.install", {
        error: "storage is full",
        errorName: "QuotaExceededError",
        times: 2,
      });
      const failure = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000000".padEnd(43, "z"), "one"),
      ).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        _tag: "ReplicaQuotaExhaustedError",
        partition,
      });
      expect((failure as { reclaimedNodes: number }).reclaimedNodes).toBeGreaterThanOrEqual(0);

      // Old-or-new: nothing was installed, and the previously committed value
      // is byte-identical to what it was before the attempt.
      const dumped = await dump(name);
      expect(bytes(dumped[COMMITTED])).toBe(manifestBefore);
      expect(bytes(dumped[COMMITTED_HEADS])).toBe(headBefore);
      resetTestHooks();
      const restored = await storage.restore(selected, attributes, READ_COMPATIBILITY);
      expect(restored?.revision).toBe(opaque("1"));
      expect((await names(restored!.db)).length).toBe(40);
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a sweep this realm cannot see refuses the install rather than corrupting it",
  async ({ browser }) => {
    const name = `ramose-gc-foreign-sweep-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(120, "seed"));
      const before = bytes((await dump(name))[COMMITTED]);

      // Park the install after materialization has written its nodes and before
      // the manifest naming them commits — the one window in which those nodes
      // are reachable from nothing.
      armCheckpoint("replica.installing", "wait");
      const installing = storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000007".padEnd(43, "z"), "changed"),
      );
      await reachedCheckpoint("replica.installing");

      // Another tab's sweep leaves exactly one durable trace, and this realm's
      // materialization mark is invisible to it. Write that trace directly, the
      // way the other tab's transaction would have.
      await bumpSweepGeneration(name, partition);
      releaseCheckpoint("replica.installing");

      // The install is refused rather than committing a manifest over nodes a
      // sweep may have taken, and the previously committed value is untouched.
      await expect(installing).rejects.toMatchObject({ _tag: "ReplicaFencedError" });
      expect(bytes((await dump(name))[COMMITTED])).toBe(before);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("1"));
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "neither a sweep nor quota recovery can reach the mutation families",
  async ({ browser }) => {
    const name = `ramose-gc-mutations-${browser.uniqueId}`;
    const selected = identity();
    const scope = { server: SERVER, principal: PRINCIPAL };
    const receiver = { ...scope, database: ROOT_DATABASE };
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(120, "seed"));
      await confirm(storage, selected, "queued");
      // Real durable work, queued through the real outbox.
      await storage.outbox().enqueue({
        invocation: invocationId(),
        receiver,
        operation: {
          catalog: "movies" as never,
          owner: { kind: "entity", name: "issue" },
          localName: "create",
        },
        operationVersion: "b".repeat(64) as OperationVersion,
        target: { type: "none" },
        input: { title: "offline" },
        allocations: [],
        inputRefs: [],
        enqueuedAt: Date.now(),
      }, { scope });
      const queued = bytes(await dumpMutations(name));
      expect(queued).toContain("offline");

      // A change orphans roots, so the pass below really does delete something.
      dropped(await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000003".padEnd(43, "z"), "changed"),
      ));
      const swept = await storage.collectGarbage();
      expect(swept.nodes).toBeGreaterThan(0);
      expect(bytes(await dumpMutations(name))).toBe(queued);

      // And the recovery pass an exhausted quota triggers is the same pass:
      // storage pressure never evicts unsubmitted work.
      armCheckpointThrow("replica.install", {
        error: "storage is full",
        errorName: "QuotaExceededError",
        times: 1,
      });
      const applied = await storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000004".padEnd(43, "z"), "later"),
      );
      expect(applied?.revision).toBe(opaque("3"));
      dropped(applied);
      expect(bytes(await dumpMutations(name))).toBe(queued);
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "clear, eviction, and close settle with GC rather than against it",
  async ({ browser }) => {
    const name = `ramose-gc-lifecycle-${browser.uniqueId}`;
    const selected = identity();
    const child = identity({ database: CHILD_DATABASE });
    const childPartition = replicaPartitionKey(child);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installSnapshot(storage, selected, opaque("1"), wideDatoms(30, "root"));
      await installSnapshot(storage, child, opaque("2"), wideDatoms(30, "child"));
      await confirm(storage, selected, "root");
      await confirm(storage, child, "child");

      // Give both partitions a real sweep generation, so the clear and the
      // eviction below have a record to take with them.
      dropped(await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("5"), "entity-000001".padEnd(43, "z"), "moved"),
      ));
      dropped(await storage.applyChange(
        changeOne(child, opaque("2"), opaque("6"), "entity-000001".padEnd(43, "z"), "moved"),
      ));
      expect((await storage.collectGarbage()).nodes).toBeGreaterThan(0);
      expect(await sweepGeneration(name, childPartition)).toBe(1);
      expect(await sweepGeneration(name, replicaPartitionKey(selected))).toBe(1);

      // Eviction deletes the database's records outright, so a later pass finds
      // no partition to sweep there and the ancestor is untouched.
      const evicted = await storage.evictDatabase({
        server: SERVER, principal: PRINCIPAL, database: CHILD_DATABASE,
      });
      expect(evicted.nodes).toBeGreaterThan(0);
      expect(await nodeHashes(name, childPartition)).toEqual([]);
      // The evicted database took its sweep generation with it: nothing would
      // ever remove a record named after a partition that no longer exists.
      expect(await sweepGeneration(name, childPartition)).toBe(0);
      const afterEvict = await storage.collectGarbage();
      expect(afterEvict.partitions).toBe(1);
      expect(afterEvict.nodes).toBe(0);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("5"));

      // A cleared scope is terminal for this handle: it may not be swept either,
      // because sweeping would write a generation record back into it.
      await storage.clearScope({ server: SERVER, principal: PRINCIPAL });
      await expect(
        storage.collectGarbage({ scope: { server: SERVER, principal: PRINCIPAL } }),
      ).rejects.toMatchObject({ _tag: "ReplicaScopeClearedError" });
      const afterClear = await storage.collectGarbage();
      expect(afterClear).toEqual({
        partitions: 0, swept: 0, skipped: 0, nodes: 0, retained: 0, staging: 0,
      });
      const dumped = await dump(name);
      expect(dumped[NODES]).toEqual([]);
      expect(dumped[COMMITTED]).toEqual([]);
      // And the clear took the scope's remaining sweep record with it, while
      // the durable scope and database generations survive by design.
      expect(await sweepGeneration(name, replicaPartitionKey(selected))).toBe(0);
      expect(
        (dumped[GENERATIONS] as { kind: string }[]).some((record) => record.kind === "partition"),
      ).toBe(false);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);
