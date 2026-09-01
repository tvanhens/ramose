import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeKey,
  replicaScopeOf,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { ReplicationSession } from "../../packages/ramose/src/internal/replication/session.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import {
  armCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const LEFT = opaque("l");
const RIGHT = opaque("r");
const ROOT_DATABASE = opaque("d");
const CHILD_DATABASE = opaque("e");
const SIBLING_DATABASE = opaque("f");
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

const openNative = (
  name: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => upgrade?.(request.result), { once: true });
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
    contents[store] = await requestResult<unknown[]>(
      transaction.objectStore(store).getAll(),
    );
  }
  await transactionDone(transaction);
  database.close();
  return contents;
};

const partitioned = (records: unknown[], prefix: string): unknown[] =>
  records.filter((record) =>
    typeof (record as { partition?: unknown }).partition === "string" &&
    (record as { partition: string }).partition.startsWith(prefix)
  );

const bytes = (value: unknown): string => JSON.stringify(value);

const scopeOf = (selected: ReplicationIdentity) => replicaScopeOf(selected);
const databaseOf = (selected: ReplicationIdentity) => replicaDatabaseScopeOf(selected);

const scopePrefix = (selected: ReplicationIdentity): string =>
  ["ramose-replica-v5", selected.server, selected.principal, ""].join(":");

const snapshotDatom = (value: string): SnapshotDatom => ({
  entity: opaque("x"),
  field: ":item/name",
  value: { type: "string", value },
  op: "add",
});

const installSnapshot = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  revision: string,
  value: string,
): Promise<void> => {
  const snapshot = opaque("q");
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 3, identity: selected, snapshot, revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk", protocol: 3, identity: selected, snapshot, index: 0,
    datoms: [snapshotDatom(value)],
  }));
  expect(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 3, identity: selected, snapshot, revision, ordinal: 1, chunks: 1,
  }, attributes)).toBeDefined();
};

const confirm = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  label: string,
  route?: { readonly scope: string; readonly pathKey: string; readonly slot: string },
): Promise<void> => {
  await storage.bindAuthenticated({
    fingerprint: `fingerprint-${label}`,
    identity: selected,
    candidateKey: { selector: `selector-${label}`, routeSlot: `slot-${label}` },
    ...(route === undefined ? {} : { route }),
  });
};

const names = async (db: Db): Promise<string[]> => {
  const attribute = db.attr(":item/name")!;
  return (await db.datomsArray(Index.AEVT, { a: attribute.id })).map((datom) => datom.v as string);
};

browserTest("clears one confirmed scope and preserves every other realm byte-identically", async ({ browser }) => {
  const name = `ramose-lifecycle-clear-${browser.uniqueId}`;
  const foreign = `ramose-lifecycle-foreign-${browser.uniqueId}`;
  const left = identity();
  const leftChild = identity({ database: CHILD_DATABASE });
  const right = identity({ principal: RIGHT });
  const sharedRoute = { scope: "origin-root", pathKey: "path-key", slot: "slot-shared" };

  const application = await openNative(foreign, 1, (database) => {
    database.createObjectStore("notes", { keyPath: "id" });
  });
  const seed = application.transaction("notes", "readwrite");
  seed.objectStore("notes").put({ id: 1, body: "unrelated application data" });
  await transactionDone(seed);
  application.close();
  const foreignBefore = bytes(await dump(foreign));

  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, left, opaque("1"), "left-root");
    await installSnapshot(storage, leftChild, opaque("2"), "left-child");
    await installSnapshot(storage, right, opaque("3"), "right-root");
    await confirm(storage, left, "left", sharedRoute);
    await confirm(storage, leftChild, "left-child");
    await confirm(storage, right, "right", sharedRoute);

    const before = await dump(name);
    const rightPrefix = scopePrefix(right);
    const rightCommitted = bytes(partitioned(before["replica-committed-v1"]!, rightPrefix));
    const rightNodes = bytes(
      before["replica-nodes-v1"]!.filter((record) =>
        (record as { partition: string }).partition.startsWith(rightPrefix)
      ),
    );
    expect(partitioned(before["replica-committed-v1"]!, scopePrefix(left))).toHaveLength(2);

    const outcome = await storage.clearScope(scopeOf(left));
    expect(outcome.scope).toBe(replicaScopeKey(scopeOf(left)));
    expect(outcome.generation).toBe(2);
    expect(outcome.partitions).toBe(2);
    expect(outcome.nodes).toBeGreaterThan(0);
    expect(outcome.bindings).toBe(2);
    expect(outcome.candidates).toBe(2);
    expect(outcome.routeObservations).toBe(1);

    const after = await dump(name);

    expect(partitioned(after["replica-committed-v1"]!, scopePrefix(left))).toEqual([]);
    expect(partitioned(after["replica-committed-heads-v1"]!, scopePrefix(left))).toEqual([]);
    expect(partitioned(after["replica-staging-v1"]!, scopePrefix(left))).toEqual([]);
    expect(partitioned(after["replica-staging-chunks-v1"]!, scopePrefix(left))).toEqual([]);
    expect(
      after["replica-nodes-v1"]!.filter((record) =>
        (record as { partition: string }).partition.startsWith(scopePrefix(left))
      ),
    ).toEqual([]);
    expect(after["replica-credential-bindings-v1"]).toHaveLength(1);
    expect(after["replica-cache-candidates-v1"]).toHaveLength(1);

    expect(bytes(partitioned(after["replica-committed-v1"]!, rightPrefix))).toBe(rightCommitted);
    expect(
      bytes(
        after["replica-nodes-v1"]!.filter((record) =>
          (record as { partition: string }).partition.startsWith(rightPrefix)
        ),
      ),
    ).toBe(rightNodes);

    const routes = after["replica-route-slots-v1"] as {
      readonly replicaScopes: readonly string[];
    }[];
    expect(routes).toHaveLength(1);
    expect(routes[0]!.replicaScopes).toEqual([replicaScopeKey(scopeOf(right))]);

    const generations = after["replica-generations-v1"] as {
      readonly key: string;
      readonly generation: number;
    }[];
    expect(
      generations.find((record) => record.key === replicaScopeKey(scopeOf(left)))?.generation,
    ).toBe(2);
    expect(
      generations.find((record) => record.key === replicaScopeKey(scopeOf(right)))?.generation,
    ).toBe(1);

    await expect(storage.restore(left, attributes, READ_COMPATIBILITY)).rejects.toMatchObject({
      _tag: "ReplicaScopeClearedError",
    });
    await expect(storage.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("z"), revision: opaque("9"),
    })).rejects.toMatchObject({ _tag: "ReplicaScopeClearedError" });
    await expect(confirm(storage, left, "again")).rejects.toMatchObject({
      _tag: "ReplicaScopeClearedError",
    });
    await expect(storage.clearScope(scopeOf(left))).rejects.toMatchObject({
      _tag: "ReplicaScopeClearedError",
    });

    expect(await names((await storage.restore(right, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["right-root"]);

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    expect(await storage.restore(left, attributes, READ_COMPATIBILITY)).toBeUndefined();
    expect(await storage.restoreBound("fingerprint-left", attributes, READ_COMPATIBILITY))
      .toBeUndefined();
    expect(await storage.restore(right, attributes, READ_COMPATIBILITY)).toBeDefined();

    expect(bytes(await dump(foreign))).toBe(foreignBefore);
  } finally {
    storage.close();
    await deleteDatabase(name);
    await deleteDatabase(foreign);
  }
});

browserTest("a clear cut before it commits leaves the old complete state", async ({ browser }) => {
  const name = `ramose-lifecycle-abort-${browser.uniqueId}`;
  const left = identity();

  const storage = await IndexedDbReplicaStorage.open(name, testRuntimeBoundaries);
  try {
    await installSnapshot(storage, left, opaque("1"), "left-root");
    await confirm(storage, left, "left", {
      scope: "origin-root", pathKey: "path-key", slot: "slot-shared",
    });
    const before = bytes(await dump(name));

    armCheckpoint("replica.clear", "throw", "cut before the clear committed");
    try {
      await expect(storage.clearScope(scopeOf(left))).rejects.toThrow(/cut before the clear/);
    } finally {
      resetTestHooks();
    }

    expect(bytes(await dump(name))).toBe(before);

    expect(await names((await storage.restore(left, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["left-root"]);

    expect((await storage.clearScope(scopeOf(left))).generation).toBe(2);
    const cleared = await dump(name);
    expect(cleared["replica-committed-v1"]).toEqual([]);
    expect(cleared["replica-nodes-v1"]).toEqual([]);
  } finally {
    resetTestHooks();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a fenced lease cannot repopulate a cleared scope or write nodes after eviction", async ({ browser }) => {
  const name = `ramose-lifecycle-fence-${browser.uniqueId}`;
  const left = identity();
  const writer = await IndexedDbReplicaStorage.open(name);
  const maintainer = await IndexedDbReplicaStorage.open(name);
  const evictor = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(writer, left, opaque("1"), "left-root");
    await confirm(writer, left, "left");

    const lease = await writer.leaseFor(left);
    expect(lease.generationOf(replicaScopeKey(scopeOf(left)))).toBe(1);
    expect(lease.generationOf(replicaDatabaseKey(databaseOf(left)))).toBe(1);
    await writer.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"),
    }, { lease });

    const idle = await writer.leaseFor(left);

    expect((await maintainer.clearScope(scopeOf(left))).generation).toBe(2);

    await expect(writer.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"),
    }, { lease: idle })).rejects.toMatchObject({ _tag: "ReplicaFencedError" });

    await expect(writer.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"),
    }, { lease })).rejects.toMatchObject({
      _tag: "ReplicaFencedError",
      key: replicaScopeKey(scopeOf(left)),
      expected: 1,
      observed: 2,
    });
    await expect(writer.bindAuthenticated({
      fingerprint: "fingerprint-left", identity: left,
    }, { lease })).rejects.toMatchObject({ _tag: "ReplicaFencedError" });
    const afterFence = await dump(name);
    expect(afterFence["replica-staging-v1"]).toEqual([]);
    expect(afterFence["replica-credential-bindings-v1"]).toEqual([]);

    const renewed = await writer.lease();
    await writer.bindAuthenticated({ fingerprint: "fingerprint-left", identity: left }, {
      lease: renewed,
    });
    await writer.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"),
    }, { lease: renewed });
    await writer.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 3, identity: left, snapshot: opaque("q"), index: 0,
      datoms: [snapshotDatom("reinstalled")],
    }), { lease: renewed });

    expect((await evictor.evictDatabase(databaseOf(left))).generation).toBe(2);
    await writer.startSnapshot({
      type: "SnapshotStart", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"),
    }, { lease: await writer.lease() });
    await writer.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk", protocol: 3, identity: left, snapshot: opaque("q"), index: 0,
      datoms: [snapshotDatom("reinstalled")],
    }));
    await expect(writer.commitSnapshot({
      type: "SnapshotCommit", protocol: 3, identity: left,
      snapshot: opaque("q"), revision: opaque("2"), ordinal: 1, chunks: 1,
    }, attributes, { lease: renewed })).rejects.toMatchObject({
      _tag: "ReplicaFencedError",
      key: replicaDatabaseKey(databaseOf(left)),
    });
    const afterEviction = await dump(name);
    expect(afterEviction["replica-nodes-v1"]).toEqual([]);
    expect(afterEviction["replica-committed-v1"]).toEqual([]);
  } finally {
    writer.close();
    maintainer.close();
    evictor.close();
    await deleteDatabase(name);
  }
});

browserTest("evicts one inactive database across its read views and refuses an active one", async ({ browser }) => {
  const name = `ramose-lifecycle-evict-${browser.uniqueId}`;
  const parent = identity();
  const child = identity({ database: CHILD_DATABASE });
  const childOtherView = identity({ database: CHILD_DATABASE, readView: opaque("w") });
  const sibling = identity({ database: SIBLING_DATABASE });
  const other = identity({ principal: RIGHT, database: CHILD_DATABASE });
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, parent, opaque("1"), "parent");
    await installSnapshot(storage, child, opaque("2"), "child");
    await installSnapshot(storage, childOtherView, opaque("3"), "child-other-view");
    await installSnapshot(storage, sibling, opaque("4"), "sibling");
    await installSnapshot(storage, other, opaque("5"), "other-principal");
    for (const [label, selected] of [
      ["parent", parent],
      ["child", child],
      ["child-view", childOtherView],
      ["sibling", sibling],
      ["other", other],
    ] as const) {
      await confirm(storage, selected, label);
    }

    const release = storage.pinDatabase(databaseOf(child));
    const before = bytes(await dump(name));
    await expect(storage.evictDatabase(databaseOf(child))).rejects.toMatchObject({
      _tag: "ReplicaDatabaseActiveError",
      database: replicaDatabaseKey(databaseOf(child)),
      pins: 1,
    });
    expect(bytes(await dump(name))).toBe(before);
    release();

    const outcome = await storage.evictDatabase(databaseOf(child));
    expect(outcome.partitions).toBe(2);
    expect(outcome.bindings).toBe(2);
    expect(outcome.candidates).toBe(2);
    expect(outcome.generation).toBe(2);

    expect(await storage.restore(child, attributes, READ_COMPATIBILITY)).toBeUndefined();
    expect(await storage.restore(childOtherView, attributes, READ_COMPATIBILITY)).toBeUndefined();
    expect(await storage.restoreBound("fingerprint-child", attributes, READ_COMPATIBILITY))
      .toBeUndefined();

    expect(await names((await storage.restore(parent, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["parent"]);
    expect(await names((await storage.restore(sibling, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["sibling"]);
    expect(await names((await storage.restore(other, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["other-principal"]);
    expect(
      (await storage.restoreBound("fingerprint-parent", attributes, READ_COMPATIBILITY))?.revision,
    ).toBe(opaque("1"));

    const generations = (await dump(name))["replica-generations-v1"] as {
      readonly key: string;
      readonly generation: number;
    }[];
    expect(
      generations.find((record) => record.key === replicaScopeKey(scopeOf(child)))?.generation,
    ).toBe(1);
    expect(
      generations.find((record) => record.key === replicaDatabaseKey(databaseOf(sibling)))
        ?.generation,
    ).toBe(1);

    await installSnapshot(storage, child, opaque("6"), "child-again");
    expect(await names((await storage.restore(child, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["child-again"]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("unconfirmed and wrong-scope requests are typed failures that delete nothing", async ({ browser }) => {
  const name = `ramose-lifecycle-unconfirmed-${browser.uniqueId}`;
  const left = identity();
  const unconfirmed = identity({ principal: RIGHT });
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, left, opaque("1"), "left-root");
    await installSnapshot(storage, unconfirmed, opaque("2"), "never-confirmed");

    await confirm(storage, left, "left");
    const before = bytes(await dump(name));

    await expect(storage.clearScope(scopeOf(unconfirmed))).rejects.toMatchObject({
      _tag: "ReplicaScopeUnconfirmedError",
      scope: replicaScopeKey(scopeOf(unconfirmed)),
    });

    await expect(storage.clearScope({ server: opaque("S"), principal: opaque("P") }))
      .rejects.toMatchObject({ _tag: "ReplicaScopeUnconfirmedError" });
    await expect(storage.evictDatabase(databaseOf(unconfirmed))).rejects.toMatchObject({
      _tag: "ReplicaScopeUnconfirmedError",
    });
    expect(bytes(await dump(name))).toBe(before);
    expect(await names((await storage.restore(unconfirmed, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["never-confirmed"]);

    await storage.clearScope(scopeOf(left));
    expect(await names((await storage.restore(unconfirmed, attributes, READ_COMPATIBILITY))!.db))
      .toEqual(["never-confirmed"]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

const PRE_GENERATION_STORES: readonly (readonly [string, string | string[]])[] = [
  ["replica-committed-v1", "partition"],
  ["replica-committed-heads-v1", "partition"],
  ["replica-staging-v1", "partition"],
  ["replica-staging-chunks-v1", ["partition", "index"]],
  ["replica-nodes-v1", ["partition", "hash"]],
  ["replica-credential-bindings-v1", "fingerprint"],
  ["replica-cache-candidates-v1", ["selector", "routeSlot"]],
  ["replica-route-slots-v1", ["scope", "pathKey"]],
];

browserTest("a replica stored before generations existed stays clearable", async ({ browser }) => {
  const name = `ramose-lifecycle-backfill-${browser.uniqueId}`;
  const left = identity();
  const partition = [
    "ramose-replica-v5", left.server, left.principal, left.database, left.readView,
    left.readCompatibilityHash,
  ].join(":");
  let storage: IndexedDbReplicaStorage | undefined;
  try {
    const legacy = await openNative(name, 5, (database) => {
      for (const [store, keyPath] of PRE_GENERATION_STORES) {
        database.createObjectStore(store, { keyPath: keyPath as string | string[] });
      }
    });
    const seed = legacy.transaction(
      [
        "replica-committed-v1",
        "replica-nodes-v1",
        "replica-credential-bindings-v1",
        "replica-route-slots-v1",
      ],
      "readwrite",
    );
    seed.objectStore("replica-committed-v1").put({
      partition, storageVersion: 3, identity: left,
      readCompatibilityHash: left.readCompatibilityHash, revision: opaque("1"),
      datoms: [], attributes: [], entityIds: [], attributeIds: [], roots: {}, nextLocalId: 1000,
    });
    seed.objectStore("replica-nodes-v1").put({
      partition, hash: "stored-node", body: new Uint8Array([1, 2, 3]),
    });

    seed.objectStore("replica-credential-bindings-v1").put({
      fingerprint: "pre-generation-fingerprint", identity: left,
    });

    seed.objectStore("replica-route-slots-v1").put({
      scope: "origin-root", pathKey: "path-key", slot: "slot-shared",
    });
    await transactionDone(seed);
    legacy.close();

    storage = await IndexedDbReplicaStorage.open(name);
    const upgraded = await dump(name);
    const generations = upgraded["replica-generations-v1"] as {
      readonly key: string;
      readonly generation: number;
    }[];
    expect(generations.map((record) => record.key).sort()).toEqual([
      replicaDatabaseKey(databaseOf(left)),
      replicaScopeKey(scopeOf(left)),
    ].sort());

    expect(upgraded["replica-route-slots-v1"]).toEqual([{
      scope: "origin-root",
      pathKey: "path-key",
      slot: "slot-shared",
      replicaScopes: [replicaScopeKey(scopeOf(left))],
    }]);

    const outcome = await storage.clearScope(scopeOf(left));
    expect(outcome.partitions).toBe(0);
    expect(outcome.nodes).toBe(0);
    expect(outcome.bindings).toBe(0);
    expect(outcome.generation).toBe(2);
    const cleared = await dump(name);
    expect(cleared["replica-committed-v1"]).toEqual([]);
    expect(cleared["replica-nodes-v1"]).toEqual([]);
    expect(cleared["replica-credential-bindings-v1"]).toEqual([]);
    expect(cleared["replica-route-slots-v1"]).toEqual([]);
    expect(outcome.routeObservations).toBe(1);
  } finally {
    storage?.close();
    await deleteDatabase(name);
  }
});

browserTest("two handles on one stored database share pins and live sessions", async ({ browser }) => {
  const name = `ramose-lifecycle-shared-${browser.uniqueId}`;
  const left = identity();
  const reader = await IndexedDbReplicaStorage.open(name);
  const maintainer = await IndexedDbReplicaStorage.open(name);
  const cleaner = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(reader, left, opaque("1"), "left-root");
    await confirm(reader, left, "left");

    let closed = 0;
    const pin = reader.pinDatabase(databaseOf(left));
    const enrolled = reader.enroll({
      scope: scopeOf(left),
      database: databaseOf(left),
      close: async () => {
        closed++;
      },
    });

    await expect(maintainer.evictDatabase(databaseOf(left))).rejects.toMatchObject({
      _tag: "ReplicaDatabaseActiveError",
      pins: 1,
    });
    pin();

    await cleaner.clearScope(scopeOf(left));
    expect(closed).toBe(1);
    enrolled();

    const survivor = await IndexedDbReplicaStorage.open(name);
    const doomed = await IndexedDbReplicaStorage.open(name);
    const survivorPin = survivor.pinDatabase(databaseOf(left));
    doomed.pinDatabase(databaseOf(left));
    doomed.close();
    await expect(maintainer.evictDatabase(databaseOf(left))).rejects.toMatchObject({
      _tag: "ReplicaDatabaseActiveError",
      pins: 1,
    });
    survivorPin();
    survivor.close();
    await expect(maintainer.evictDatabase(databaseOf(left))).resolves.toBeDefined();
  } finally {
    reader.close();
    maintainer.close();
    cleaner.close();
    await deleteDatabase(name);
  }
});

browserTest("destructive maintenance closes the sessions bound to the affected realm", async ({ browser }) => {
  const name = `ramose-lifecycle-sessions-${browser.uniqueId}`;
  const left = identity();
  const sibling = identity({ database: SIBLING_DATABASE });
  const storage = await IndexedDbReplicaStorage.open(name);
  const address = replicationActivationAddress({
    server: "http://127.0.0.1:1",
    root: "root",
    graphPath: [],
  });
  const routeSlot = await rootReplicaRouteSlot();
  let leftSession: ReplicationSession | undefined;
  let siblingSession: ReplicationSession | undefined;
  try {
    await installSnapshot(storage, left, opaque("1"), "left-root");
    await installSnapshot(storage, sibling, opaque("2"), "sibling");

    for (const [credential, selected] of [
      ["left-credential", left],
      ["sibling-credential", sibling],
    ] as const) {
      await storage.bindAuthenticated({
        fingerprint: await replicationCredentialFingerprint(credential, address, routeSlot),
        identity: selected,
      });
    }

    const openSession = (credential: string): Promise<ReplicationSession> =>
      ReplicationSession.open({
        activation: { server: "http://127.0.0.1:1", root: "root", graphPath: [] },
        credential,
        attributes,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
    leftSession = await openSession("left-credential");
    siblingSession = await openSession("sibling-credential");
    expect(leftSession.snapshot().value?.revision).toBe(opaque("1"));
    expect(siblingSession.snapshot().value?.revision).toBe(opaque("2"));

    await expect(storage.evictDatabase(databaseOf(left))).rejects.toMatchObject({
      _tag: "ReplicaDatabaseActiveError",
      pins: 1,
    });
    expect((await storage.restore(left, attributes, READ_COMPATIBILITY))?.revision)
      .toBe(opaque("1"));

    await storage.clearScope(scopeOf(left));
    expect(leftSession.snapshot().status).toBe("closed");
    expect(siblingSession.snapshot().status).toBe("closed");
    const after = await dump(name);
    expect(after["replica-committed-v1"]).toEqual([]);
    expect(after["replica-credential-bindings-v1"]).toEqual([]);
  } finally {
    await leftSession?.close();
    await siblingSession?.close();
    storage.close();
    await deleteDatabase(name);
  }
});
