import { expect } from "vitest";
import { Index, ValueTag } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  Change,
  LogicalDatom,
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { browserTest } from "./fixtures.ts";

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const DATABASE = opaque("d");
const CATALOG = opaque("c");
const READ_VIEW = opaque("v");
const AUTHENTICATOR = opaque("h");

const identity = (principal = opaque("p")): ReplicationIdentity => ({
  version: 1,
  server: SERVER,
  principal,
  database: DATABASE,
  catalog: CATALOG,
  readView: READ_VIEW,
  authenticator: AUTHENTICATOR,
});

const attributes: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", cardinality: "one", index: true },
  { ident: ":item/friend", valueType: ":db.type/ref", cardinality: "one" },
  { ident: ":item/tags", valueType: ":db.type/string", cardinality: "many" },
];

const snapshotDatom = (
  entity: string,
  field: string,
  value: SnapshotDatom["value"],
): SnapshotDatom => ({ entity, field, value, op: "add" });

const logicalDatom = (
  entity: string,
  field: string,
  value: LogicalDatom["value"],
  op: LogicalDatom["op"] = "add",
): LogicalDatom => ({ entity, field, value, op });

const installSnapshot = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  snapshot: string,
  revision: string,
  datoms: readonly SnapshotDatom[],
) => {
  await storage.startSnapshot({
    type: "SnapshotStart",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
  });
  await storage.stageSnapshotChunk({
    type: "SnapshotChunk",
    protocol: 1,
    identity: selected,
    snapshot,
    index: 0,
    datoms,
  });
  return storage.commitSnapshot({
    type: "SnapshotCommit",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
    chunks: 1,
  }, attributes);
};

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("database deletion blocked")), {
      once: true,
    });
  });

const openDatabase = (name: string, version: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("database upgrade blocked")), {
      once: true,
    });
  });

const facts = async (db: Db, field: string) => {
  const attribute = db.attr(field);
  if (attribute === undefined) throw new Error(`missing ${field}`);
  return db.datomsArray(Index.AEVT, { a: attribute.id });
};

const namedEntities = async (db: Db): Promise<Map<string, number>> =>
  new Map((await facts(db, ":item/name")).map((datom) => [datom.v as string, datom.e]));

browserTest("keeps stable partition-local ids across snapshot, change, and reopen", async ({ browser }) => {
  expect(indexedDB).toBeInstanceOf(IDBFactory);
  const name = `ramose-replica-identity-${browser.uniqueId}`;
  const selected = identity();
  const entityZ = opaque("z");
  const entityA = opaque("a");
  const entityM = opaque("m");
  const revision1 = opaque("1");
  const revision2 = opaque("2");
  const revision3 = opaque("3");
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    const first = await installSnapshot(storage, selected, opaque("q"), revision1, [
      snapshotDatom(entityZ, ":item/name", { type: "string", value: "original" }),
      snapshotDatom(entityZ, ":ramose/type", { type: "string", value: ":item" }),
    ]);
    expect(first?.revision).toBe(revision1);
    const firstNames = await namedEntities(first!.db);
    const originalEid = firstNames.get("original")!;
    const nameAid = first!.db.attr(":item/name")!.id;
    expect((await facts(first!.db, ":ramose/type"))[0]).toMatchObject({
      e: originalEid,
      v: ":item",
      vt: ValueTag.Str,
    });

    const second = await installSnapshot(storage, selected, opaque("r"), revision2, [
      snapshotDatom(entityZ, ":item/name", { type: "string", value: "original" }),
      snapshotDatom(entityZ, ":ramose/type", { type: "string", value: ":item" }),
      snapshotDatom(entityA, ":item/name", { type: "string", value: "lexically earlier" }),
      snapshotDatom(entityA, ":item/friend", { type: "ref", value: entityZ }),
    ]);
    const secondNames = await namedEntities(second!.db);
    expect(secondNames.get("original")).toBe(originalEid);
    expect(second!.db.attr(":item/name")!.id).toBe(nameAid);
    const ref = (await facts(second!.db, ":item/friend"))[0]!;
    expect(ref.vt).toBe(ValueTag.Ref);
    expect(ref.v).toBe(originalEid);
    expect(ref.e).toBe(secondNames.get("lexically earlier"));

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    const reopened = await storage.restore(selected, attributes);
    expect(reopened?.revision).toBe(revision2);
    expect((await namedEntities(reopened!.db)).get("original")).toBe(originalEid);
    expect(reopened!.db.attr(":item/name")!.id).toBe(nameAid);
    expect((await facts(reopened!.db, ":item/friend"))[0]!.v).toBe(originalEid);

    const changed: Change = {
      type: "Change",
      protocol: 1,
      identity: selected,
      from: revision2,
      revision: revision3,
      datoms: [
        logicalDatom(entityZ, ":item/name", { type: "string", value: "original" }, "retract"),
        logicalDatom(entityZ, ":item/name", { type: "string", value: "updated" }),
        logicalDatom(entityM, ":item/name", { type: "string", value: "incremental" }),
        logicalDatom(entityM, ":item/friend", { type: "ref", value: entityZ }),
      ],
    };
    const third = await storage.applyChange(changed);
    const thirdNames = await namedEntities(third!.db);
    expect(third?.revision).toBe(revision3);
    expect(thirdNames.get("updated")).toBe(originalEid);
    expect((await facts(third!.db, ":item/friend")).find((d) => d.e === thirdNames.get("incremental"))?.v)
      .toBe(originalEid);

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    const final = await storage.restore(selected, attributes);
    expect(final?.revision).toBe(revision3);
    expect((await namedEntities(final!.db)).get("updated")).toBe(originalEid);
    await expect(storage.restore(selected, [
      { ...attributes[0]!, cardinality: "many" },
      ...attributes.slice(1),
    ])).rejects.toThrow(/metadata is incompatible/);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("isolates committed replicas by the canonical authenticated partition", async ({ browser }) => {
  const name = `ramose-replica-partitions-${browser.uniqueId}`;
  const left = identity(opaque("l"));
  const right = identity(opaque("r"));
  expect(replicaPartitionKey(left)).not.toBe(replicaPartitionKey(right));
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, left, opaque("a"), opaque("1"), [
      snapshotDatom(opaque("x"), ":item/name", { type: "string", value: "left" }),
    ]);
    await installSnapshot(storage, right, opaque("b"), opaque("2"), [
      snapshotDatom(opaque("x"), ":item/name", { type: "string", value: "right" }),
    ]);
    expect([...(await namedEntities((await storage.restore(left, attributes))!.db)).keys()])
      .toEqual(["left"]);
    expect([...(await namedEntities((await storage.restore(right, attributes))!.db)).keys()])
      .toEqual(["right"]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("restores only old-or-new values across durable staging and aborted installs", async ({ browser }) => {
  const name = `ramose-replica-atomic-${browser.uniqueId}`;
  const selected = identity();
  const entity = opaque("e");
  const oldRevision = opaque("o");
  const snapshotRevision = opaque("n");
  const changeRevision = opaque("g");
  const nextSnapshot = opaque("t");
  let storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, selected, opaque("s"), oldRevision, [
      snapshotDatom(entity, ":item/name", { type: "string", value: "old" }),
    ]);
    await storage.startSnapshot({
      type: "SnapshotStart",
      protocol: 1,
      identity: selected,
      snapshot: nextSnapshot,
      revision: snapshotRevision,
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk",
      protocol: 1,
      identity: selected,
      snapshot: nextSnapshot,
      index: 0,
      datoms: [snapshotDatom(entity, ":item/name", { type: "string", value: "snapshot" })],
    });
    await expect(storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected,
      snapshot: nextSnapshot, index: 0,
      datoms: [snapshotDatom(entity, ":item/name", { type: "string", value: "changed bytes" })],
    })).rejects.toMatchObject({
      _tag: "ReplicationTransitionError",
      reason: "duplicate snapshot chunk changed bytes",
    });

    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);
    expect((await storage.restore(selected, attributes))?.revision).toBe(oldRevision);
    expect(await storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 1,
      identity: selected,
      snapshot: nextSnapshot,
      revision: snapshotRevision,
      chunks: 2,
    }, attributes)).toBeUndefined();
    expect((await storage.restore(selected, attributes))?.revision).toBe(oldRevision);

    const snapshotAbort = new AbortController();
    const abortedSnapshot = storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 1,
      identity: selected,
      snapshot: nextSnapshot,
      revision: snapshotRevision,
      chunks: 1,
    }, attributes, { signal: snapshotAbort.signal });
    snapshotAbort.abort();
    await expect(abortedSnapshot).rejects.toHaveProperty("name", "AbortError");
    expect((await storage.restore(selected, attributes))?.revision).toBe(oldRevision);

    const installedController = new AbortController();
    const installed = await storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 1,
      identity: selected,
      snapshot: nextSnapshot,
      revision: snapshotRevision,
      chunks: 1,
    }, attributes, { signal: installedController.signal });
    installedController.abort();
    expect(installed?.revision).toBe(snapshotRevision);
    expect([...(await namedEntities(installed!.db)).keys()]).toEqual(["snapshot"]);
    await expect(storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected,
      snapshot: nextSnapshot, index: 0, datoms: [],
    })).resolves.toBeUndefined();

    const change: Change = {
      type: "Change",
      protocol: 1,
      identity: selected,
      from: snapshotRevision,
      revision: changeRevision,
      datoms: [
        logicalDatom(entity, ":item/name", { type: "string", value: "snapshot" }, "retract"),
        logicalDatom(entity, ":item/name", { type: "string", value: "changed" }),
      ],
    };
    const changeAbort = new AbortController();
    const abortedChange = storage.applyChange(change, { signal: changeAbort.signal });
    changeAbort.abort();
    await expect(abortedChange).rejects.toHaveProperty("name", "AbortError");
    expect((await storage.restore(selected, attributes))?.revision).toBe(snapshotRevision);

    const applying = storage.applyChange(change);
    const during = await storage.restore(selected, attributes);
    const after = await applying;
    expect([snapshotRevision, changeRevision]).toContain(during!.revision);
    expect([...(await namedEntities(during!.db)).keys()]).toEqual([
      during!.revision === snapshotRevision ? "snapshot" : "changed",
    ]);
    expect(after?.revision).toBe(changeRevision);
    expect([...(await namedEntities(after!.db)).keys()]).toEqual(["changed"]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("rejects unknown fields and logical type mismatches without replacing the manifest", async ({ browser }) => {
  const name = `ramose-replica-validation-${browser.uniqueId}`;
  const selected = identity();
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const oldRevision = opaque("1");
    await installSnapshot(storage, selected, opaque("a"), oldRevision, [
      snapshotDatom(opaque("e"), ":item/name", { type: "string", value: "valid" }),
    ]);
    await storage.startSnapshot({
      type: "SnapshotStart",
      protocol: 1,
      identity: selected,
      snapshot: opaque("b"),
      revision: opaque("2"),
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk",
      protocol: 1,
      identity: selected,
      snapshot: opaque("b"),
      index: 0,
      datoms: [snapshotDatom(opaque("e"), ":missing/field", { type: "string", value: "bad" })],
    });
    await expect(storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 1,
      identity: selected,
      snapshot: opaque("b"),
      revision: opaque("2"),
      chunks: 1,
    }, attributes)).rejects.toThrow(/unknown field/);
    expect((await storage.restore(selected, attributes))?.revision).toBe(oldRevision);

    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 1, identity: selected,
      snapshot: opaque("c"), revision: opaque("3"),
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected,
      snapshot: opaque("c"), index: 0,
      datoms: [snapshotDatom(opaque("e"), ":item/name", { type: "long", value: 7 })],
    });
    await expect(storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity: selected,
      snapshot: opaque("c"), revision: opaque("3"), chunks: 1,
    }, attributes)).rejects.toThrow(/value type disagrees/);
    expect((await storage.restore(selected, attributes))?.revision).toBe(oldRevision);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("a snapshot cannot overwrite a change committed after staging began", async ({ browser }) => {
  const name = `ramose-replica-snapshot-cas-${browser.uniqueId}`;
  const selected = identity();
  const entity = opaque("e");
  const r1 = opaque("1");
  const r2 = opaque("2");
  const r3 = opaque("3");
  const snapshot = opaque("s");
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    await installSnapshot(storage, selected, opaque("a"), r1, [
      snapshotDatom(entity, ":item/name", { type: "string", value: "r1" }),
    ]);
    await storage.startSnapshot({
      type: "SnapshotStart", protocol: 1, identity: selected,
      snapshot, revision: r2,
    });
    await storage.stageSnapshotChunk({
      type: "SnapshotChunk", protocol: 1, identity: selected,
      snapshot, index: 0,
      datoms: [snapshotDatom(entity, ":item/name", { type: "string", value: "stale-r2" })],
    });
    await storage.applyChange({
      type: "Change", protocol: 1, identity: selected, from: r1, revision: r3,
      datoms: [
        logicalDatom(entity, ":item/name", { type: "string", value: "r1" }, "retract"),
        logicalDatom(entity, ":item/name", { type: "string", value: "r3" }),
      ],
    });
    expect(await storage.commitSnapshot({
      type: "SnapshotCommit", protocol: 1, identity: selected,
      snapshot, revision: r2, chunks: 1,
    }, attributes)).toBeUndefined();
    const restored = await storage.restore(selected, attributes);
    expect(restored?.revision).toBe(r3);
    expect([...(await namedEntities(restored!.db)).keys()]).toEqual(["r3"]);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an open adapter does not block a future IndexedDB schema upgrade", async ({ browser }) => {
  const name = `ramose-replica-upgrade-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  try {
    const upgraded = await openDatabase(name, 3);
    expect(upgraded.version).toBe(3);
    upgraded.close();
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});
