/**
 * Real-Chromium integrity and corruption-recovery coverage (#474 slice 9).
 *
 * Every corruption below is inflicted on the actual IndexedDB records the
 * production adapter wrote — a flipped byte in a real gzipped node body, a real
 * deleted node record, a real edited manifest — through the browser's own
 * `indexedDB`. Nothing here fakes storage, and nothing observes the replica
 * except through the ordinary restore paths.
 */

import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  armCheckpoint,
  releaseCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import { browserTest } from "./fixtures.ts";

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const LEFT = opaque("l");
const RIGHT = opaque("r");
const ROOT_DATABASE = opaque("d");
const SIBLING_DATABASE = opaque("f");
const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));
const OTHER_COMPATIBILITY = ReadCompatibilityHash.make(opaque("K"));

const COMMITTED = "replica-committed-v1";
const COMMITTED_HEADS = "replica-committed-heads-v1";
const NODES = "replica-nodes-v1";
const GENERATIONS = "replica-generations-v1";
const ROUTE_SLOTS = "replica-route-slots-v1";
const CREDENTIAL_BINDINGS = "replica-credential-bindings-v1";
const CACHE_CANDIDATES = "replica-cache-candidates-v1";

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

/** Every record of every store, as a comparable value. */
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

/** Records of one store whose primary key begins with a partition string. */
const partitioned = (records: unknown[], partition: string): unknown[] =>
  records.filter((record) => (record as { partition?: unknown }).partition === partition);

const nodeRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, ""], [partition, "￿"]);

type NodeRecord = { partition: string; hash: string; body: Uint8Array };

const nodesOf = async (name: string, partition: string): Promise<NodeRecord[]> => {
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readonly");
  const records = await requestResult<NodeRecord[]>(
    transaction.objectStore(NODES).getAll(nodeRange(partition)),
  );
  await transactionDone(transaction);
  database.close();
  return records;
};

const committedOf = async (name: string, partition: string): Promise<Record<string, unknown>> => {
  const database = await openNative(name);
  const transaction = database.transaction(COMMITTED, "readonly");
  const record = await requestResult<Record<string, unknown>>(
    transaction.objectStore(COMMITTED).get(partition),
  );
  await transactionDone(transaction);
  database.close();
  return record;
};

/** Rewrite one real stored record through the browser's own IndexedDB. */
const writeRecord = async (name: string, store: string, record: unknown): Promise<void> => {
  const database = await openNative(name);
  const transaction = database.transaction(store, "readwrite");
  transaction.objectStore(store).put(record);
  await transactionDone(transaction);
  database.close();
};

const deleteNode = async (name: string, partition: string, hash: string): Promise<void> => {
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readwrite");
  transaction.objectStore(NODES).delete([partition, hash]);
  await transactionDone(transaction);
  database.close();
};

/** Flip one bit of a stored node body, leaving it filed under the same address. */
const flipNodeByte = async (
  name: string,
  partition: string,
  hash: string,
): Promise<void> => {
  const records = await nodesOf(name, partition);
  const record = records.find((entry) => entry.hash === hash);
  if (record === undefined) throw new Error(`no stored node ${hash}`);
  const body = new Uint8Array(record.body);
  body[body.length - 1] ^= 0x01;
  await writeRecord(name, NODES, { partition, hash, body });
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
  // The wire protocol caps one chunk at 16 datoms, so a larger replica really
  // is staged as many real transactions, exactly as a session would stage it.
  let index = 0;
  for (let offset = 0; offset < datoms.length; offset += 16) {
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected, snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + 16),
    });
  }
  expect(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 1, identity: selected, snapshot, revision,
    chunks: index,
  }, attributes)).toBeDefined();
};

const installOne = (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  revision: string,
  value: string,
): Promise<void> =>
  installSnapshot(storage, selected, revision, [snapshotDatom(opaque("x"), value)]);

const confirm = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  label: string,
): Promise<void> => {
  await storage.bindAuthenticated({
    fingerprint: `fingerprint-${label}`,
    identity: selected,
    candidateKey: { selector: `selector-${label}`, routeSlot: `slot-${label}` },
    route: { scope: "origin-root", pathKey: `path-${label}`, slot: `slot-${label}` },
  });
};

const names = async (db: Db): Promise<string[]> => {
  const attribute = db.attr(":item/name")!;
  return (await db.datomsArray(Index.AEVT, { a: attribute.id })).map((datom) => datom.v as string);
};

browserTest(
  "a flipped byte in a content node yields no Db and quarantines exactly that partition",
  async ({ browser }) => {
    const name = `ramose-integrity-flip-${browser.uniqueId}`;
    const corrupt = identity();
    const sibling = identity({ database: SIBLING_DATABASE });
    const other = identity({ principal: RIGHT });
    const partition = replicaPartitionKey(corrupt);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installOne(storage, corrupt, opaque("1"), "corrupt-root");
      await installOne(storage, sibling, opaque("2"), "sibling-root");
      await installOne(storage, other, opaque("3"), "other-principal");
      await confirm(storage, corrupt, "corrupt");
      await confirm(storage, sibling, "sibling");
      await confirm(storage, other, "other");

      const before = await dump(name);
      const siblingPartition = replicaPartitionKey(sibling);
      const otherPartition = replicaPartitionKey(other);
      const siblingBefore = bytes(partitioned(before[NODES], siblingPartition));
      const otherBefore = bytes(partitioned(before[NODES], otherPartition));
      const generationsBefore = bytes(before[GENERATIONS]);
      const routesBefore = bytes(before[ROUTE_SLOTS]);

      // Corrupt the real body of a real stored node under its own address.
      const roots = (await committedOf(name, partition)).roots as Record<string, { hash: string }>;
      storage.close();
      await flipNodeByte(name, partition, roots.eavt.hash);

      storage = await IndexedDbReplicaStorage.open(name);
      const outcome = await storage.restoreOutcome(corrupt, attributes, READ_COMPATIBILITY);
      expect(outcome).toMatchObject({
        _tag: "replacement-required",
        partition,
        reason: "node-hash",
      });
      // Nothing observable was produced, not even over the datoms the walk did
      // manage to read before it reached the damaged node.
      expect(outcome).not.toHaveProperty("replica");
      expect(await storage.restore(corrupt, attributes, READ_COMPATIBILITY)).toBeUndefined();

      const after = await dump(name);
      // Exactly one partition lost its content, its head, and the selectors
      // that would nominate it again.
      expect(partitioned(after[COMMITTED], partition)).toEqual([]);
      expect(partitioned(after[COMMITTED_HEADS], partition)).toEqual([]);
      expect(partitioned(after[NODES], partition)).toEqual([]);
      expect(after[CREDENTIAL_BINDINGS]).toHaveLength(2);
      expect(after[CACHE_CANDIDATES]).toHaveLength(2);
      // Its scope is still confirmed and was never fenced: quarantine is not a
      // clear, and the user can still clear their own data afterwards.
      expect(bytes(after[GENERATIONS])).toBe(generationsBefore);
      expect(bytes(after[ROUTE_SLOTS])).toBe(routesBefore);
      // A sibling database in the same scope and another principal are intact
      // byte for byte, and still restore.
      expect(bytes(partitioned(after[NODES], siblingPartition))).toBe(siblingBefore);
      expect(bytes(partitioned(after[NODES], otherPartition))).toBe(otherBefore);
      expect(await names((await storage.restore(sibling, attributes, READ_COMPATIBILITY))!.db))
        .toEqual(["sibling-root"]);
      expect(await names((await storage.restore(other, attributes, READ_COMPATIBILITY))!.db))
        .toEqual(["other-principal"]);

      // Recovery is an ordinary fresh snapshot into the very same scope.
      await installOne(storage, corrupt, opaque("4"), "replaced");
      const recovered = await storage.restoreOutcome(corrupt, attributes, READ_COMPATIBILITY);
      expect(recovered._tag).toBe("restored");
      expect(await names((await storage.restore(corrupt, attributes, READ_COMPATIBILITY))!.db))
        .toEqual(["replaced"]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "the walk descends past the roots and finds a deleted interior node",
  async ({ browser }) => {
    const name = `ramose-integrity-missing-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      // Enough datoms that the default 3000-datom leaf splits: the eavt tree is
      // a directory over two leaves, so a leaf is only reachable by descending.
      const datoms = Array.from(
        { length: 3200 },
        (_unused, index) =>
          snapshotDatom(`${index}`.padStart(43, "e"), `value-${index}`),
      );
      await installSnapshot(storage, selected, opaque("1"), datoms);
      const record = await committedOf(name, partition);
      const roots = record.roots as Record<string, { hash: string; kind: number }>;
      expect(roots.eavt.kind).toBe(1);

      const stored = await nodesOf(name, partition);
      const rootHashes = new Set(
        ["eavt", "aevt", "avet", "vaet"].map((index) => roots[index].hash),
      );
      const interior = stored.find((entry) => !rootHashes.has(entry.hash));
      expect(interior).toBeDefined();

      storage.close();
      await deleteNode(name, partition, interior!.hash);

      storage = await IndexedDbReplicaStorage.open(name);
      expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
        .toMatchObject({ _tag: "replacement-required", reason: "node-missing" });
      expect(partitioned((await dump(name))[COMMITTED], partition)).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("counts that no tree could produce are refused", async ({ browser }) => {
  const name = `ramose-integrity-counts-${browser.uniqueId}`;
  const selected = identity();
  const partition = replicaPartitionKey(selected);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installOne(storage, selected, opaque("1"), "counted");
    const record = await committedOf(name, partition);
    const roots = record.roots as Record<string, { hash: string; kind: number; count: number }>;
    storage.close();

    // Only eavt's count moves: the two full indexes can never disagree, so the
    // manifest contradicts itself and no node is ever read.
    await writeRecord(name, COMMITTED, {
      ...record,
      roots: { ...roots, eavt: { ...roots.eavt, count: roots.eavt.count + 5 } },
    });
    storage = await IndexedDbReplicaStorage.open(name);
    expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
      .toMatchObject({ _tag: "replacement-required", reason: "manifest-invariant" });

    // Both counts move together, so the manifest is self-consistent and only
    // the node itself can settle it.
    await installOne(storage, selected, opaque("2"), "counted again");
    const reinstalled = await committedOf(name, partition);
    const rebuilt = reinstalled.roots as Record<string, { count: number }>;
    storage.close();
    await writeRecord(name, COMMITTED, {
      ...reinstalled,
      roots: {
        ...rebuilt,
        eavt: { ...rebuilt.eavt, count: rebuilt.eavt.count + 5 },
        aevt: { ...rebuilt.aevt, count: rebuilt.aevt.count + 5 },
      },
    });
    storage = await IndexedDbReplicaStorage.open(name);
    expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
      .toMatchObject({ _tag: "replacement-required", reason: "node-invariant" });
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a manifest that mixes two values is refused even though every node is intact",
  async ({ browser }) => {
    const name = `ramose-integrity-mixed-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      // Two committed values with the same datom count. Nothing collects the
      // superseded nodes yet (#474 slice 11 owns reachability GC), so the older
      // value's roots are still perfectly loadable.
      await installOne(storage, selected, opaque("1"), "before");
      const stale = (await committedOf(name, partition)).roots as Record<
        string,
        { hash: string; kind: number; count: number }
      >;
      await installOne(storage, selected, opaque("2"), "after");
      const current = await committedOf(name, partition);
      const roots = current.roots as Record<string, { hash: string; count: number }>;
      expect(stale.eavt.count).toBe(roots.eavt.count);
      expect(stale.eavt.hash).not.toBe(roots.eavt.hash);
      storage.close();

      // Every count still agrees and every node still hashes to its address;
      // only entity-ordered and attribute-ordered reads would disagree.
      await writeRecord(name, COMMITTED, {
        ...current,
        roots: { ...roots, aevt: stale.aevt },
      });
      storage = await IndexedDbReplicaStorage.open(name);
      expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
        .toMatchObject({ _tag: "replacement-required", reason: "manifest-invariant" });

      // The basis is the manifest's own claim, and it becomes the restored
      // value's `basisT`: lowering it would filter intact facts out of reads.
      await installOne(storage, selected, opaque("3"), "rebuilt");
      const rebuilt = await committedOf(name, partition);
      expect(rebuilt.roots).toMatchObject({ t: expect.any(Number) });
      storage.close();
      await writeRecord(name, COMMITTED, {
        ...rebuilt,
        roots: { ...rebuilt.roots as Record<string, unknown>, t: 1 },
      });
      storage = await IndexedDbReplicaStorage.open(name);
      expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
        .toMatchObject({ _tag: "replacement-required", reason: "manifest-invariant" });
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a replacement installed while the walk runs is never quarantined",
  async ({ browser }) => {
    const name = `ramose-integrity-race-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const reader = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    const writer = await IndexedDbReplicaStorage.open(name);
    try {
      await installOne(reader, selected, opaque("1"), "corrupt");
      const roots = (await committedOf(name, partition)).roots as Record<string, { hash: string }>;
      await flipNodeByte(name, partition, roots.eavt.hash);

      // Park the refusal after it decides and before it removes anything.
      armCheckpoint("replica.refused", "wait");
      const refusing = reader.restoreOutcome(selected, attributes, READ_COMPATIBILITY);
      // Another session commits a complete replacement in that window and may
      // already have published a Db over the nodes a quarantine would take.
      await installOne(writer, selected, opaque("2"), "replacement");
      releaseCheckpoint("replica.refused");

      // Nothing was removed, and the refusal describes nothing that is stored.
      expect(await refusing).toEqual({ _tag: "absent" });
      expect(await names((await writer.restore(selected, attributes, READ_COMPATIBILITY))!.db))
        .toEqual(["replacement"]);
      expect(partitioned((await dump(name))[COMMITTED], partition)).toHaveLength(1);
    } finally {
      resetTestHooks();
      reader.close();
      writer.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("a manifest that cannot describe its own facts is quarantined", async ({ browser }) => {
  const name = `ramose-integrity-manifest-${browser.uniqueId}`;
  const selected = identity();
  const partition = replicaPartitionKey(selected);
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installOne(storage, selected, opaque("1"), "described");
    const record = await committedOf(name, partition);
    expect((record.entityIds as unknown[]).length).toBeGreaterThan(0);
    storage.close();
    await writeRecord(name, COMMITTED, { ...record, entityIds: [] });

    storage = await IndexedDbReplicaStorage.open(name);
    expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
      .toMatchObject({ _tag: "replacement-required", reason: "manifest-invariant" });
    const after = await dump(name);
    expect(partitioned(after[COMMITTED], partition)).toEqual([]);
    expect(partitioned(after[NODES], partition)).toEqual([]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a bound restore quarantines the corrupt partition and only its own selector",
  async ({ browser }) => {
    const name = `ramose-integrity-bound-${browser.uniqueId}`;
    const corrupt = identity();
    const other = identity({ principal: RIGHT });
    const partition = replicaPartitionKey(corrupt);
    let storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installOne(storage, corrupt, opaque("1"), "bound");
      await installOne(storage, other, opaque("2"), "other-principal");
      await confirm(storage, corrupt, "corrupt");
      await confirm(storage, other, "other");
      const roots = (await committedOf(name, partition)).roots as Record<string, { hash: string }>;
      storage.close();
      await flipNodeByte(name, partition, roots.aevt.hash);

      storage = await IndexedDbReplicaStorage.open(name);
      expect(
        await storage.restoreBoundOutcome("fingerprint-corrupt", attributes, READ_COMPATIBILITY),
      ).toMatchObject({ _tag: "replacement-required", partition, reason: "node-hash" });

      const after = await dump(name);
      expect(after[CREDENTIAL_BINDINGS]).toEqual([
        expect.objectContaining({ fingerprint: "fingerprint-other" }),
      ]);
      expect(
        (await storage.restoreBoundOutcome(
          "fingerprint-other",
          attributes,
          READ_COMPATIBILITY,
        ))._tag,
      ).toBe("restored");
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "an intact replica this client cannot interpret is an update, not a replacement",
  async ({ browser }) => {
    const name = `ramose-integrity-update-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const storage = await IndexedDbReplicaStorage.open(name);
    try {
      await installOne(storage, selected, opaque("1"), "installed");
      await confirm(storage, selected, "installed");
      // A stale selector still names the identity that was stored, but the
      // client's catalog now confirms a different read compatibility. Nothing
      // under the old one may be interpreted, and the partition is withdrawn.
      expect(await storage.restoreOutcome(selected, attributes, OTHER_COMPATIBILITY))
        .toMatchObject({ _tag: "update-required", reason: "read-compatibility" });
      expect(partitioned((await dump(name))[COMMITTED], partition)).toEqual([]);

      // The same client, disagreeing about the schema behind a hash it does
      // confirm, is the other update-required case.
      await installOne(storage, selected, opaque("2"), "reinstalled");
      expect(
        await storage.restoreOutcome(selected, [
          { ident: ":item/name", valueType: ":db.type/long", cardinality: "one", index: true },
        ], READ_COMPATIBILITY),
      ).toMatchObject({ _tag: "update-required", reason: "schema-metadata" });
      expect(partitioned((await dump(name))[COMMITTED], partition)).toEqual([]);
      // Neither refusal touched the durable confirmation of the scope.
      expect((await dump(name))[GENERATIONS]).toHaveLength(2);
    } finally {
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a quarantine cut before it commits leaves the corrupt partition exactly as it was",
  async ({ browser }) => {
    const name = `ramose-integrity-cut-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    // The repository's inert runtime boundary, armed only for this test. The
    // real IndexedDB transaction runs unchanged; the armed checkpoint only
    // decides when the boundary before its commit fails.
    let storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
    try {
      await installOne(storage, selected, opaque("1"), "cut");
      await confirm(storage, selected, "cut");
      const roots = (await committedOf(name, partition)).roots as Record<string, { hash: string }>;
      storage.close();
      await flipNodeByte(name, partition, roots.eavt.hash);
      const corrupted = bytes(await dump(name));

      storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
      armCheckpoint("replica.quarantine", "throw", "cut before the quarantine committed");
      try {
        await expect(storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
          .rejects.toThrow(/cut before the quarantine/);
      } finally {
        resetTestHooks();
      }
      // Every deletion the transaction had issued rolled back; a crash cut
      // never leaves a half-quarantined partition.
      expect(bytes(await dump(name))).toBe(corrupted);

      // Retrying completes the quarantine, and still publishes nothing.
      expect(await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY))
        .toMatchObject({ _tag: "replacement-required", reason: "node-hash" });
      expect(partitioned((await dump(name))[NODES], partition)).toEqual([]);
    } finally {
      resetTestHooks();
      storage.close();
      await deleteDatabase(name);
    }
  },
);
