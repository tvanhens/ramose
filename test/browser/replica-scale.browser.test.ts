import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { Index, ValueTag, datom } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
  type ReplicaWriteCounts,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import { entityIdScopeOf } from "../../packages/ramose/src/internal/replication/identity.ts";
import {
  makeLogicalIdentityEncoder,
  projectLogicalValueParts,
} from "../../packages/ramose/src/internal/replication/logical.ts";
import {
  generateServerIdentityRoot,
  sealingKeyOf,
} from "../../packages/ramose/src/internal/replication/server-identity.ts";
import {
  MAX_REPLICATION_DATOMS_PER_CHANGE,
  MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK,
  MAX_REPLICATION_FRAME_BYTES,
  type EntityHandleBinding,
  type ReplicationIdentity,
  type SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  armCheckpointThrow,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import { browserTest } from "./fixtures.ts";
import {
  changeFrame,
  sealedHandle,
  snapshotChunk,
} from "../../packages/ramose/test/replication-fixtures.ts";

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
    protocol: 3,
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
      protocol: 3,
      identity: selected,
      snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK),
    }));
  }
  const installed = await storage.commitSnapshot({
    type: "SnapshotCommit",
    protocol: 3,
    identity: selected,
    snapshot,
    revision,
    ordinal: 1,
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
  const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
  try {
    return await run(storage);
  } finally {
    storage.close();
  }
};

const budgetHeadroom = (label: string, ms: number, budget: number): void => {
  expect(ms, `${label} exceeded its #480 budget of ${budget}ms`).toBeLessThan(budget);
};

const HALF_MEGABYTE = 512 * 1024;

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const largeUtf8Text = (bytes: number): string => {
  const unit = "aé☃";
  const repeated = unit.repeat(Math.floor(bytes / utf8Length(unit)));
  return repeated + "x".repeat(bytes - utf8Length(repeated));
};

const largeBytes = (length: number): Uint8Array => {
  const value = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + index) >>> 0;
    value[index] = state & 0xff;
  }
  return value;
};

const PARTS_PER_CHUNK = 4;

const CRASH_SCALES = [
  { label: "10k", count: SCALE_10K },
  { label: "100k", count: SCALE_100K },
] as const;

const stageSnapshot = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  snapshot: string,
  revision: string,
  datoms: readonly SnapshotDatom[],
): Promise<number> => {
  await storage.startSnapshot({
    type: "SnapshotStart",
    protocol: 3,
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
      protocol: 3,
      identity: selected,
      snapshot,
      index: index++,
      datoms: datoms.slice(offset, offset + MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK),
    }));
  }
  return index;
};

const writtenNodes = async (
  storage: IndexedDbReplicaStorage,
): Promise<number> => {
  for (let attempt = 0; attempt < 20_000; attempt++) {
    const written = storage.writeCounts().nodes;
    if (written > 0) return written;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return storage.writeCounts().nodes;
};

type ExposedValue = {
  readonly revision: string;
  readonly entity: string;
  readonly name: string;
};

const completeAt = async (
  storageName: string,
  selected: ReplicationIdentity,
  exposed: ExposedValue,
): Promise<void> =>
  await withStorage(storageName, async (storage) => {
    const restored = await storage.restore(selected, attributes, READ_COMPATIBILITY);
    expect(restored).toBeDefined();
    expect(restored!.revision).toBe(exposed.revision);
    const subject = restored!.handles.get(sealedHandle(exposed.entity));
    expect(subject).toBeDefined();
    const facts = await restored!.db.datomsArray(Index.EAVT, { e: subject! });
    expect(facts).toHaveLength(FIELDS_PER_ENTITY);
    const nameAttribute = restored!.db.requireAttr(":item/name");
    expect(facts.find((fact) => fact.a === nameAttribute.id)?.v)
      .toBe(exposed.name);
    await representativeQuery(restored!.db);
  });

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

      const target = datoms[0]!;
      expect(target.field).toBe(":item/name");
      expect(target.value.type).toBe("string");
      const targetName = (target.value as { readonly value: string }).value;
      const change = await timed(async () =>
        await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          const applied = await storage.applyChange(changeFrame({
            type: "Change",
            protocol: 3,
            identity: selected,
            from: opaque("1"),
            revision: opaque("2"),
            ordinal: 2,
            datoms: [{
              entity: target.entity,
              field: ":item/name",
              value: { type: "string", value: targetName },
              op: "retract",
            }, {
              entity: target.entity,
              field: ":item/name",
              value: { type: "string", value: "one changed datom" },
              op: "add",
            }],
          }));
          expect(applied).toBeDefined();

          const subject = applied!.handles.get(sealedHandle(target.entity));
          expect(subject).toBeDefined();
          const facts = await applied!.db.datomsArray(Index.EAVT, { e: subject! });
          expect(facts).toHaveLength(FIELDS_PER_ENTITY);
          const nameAttribute = applied!.db.requireAttr(":item/name");
          expect(facts.find((fact) => fact.a === nameAttribute.id)?.v)
            .toBe("one changed datom");
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

browserTest(
  "half-megabyte string and byte values persist and restore byte-exactly",
  { timeout: 300_000 },
  async ({ browser }) => {
    const name = `ramose-scale-large-${browser.uniqueId}`;
    const selected = identity();
    const sealing = sealingKeyOf(generateServerIdentityRoot(Date.now()));
    const encoder = makeLogicalIdentityEncoder(
      sealing,
      "ramose-large-values",
      entityIdScopeOf(selected),
    );
    const subject = await encoder.entity(4_242);
    const handles: readonly EntityHandleBinding[] = [
      { entity: subject.identity, handle: subject.handle },
    ];
    const body = largeUtf8Text(HALF_MEGABYTE);
    const blob = largeBytes(HALF_MEGABYTE);
    expect(utf8Length(body)).toBe(HALF_MEGABYTE);
    expect(blob.byteLength).toBe(HALF_MEGABYTE);

    const largeAttributes: readonly AttributeSpec[] = [
      { ident: ":item/body", valueType: ":db.type/string", cardinality: "one" },
      { ident: ":item/blob", valueType: ":db.type/bytes", cardinality: "one" },
    ];

    const valueParts = async (
      field: string,
      tag: ValueTag,
      value: string | Uint8Array,
    ): Promise<readonly SnapshotDatom[]> => {
      const parts: SnapshotDatom[] = [];
      for await (
        const part of projectLogicalValueParts(
          datom(4_242, 1, tag, value, 1),
          encoder,
        )
      ) {
        parts.push({ entity: subject.identity, field, value: part, op: "add" });
      }
      return parts;
    };

    const datoms = [
      ...await valueParts(":item/body", ValueTag.Str, body),
      ...await valueParts(":item/blob", ValueTag.Bytes, blob),
    ];
    expect(datoms.filter((item) => item.value.type === "string-part").length)
      .toBeGreaterThan(1);
    expect(datoms.filter((item) => item.value.type === "bytes-part").length)
      .toBeGreaterThan(1);

    try {
      const snapshot = opaque("m");
      const revision = opaque("1");
      let widestFrameBytes = 0;
      const installed = await timed(async () =>
        await withStorage(name, async (storage) => {
          await storage.startSnapshot({
            type: "SnapshotStart",
            protocol: 3,
            identity: selected,
            snapshot,
            revision,
          });
          let index = 0;
          for (
            let offset = 0;
            offset < datoms.length;
            offset += PARTS_PER_CHUNK
          ) {
            const frame = {
              type: "SnapshotChunk" as const,
              protocol: 3 as const,
              identity: selected,
              snapshot,
              index: index++,
              datoms: datoms.slice(offset, offset + PARTS_PER_CHUNK),
              handles,
            };
            widestFrameBytes = Math.max(
              widestFrameBytes,
              utf8Length(JSON.stringify(frame)),
            );
            await storage.stageSnapshotChunk(frame);
          }
          const committed = await storage.commitSnapshot({
            type: "SnapshotCommit",
            protocol: 3,
            identity: selected,
            snapshot,
            revision,
            ordinal: 1,
            chunks: index,
          }, largeAttributes);
          expect(committed).toBeDefined();
          return { chunks: index, writes: storage.writeCounts() };
        })
      );

      expect(widestFrameBytes).toBeLessThanOrEqual(MAX_REPLICATION_FRAME_BYTES);

      const restored = await timed(async () =>
        await withStorage(name, async (storage) => {
          const replica = await storage.restore(
            selected,
            largeAttributes,
            READ_COMPATIBILITY,
          );
          expect(replica).toBeDefined();
          const db = replica!.db;
          const anchor = await db.datomsArray(Index.AEVT, {
            a: db.requireAttr(":item/body").id,
          });
          expect(anchor).toHaveLength(1);
          const facts = await db.datomsArray(Index.EAVT, { e: anchor[0]!.e });
          const stored = new Map(
            facts.map((fact) => [db.attr(fact.a)!.ident, fact.v]),
          );
          return {
            body: stored.get(":item/body"),
            blob: stored.get(":item/blob"),
            writes: storage.writeCounts(),
          };
        })
      );

      expect(restored.body).toBe(body);
      expect(restored.blob).toBeInstanceOf(Uint8Array);
      const restoredBlob = restored.blob as Uint8Array;
      expect(restoredBlob.byteLength).toBe(blob.byteLength);
      let identicalBytes = true;
      for (let index = 0; index < blob.length; index++) {
        if (restoredBlob[index] !== blob[index]) {
          identicalBytes = false;
          break;
        }
      }
      expect(identicalBytes).toBe(true);
      expect(restored.writes).toEqual({
        nodes: 0,
        manifests: 0,
        heads: 0,
        staging: 0,
        stagingChunks: 0,
      });

      const image = await imageOf(name, replicaPartitionKey(selected));
      report("512KiB string+bytes install", installed.ms, BUDGET_10K_COLD_MS, {
        chunks: installed.chunks,
        widestFrameBytes,
        nodes: image.nodeCount,
        nodeKiB: Math.round(image.nodeBytes / 1024),
        nodeWrites: installed.writes.nodes,
      });
      report("512KiB string+bytes restore", restored.ms, BUDGET_100K_RESTORE_MS, {
        nodeWrites: restored.writes.nodes,
      });
      budgetHeadroom("512KiB value install", installed.ms, BUDGET_10K_COLD_MS);
      budgetHeadroom("512KiB value restore", restored.ms, BUDGET_100K_RESTORE_MS);
    } finally {
      await deleteDatabase(name);
    }
  },
);

for (const scale of CRASH_SCALES) {
  browserTest(
    `${scale.label} crash cuts before and during install expose only the old or new value`,
    { timeout: 600_000 },
    async ({ browser }) => {
      const name = `ramose-scale-crash-${scale.label}-${browser.uniqueId}`;
      const selected = identity();
      const base = scaleDatoms(scale.count);
      const subject = base[0]!;
      expect(subject.field).toBe(":item/name");
      expect(subject.value.type).toBe("string");
      const originalName = (subject.value as { readonly value: string }).value;
      const replacement = [
        { ...subject, value: { type: "string" as const, value: "replaced" } },
        ...base.slice(1),
      ];
      const first = opaque("1");
      const second = opaque("2");
      const third = opaque("3");
      const atFirst: ExposedValue = {
        revision: first,
        entity: subject.entity,
        name: originalName,
      };
      const atSecond: ExposedValue = {
        revision: second,
        entity: subject.entity,
        name: "replaced",
      };
      const atThird: ExposedValue = {
        revision: third,
        entity: subject.entity,
        name: "changed once",
      };
      try {
        await withStorage(name, async (storage) => {
          await installSnapshot(storage, selected, first, base);
        });
        await completeAt(name, selected, atFirst);

        const chunks = await withStorage(
          name,
          (storage) =>
            stageSnapshot(storage, selected, opaque("q"), second, replacement),
        );
        const commit = (
          storage: IndexedDbReplicaStorage,
          signal?: AbortSignal,
        ) =>
          storage.commitSnapshot({
            type: "SnapshotCommit",
            protocol: 3,
            identity: selected,
            snapshot: opaque("q"),
            revision: second,
            ordinal: 2,
            chunks,
          }, attributes, signal === undefined ? {} : { signal });

        const partialNodes = await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          const controller = new AbortController();
          const cut = commit(storage, controller.signal);
          const written = await writtenNodes(storage);
          controller.abort();
          await expect(cut).rejects.toBeDefined();
          return written;
        });
        expect(partialNodes).toBeGreaterThan(0);
        await completeAt(name, selected, atFirst);

        for (const checkpoint of ["replica.installing", "replica.install"]) {
          try {
            armCheckpointThrow(checkpoint, { error: `cut at ${checkpoint}` });
            await withStorage(name, async (storage) => {
              await expect(commit(storage)).rejects.toBeDefined();
            });
          } finally {
            resetTestHooks();
          }
          await completeAt(name, selected, atFirst);
        }

        const completeNodes = await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          expect((await commit(storage))?.revision).toBe(second);
          return storage.writeCounts().nodes;
        });
        expect(partialNodes).toBeLessThan(completeNodes);
        await completeAt(name, selected, atSecond);

        const change = changeFrame({
          type: "Change",
          protocol: 3,
          identity: selected,
          from: second,
          revision: third,
          ordinal: 2,
          datoms: [{
            entity: subject.entity,
            field: ":item/name",
            value: { type: "string", value: "replaced" },
            op: "retract",
          }, {
            entity: subject.entity,
            field: ":item/name",
            value: { type: "string", value: "changed once" },
            op: "add",
          }],
        });

        const partialChangeNodes = await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          const controller = new AbortController();
          const cut = storage.applyChange(change, { signal: controller.signal });
          const written = await writtenNodes(storage);
          controller.abort();
          await expect(cut).rejects.toBeDefined();
          return written;
        });
        expect(partialChangeNodes).toBeGreaterThan(0);
        await completeAt(name, selected, atSecond);

        for (const checkpoint of ["replica.installing", "replica.install"]) {
          try {
            armCheckpointThrow(checkpoint, { error: `cut at ${checkpoint}` });
            await withStorage(name, async (storage) => {
              await expect(storage.applyChange(change)).rejects.toBeDefined();
            });
          } finally {
            resetTestHooks();
          }
          await completeAt(name, selected, atSecond);
        }

        const completeChangeNodes = await withStorage(name, async (storage) => {
          storage.resetWriteCounts();
          expect((await storage.applyChange(change))?.revision).toBe(third);
          return storage.writeCounts().nodes;
        });
        expect(partialChangeNodes).toBeLessThan(completeChangeNodes);
        await completeAt(name, selected, atThird);
      } finally {
        resetTestHooks();
        await deleteDatabase(name);
      }
    },
  );
}
