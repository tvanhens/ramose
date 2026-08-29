import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
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
import { browserTest } from "./fixtures.ts";

const opaque = (character: string): string => character.repeat(43);
const selected: ReplicationIdentity = {
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  authenticator: opaque("a"),
};
const attributes: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", index: true },
];
const activation = {
  server: "http://127.0.0.1:1",
  root: "root",
  graphPath: [] as const,
};

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
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

const openNative = (
  name: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  request.addEventListener("upgradeneeded", () => upgrade?.(request.result), { once: true });
  request.addEventListener("success", () => resolve(request.result), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
});

const install = async (
  storage: IndexedDbReplicaStorage,
  snapshot = opaque("q"),
  revision = opaque("r"),
): Promise<void> => {
  const datoms: readonly SnapshotDatom[] = [{
    entity: opaque("e"),
    field: ":item/name",
    value: { type: "string", value: "persisted" },
    op: "add",
  }];
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 1, identity: selected, snapshot, revision,
  });
  await storage.stageSnapshotChunk({
    type: "SnapshotChunk", protocol: 1, identity: selected, snapshot, index: 0, datoms,
  });
  expect(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 1, identity: selected, snapshot, revision, chunks: 1,
  }, attributes)).toBeDefined();
};

browserTest("restores only an exact credential binding and isolates observer failures", async ({ browser }) => {
  const name = `ramose-session-binding-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  let session: ReplicationSession | undefined;
  try {
    await install(storage);
    const fingerprint = await replicationCredentialFingerprint(
      "known-credential",
      replicationActivationAddress(activation),
    );
    await storage.bindCredential(fingerprint, selected);
    const inspected = await openNative(name);
    const bindingTx = inspected.transaction("replica-credential-bindings-v1", "readonly");
    const bindingRecords = await requestResult<unknown[]>(
      bindingTx.objectStore("replica-credential-bindings-v1").getAll(),
    );
    await transactionDone(bindingTx);
    inspected.close();
    expect(JSON.stringify(bindingRecords)).not.toContain("known-credential");
    expect(bindingRecords).toHaveLength(1);

    session = await ReplicationSession.open({
      activation,
      credential: "known-credential",
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    expect(session.snapshot()).toMatchObject({
      status: "connecting",
      value: { revision: opaque("r"), stale: true },
    });
    session.observe(() => {
      throw new Error("consumer failure");
    });
    const failed = new Promise<void>((resolve) => {
      session!.observe((snapshot) => {
        if (snapshot.status === "failed") resolve();
      });
    });
    await failed;
    expect(session.snapshot()).toMatchObject({
      status: "failed",
      value: { revision: opaque("r"), stale: true },
    });
    await session.close();

    const unknown = await ReplicationSession.open({
      activation,
      credential: "refreshed-unknown-credential",
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    expect(unknown.snapshot().value).toBeUndefined();
    await unknown.close();
    expect((await storage.restore(selected, attributes, selected.readCompatibilityHash))?.revision).toBe(opaque("r"));
  } finally {
    await session?.close();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("additively upgrades and restores a compatible populated version-2 replica", async ({ browser }) => {
  const sourceName = `ramose-session-v3-source-${browser.uniqueId}`;
  const legacyName = `ramose-session-v2-${browser.uniqueId}`;
  const source = await IndexedDbReplicaStorage.open(sourceName);
  let upgraded: IndexedDbReplicaStorage | undefined;
  try {
    await install(source);
    source.close();
    const sourceDb = await openNative(sourceName);
    const sourceTx = sourceDb.transaction(["replica-committed-v1", "replica-nodes-v1"], "readonly");
    const [committed, nodes] = await Promise.all([
      requestResult<unknown[]>(sourceTx.objectStore("replica-committed-v1").getAll()),
      requestResult<unknown[]>(sourceTx.objectStore("replica-nodes-v1").getAll()),
    ]);
    await transactionDone(sourceTx);
    sourceDb.close();

    const legacy = await openNative(legacyName, 2, (database) => {
      database.createObjectStore("replica-committed-v1", { keyPath: "partition" });
      database.createObjectStore("replica-staging-v1", { keyPath: "partition" });
      database.createObjectStore("replica-staging-chunks-v1", { keyPath: ["partition", "index"] });
      database.createObjectStore("replica-nodes-v1", { keyPath: ["partition", "hash"] });
      database.createObjectStore("replica-credential-bindings-v1", { keyPath: "fingerprint" });
    });
    const legacyTx = legacy.transaction(
      ["replica-committed-v1", "replica-nodes-v1"],
      "readwrite",
    );
    for (const record of committed) legacyTx.objectStore("replica-committed-v1").put(record);
    for (const record of nodes) legacyTx.objectStore("replica-nodes-v1").put(record);
    await transactionDone(legacyTx);
    legacy.close();

    upgraded = await IndexedDbReplicaStorage.open(legacyName);
    expect((await upgraded.restore(selected, attributes, selected.readCompatibilityHash))?.revision).toBe(opaque("r"));
    const reopened = await openNative(legacyName);
    expect(reopened.version).toBe(3);
    expect([...reopened.objectStoreNames]).toContain("replica-credential-bindings-v1");
    reopened.close();
  } finally {
    source.close();
    upgraded?.close();
    await deleteDatabase(sourceName);
    await deleteDatabase(legacyName);
  }
});

browserTest("quarantines mismatched and legacy manifests before constructing a Db", async ({ browser }) => {
  const mismatchName = `ramose-session-mismatch-${browser.uniqueId}`;
  const legacyName = `ramose-session-legacy-${browser.uniqueId}`;
  const mismatch = await IndexedDbReplicaStorage.open(mismatchName);
  let upgraded: IndexedDbReplicaStorage | undefined;
  try {
    await install(mismatch);
    const fingerprint = "fingerprint";
    await mismatch.bindCredential(fingerprint, selected);
    expect(await mismatch.restoreBound(
      fingerprint,
      attributes,
      ReadCompatibilityHash.make(opaque("x")),
    )).toBeUndefined();
    expect(await mismatch.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();

    const legacy = await openNative(legacyName, 2, (database) => {
      database.createObjectStore("replica-committed-v1", { keyPath: "partition" });
      database.createObjectStore("replica-staging-v1", { keyPath: "partition" });
      database.createObjectStore("replica-staging-chunks-v1", { keyPath: ["partition", "index"] });
      database.createObjectStore("replica-nodes-v1", { keyPath: ["partition", "hash"] });
      database.createObjectStore("replica-credential-bindings-v1", { keyPath: "fingerprint" });
    });
    const legacyIdentity = { ...selected } as Record<string, unknown>;
    delete legacyIdentity.readCompatibilityHash;
    const tx = legacy.transaction(
      ["replica-committed-v1", "replica-credential-bindings-v1"],
      "readwrite",
    );
    tx.objectStore("replica-committed-v1").put({
      partition: "legacy-partition",
      storageVersion: 1,
      identity: legacyIdentity,
      revision: opaque("r"),
      datoms: [],
      attributes: [],
      entityIds: [],
      attributeIds: [],
      roots: {},
      nextLocalId: 1,
    });
    tx.objectStore("replica-credential-bindings-v1").put({
      fingerprint,
      identity: legacyIdentity,
    });
    await transactionDone(tx);
    legacy.close();

    upgraded = await IndexedDbReplicaStorage.open(legacyName);
    expect(await upgraded.restoreBound(
      fingerprint,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    const inspected = await openNative(legacyName);
    const inspectTx = inspected.transaction(
      ["replica-committed-v1", "replica-credential-bindings-v1"],
      "readonly",
    );
    expect(await requestResult(inspectTx.objectStore("replica-committed-v1").count())).toBe(0);
    expect(await requestResult(inspectTx.objectStore("replica-credential-bindings-v1").count())).toBe(0);
    await transactionDone(inspectTx);
    inspected.close();
  } finally {
    mismatch.close();
    upgraded?.close();
    await deleteDatabase(mismatchName);
    await deleteDatabase(legacyName);
  }
});
