import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
  type ReplicaWriteCounts,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  MAX_REPLICATION_DATOMS_PER_CHANGE,
  MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK,
  type ReplicationIdentity,
  type SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk, changeFrame } from "../../packages/ramose/test/replication-fixtures.ts";

const BUDGET_10K_COLD_MS = 15_000;

const BUDGET_100K_SNAPSHOT_MS = 90_000;

const BUDGET_100K_RESTORE_MS = 10_000;

const BUDGET_100K_CHANGE_MS = 10_000;

const SCALE_10K = 10_000;
const SCALE_100K = 100_000;

const opaque = (character: string): string => character.repeat(43);

const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));

const identity = (overrides: Partial<ReplicationIdentity> = {}): ReplicationIdentity => ({
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: READ_COMPATIBILITY,
  graphLineage: [],
  authenticator: opaque("a"),
  ...overrides,
});

const attributes: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", cardinality: "one" },
  { ident: ":item/tag", valueType: ":db.type/string", cardinality: "one", index: true },
  { ident: ":item/rank", valueType: ":db.type/long", cardinality: "one" },
  { ident: ":item/done", valueType: ":db.type/boolean", cardinality: "one" },
];

const FIELDS_PER_ENTITY = attributes.length;

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const entityId = (n: number): string =>
  `e${n.toString(36).padStart(9, "0")}`.padEnd(43, "-");

const TAGS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

const scaleDatoms = (count: number, seed = 0x5eed): readonly SnapshotDatom[] => {
  const random = mulberry32(seed);
  const entities = Math.ceil(count / FIELDS_PER_ENTITY);
  const datoms: SnapshotDatom[] = [];
  for (let n = 0; n < entities && datoms.length < count; n++) {
    const entity = entityId(n);
    const tag = TAGS[Math.floor(random() * TAGS.length)];
    const rank = Math.floor(random() * 1_000_000);
    const facts: readonly SnapshotDatom[] = [
      { entity, field: ":item/name", value: { type: "string", value: `item ${n} ${tag}` }, op: "add" },
      { entity, field: ":item/tag", value: { type: "string", value: tag }, op: "add" },
      { entity, field: ":item/rank", value: { type: "long", value: rank }, op: "add" },
      { entity, field: ":item/done", value: { type: "boolean", value: rank % 2 === 0 }, op: "add" },
    ];
    for (const fact of facts) {
      if (datoms.length >= count) break;
      datoms.push(fact);
    }
  }
  return datoms;
};

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
    request.addEventListener("blocked", () => reject(new Error("delete blocked")), { once: true });
  });

const NODES = "replica-nodes-v1";
const COMMITTED = "replica-committed-v1";

type StoredNode = { readonly partition: string; readonly hash: string; readonly body: Uint8Array };

const nodeRange = (partition: string): IDBKeyRange =>
  IDBKeyRange.bound([partition, ""], [partition, "￿"]);

const storedNodes = async (name: string, partition: string): Promise<readonly StoredNode[]> => {
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readonly");
  const records = await requestResult<StoredNode[]>(
    transaction.objectStore(NODES).getAll(nodeRange(partition)),
  );
  await transactionDone(transaction);
  database.close();
  return records;
};

const flipStoredNodeByte = async (
  name: string,
  partition: string,
  hash: string,
): Promise<void> => {
  const records = await storedNodes(name, partition);
  const record = records.find((entry) => entry.hash === hash);
  if (record === undefined) throw new Error(`no stored node ${hash}`);
  const body = new Uint8Array(record.body);
  body[body.length - 1] ^= 0x01;
  const database = await openNative(name);
  const transaction = database.transaction(NODES, "readwrite");
  transaction.objectStore(NODES).put({ partition, hash, body });
  await transactionDone(transaction);
  database.close();
};

type StorageImage = {
  readonly nodeCount: number;
  readonly nodeBytes: number;
  readonly hashes: ReadonlySet<string>;
  readonly manifest: string;
};

const imageOf = async (name: string, partition: string): Promise<StorageImage> => {
  const nodes = await storedNodes(name, partition);
  const database = await openNative(name);
  const transaction = database.transaction(COMMITTED, "readonly");
  const manifest = await requestResult<unknown>(transaction.objectStore(COMMITTED).get(partition));
  await transactionDone(transaction);
  database.close();
  let nodeBytes = 0;
  const hashes = new Set<string>();
  for (const node of nodes) {
    nodeBytes += node.body.byteLength;
    hashes.add(node.hash);
  }
  return {
    nodeCount: nodes.length,
    nodeBytes,
    hashes,
    manifest: JSON.stringify(manifest, (_key, value) =>
      value instanceof Uint8Array ? [...value] : (value as unknown)),
  };
};

type Timing = { readonly ms: number };

const timed = async <A>(run: () => Promise<A>): Promise<A & Timing> => {
  const started = performance.now();
  const value = await run();
  return { ...(value as object), ms: performance.now() - started } as A & Timing;
};

const report = (cell: string, ms: number, budget: number, detail: Record<string, unknown>): void => {
  const facts = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`).join(" ");
  console.log(
    `[#474 scale] ${cell}: ${ms.toFixed(0)}ms / ${budget}ms budget (${(100 * ms / budget).toFixed(0)}%) ${facts}`,
  );
};

const installSnapshot = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  revision: string,
  datoms: readonly SnapshotDatom[],
): Promise<{ readonly chunks: number }> => {
  const snapshot = `${revision}-snap`.padEnd(43, "q").slice(0, 43);
  await storage.startSnapshot({
    type: "SnapshotStart",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
  });
  let index = 0;
  for (
    let offset = 0;
    offset < datoms.length;
    offset += MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK
  ) {
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk",
      protocol: 1,
      identity: selected,
      snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK),
    }));
  }
  const installed = await storage.commitSnapshot({
    type: "SnapshotCommit",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
    chunks: index,
  }, attributes);
  expect(installed).toBeDefined();
  return { chunks: index };
};

const representativeQuery = async (db: Db): Promise<{
  readonly matched: number;
  readonly name: string;
}> => {
  const tag = db.requireAttr(":item/tag");
  const matches = await db.datomsArray(Index.AVET, { a: tag.id, v: "delta" });
  expect(matches.length).toBeGreaterThan(0);
  const nameAttribute = db.requireAttr(":item/name");
  const facts = await db.datomsArray(Index.EAVT, { e: matches[0].e });
  expect(facts.length).toBe(FIELDS_PER_ENTITY);
  const name = facts.find((datom) => datom.a === nameAttribute.id)?.v;
  expect(typeof name).toBe("string");
  return { matched: matches.length, name: name as string };
};

const withStorage = async <A>(
  name: string,
  run: (storage: IndexedDbReplicaStorage) => Promise<A>,
): Promise<A> => {
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    return await run(storage);
  } finally {
    storage.close();
  }
};

const budgetHeadroom = (label: string, ms: number, budget: number): void => {
  expect(ms, `${label} exceeded its #480 budget of ${budget}ms`).toBeLessThan(budget);
};

browserTest(
  "10k datoms: cold snapshot, atomic install, reopen and one query stay inside the 15s budget",
  { timeout: 300_000 },
  async ({ browser }) => {
    const name = `ramose-scale-10k-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const datoms = scaleDatoms(SCALE_10K);
    expect(datoms).toHaveLength(SCALE_10K);
    try {
      let writes: ReplicaWriteCounts | undefined;
      let chunks = 0;
      const cold = await timed(async () => {

        await withStorage(name, async (storage) => {
          chunks = (await installSnapshot(storage, selected, opaque("1"), datoms)).chunks;
          writes = storage.writeCounts();
        });
        return await withStorage(name, async (storage) => {
          const restored = await storage.restore(selected, attributes, READ_COMPATIBILITY);
          expect(restored).toBeDefined();
          const query = await representativeQuery(restored!.db);
          return { matched: query.matched };
        });
      });
      const image = await imageOf(name, partition);
      report("10k cold snapshot+install+reopen+query", cold.ms, BUDGET_10K_COLD_MS, {
        chunks,
        nodes: image.nodeCount,
        nodeKiB: Math.round(image.nodeBytes / 1024),
        nodeWrites: writes?.nodes,
        manifestWrites: writes?.manifests,
        matched: cold.matched,
      });
      budgetHeadroom("10k cold path", cold.ms, BUDGET_10K_COLD_MS);
    } finally {
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "100k datoms: snapshot, validated restore and a single-datom change all stay inside their budgets",
  { timeout: 600_000 },
  async ({ browser }) => {
    const name = `ramose-scale-100k-${browser.uniqueId}`;
    const selected = identity();
    const partition = replicaPartitionKey(selected);
    const datoms = scaleDatoms(SCALE_100K);
    expect(datoms).toHaveLength(SCALE_100K);
    try {

      let snapshotWrites: ReplicaWriteCounts | undefined;
      const install = await timed(async () =>
        await withStorage(name, async (storage) => {
          const { chunks } = await installSnapshot(storage, selected, opaque("1"), datoms);
          snapshotWrites = storage.writeCounts();
          return { chunks };
        })
      );
      const installed = await imageOf(name, partition);
      report("100k snapshot+install", install.ms, BUDGET_100K_SNAPSHOT_MS, {
        chunks: install.chunks,
        nodes: installed.nodeCount,
        nodeKiB: Math.round(installed.nodeBytes / 1024),
        nodeWrites: snapshotWrites?.nodes,
        stagedChunks: snapshotWrites?.stagingChunks,
      });
      budgetHeadroom("100k snapshot and install", install.ms, BUDGET_100K_SNAPSHOT_MS);

      let restoreWrites: ReplicaWriteCounts | undefined;
      const restore = await timed(async () =>
        await withStorage(name, async (storage) => {
          const restored = await storage.restore(selected, attributes, READ_COMPATIBILITY);
          expect(restored).toBeDefined();
          const query = await representativeQuery(restored!.db);
          restoreWrites = storage.writeCounts();
          return { matched: query.matched };
        })
      );
      const afterRestore = await imageOf(name, partition);
      report("100k persisted restore (validate + query)", restore.ms, BUDGET_100K_RESTORE_MS, {
        nodes: afterRestore.nodeCount,
        nodeWrites: restoreWrites?.nodes,
        manifestWrites: restoreWrites?.manifests,
        matched: restore.matched,
      });

      expect(restoreWrites).toEqual({
        nodes: 0,
        manifests: 0,
        heads: 0,
        staging: 0,
        stagingChunks: 0,
      });
      expect(afterRestore.nodeCount).toBe(installed.nodeCount);
      expect(afterRestore.manifest).toBe(installed.manifest);
      budgetHeadroom("100k persisted restore", restore.ms, BUDGET_100K_RESTORE_MS);

      const target = datoms[0];
      expect(target.field).toBe(":item/name");
      const change = await timed(async () =>
        await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          const applied = await storage.applyChange(changeFrame({
            type: "Change",
            protocol: 1,
            identity: selected,
            from: opaque("1"),
            revision: opaque("2"),
            datoms: [{
              entity: target.entity,
              field: ":item/name",
              value: { type: "string", value: "one changed datom" },
              op: "add",
            }],
          }));
          expect(applied).toBeDefined();

          const nameAttribute = applied!.db.requireAttr(":item/name");
          const changed = await applied!.db.datomsArray(Index.AEVT, { a: nameAttribute.id });
          expect(changed.some((datom) => datom.v === "one changed datom")).toBe(true);
          const query = await representativeQuery(applied!.db);
          return { matched: query.matched, writes: storage.writeCounts() };
        })
      );
      const afterChange = await imageOf(name, partition);
      const rewritten = [...afterChange.hashes].filter((hash) => !installed.hashes.has(hash));
      report("100k single-datom change", change.ms, BUDGET_100K_CHANGE_MS, {
        nodeWrites: change.writes.nodes,
        manifestWrites: change.writes.manifests,
        headWrites: change.writes.heads,
        newNodeRecords: rewritten.length,
        totalNodeRecords: afterChange.nodeCount,
        changeDatomCap: MAX_REPLICATION_DATOMS_PER_CHANGE,
      });
      budgetHeadroom("100k single-datom change", change.ms, BUDGET_100K_CHANGE_MS);

      const largest = [...await storedNodes(name, partition)]
        .sort((left, right) => right.body.byteLength - left.body.byteLength)[0];
      await flipStoredNodeByte(name, partition, largest.hash);
      const detected = await timed(async () =>
        await withStorage(name, async (storage) => ({
          outcome: await storage.restoreOutcome(selected, attributes, READ_COMPATIBILITY),
        }))
      );
      expect(detected.outcome).toMatchObject({
        _tag: "replacement-required",
        reason: "node-hash",
      });
      report("100k corrupt-node detection (walk proof)", detected.ms, BUDGET_100K_RESTORE_MS, {
        corruptedNodeBytes: largest.body.byteLength,
      });
    } finally {
      await deleteDatabase(name);
    }
  },
);
