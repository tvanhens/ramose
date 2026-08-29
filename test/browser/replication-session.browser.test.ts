import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
  type ReplicaCacheCandidate,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type {
  ReplicationIdentity,
  SnapshotDatom,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  ReplicationSession,
  classifyReplicationCandidateFrame,
} from "../../packages/ramose/src/internal/replication/session.ts";
import {
  replicationActivationAddress,
  replicationCacheRouteSlot,
  replicationCacheSelector,
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
  identity = selected,
  value = "persisted",
): Promise<void> => {
  const datoms: readonly SnapshotDatom[] = [{
    entity: opaque("e"),
    field: ":item/name",
    value: { type: "string", value },
    op: "add",
  }];
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
  });
  await storage.stageSnapshotChunk({
    type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0, datoms,
  });
  expect(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
  }, attributes)).toBeDefined();
};

browserTest("restores only an exact credential binding and isolates observer failures", async ({ browser }) => {
  const name = `ramose-session-binding-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  let session: ReplicationSession | undefined;
  try {
    await install(storage);
    const address = replicationActivationAddress(activation);
    const rawCacheKey = "local-user-id";
    const fingerprint = await replicationCredentialFingerprint(
      "known-credential",
      address,
    );
    const candidateKey = {
      selector: await replicationCacheSelector(rawCacheKey, address),
      routeSlot: await replicationCacheRouteSlot(address),
    };
    await storage.bindAuthenticated(fingerprint, selected, candidateKey);
    const inspected = await openNative(name);
    const bindingTx = inspected.transaction([
      "replica-credential-bindings-v1",
      "replica-cache-candidates-v1",
    ], "readonly");
    const [bindingRecords, candidateRecords] = await Promise.all([
      requestResult<unknown[]>(
        bindingTx.objectStore("replica-credential-bindings-v1").getAll(),
      ),
      requestResult<unknown[]>(
        bindingTx.objectStore("replica-cache-candidates-v1").getAll(),
      ),
    ]);
    await transactionDone(bindingTx);
    inspected.close();
    expect(JSON.stringify(bindingRecords)).not.toContain("known-credential");
    expect(JSON.stringify(candidateRecords)).not.toContain(rawCacheKey);
    expect(bindingRecords).toHaveLength(1);
    expect(candidateRecords).toHaveLength(1);

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
    const unknownFailed = new Promise<void>((resolve) => {
      session!.observe((snapshot) => {
        if (snapshot.status === "failed") resolve();
      });
    });
    await unknownFailed;
    expect(session.snapshot()).toMatchObject({
      status: "failed",
      value: { revision: opaque("r"), stale: true },
    });
    await session.close();

    const unknown = await ReplicationSession.open({
      activation,
      credential: "refreshed-unknown-credential",
      cacheKey: rawCacheKey,
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    expect(unknown.snapshot().value).toBeUndefined();
    const observed: unknown[] = [];
    const failed = new Promise<void>((resolve) => {
      unknown.observe((snapshot) => {
        observed.push(snapshot);
        if (snapshot.status === "failed") resolve();
      });
    });
    await failed;
    expect(observed.every((snapshot) =>
      !("value" in (snapshot as Record<string, unknown>))
    )).toBe(true);
    await unknown.close();
    expect((await storage.restore(selected, attributes, selected.readCompatibilityHash))?.revision).toBe(opaque("r"));
  } finally {
    await session?.close();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("keeps rotated-token candidates quarantined and safely rebinds collisions and renamed paths", async ({ browser }) => {
  const name = `ramose-session-candidate-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const rawCacheKey = "principal-local-selector";
  const oldAddress = replicationActivationAddress(activation);
  const renamedAddress = replicationActivationAddress({
    ...activation,
    graphPath: ["renamed"],
  });
  const selector = await replicationCacheSelector(rawCacheKey, oldAddress);
  const oldKey = {
    selector,
    routeSlot: await replicationCacheRouteSlot(oldAddress),
  };
  const renamedKey = {
    selector,
    routeSlot: await replicationCacheRouteSlot(renamedAddress),
  };
  const originalFingerprint = await replicationCredentialFingerprint(
    "token-before-refresh",
    oldAddress,
  );
  const rotatedFingerprint = await replicationCredentialFingerprint(
    "token-after-refresh",
    oldAddress,
  );
  const other: ReplicationIdentity = {
    ...selected,
    principal: opaque("o"),
    authenticator: opaque("z"),
  };
  try {
    await install(storage);
    await install(storage, opaque("u"), opaque("2"), other, "other-principal");
    await storage.bindAuthenticated(originalFingerprint, selected, oldKey);

    const partition = replicaPartitionKey(selected);
    const inspectedHead = await openNative(name);
    const headTx = inspectedHead.transaction([
      "replica-committed-v1",
      "replica-committed-heads-v1",
    ], "readonly");
    const [manifest, head] = await Promise.all([
      requestResult<Record<string, unknown> | undefined>(
        headTx.objectStore("replica-committed-v1").get(partition),
      ),
      requestResult<Record<string, unknown> | undefined>(
        headTx.objectStore("replica-committed-heads-v1").get(partition),
      ),
    ]);
    await transactionDone(headTx);
    inspectedHead.close();
    expect(head).toEqual({
      partition,
      storageVersion: 1,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
    });
    expect(head?.revision).toBe(manifest?.revision);
    expect(head).not.toHaveProperty("datoms");
    expect(head).not.toHaveProperty("roots");

    expect(await storage.restoreBound(
      rotatedFingerprint,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    const touchedStores: string[][] = [];
    const databasePrototype = IDBDatabase.prototype;
    const nativeTransaction = databasePrototype.transaction;
    databasePrototype.transaction = function(
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ): IDBTransaction {
      if (this.name === name) {
        touchedStores.push(typeof storeNames === "string" ? [storeNames] : [...storeNames]);
      }
      return nativeTransaction.call(this, storeNames, mode, options);
    } as IDBDatabase["transaction"];
    let candidate: ReplicaCacheCandidate | undefined;
    try {
      candidate = await storage.selectCacheCandidate(
        oldKey,
        selected.readCompatibilityHash,
      );
    } finally {
      databasePrototype.transaction = nativeTransaction;
    }
    expect(touchedStores).toEqual([[
      "replica-cache-candidates-v1",
      "replica-committed-heads-v1",
    ]]);
    expect(candidate).toEqual({ identity: selected, revision: opaque("r") });
    expect(candidate === undefined || "db" in candidate).toBe(false);
    expect(await storage.selectCacheCandidate(
      oldKey,
      ReadCompatibilityHash.make(opaque("x")),
    )).toBeUndefined();

    const correctHead = {
      partition,
      storageVersion: 1,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
    };
    const missing = await openNative(name);
    let corruptHead = missing.transaction("replica-committed-heads-v1", "readwrite");
    corruptHead.objectStore("replica-committed-heads-v1").delete(partition);
    await transactionDone(corruptHead);
    expect(await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    corruptHead = missing.transaction("replica-committed-heads-v1", "readwrite");
    corruptHead.objectStore("replica-committed-heads-v1").put({
      ...correctHead,
      identity: other,
    });
    await transactionDone(corruptHead);
    expect(await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    corruptHead = missing.transaction("replica-committed-heads-v1", "readwrite");
    corruptHead.objectStore("replica-committed-heads-v1").put(correctHead);
    await transactionDone(corruptHead);
    missing.close();

    const ready = {
      type: "ResumeReady" as const,
      protocol: 1 as const,
      identity: selected,
      revision: opaque("r"),
    };
    expect(classifyReplicationCandidateFrame(candidate, ready)).toBe("resume");
    await storage.bindAuthenticated(rotatedFingerprint, selected, oldKey);
    expect((await storage.restoreConfirmedCandidate(
      candidate!,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));
    expect((await storage.restoreBound(
      rotatedFingerprint,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));
    const changedRevision = opaque("3");
    expect((await storage.applyChange({
      type: "Change",
      protocol: 1,
      identity: selected,
      from: opaque("r"),
      revision: changedRevision,
      datoms: [],
    }))?.revision).toBe(changedRevision);
    expect((await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    ))?.revision).toBe(changedRevision);
    expect(await storage.restoreConfirmedCandidate(
      candidate!,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    expect((await storage.restoreBound(
      rotatedFingerprint,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(changedRevision);

    // A colliding selector nominates the old principal only until the current
    // authenticated Reset confirms and rebinds the other identity.
    const collision = await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    );
    const reset = { type: "Reset" as const, protocol: 1 as const, identity: other };
    expect(classifyReplicationCandidateFrame(collision, reset)).toBe("reset");
    await storage.bindAuthenticated(
      await replicationCredentialFingerprint("other-principal-token", oldAddress),
      other,
      oldKey,
    );
    const rebound = await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    );
    expect(rebound).toEqual({ identity: other, revision: opaque("2") });
    expect((await storage.restore(
      other,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("2"));

    // Mutable path text is not identity: a new opaque route slot has no
    // candidate, but the authenticated identity still locates the committed
    // partition and can bind that new slot.
    expect(await storage.selectCacheCandidate(
      renamedKey,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    const start = {
      type: "SnapshotStart" as const,
      protocol: 1 as const,
      identity: selected,
      snapshot: opaque("n"),
      revision: opaque("3"),
    };
    expect(classifyReplicationCandidateFrame(undefined, start)).toBe("snapshot");
    expect((await storage.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(changedRevision);
    await storage.bindAuthenticated(
      await replicationCredentialFingerprint("renamed-path-token", renamedAddress),
      selected,
      renamedKey,
    );
    expect((await storage.selectCacheCandidate(
      renamedKey,
      selected.readCompatibilityHash,
    ))?.identity).toEqual(selected);

    const inspected = await openNative(name);
    const tx = inspected.transaction("replica-cache-candidates-v1", "readonly");
    const records = await requestResult<unknown[]>(
      tx.objectStore("replica-cache-candidates-v1").getAll(),
    );
    await transactionDone(tx);
    inspected.close();
    const persisted = JSON.stringify(records);
    expect(persisted).not.toContain(rawCacheKey);
    expect(persisted).not.toContain("renamed");
    expect(persisted).not.toContain("token");
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("never relabels a shared physical partition after a post-fence crash", async ({ browser }) => {
  const name = `ramose-session-shared-partition-${browser.uniqueId}`;
  let storage = await IndexedDbReplicaStorage.open(name);
  const address = replicationActivationAddress(activation);
  const replacement: ReplicationIdentity = {
    ...selected,
    catalog: opaque("b"),
    authenticator: opaque("z"),
  };
  const fingerprint = await replicationCredentialFingerprint(
    "replacement-token",
    address,
  );
  const candidateKey = {
    selector: await replicationCacheSelector("same-local-user", address),
    routeSlot: await replicationCacheRouteSlot(address),
  };
  try {
    expect(replicaPartitionKey(replacement)).toBe(replicaPartitionKey(selected));
    await install(storage);

    // A valid Reset/Start may bind the newly authenticated identity before its
    // replacement snapshot commits. A crash at that point must not turn the
    // prior record into the new identity's value on restart.
    await storage.bindAuthenticated(fingerprint, replacement, candidateKey);
    storage.close();
    storage = await IndexedDbReplicaStorage.open(name);

    expect(await storage.restore(
      replacement,
      attributes,
      replacement.readCompatibilityHash,
    )).toBeUndefined();
    await expect(storage.restoreBound(
      fingerprint,
      attributes,
      replacement.readCompatibilityHash,
    )).resolves.toBeUndefined();
    expect((await storage.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));
    expect(await storage.selectCacheCandidate(
      candidateKey,
      selected.readCompatibilityHash,
    )).toBeUndefined();

    const inspected = await openNative(name);
    const tx = inspected.transaction("replica-credential-bindings-v1", "readonly");
    expect(await requestResult(tx.objectStore("replica-credential-bindings-v1").count())).toBe(0);
    await transactionDone(tx);
    inspected.close();
  } finally {
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
    expect(reopened.version).toBe(4);
    expect([...reopened.objectStoreNames]).toContain("replica-credential-bindings-v1");
    expect([...reopened.objectStoreNames]).toContain("replica-cache-candidates-v1");
    expect([...reopened.objectStoreNames]).toContain("replica-committed-heads-v1");
    const headTx = reopened.transaction("replica-committed-heads-v1", "readonly");
    const heads = await requestResult<Record<string, unknown>[]>(
      headTx.objectStore("replica-committed-heads-v1").getAll(),
    );
    await transactionDone(headTx);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      identity: selected,
      revision: opaque("r"),
      readCompatibilityHash: selected.readCompatibilityHash,
    });
    expect(heads[0]).not.toHaveProperty("datoms");
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
      [
        "replica-committed-v1",
        "replica-committed-heads-v1",
        "replica-credential-bindings-v1",
      ],
      "readonly",
    );
    expect(await requestResult(inspectTx.objectStore("replica-committed-v1").count())).toBe(0);
    expect(await requestResult(inspectTx.objectStore("replica-committed-heads-v1").count())).toBe(0);
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
