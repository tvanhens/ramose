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
import type { ReplicaNotice } from "../../packages/ramose/src/internal/replication/notices.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeKey,
  replicaScopeOf,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
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

const reachedCheckpoint = async (name: string): Promise<void> => {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (checkpointStatus()[name]?.pending === true) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`checkpoint ${name} was never reached`);
};

const revisionOf = async (
  pending: Promise<{ readonly revision: string; readonly release: () => void } | undefined>,
): Promise<string | undefined> => {
  const value = await pending;
  value?.release();
  return value?.revision;
};

const dropped = (value: { readonly release: () => void } | undefined): void => {
  value?.release();
};

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
    type: "SnapshotStart", protocol: 3, identity: selected, snapshot, revision,
  });
  let index = 0;
  for (let offset = 0; offset < datoms.length; offset += 16) {
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 3, identity: selected, snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + 16),
    }));
  }
  const committed = await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 3, identity: selected, snapshot, revision,
    ordinal: 1,
    chunks: index,
  }, attributes);
  expect(committed).toBeDefined();
  dropped(committed);
};

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
  protocol: 3 as const,
  identity: selected,
  from,
  revision,
  ordinal: 2,
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

      expect(afterChange.length).toBeGreaterThan(afterSnapshot.length);

      storage.resetWriteCounts();
      const outcome = await storage.collectGarbage();

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

      await storage.startSnapshot({
        type: "SnapshotStart", protocol: 3, identity: selected,
        snapshot: opaque("y"), revision: opaque("9"),
      });
      await storage.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 3, identity: selected, snapshot: opaque("y"),
        index: 0, datoms: [snapshotDatom(opaque("x"), "abandoned")],
      }));

      const before = await nodeHashes(name, partition);
      const siblingBefore = await nodeHashes(name, siblingPartition);
      storage.close();

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

      expect((await dump(name))[COMMITTED]).toHaveLength(1);
      expect(await nodeHashes(name, partition)).toHaveLength(before.length);

      const swept = await storage.collectGarbage();
      expect(await nodeHashes(name, partition)).toEqual([]);
      expect(swept.nodes).toBe(before.length);
      expect(swept.staging).toBe(1);

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

      armCheckpoint("replica.validated", "wait");
      const walking = storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000009".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      const beforeSweep = await nodeHashes(name, partition);
      expect(beforeSweep.length).toBeGreaterThan(original.length);

      armCheckpoint("replica.gc.planned", "wait");
      const sweeping = storage.collectGarbage();
      await reachedCheckpoint("replica.gc.planned");

      releaseCheckpoint("replica.validated");
      await drainMicrotasks(50);
      releaseCheckpoint("replica.gc.planned");

      const outcome = await walking;
      const swept = await sweeping;
      expect(outcome._tag).toBe("restored");
      const restored = outcome._tag === "restored" ? outcome.replica : undefined;
      try {

        expect((await names(restored!.db)).length).toBe(120);
        expect(swept.nodes).toBe(0);
        expect(swept.skipped).toBe(1);

        expect(await nodeHashes(name, partition)).toEqual(beforeSweep);
      } finally {
        dropped(restored);
      }

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

      armCheckpoint("replica.validated", "wait");
      const walking = reader.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      const applied = await writer.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000009".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);
      const sweep = await writer.collectGarbage();
      expect(sweep.nodes).toBeGreaterThan(0);
      const survivors = new Set(await nodeHashes(name, partition));

      expect(original.some((hash) => !survivors.has(hash))).toBe(true);
      expect(await sweepGeneration(name, partition)).toBe(1);

      releaseCheckpoint("replica.validated");
      const outcome = await walking;

      expect(outcome._tag).toBe("restored");
      const restored = outcome._tag === "restored" ? outcome.replica : undefined;
      expect(restored?.revision).toBe(opaque("2"));

      expect((await names(restored!.db)).includes("changed")).toBe(true);

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

      await installSnapshot(storage, selected, opaque("1"), wideDatoms(4000, "seed"));
      const before = await nodeHashes(name, partition);
      expect(before.length).toBeGreaterThan(4);
      storage.close();

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

        expect(outcome.skipped).toBe(1);
        expect(outcome.swept).toBe(0);
        expect(outcome.nodes).toBe(0);
        expect(await nodeHashes(name, partition)).toEqual(before);
        expect(await sweepGeneration(name, partition)).toBe(0);

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

      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000008".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);
      const before = await nodeHashes(name, partition);
      const current = await committedOf(name, partition);
      storage.close();

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

      dropped(superseded);

      armCheckpoint("replica.gc.planned", "wait");
      const sweeping = storage.collectGarbage();
      await reachedCheckpoint("replica.gc.planned");
      const retention = storage.retainRoots(selected, superseded!.db.roots);
      releaseCheckpoint("replica.gc.planned");
      const outcome = await sweeping;

      expect(outcome.nodes).toBe(0);
      expect(outcome.skipped).toBe(1);
      expect(outcome.swept).toBe(0);
      expect(await sweepGeneration(name, partition)).toBe(0);

      expect((await names(superseded!.db)).length).toBe(120);

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
      });
      await storage.bindAuthenticated({
        fingerprint: await replicationCredentialFingerprint(
          "known-credential",
          address,
          await rootReplicaRouteSlot(),
        ),
        identity: selected,
      });

      session = await ReplicationSession.open({
        activation: { server: "http://127.0.0.1:1", root: "root" },
        credential: "known-credential",
        attributes,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const published = session.snapshot().value;
      expect(published?.revision).toBe(opaque("1"));

      const applied = await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000005".padEnd(43, "z"), "changed"),
      );
      expect(applied?.revision).toBe(opaque("2"));
      dropped(applied);

      const outcome = await storage.collectGarbage();

      expect(outcome.skipped).toBe(0);
      expect(outcome.retained).toBe((await nodeHashes(name, partition)).length);

      expect((await names(published!.db)).length).toBe(80);

      const next = await storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000006".padEnd(43, "z"), "later"),
      );
      expect(next?.revision).toBe(opaque("3"));
      dropped(next);

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

    armCheckpoint("replica.sweep", "throw", "simulated crash cut");
    await expect(storage.collectGarbage()).rejects.toThrow("simulated crash cut");

    expect(bytes(await dump(name))).toBe(before);
    expect(await sweepGeneration(name, partition)).toBe(0);
    resetTestHooks();

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

      expect(await sweepGeneration(name, partition)).toBe(0);

      armCheckpointThrow("replica.install", {
        error: "storage is full",
        errorName: "QuotaExceededError",
        times: 1,
      });
      const applied = await storage.applyChange(
        changeOne(selected, opaque("2"), opaque("3"), "entity-000002".padEnd(43, "z"), "two"),
      );

      expect(applied?.revision).toBe(opaque("3"));
      expect(await sweepGeneration(name, partition)).toBe(1);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("3"));

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

      armCheckpoint("replica.installing", "wait");
      const installing = storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000007".padEnd(43, "z"), "changed"),
      );
      await reachedCheckpoint("replica.installing");

      await bumpSweepGeneration(name, partition);
      releaseCheckpoint("replica.installing");

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

      dropped(await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("2"), "entity-000003".padEnd(43, "z"), "changed"),
      ));
      const swept = await storage.collectGarbage();
      expect(swept.nodes).toBeGreaterThan(0);
      expect(bytes(await dumpMutations(name))).toBe(queued);

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
  "a rotated read view leaves a partition the next sweep reclaims whole",
  async ({ browser }) => {
    const name = `ramose-gc-rotated-read-view-${browser.uniqueId}`;
    const original = identity();
    const rotated = identity({ readView: opaque("w"), authenticator: opaque("b") });
    const sibling = identity({ database: CHILD_DATABASE });
    const partition = replicaPartitionKey(original);
    const siblingPartition = replicaPartitionKey(sibling);
    const storage = await IndexedDbReplicaStorage.open(name);
    const observer = await IndexedDbReplicaStorage.open(name);
    const announced = new Promise<ReplicaNotice | undefined>((resolve) => {
      observer.notices((notice) => {
        if (notice.kind === "reset") resolve(notice);
      });
      setTimeout(() => resolve(undefined), 2000);
    });
    try {
      await installSnapshot(storage, original, opaque("1"), wideDatoms(60, "before"));
      await installSnapshot(storage, sibling, opaque("3"), wideDatoms(20, "child"));
      await confirm(storage, original, "root");
      await confirm(storage, sibling, "child");
      const before = await nodeHashes(name, partition);
      const siblingBefore = await nodeHashes(name, siblingPartition);
      expect(before.length).toBeGreaterThan(0);

      await installSnapshot(storage, rotated, opaque("2"), wideDatoms(60, "after"));
      await confirm(storage, rotated, "root");
      expect((await dump(name))[COMMITTED]).toHaveLength(3);

      const outcome = await storage.collectGarbage();
      expect(outcome.partitions).toBe(3);
      expect(outcome.swept).toBe(1);
      expect(outcome.skipped).toBe(0);
      expect(outcome.nodes).toBe(before.length);
      expect(await nodeHashes(name, partition)).toEqual([]);
      expect(await sweepGeneration(name, partition)).toBe(1);

      const dumped = await dump(name);
      expect(dumped[COMMITTED]).toHaveLength(2);
      expect(dumped[COMMITTED_HEADS]).toHaveLength(2);

      expect(await storage.restore(original, attributes, READ_COMPATIBILITY)).toBeUndefined();
      expect(await revisionOf(storage.restore(rotated, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("2"));
      expect(await revisionOf(storage.restore(sibling, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("3"));
      expect(await nodeHashes(name, siblingPartition)).toEqual(siblingBefore);

      expect(await announced).toEqual({
        kind: "reset",
        scope: replicaScopeKey(replicaScopeOf(original)),
        database: replicaDatabaseKey(replicaDatabaseScopeOf(original)),
      });
    } finally {
      observer.close();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a walk parked over a superseded partition cannot publish after it is reclaimed",
  async ({ browser }) => {
    const name = `ramose-gc-superseded-parked-walk-${browser.uniqueId}`;
    const original = identity();
    const rotated = identity({ readView: opaque("w"), authenticator: opaque("b") });
    const partition = replicaPartitionKey(original);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, original, opaque("1"), wideDatoms(120, "seed"));
      await confirm(storage, original, "root");

      armCheckpoint("replica.validated", "wait");
      const walking = storage.restoreOutcome(original, attributes, READ_COMPATIBILITY);
      await reachedCheckpoint("replica.validated");

      await installSnapshot(storage, rotated, opaque("2"), wideDatoms(120, "next"));
      await confirm(storage, rotated, "root");
      const swept = await storage.collectGarbage();
      expect(swept.nodes).toBeGreaterThan(0);
      expect(await nodeHashes(name, partition)).toEqual([]);
      expect(await sweepGeneration(name, partition)).toBe(1);

      releaseCheckpoint("replica.validated");
      const outcome = await walking;

      expect(outcome._tag).toBe("absent");
      expect(await revisionOf(storage.restore(rotated, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("2"));
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a confirmation that reclaims a planned partition leaves it whole",
  async ({ browser }) => {
    const name = `ramose-gc-reconfirmed-partition-${browser.uniqueId}`;
    const original = identity();
    const rotated = identity({ readView: opaque("w"), authenticator: opaque("b") });
    const partition = replicaPartitionKey(original);
    const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installSnapshot(storage, original, opaque("1"), wideDatoms(60, "seed"));
      await installSnapshot(storage, rotated, opaque("2"), wideDatoms(60, "next"));
      await confirm(storage, rotated, "root");
      const before = await nodeHashes(name, partition);

      armCheckpoint("replica.gc.planned", "wait");
      const sweeping = storage.collectGarbage();
      await reachedCheckpoint("replica.gc.planned");
      await confirm(storage, original, "root");
      releaseCheckpoint("replica.gc.planned");

      const outcome = await sweeping;
      expect(outcome.skipped).toBeGreaterThan(0);
      expect(await nodeHashes(name, partition)).toEqual(before);
      expect(await sweepGeneration(name, partition)).toBe(0);
      expect(await revisionOf(storage.restore(original, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("1"));
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

      dropped(await storage.applyChange(
        changeOne(selected, opaque("1"), opaque("5"), "entity-000001".padEnd(43, "z"), "moved"),
      ));
      dropped(await storage.applyChange(
        changeOne(child, opaque("2"), opaque("6"), "entity-000001".padEnd(43, "z"), "moved"),
      ));
      expect((await storage.collectGarbage()).nodes).toBeGreaterThan(0);
      expect(await sweepGeneration(name, childPartition)).toBe(1);
      expect(await sweepGeneration(name, replicaPartitionKey(selected))).toBe(1);

      const evicted = await storage.evictDatabase({
        server: SERVER, principal: PRINCIPAL, database: CHILD_DATABASE,
      });
      expect(evicted.nodes).toBeGreaterThan(0);
      expect(await nodeHashes(name, childPartition)).toEqual([]);

      expect(await sweepGeneration(name, childPartition)).toBe(0);
      const afterEvict = await storage.collectGarbage();
      expect(afterEvict.partitions).toBe(1);
      expect(afterEvict.nodes).toBe(0);
      expect(await revisionOf(storage.restore(selected, attributes, READ_COMPATIBILITY)))
        .toBe(opaque("5"));

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
