import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import type { Db } from "../../packages/ramose/src/internal/core/db.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import {
  IndexedDbReplicaStorage,
  REPLICA_DATABASE_VERSION,
  REPLICA_MANIFEST_STORAGE_VERSION,
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
  replicationCacheSelector,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import {
  provisionalReplicaRouteSlot,
  replicaRoutePathKey,
  replicaRouteScope,
  rootReplicaRouteSlot,
  stableReplicaRouteSlot,
} from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  REPLICA_CLEAR_BARRIER_KEY,
  REPLICA_GENERATIONS_STORE,
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeKey,
  replicaScopeOf,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  createMutationStores,
  MUTATION_OUTBOX,
  MUTATION_QUEUES,
  MUTATION_RECEIPTS,
} from "../../packages/ramose/src/internal/replication/outbox-storage.ts";
import {
  buildOutboxRecord,
  buildQueueCursor,
  buildReceipt,
  mutationPartitionKey,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk, changeFrame } from "../../packages/ramose/test/replication-fixtures.ts";

const opaque = (character: string): string => character.repeat(43);
const selected: ReplicationIdentity = {
  version: 1,
  server: opaque("s"),
  principal: opaque("p"),
  database: opaque("d"),
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: ReadCompatibilityHash.make(opaque("k")),
  graphLineage: [],
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
  upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  request.addEventListener("upgradeneeded", () => {
    upgrade?.(request.result, request.transaction!);
  }, { once: true });
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
    type: "SnapshotStart", protocol: 2, identity, snapshot, revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk", protocol: 2, identity, snapshot, index: 0, datoms,
  }));
  expect(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 2, identity, snapshot, revision, ordinal: 1, chunks: 1,
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
    const rootSlot = await rootReplicaRouteSlot();
    const fingerprint = await replicationCredentialFingerprint(
      "known-credential",
      address,
      rootSlot,
    );
    const candidateKey = {
      selector: await replicationCacheSelector(rawCacheKey, address),
      routeSlot: rootSlot,
    };
    await storage.bindAuthenticated({
      fingerprint,
      identity: selected,
      candidateKey,
    });
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

    let fences = 0;
    session = await ReplicationSession.open({
      activation,
      credential: "known-credential",
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
      onActivationOutcome: () => {
        fences++;
      },
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
    expect(fences).toBe(0);

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

browserTest("a follower never re-renders a committed revision it has already left behind", async ({ browser }) => {
  const name = `ramose-session-monotonic-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const entity = opaque("e");
  const installed = opaque("r");
  const committed = opaque("2");
  const current = opaque("3");
  const named = async (db: Db): Promise<string[]> => {
    const attribute = db.attr(":item/name")!;
    return (await db.datomsArray(Index.AEVT, { a: attribute.id }))
      .map((datom) => datom.v as string);
  };
  const fact = <Op extends "add" | "retract">(value: string, op: Op) => ({
    entity,
    field: ":item/name",
    value: { type: "string" as const, value },
    op,
  });
  const rename = async (
    from: string,
    revision: string,
    ordinal: number,
    before: string,
    after: string,
  ): Promise<void> => {
    (await storage.applyChange(changeFrame({
      type: "Change",
      protocol: 2,
      identity: selected,
      from,
      revision,
      ordinal,
      datoms: [fact(before, "retract"), fact(after, "add")],
    })))?.release();
  };
  let session: ReplicationSession | undefined;
  try {
    await install(storage);
    const fingerprint = await replicationCredentialFingerprint(
      "follower-credential",
      replicationActivationAddress(activation),
      await rootReplicaRouteSlot(),
    );
    await storage.bindCredential(fingerprint, selected);
    session = await ReplicationSession.open({
      activation,
      credential: "follower-credential",
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    const rendered: string[] = [];
    const ordinals: number[] = [];
    const failed = new Promise<void>((resolve) => {
      session!.observe((snapshot) => {
        const value = snapshot.value;
        if (value !== undefined && rendered.at(-1) !== value.revision) {
          rendered.push(value.revision);
          ordinals.push(value.ordinal);
        }
        if (snapshot.status === "failed") resolve();
      });
    });
    await failed;
    expect(session.snapshot().value?.revision).toBe(installed);

    await rename(installed, committed, 2, "persisted", "committed");
    expect(await session.refreshFromDurable()).toBe(true);
    expect(session.snapshot().value?.revision).toBe(committed);
    expect(await named(session.snapshot().value!.db)).toEqual(["committed"]);

    await storage.startSnapshot({
      type: "SnapshotStart",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      revision: installed,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      index: 0,
      datoms: [fact("persisted", "add")],
    }));
    expect(await storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      revision: installed,
      ordinal: 1,
      chunks: 1,
    }, attributes)).toBeUndefined();
    const stored = await storage.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    );
    expect(stored?.revision).toBe(committed);
    expect(stored?.ordinal).toBe(2);
    expect(await named(stored!.db)).toEqual(["committed"]);
    stored!.release();

    expect(await session.refreshFromDurable()).toBe(false);
    expect(session.snapshot().value?.revision).toBe(committed);
    expect(await named(session.snapshot().value!.db)).toEqual(["committed"]);

    await rename(committed, current, 3, "committed", "current");
    expect(await session.refreshFromDurable()).toBe(true);
    expect(session.snapshot().value?.revision).toBe(current);
    expect(await named(session.snapshot().value!.db)).toEqual(["current"]);

    expect(rendered).toEqual([installed, committed, current]);
    expect(ordinals).toEqual([1, 2, 3]);
  } finally {
    await session?.close();
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("an acknowledged resume durably advances the ordinal a delayed change cannot pass", async ({ browser }) => {
  const name = `ramose-session-resume-ordinal-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const entity = opaque("e");
  const installed = opaque("r");
  const delayed = opaque("2");
  const partition = replicaPartitionKey(selected);
  const storedOrdinal = async (): Promise<number | undefined> => {
    const database = await openNative(name);
    const read = database.transaction("replica-committed-heads-v1", "readonly");
    const head = await requestResult<{ readonly ordinal?: number } | undefined>(
      read.objectStore("replica-committed-heads-v1").get(partition),
    );
    await transactionDone(read);
    database.close();
    return head?.ordinal;
  };
  const named = async (db: Db): Promise<string[]> => {
    const attribute = db.attr(":item/name")!;
    return (await db.datomsArray(Index.AEVT, { a: attribute.id }))
      .map((datom) => datom.v as string);
  };
  const fact = <Op extends "add" | "retract">(value: string, op: Op) => ({
    entity,
    field: ":item/name",
    value: { type: "string" as const, value },
    op,
  });
  const acknowledge = (revision: string, ordinal: number) =>
    storage.acknowledgeResume({
      type: "ResumeReady",
      protocol: 2,
      identity: selected,
      revision,
      ordinal,
    });
  try {
    await install(storage);
    expect(await storedOrdinal()).toBe(1);

    expect(await acknowledge(opaque("9"), 5)).toBeUndefined();
    expect(await storedOrdinal()).toBe(1);

    expect(await acknowledge(installed, 3)).toBe(3);
    expect(await storedOrdinal()).toBe(3);
    for (const ordinal of [1, 3]) {
      expect(await acknowledge(installed, ordinal)).toBe(3);
      expect(await storedOrdinal()).toBe(3);
    }
    const advanced = await storage.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    );
    expect(advanced?.revision).toBe(installed);
    expect(advanced?.ordinal).toBe(3);
    advanced!.release();

    (await storage.applyChange(changeFrame({
      type: "Change",
      protocol: 2,
      identity: selected,
      from: installed,
      revision: delayed,
      ordinal: 2,
      datoms: [fact("persisted", "retract"), fact("delayed", "add")],
    })))?.release();
    expect(await storedOrdinal()).toBe(3);

    await storage.startSnapshot({
      type: "SnapshotStart",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      revision: delayed,
    });
    await storage.stageSnapshotChunk(snapshotChunk({
      type: "SnapshotChunk",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      index: 0,
      datoms: [fact("delayed", "add")],
    }));
    expect(await storage.commitSnapshot({
      type: "SnapshotCommit",
      protocol: 2,
      identity: selected,
      snapshot: opaque("p"),
      revision: delayed,
      ordinal: 2,
      chunks: 1,
    }, attributes)).toBeUndefined();
    expect(await storedOrdinal()).toBe(3);

    const held = await storage.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    );
    expect(held?.revision).toBe(installed);
    expect(await named(held!.db)).toEqual(["persisted"]);
    held!.release();

    const current = await storage.applyChange(changeFrame({
      type: "Change",
      protocol: 2,
      identity: selected,
      from: installed,
      revision: opaque("3"),
      ordinal: 4,
      datoms: [fact("persisted", "retract"), fact("current", "add")],
    }));
    expect(current?.revision).toBe(opaque("3"));
    expect(current?.ordinal).toBe(4);
    expect(await named(current!.db)).toEqual(["current"]);
    current!.release();
    expect(await storedOrdinal()).toBe(4);
  } finally {
    storage.close();
    await deleteDatabase(name);
  }
});

browserTest("keeps rotated-token candidates quarantined and safely rebinds collisions and renamed paths", async ({ browser }) => {
  const name = `ramose-session-candidate-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const rawCacheKey = "principal-local-selector";
  const oldAddress = replicationActivationAddress(activation);
  const rootSlot = await rootReplicaRouteSlot();
  const otherSlot = await provisionalReplicaRouteSlot(["renamed"]);
  const selector = await replicationCacheSelector(rawCacheKey, oldAddress);
  const oldKey = { selector, routeSlot: rootSlot };
  const renamedKey = { selector, routeSlot: otherSlot };
  const originalFingerprint = await replicationCredentialFingerprint(
    "token-before-refresh",
    oldAddress,
    rootSlot,
  );
  const rotatedFingerprint = await replicationCredentialFingerprint(
    "token-after-refresh",
    oldAddress,
    rootSlot,
  );
  const other: ReplicationIdentity = {
    ...selected,
    principal: opaque("o"),
    authenticator: opaque("z"),
  };
  try {
    await install(storage);
    await install(storage, opaque("u"), opaque("2"), other, "other-principal");
    await storage.bindAuthenticated({
      fingerprint: originalFingerprint,
      identity: selected,
      candidateKey: oldKey,
    });

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
      storageVersion: 4,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
      ordinal: 1,
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
      storageVersion: 4,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
      ordinal: 1,
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
      protocol: 2 as const,
      identity: selected,
      revision: opaque("r"),
      ordinal: 1,
    };
    expect(classifyReplicationCandidateFrame(candidate, ready)).toBe("resume");
    await storage.bindAuthenticated({
      fingerprint: rotatedFingerprint,
      identity: selected,
      candidateKey: oldKey,
    });
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
    expect((await storage.applyChange(changeFrame({
      type: "Change",
      protocol: 2,
      identity: selected,
      from: opaque("r"),
      revision: changedRevision,
      ordinal: 2,
      datoms: [],
    })))?.revision).toBe(changedRevision);
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

    const collision = await storage.selectCacheCandidate(
      oldKey,
      selected.readCompatibilityHash,
    );
    const reset = { type: "Reset" as const, protocol: 2 as const, identity: other };
    expect(classifyReplicationCandidateFrame(collision, reset)).toBe("reset");
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        "other-principal-token",
        oldAddress,
        rootSlot,
      ),
      identity: other,
      candidateKey: oldKey,
    });
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

    expect(await storage.selectCacheCandidate(
      renamedKey,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    const start = {
      type: "SnapshotStart" as const,
      protocol: 2 as const,
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
    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint(
        "renamed-path-token",
        oldAddress,
        otherSlot,
      ),
      identity: selected,
      candidateKey: renamedKey,
    });
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

browserTest("a replaced principal leaves no candidate slot to re-fence", async ({ browser }) => {
  const name = `ramose-session-replaced-slots-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const address = replicationActivationAddress(activation);
  const rootSlot = await rootReplicaRouteSlot();
  const childSlot = await provisionalReplicaRouteSlot(["child"]);
  const selector = await replicationCacheSelector("shared-local-user", address);
  const other: ReplicationIdentity = {
    ...selected,
    principal: opaque("o"),
    authenticator: opaque("z"),
  };
  const replaced = replicaScopeKey(replicaScopeOf(selected));
  const generationOf = async (key: string): Promise<number> => {
    const database = await openNative(name);
    const inspect = database.transaction(REPLICA_GENERATIONS_STORE, "readonly");
    const record = await requestResult<{ readonly generation: number } | undefined>(
      inspect.objectStore(REPLICA_GENERATIONS_STORE).get(key),
    );
    await transactionDone(inspect);
    database.close();
    return record?.generation ?? 0;
  };
  const held = await replicationCredentialFingerprint("held-token", address, rootSlot);
  try {
    await install(storage);
    await install(storage, opaque("u"), opaque("2"), other, "other-principal");
    for (const routeSlot of [rootSlot, childSlot]) {
      await storage.bindAuthenticated({
        fingerprint: routeSlot === rootSlot
          ? held
          : await replicationCredentialFingerprint("held-token", address, routeSlot),
        identity: selected,
        candidateKey: { selector, routeSlot },
      });
    }

    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint("other-token", address, childSlot),
      identity: other,
      candidateKey: { selector, routeSlot: childSlot },
    });
    const fenced = await generationOf(replaced);
    const barrier = await generationOf(REPLICA_CLEAR_BARRIER_KEY);
    expect(fenced).toBe(2);
    expect(barrier).toBe(1);

    expect(await storage.selectCacheCandidate(
      { selector, routeSlot: rootSlot },
      selected.readCompatibilityHash,
    )).toBeUndefined();
    expect((await storage.selectCacheCandidate(
      { selector, routeSlot: childSlot },
      selected.readCompatibilityHash,
    ))?.identity).toEqual(other);

    await storage.bindAuthenticated({
      fingerprint: await replicationCredentialFingerprint("other-token", address, rootSlot),
      identity: other,
      candidateKey: { selector, routeSlot: rootSlot },
    });
    expect(await generationOf(replaced)).toBe(fenced);
    expect(await generationOf(REPLICA_CLEAR_BARRIER_KEY)).toBe(barrier);

    expect((await storage.restoreBound(
      held,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));
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
    await rootReplicaRouteSlot(),
  );
  const candidateKey = {
    selector: await replicationCacheSelector("same-local-user", address),
    routeSlot: await rootReplicaRouteSlot(),
  };
  try {
    expect(replicaPartitionKey(replacement)).toBe(replicaPartitionKey(selected));
    await install(storage);

    await storage.bindAuthenticated({
      fingerprint,
      identity: replacement,
      candidateKey,
    });
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

const LEGACY_STORE_KEY_PATHS: readonly (readonly [string, string | string[]])[] = [
  ["replica-committed-v1", "partition"],
  ["replica-committed-heads-v1", "partition"],
  ["replica-staging-v1", "partition"],
  ["replica-staging-chunks-v1", ["partition", "index"]],
  ["replica-nodes-v1", ["partition", "hash"]],
  ["replica-credential-bindings-v1", "fingerprint"],
  ["replica-cache-candidates-v1", ["selector", "routeSlot"]],
];

browserTest("one atomic migration resets every documentation-bearing, path-keyed record", async ({ browser }) => {
  const legacyName = `ramose-session-storage-v1-${browser.uniqueId}`;
  const mutations = "future-mutation-outbox";
  let upgraded: IndexedDbReplicaStorage | undefined;
  try {
    const legacy = await openNative(legacyName, 4, (database) => {
      for (const [store, keyPath] of LEGACY_STORE_KEY_PATHS) {
        database.createObjectStore(store, { keyPath: keyPath as string | string[] });
      }

      database.createObjectStore(mutations, { keyPath: "id" });
    });
    const legacyPartition = "ramose-replica-v1:legacy";
    const seed = legacy.transaction([
      ...LEGACY_STORE_KEY_PATHS.map(([store]) => store),
      mutations,
    ], "readwrite");
    seed.objectStore("replica-committed-v1").put({
      partition: legacyPartition,
      storageVersion: 1,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
      datoms: [],

      attributes: [{
        ident: ":item/name",
        valueType: 2,
        cardinality: "one",
        index: true,
        isComponent: false,
        optional: false,
        doc: "documentation that version 1 folded into its stored roots",
      }],
      entityIds: [],
      attributeIds: [[":item/name", 1000]],
      roots: {},
      nextLocalId: 1001,
    });
    seed.objectStore("replica-committed-heads-v1").put({
      partition: legacyPartition,
      storageVersion: 1,
      identity: selected,
      readCompatibilityHash: selected.readCompatibilityHash,
      revision: opaque("r"),
    });
    seed.objectStore("replica-staging-v1").put({
      partition: legacyPartition,
      identity: selected,
      snapshot: opaque("q"),
      revision: opaque("r"),
      baseRevision: null,
    });
    seed.objectStore("replica-staging-chunks-v1").put({
      partition: legacyPartition,
      index: 0,
      datoms: [],
    });
    seed.objectStore("replica-nodes-v1").put({
      partition: legacyPartition,
      hash: "legacy-node",
      body: new Uint8Array([1, 2, 3]),
    });

    seed.objectStore("replica-credential-bindings-v1").put({
      fingerprint: "path-keyed-fingerprint",
      identity: selected,
    });
    seed.objectStore("replica-cache-candidates-v1").put({
      selector: opaque("S"),
      routeSlot: opaque("R"),
      identity: selected,
    });
    seed.objectStore(mutations).put({ id: "queued-operation" });
    await transactionDone(seed);
    legacy.close();

    upgraded = await IndexedDbReplicaStorage.open(legacyName);
    const reopened = await openNative(legacyName);
    expect(reopened.version).toBe(REPLICA_DATABASE_VERSION);
    expect([...reopened.objectStoreNames]).toContain("replica-route-slots-v1");
    const inspect = reopened.transaction([
      ...LEGACY_STORE_KEY_PATHS.map(([store]) => store),
      "replica-route-slots-v1",
      mutations,
    ], "readonly");
    const counts = await Promise.all(
      [...LEGACY_STORE_KEY_PATHS.map(([store]) => store), "replica-route-slots-v1"]
        .map((store) => requestResult(inspect.objectStore(store).count())),
    );
    const preserved = await requestResult(inspect.objectStore(mutations).count());
    await transactionDone(inspect);
    reopened.close();
    expect(counts).toEqual(counts.map(() => 0));
    expect(preserved).toBe(1);

    expect(await upgraded.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    await install(upgraded);
    expect((await upgraded.restore(
      selected,
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));
    expect(replicaPartitionKey(selected).startsWith("ramose-replica-v4:")).toBe(true);
  } finally {
    upgraded?.close();
    await deleteDatabase(legacyName);
  }
});

const PREVIOUS_STORE_KEY_PATHS: readonly (readonly [string, string | string[]])[] = [
  ...LEGACY_STORE_KEY_PATHS,
  ["replica-route-slots-v1", ["scope", "pathKey"]],
  [REPLICA_GENERATIONS_STORE, "key"],
];

browserTest(
  "the storage-version-3 upgrade resets stored values and leaves queued work and fence state alone",
  async ({ browser }) => {
    const name = `ramose-session-storage-v3-${browser.uniqueId}`;
    const scope = replicaScopeOf(selected);
    const receiver = replicaDatabaseScopeOf(selected);

    const scopeKey = ["ramose-replica-scope-v2", selected.server, selected.principal]
      .join(":");
    expect(replicaScopeKey(scope)).toBe(scopeKey);
    const partition = mutationPartitionKey(receiver);
    const legacyPartition = replicaPartitionKey(selected).replace(
      "ramose-replica-v4:",
      "ramose-replica-v2:",
    );

    const record = buildOutboxRecord({
      invocation: invocationId(),
      receiver,
      operation: {
        catalog: "app" as never,
        owner: { kind: "entity", name: "issue" },
        localName: "create",
      },
      operationVersion: "b".repeat(64) as OperationVersion,
      target: { type: "none" },
      input: { title: "queued before the upgrade" },
      allocations: [],
      inputRefs: [],
      enqueuedAt: 1_700_000_000_000,
    }, scopeKey, 1);
    let upgraded: IndexedDbReplicaStorage | undefined;
    try {
      const previous = await openNative(
        name,
        REPLICA_MANIFEST_STORAGE_VERSION - 1,
        (database, upgrade) => {
          for (const [store, keyPath] of PREVIOUS_STORE_KEY_PATHS) {
            database.createObjectStore(store, { keyPath: keyPath as string | string[] });
          }
          createMutationStores(database, upgrade, false);
        },
      );
      const seed = previous.transaction([
        "replica-committed-v1",
        "replica-nodes-v1",
        REPLICA_GENERATIONS_STORE,
        MUTATION_OUTBOX,
        MUTATION_QUEUES,
        MUTATION_RECEIPTS,
      ], "readwrite");

      seed.objectStore("replica-committed-v1").put({
        partition: legacyPartition,
        storageVersion: 2,
        identity: selected,
        readCompatibilityHash: selected.readCompatibilityHash,
        revision: opaque("r"),
        datoms: [],
        attributes: [],
        entityIds: [],
        attributeIds: [],
        roots: {},
        nextLocalId: 1_000,
      });
      seed.objectStore("replica-nodes-v1").put({
        partition: legacyPartition,
        hash: "version-2-node",
        body: new Uint8Array([1, 2, 3]),
      });

      const generations = seed.objectStore(REPLICA_GENERATIONS_STORE);
      generations.put({ key: scopeKey, generation: 7, confirmedAt: 1_700_000_000_000 });
      generations.put({
        key: replicaDatabaseKey(receiver),
        generation: 4,
        confirmedAt: 1_700_000_000_000,
      });
      seed.objectStore(MUTATION_OUTBOX).add(record);
      seed.objectStore(MUTATION_QUEUES).put(buildQueueCursor({
        partition,
        scope: scopeKey,
        receiver: record.receiver,
        nextSequence: 2,
        sealing: null,
        activation: 0,
        updatedAt: record.enqueuedAt,
      }));
      seed.objectStore(MUTATION_RECEIPTS).add(buildReceipt({
        partition,
        invocation: record.invocation,
        scope: scopeKey,
        state: "queued",
        observation: null,
        activation: 0,
        output: null,
        mappings: [],
        failure: null,
        updatedAt: record.enqueuedAt,
      }));
      await transactionDone(seed);
      previous.close();

      upgraded = await IndexedDbReplicaStorage.open(name);

      const inspect = (await openNative(name)).transaction([
        "replica-committed-v1",
        "replica-nodes-v1",
        REPLICA_GENERATIONS_STORE,
        MUTATION_OUTBOX,
      ], "readonly");
      const [manifests, nodes, scopeGeneration, databaseGeneration, queued] =
        await Promise.all([
          requestResult(inspect.objectStore("replica-committed-v1").count()),
          requestResult(inspect.objectStore("replica-nodes-v1").count()),
          requestResult<{ readonly generation: number } | undefined>(
            inspect.objectStore(REPLICA_GENERATIONS_STORE).get(scopeKey),
          ),
          requestResult<{ readonly generation: number } | undefined>(
            inspect.objectStore(REPLICA_GENERATIONS_STORE)
              .get(replicaDatabaseKey(receiver)),
          ),
          requestResult(inspect.objectStore(MUTATION_OUTBOX).count()),
        ]);
      await transactionDone(inspect);
      inspect.db.close();

      expect(manifests).toBe(0);
      expect(nodes).toBe(0);

      expect(queued).toBe(1);

      await expect(upgraded.outbox().acknowledge(record, {
        _tag: "Committed",
        output: null,
        mappings: [],
      })).resolves.toMatchObject({ state: "committed" });

      expect(scopeGeneration?.generation).toBe(7);
      expect(databaseGeneration?.generation).toBe(4);
    } finally {
      upgraded?.close();
      await deleteDatabase(name);
    }
  },
);

browserTest("stable route slots survive a rename and refuse a delete/recreate", async ({ browser }) => {
  const name = `ramose-session-route-slots-${browser.uniqueId}`;
  const storage = await IndexedDbReplicaStorage.open(name);
  const address = replicationActivationAddress(activation);
  const scope = await replicaRouteScope(address);

  const boardLineage = [opaque("1")];
  const recreatedLineage = [opaque("2")];
  const boardSlot = await stableReplicaRouteSlot(boardLineage);
  const recreatedSlot = await stableReplicaRouteSlot(recreatedLineage);
  const child: ReplicationIdentity = {
    ...selected,
    database: opaque("D"),
    graphLineage: boardLineage,
    authenticator: opaque("A"),
  };
  const recreated: ReplicationIdentity = {
    ...selected,
    database: opaque("E"),
    graphLineage: recreatedLineage,
    authenticator: opaque("B"),
  };
  const credential = "one-exact-token";
  const boundFingerprint = await replicationCredentialFingerprint(
    credential,
    address,
    boardSlot,
  );
  try {
    expect(boardSlot).not.toBe(recreatedSlot);
    expect(boardSlot).not.toBe(await rootReplicaRouteSlot());
    await install(storage, opaque("q"), opaque("r"), child, "child-value");
    await storage.bindAuthenticated({
      fingerprint: boundFingerprint,
      identity: child,
      route: {
        scope,
        pathKey: await replicaRoutePathKey(["board"]),
        slot: boardSlot,
      },
    });

    const renamedPathKey = await replicaRoutePathKey(["board-renamed"]);
    await storage.bindAuthenticated({
      fingerprint: boundFingerprint,
      identity: child,
      route: { scope, pathKey: renamedPathKey, slot: boardSlot },
    });
    expect(await storage.observedRouteSlot({ scope, pathKey: renamedPathKey }))
      .toBe(boardSlot);
    expect((await storage.restoreBound(
      await replicationCredentialFingerprint(
        credential,
        replicationActivationAddress({ ...activation, graphPath: ["board-renamed"] }),
        boardSlot,
      ),
      attributes,
      selected.readCompatibilityHash,
    ))?.revision).toBe(opaque("r"));

    expect(await storage.restoreBound(
      await replicationCredentialFingerprint(credential, address, recreatedSlot),
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();
    expect(await storage.restore(
      recreated,
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();

    const unobservedPathKey = await replicaRoutePathKey(["board-never-observed"]);
    expect(await storage.observedRouteSlot({ scope, pathKey: unobservedPathKey }))
      .toBeUndefined();
    const provisional = await provisionalReplicaRouteSlot(["board-never-observed"]);
    expect(provisional).not.toBe(boardSlot);
    expect(await storage.restoreBound(
      await replicationCredentialFingerprint(credential, address, provisional),
      attributes,
      selected.readCompatibilityHash,
    )).toBeUndefined();

    const renamed = await ReplicationSession.open({
      activation: { ...activation, graphPath: ["board-renamed"] },
      credential,
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    expect(renamed.snapshot()).toMatchObject({
      status: "connecting",
      value: { revision: opaque("r"), stale: true },
    });
    await renamed.close();
    const undiscovered = await ReplicationSession.open({
      activation: { ...activation, graphPath: ["board-never-observed"] },
      credential,
      attributes,
      readCompatibilityHash: selected.readCompatibilityHash,
      storage,
    });
    expect(undiscovered.snapshot().value).toBeUndefined();
    await undiscovered.close();

    const inspected = await openNative(name);
    const tx = inspected.transaction("replica-route-slots-v1", "readonly");
    const records = await requestResult<unknown[]>(
      tx.objectStore("replica-route-slots-v1").getAll(),
    );
    await transactionDone(tx);
    inspected.close();
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("board");
  } finally {
    storage.close();
    await deleteDatabase(name);
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
