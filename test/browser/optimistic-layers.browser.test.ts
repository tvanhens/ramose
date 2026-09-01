import * as Result from "effect/Result";
import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import { clientRef, invocationId } from "../../packages/ramose/src/db/refs.ts";
import type {
  ClientRef,
  EntityId,
  InvocationId,
} from "../../packages/ramose/src/db/refs.ts";
import type { ProjectionTx } from "../../packages/ramose/src/db/Projection.ts";
import {
  sealEntityId,
  type EntityIdScope,
} from "../../packages/ramose/src/internal/replication/entity-id.ts";
import {
  IndexedDbReplicaStorage,
  replicaPartitionKey,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type { OutboxDraft } from "../../packages/ramose/src/internal/replication/outbox.ts";
import { mutationPartitionKey } from "../../packages/ramose/src/internal/replication/outbox.ts";
import { makeClientProjectionCatalog } from "../../packages/ramose/src/internal/replication/projection-binding.ts";
import type { ClientProjectionCatalog } from "../../packages/ramose/src/internal/replication/projection-binding.ts";
import { OptimisticReconciler } from "../../packages/ramose/src/internal/replication/reconciliation.ts";
import {
  classifyReplicationAdoption,
  ReplicationSession,
  type ReplicationSessionSnapshot,
} from "../../packages/ramose/src/internal/replication/session.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  decodeReplicationFrame,
  type Change,
  type ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import { rootReplicaRouteSlot } from "../../packages/ramose/src/internal/replication/route-slot.ts";
import {
  replicationActivationAddress,
  replicationCredentialFingerprint,
} from "../../packages/ramose/src/internal/replication/transport.ts";
import {
  generateServerIdentityRoot,
  sealingKeyOf,
} from "../../packages/ramose/src/internal/replication/server-identity.ts";
import {
  armCheckpoint,
  checkpointStatus,
  releaseCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import recorded from "./frames/optimistic-fence.client.json";
import { browserTest } from "./fixtures.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const identity = (
  overrides: Partial<ReplicationIdentity> = {},
): ReplicationIdentity => ({
  ...(recorded.identity as unknown as ReplicationIdentity),
  ...overrides,
});

const READ_COMPATIBILITY = ReadCompatibilityHash.make(
  recorded.identity.readCompatibilityHash,
);

const ATTRIBUTES = recorded.attributes as readonly AttributeSpec[];

const TITLE = ":conformanceIssue/title";

const version = "b".repeat(64) as OperationVersion;

const operation = {
  catalog: "issues" as never,
  owner: { kind: "entity", name: "issue" } as const,
  localName: "rename",
};

const name = { ident: TITLE, valueType: "string" } as const;

const rename = ({ input, self, tx }: {
  readonly input: { readonly name: string };
  readonly self: ClientRef | EntityId | undefined;
  readonly tx: ProjectionTx;
}): void => {
  const target = self ?? tx.create("issue", { ns: "Issue" });
  tx.set(target, name, input.name);
};

const catalog = (
  build = "build-a",
  revision = 3,
  run: unknown = rename,
): ClientProjectionCatalog =>
  makeClientProjectionCatalog(build, [
    { operation, projection: { revision, run: run as never } },
  ]);

const PROJECTION = { revision: 3, build: "build-a" };

const draft = (
  receiver: ReplicaDatabaseScope,
  overrides: Partial<OutboxDraft> = {},
): OutboxDraft => ({
  invocation: invocationId(),
  receiver,
  operation,
  operationVersion: version,
  target: { type: "none" },
  input: { name: "queued" },
  allocations: [],
  inputRefs: [],
  enqueuedAt: 1_700_000_000_000,
  ...overrides,
});

const root = generateServerIdentityRoot(1_700_000_000_000);

const handleFor = async (
  receiver: ReplicaDatabaseScope,
  eid: number,
): Promise<EntityId> => {
  const scope: EntityIdScope = {
    server: receiver.server,
    principal: receiver.principal,
    database: receiver.database,
  };
  return sealEntityId(sealingKeyOf(root), scope, eid) as Promise<EntityId>;
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

const openNative = (database: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(database);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const deleteDatabase = (database: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(database);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });

const rawLayers = async (database: string): Promise<readonly Record<string, unknown>[]> => {
  const connection = await openNative(database);
  const transaction = connection.transaction("mutation-layers-v1", "readonly");
  const rows = await requestResult<Record<string, unknown>[]>(
    transaction.objectStore("mutation-layers-v1").getAll(),
  );
  await transactionDone(transaction);
  connection.close();
  return rows;
};

const dropped = (value: { readonly release: () => void } | undefined): void => {
  value?.release();
};

const revisionOf = async (
  pending: Promise<{ readonly revision: string; readonly release: () => void } | undefined>,
): Promise<string | undefined> => {
  const value = await pending;
  value?.release();
  return value?.revision;
};

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

const install = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
  label: string,
  value = "authoritative",
): Promise<void> => {
  await confirm(storage, selected, label);
  const snapshot = `snapshot-${label}`.padEnd(43, "0");
  const revision = `revision-${label}`.padEnd(43, "0");
  await storage.startSnapshot({
    type: "SnapshotStart", protocol: 4, identity: selected, snapshot, revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk",
    protocol: 4,
    identity: selected,
    snapshot,
    index: 0,
    datoms: [{
      entity: "e".repeat(43),
      field: TITLE,
      value: { type: "string", value },
      op: "add",
    }],
  }));
  dropped(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 4, identity: selected, snapshot, revision, ordinal: 1, settled: 0, chunks: 1,
  }, ATTRIBUTES));
};

const enqueueProjected = (
  storage: IndexedDbReplicaStorage,
  receiver: ReplicaDatabaseScope,
  scope: ReplicaScope,
  overrides: Partial<OutboxDraft> = {},
) =>
  storage.outbox().enqueue(draft(receiver, overrides), {
    scope,
    projection: PROJECTION,
  });

const names = async (
  reconciler: OptimisticReconciler,
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
): Promise<readonly string[]> => {
  const restored = await storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY);
  try {
    const view = await reconciler.view(restored!.db);
    const attribute = restored!.db.schema.attr(TITLE)!.id;
    const rows = await view.db.datomsArray(Index.AEVT, { a: attribute });
    return rows.filter((datom) => datom.op).map((datom) => String(datom.v)).sort();
  } finally {
    dropped(restored);
  }
};

browserTest(
  "the recorded fixture is still a valid stream under the current codec",
  async () => {

    const response = await fetch("/db/optimistic-fence/replicate", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await response.text()).split("\n").filter((line) => line !== "");
    const frames = lines.map((line) => {
      const decoded = decodeReplicationFrame(line);
      if (Result.isFailure(decoded)) throw decoded.failure;
      return decoded.success;
    });
    expect(frames.map((frame) => frame.type)).toEqual([
      "SnapshotStart",
      ...frames.slice(1, -1).map(() => "SnapshotChunk"),
      "SnapshotCommit",
    ]);

    for (const frame of frames) {
      expect((frame as { readonly identity?: unknown }).identity)
        .toEqual(recorded.identity);
    }
  },
);

const CREDENTIAL = "session-credential";

const recordedFrames = async (root: string) => {
  const response = await fetch(`/db/${root}/replicate`, { method: "POST" });
  expect(response.status).toBe(200);
  return (await response.text()).split("\n").filter((line) => line !== "").map(
    (line) => {
      const decoded = decodeReplicationFrame(line);
      if (Result.isFailure(decoded)) throw decoded.failure;
      return decoded.success;
    },
  );
};

const installRecorded = async (
  storage: IndexedDbReplicaStorage,
  root: string,
): Promise<void> => {
  for (const frame of await recordedFrames("optimistic-fence")) {
    if (frame.type === "SnapshotStart") await storage.startSnapshot(frame);
    else if (frame.type === "SnapshotChunk") await storage.stageSnapshotChunk(frame);
    else if (frame.type === "SnapshotCommit") {
      dropped(await storage.commitSnapshot(frame, ATTRIBUTES));
    } else throw new Error(`the recorded snapshot carries a ${frame.type}`);
  }
  await storage.bindAuthenticated({
    fingerprint: await replicationCredentialFingerprint(
      CREDENTIAL,
      replicationActivationAddress({
        server: globalThis.location.origin,
        root,
        graphPath: [],
      }),
      await rootReplicaRouteSlot(),
    ),
    identity: identity(),
  });
};

const committedNames = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
): Promise<readonly string[]> => {
  const restored = await storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY);
  try {
    const attribute = restored!.db.schema.attr(TITLE)!.id;
    const rows = await restored!.db.datomsArray(Index.AEVT, { a: attribute });
    return rows.filter((datom) => datom.op).map((datom) => String(datom.v)).sort();
  } finally {
    dropped(restored);
  }
};

const committedEid = async (
  storage: IndexedDbReplicaStorage,
  selected: ReplicationIdentity,
): Promise<number> => {
  const restored = await storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY);
  try {
    const attribute = restored!.db.schema.attr(TITLE)!.id;
    const rows = await restored!.db.datomsArray(Index.AEVT, { a: attribute });
    return rows[0]!.e;
  } finally {
    dropped(restored);
  }
};

browserTest(
  "the authoritative outcome replaces the requested optimistic target",
  async ({ browser }) => {
    const database = `ramose-layer-conditional-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left", "server-decided");
      const outbox = storage.outbox();

      const target = await handleFor(receiver, 1);
      const eid = await committedEid(storage, selected);
      const record = await enqueueProjected(storage, receiver, scope, {
        input: { name: "requested" },
        target: { type: "entity", entityId: target },
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog(), {
        entity: (id) => (id === target ? eid : undefined),
      });
      await reconciler.refresh();

      expect(await names(reconciler, storage, selected)).toEqual(["requested"]);

      await outbox.acknowledge(record, {
        _tag: "Committed",
        settled: 1,
        output: { name: "server-decided" },
        mappings: [],
      });
      await reconciler.refresh();
      expect(await names(reconciler, storage, selected)).toEqual(["requested"]);

      await storedSettlement(database, 1);
      const activation = await reconciler.restart();
      await reconciler.outcome(activation)();
      expect(await names(reconciler, storage, selected)).toEqual(["server-decided"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a projection and its invocation become durable in one write",
  async ({ browser }) => {
    const database = `ramose-layer-atomic-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database, testRuntimeBoundaries);
    try {
      await install(storage, selected, "left");
      armCheckpoint("outbox.enqueue", "throw", "cut before the enqueue committed");
      try {
        await expect(enqueueProjected(storage, receiver, scope)).rejects.toThrow(
          /cut before the enqueue/,
        );
      } finally {
        resetTestHooks();
      }

      expect(await rawLayers(database)).toEqual([]);
      expect((await storage.outbox().restore(scope)).records).toEqual([]);

      const record = await enqueueProjected(storage, receiver, scope);
      const rows = await rawLayers(database);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        partition: mutationPartitionKey(receiver),
        sequence: record.sequence,
        invocation: record.invocation,
        projection: PROJECTION,
        state: "queued",
        activation: 0,
      });

      expect(Object.keys(rows[0]!)).not.toContain("changeset");
      expect(JSON.stringify(rows[0])).not.toContain("tx.set");
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "restart reconstructs exactly the same speculative view by native replay",
  async ({ browser }) => {
    const database = `ramose-layer-restart-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    let storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      await enqueueProjected(storage, receiver, scope, {
        input: { name: "first" },
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      await enqueueProjected(storage, receiver, scope, {
        input: { name: "second" },
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      const before = new OptimisticReconciler(storage.outbox(), receiver, catalog());
      await before.refresh();
      const seen = await names(before, storage, selected);
      expect(seen).toEqual(["authoritative", "first", "second"]);

      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      const after = new OptimisticReconciler(storage.outbox(), receiver, catalog("build-b"));
      await after.refresh();
      expect(await names(after, storage, selected)).toEqual(seen);
      expect(after.snapshot().layers.map((layer) => layer.changeset))
        .toEqual(before.snapshot().layers.map((layer) => layer.changeset));

      expect([...after.snapshot().pending.values()].map((entry) => entry.state))
        .toEqual(["queued", "queued"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a commit aliases its client ref and keeps the layer visible until its fence",
  async ({ browser }) => {
    const database = `ramose-layer-alias-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    let storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      const allocation = clientRef();
      const record = await enqueueProjected(storage, receiver, scope, {
        input: { name: "optimistic" },
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      const reconciler = new OptimisticReconciler(
        storage.outbox(),
        receiver,
        catalog(),
      );
      await reconciler.refresh();
      const queued = await names(reconciler, storage, selected);
      expect(queued).toEqual(["authoritative", "optimistic"]);

      const entityId = await handleFor(receiver, 41);
      await storage.outbox().acknowledge(record, {
        _tag: "Committed",
        settled: 1,
        output: null,
        mappings: [{ clientRef: allocation, entityId }],
      });
      await reconciler.refresh();

      expect(await names(reconciler, storage, selected)).toEqual(queued);
      expect(reconciler.snapshot().layers).toMatchObject([
        { invocation: record.invocation, state: "committed-unobserved", activation: 0 },
      ]);
      expect([...reconciler.snapshot().pending.values()].map((entry) => entry.state))
        .toEqual(["committed-unobserved"]);

      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      const restarted = new OptimisticReconciler(storage.outbox(), receiver, catalog());
      await restarted.refresh();
      expect(await names(restarted, storage, selected)).toEqual(queued);
      expect(restarted.snapshot().layers).toMatchObject([
        { state: "committed-unobserved" },
      ]);

      await storedSettlement(database, 1);
      const activation = await restarted.restart();
      expect(activation).toBe(1);
      await restarted.outcome(activation)();
      expect(restarted.snapshot().layers).toEqual([]);
      expect(await rawLayers(database)).toEqual([]);
      expect((await storage.outbox().receipt(receiver, record.invocation))?.observation)
        .toBe("observed");
      expect(await names(restarted, storage, selected)).toEqual(["authoritative"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "the fence removes only the layers its own activation covers",
  async ({ browser }) => {
    const database = `ramose-layer-fence-window-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      const outbox = storage.outbox();
      const commit = async (value: string) => {
        const record = await enqueueProjected(storage, receiver, scope, {
          input: { name: value },
          allocations: [{ slot: "issue", clientRef: clientRef() }],
        });
        await outbox.acknowledge(record, {
          _tag: "Committed",
          settled: record.sequence,
          output: null,
          mappings: [{
            clientRef: record.allocations[0]!.clientRef,
            entityId: await handleFor(receiver, record.sequence + 100),
          }],
        });
        return record;
      };
      const early = await commit("early");
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
      const activation = await reconciler.restart();

      const late = await commit("late");
      await reconciler.refresh();
      expect(reconciler.snapshot().layers).toHaveLength(2);

      await storedSettlement(database, early.sequence);
      await reconciler.outcome(activation)();
      expect(reconciler.snapshot().layers.map((layer) => layer.invocation))
        .toEqual([late.invocation]);
      expect((await outbox.receipt(receiver, early.invocation))?.observation)
        .toBe("observed");
      expect((await outbox.receipt(receiver, late.invocation))?.observation)
        .toBe("unobserved");
      expect(await names(reconciler, storage, selected))
        .toEqual(["authoritative", "late"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a crash inside the fence transaction changes nothing and the retry converges",
  async ({ browser }) => {
    const database = `ramose-layer-fence-cut-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database, testRuntimeBoundaries);
    try {
      await install(storage, selected, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await enqueueProjected(storage, receiver, scope, {
        input: { name: "in-flight" },
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      await outbox.acknowledge(record, {
        _tag: "Committed",
        settled: 1,
        output: null,
        mappings: [{ clientRef: allocation, entityId: await handleFor(receiver, 7) }],
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
      const activation = await reconciler.restart();

      armCheckpoint("outbox.fence", "throw", "cut inside the fence transaction");
      try {
        await expect(reconciler.outcome(activation)()).rejects.toThrow(
          /cut inside the fence/,
        );
      } finally {
        resetTestHooks();
      }

      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("unobserved");
      expect(await rawLayers(database)).toHaveLength(1);

      await storedSettlement(database, 1);
      await reconciler.outcome(activation)();
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("observed");
      expect(await rawLayers(database)).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "the fence confirms the authoritative replica before it removes anything",
  async ({ browser }) => {
    const database = `ramose-layer-confirm-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await enqueueProjected(storage, receiver, scope, {
        input: { name: "still-optimistic" },
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      await outbox.acknowledge(record, {
        _tag: "Committed",
        settled: 1,
        output: null,
        mappings: [{ clientRef: allocation, entityId: await handleFor(receiver, 21) }],
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
      const activation = await reconciler.restart();

      await storage.evictDatabase(receiver);
      expect(await revisionOf(storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY)))
        .toBeUndefined();
      await expect(reconciler.outcome(activation)()).rejects.toMatchObject({
        _tag: "OutboxRecordInvalid",
      });
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("unobserved");
      expect(await rawLayers(database)).toHaveLength(1);

      await install(storage, selected, "left", "reinstalled");
      await storedSettlement(database, 1);
      await reconciler.outcome(activation)();
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("observed");
      expect(await rawLayers(database)).toEqual([]);
      expect(reconciler.snapshot().layers).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a rejection removes exactly its layer and the later ones replay at once",
  async ({ browser }) => {
    const database = `ramose-layer-reject-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    let storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      const outbox = storage.outbox();
      const first = await enqueueProjected(storage, receiver, scope, {
        input: { name: "doomed" },
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      const second = await enqueueProjected(storage, receiver, scope, {
        input: { name: "unrelated" },
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
      await reconciler.refresh();
      expect(await names(reconciler, storage, selected))
        .toEqual(["authoritative", "doomed", "unrelated"]);

      await outbox.acknowledge(first, { _tag: "Rejected", code: "operation_rejected" });

      await reconciler.reconcile([{
        partition: mutationPartitionKey(receiver),
        receiver,
        state: { _tag: "Rejected", invocation: first.invocation, code: "operation_rejected" },
      }]);
      expect(reconciler.snapshot().layers.map((layer) => layer.invocation))
        .toEqual([second.invocation]);
      expect(await names(reconciler, storage, selected))
        .toEqual(["authoritative", "unrelated"]);

      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      const restarted = new OptimisticReconciler(storage.outbox(), receiver, catalog());
      await restarted.refresh();
      expect(restarted.snapshot().layers.map((layer) => layer.invocation))
        .toEqual([second.invocation]);
      expect(await names(restarted, storage, selected))
        .toEqual(["authoritative", "unrelated"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "projection identity drift is typed update-required with the replica intact",
  async ({ browser }) => {
    const database = `ramose-layer-drift-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      await enqueueProjected(storage, receiver, scope, {
        input: { name: "queued" },
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      const drifted = new OptimisticReconciler(
        storage.outbox(),
        receiver,

        catalog("build-a", 4),
      );
      await drifted.refresh();
      expect(drifted.snapshot().updateRequired)
        .toMatchObject([{ reason: "projection-revision" }]);

      expect(drifted.snapshot().layers).toEqual([]);
      expect(drifted.snapshot().pending.size).toBe(0);
      expect(JSON.stringify(drifted.snapshot().updateRequired)).not.toContain("queued");

      expect(await revisionOf(storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY)))
        .toBe("revision-left".padEnd(43, "0"));
      expect(await names(drifted, storage, selected)).toEqual(["authoritative"]);
      expect(await rawLayers(database)).toHaveLength(1);

      const compatible = new OptimisticReconciler(storage.outbox(), receiver, catalog());
      await compatible.refresh();
      expect(compatible.snapshot().updateRequired).toEqual([]);
      expect(await names(compatible, storage, selected))
        .toEqual(["authoritative", "queued"]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a scoped clear removes the layers with the replicas, and close does not",
  async ({ browser }) => {
    const database = `ramose-layer-clear-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    let storage = await IndexedDbReplicaStorage.open(database);
    try {
      await install(storage, selected, "left");
      await enqueueProjected(storage, receiver, scope, {
        allocations: [{ slot: "issue", clientRef: clientRef() }],
      });
      expect(await rawLayers(database)).toHaveLength(1);

      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      expect(await rawLayers(database)).toHaveLength(1);

      const outcome = await storage.clearScope(scope);
      expect(outcome.layers).toBe(1);
      expect(await rawLayers(database)).toEqual([]);
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "the session's own settled frame drives the durable fence end to end",
  async ({ browser }) => {
    const database = `ramose-layer-session-join-${browser.uniqueId}`;
    const selected = identity();
    const receiver = replicaDatabaseScopeOf(selected);
    const scope = replicaScopeOf(selected);
    const storage = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await confirm(storage, selected, "left");
      const outbox = storage.outbox();
      const allocation = clientRef();
      const record = await enqueueProjected(storage, receiver, scope, {
        input: { name: "committed-unobserved" },
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      await outbox.acknowledge(record, {
        _tag: "Committed",
        settled: 1,
        output: null,
        mappings: [{ clientRef: allocation, entityId: await handleFor(receiver, 12) }],
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());

      const activation = await reconciler.restart();
      expect(activation).toBe(1);
      expect(reconciler.snapshot().layers).toMatchObject([
        { state: "committed-unobserved", activation: 0 },
      ]);

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence",
          graphPath: [],
        },
        credential: "session-credential",
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
        onActivationOutcome: reconciler.outcome(activation),
      });

      const fenced = new Promise<void>((resolve, reject) => {
        const stop = reconciler.observe((state) => {
          if (state.layers.length === 0 || state.layers[0]?.state === "retired") {
            stop();
            resolve();
          }
        });
        session!.observe((snapshot) => {
          if (snapshot.status === "failed" || snapshot.status === "terminal") {
            stop();
            reject(new Error(`session ${snapshot.status}`));
          }
        });
      });
      await fenced;

      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("observed");
      expect(reconciler.snapshot().layers).toMatchObject([{ state: "retired" }]);
      await storedSettlement(database, 1);
      const covered = await reconciler.restart();
      await reconciler.outcome(covered)();
      expect(await rawLayers(database)).toEqual([]);
      expect(reconciler.snapshot().layers).toEqual([]);

      const authoritative = await committedNames(storage, selected);
      expect(authoritative.length).toBeGreaterThan(0);
      expect(authoritative).not.toContain("committed-unobserved");
      expect(await names(reconciler, storage, selected)).toEqual(authoritative);
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

type PendingFence = {
  readonly storage: IndexedDbReplicaStorage;
  readonly reconciler: OptimisticReconciler;
  readonly invocation: InvocationId;
  readonly receiver: ReplicaDatabaseScope;
  readonly activation: number;
};

const pendingFence = async (
  database: string,
  root: string,
): Promise<PendingFence> => {
  const selected = identity();
  const receiver = replicaDatabaseScopeOf(selected);
  const scope = replicaScopeOf(selected);
  const storage = await IndexedDbReplicaStorage.open(database);
  await installRecorded(storage, root);
  const outbox = storage.outbox();
  const allocation = clientRef();
  const record = await enqueueProjected(storage, receiver, scope, {
    input: { name: "committed-unobserved" },
    allocations: [{ slot: "issue", clientRef: allocation }],
  });
  await outbox.acknowledge(record, {
    _tag: "Committed",
    settled: 1,
    output: null,
    mappings: [{ clientRef: allocation, entityId: await handleFor(receiver, 12) }],
  });
  const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
  const activation = await reconciler.restart();
  expect(reconciler.snapshot().layers).toMatchObject([
    { state: "committed-unobserved", activation: 0 },
  ]);
  return { storage, reconciler, invocation: record.invocation, receiver, activation };
};

const fenced = (
  reconciler: OptimisticReconciler,
  session: ReplicationSession,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const stop = reconciler.observe((state) => {
      if (state.layers.length === 0 || state.layers[0]?.state === "retired") {
        stop();
        resolve();
      }
    });
    session.observe((snapshot) => {
      if (snapshot.status === "failed" || snapshot.status === "terminal") {
        stop();
        reject(new Error(`session ${snapshot.status}`));
      }
    });
  });

browserTest(
  "the resume acknowledgement of a restored replica fences its receipt",
  async ({ browser }) => {
    const database = `ramose-layer-resume-fence-${browser.uniqueId}`;
    const root = "optimistic-fence-resume";
    const pending = await pendingFence(database, root);
    const { storage, reconciler, invocation, receiver } = pending;
    let session: ReplicationSession | undefined;
    let refused: ReplicationSession | undefined;
    try {
      refused = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "refuses-credentials",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
        onActivationOutcome: reconciler.outcome(pending.activation),
      });
      await new Promise<void>((resolve) => {
        refused!.observe((snapshot) => {
          if (snapshot.status === "failed") resolve();
        });
      });
      await reconciler.refresh();
      expect(reconciler.snapshot().layers).toMatchObject([
        { state: "committed-unobserved" },
      ]);
      expect((await storage.outbox().receipt(receiver, invocation))?.observation)
        .toBe("unobserved");

      const activation = await reconciler.restart();
      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root,
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
        onActivationOutcome: reconciler.outcome(activation),
      });
      await fenced(reconciler, session);

      expect(session.snapshot()).toMatchObject({
        status: "open",
        value: { revision: recorded.revision, stale: false },
      });
      expect((await storage.outbox().receipt(receiver, invocation))?.observation)
        .toBe("observed");
      await storedSettlement(database, 1);
      const covered = await reconciler.restart();
      await reconciler.outcome(covered)();
      expect(await rawLayers(database)).toEqual([]);
    } finally {
      await refused?.close();
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

const settledSnapshots = (
  session: ReplicationSession,
): { readonly seen: readonly ReplicationSessionSnapshot[]; readonly failed: Promise<void> } => {
  const seen: ReplicationSessionSnapshot[] = [];
  const failed = new Promise<void>((resolve) => {
    session.observe((snapshot) => {
      seen.push(snapshot);
      if (snapshot.status === "failed" || snapshot.status === "terminal") resolve();
    });
  });
  return { seen, failed };
};

const reached = async (name: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (checkpointStatus()[name]?.pending === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`storage did not reach ${name}`);
};

const recordedChange = async (): Promise<Change> => {
  const [frame] = await recordedFrames("optimistic-fence-change");
  if (frame?.type !== "Change") throw new Error("the recorded change is not a Change");
  return frame;
};

browserTest(
  "a resume the durable replica has moved past reconnects instead of publishing fresh",
  async ({ browser }) => {
    const database = `ramose-layer-resume-moved-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database, testRuntimeBoundaries);
    const writer = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await installRecorded(storage, "optimistic-fence-resume");
      const delayed = await recordedChange();
      expect(delayed.from).toBe(recorded.revision);

      armCheckpoint("replica.installing", "wait");
      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence-resume",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const observed = settledSnapshots(session);
      await reached("replica.installing");

      dropped(await writer.applyChange(delayed));
      releaseCheckpoint("replica.installing");
      await observed.failed;

      expect(observed.seen.map((snapshot) => snapshot.status))
        .not.toContain("open");
      for (const snapshot of observed.seen) {
        expect(snapshot.value?.stale).not.toBe(false);
      }
      expect(session.snapshot().status).toBe("failed");
      expect(session.snapshot().value).toBeUndefined();

      const durable = await writer.restore(
        identity(),
        ATTRIBUTES,
        READ_COMPATIBILITY,
      );
      expect(durable?.revision).toBe(delayed.revision);
      expect(durable?.ordinal).toBe(delayed.ordinal);
      durable!.release();
    } finally {
      resetTestHooks();
      await session?.close();
      writer.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

const storedOrdinal = async (
  database: string,
  ordinal?: number,
): Promise<number | undefined> => {
  const connection = await openNative(database);
  const partition = replicaPartitionKey(identity());
  const transaction = connection.transaction(
    ["replica-committed-v1", "replica-committed-heads-v1"],
    ordinal === undefined ? "readonly" : "readwrite",
  );
  const manifests = transaction.objectStore("replica-committed-v1");
  const heads = transaction.objectStore("replica-committed-heads-v1");
  const [manifest, head] = await Promise.all([
    requestResult<Record<string, unknown> | undefined>(manifests.get(partition)),
    requestResult<Record<string, unknown> | undefined>(heads.get(partition)),
  ]);
  if (ordinal !== undefined && manifest !== undefined && head !== undefined) {
    manifests.put({ ...manifest, ordinal });
    heads.put({ ...head, ordinal });
  }
  await transactionDone(transaction);
  connection.close();
  return head?.ordinal as number | undefined;
};

const storedSettlement = async (
  database: string,
  settled?: number,
): Promise<number | undefined> => {
  const connection = await openNative(database);
  const partition = replicaPartitionKey(identity());
  const transaction = connection.transaction(
    ["replica-committed-v1", "replica-committed-heads-v1"],
    settled === undefined ? "readonly" : "readwrite",
  );
  const manifests = transaction.objectStore("replica-committed-v1");
  const heads = transaction.objectStore("replica-committed-heads-v1");
  const [manifest, head] = await Promise.all([
    requestResult<Record<string, unknown> | undefined>(manifests.get(partition)),
    requestResult<Record<string, unknown> | undefined>(heads.get(partition)),
  ]);
  if (settled !== undefined && manifest !== undefined && head !== undefined) {
    manifests.put({ ...manifest, settled });
    heads.put({ ...head, settled });
  }
  await transactionDone(transaction);
  connection.close();
  return head?.settled as number | undefined;
};

browserTest(
  "a change re-reaching the published revision publishes its settlement, not only its ordinal",
  async ({ browser }) => {
    const database = `ramose-layer-change-settlement-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await installRecorded(storage, "optimistic-fence-change");
      const acknowledging = await recordedChange();
      expect(acknowledging.settled).toBeGreaterThan(0);
      dropped(await storage.applyChange(acknowledging));
      expect(await storedSettlement(database)).toBe(acknowledging.settled);

      await storedOrdinal(database, acknowledging.ordinal - 1);
      await storedSettlement(database, 0);
      const behind = await storage.restore(identity(), ATTRIBUTES, READ_COMPATIBILITY);
      expect(behind?.settled).toBe(0);
      behind!.release();

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence-change",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const observed = settledSnapshots(session);
      await observed.failed;

      expect(session.snapshot().value).toMatchObject({
        revision: acknowledging.revision,
        ordinal: acknowledging.ordinal,
        settled: acknowledging.settled,
        stale: false,
      });
      expect(await storedSettlement(database)).toBe(acknowledging.settled);
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

const storedHeadSettlement = async (
  database: string,
  settled: number,
): Promise<void> => {
  const connection = await openNative(database);
  const partition = replicaPartitionKey(identity());
  const transaction = connection.transaction("replica-committed-heads-v1", "readwrite");
  const heads = transaction.objectStore("replica-committed-heads-v1");
  const head = await requestResult<Record<string, unknown> | undefined>(
    heads.get(partition),
  );
  if (head !== undefined) heads.put({ ...head, settled });
  await transactionDone(transaction);
  connection.close();
};

browserTest(
  "an install never regresses a watermark the durable head already carries",
  async ({ browser }) => {
    const database = `ramose-layer-watermark-merge-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database);
    try {
      await installRecorded(storage, "optimistic-fence-change");
      const delayed = await recordedChange();
      expect(delayed.settled).toBe(1);

      await storedHeadSettlement(database, 5);
      expect(await storedSettlement(database)).toBe(5);

      const installed = await storage.applyChange(delayed);
      expect(installed?.revision).toBe(delayed.revision);
      expect(installed?.settled).toBe(5);
      installed?.release();

      expect(await storedSettlement(database)).toBe(5);
      const restored = await storage.restore(identity(), ATTRIBUTES, READ_COMPATIBILITY);
      expect(restored?.settled).toBe(5);
      restored!.release();
    } finally {
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a snapshot the identity has advanced past reconnects instead of being consumed",
  async ({ browser }) => {
    const database = `ramose-layer-snapshot-superseded-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await installRecorded(storage, "optimistic-fence");
      expect(await storage.acknowledgeOrdinal({
        identity: identity(),
        revision: recorded.revision,
        ordinal: 5,
        settled: 0,
      })).toEqual({ ordinal: 5, settled: 0 });
      expect(await storedOrdinal(database)).toBe(5);

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const observed = settledSnapshots(session);
      await observed.failed;

      expect(session.snapshot().status).toBe("failed");
      expect(observed.seen.map((snapshot) => snapshot.status)).not.toContain("open");
      for (const snapshot of observed.seen) {
        expect(snapshot.value?.stale).not.toBe(false);
      }
      expect(await storedOrdinal(database)).toBe(5);
      const held = await storage.restore(identity(), ATTRIBUTES, READ_COMPATIBILITY);
      expect(held?.revision).toBe(recorded.revision);
      expect(held?.ordinal).toBe(5);
      held!.release();
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a change re-reaching the published revision acknowledges its higher ordinal",
  async ({ browser }) => {
    const database = `ramose-layer-change-acknowledge-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await installRecorded(storage, "optimistic-fence-change");
      const acknowledging = await recordedChange();
      dropped(await storage.applyChange(acknowledging));
      expect(await storedOrdinal(database)).toBe(acknowledging.ordinal);

      await storedOrdinal(database, acknowledging.ordinal - 1);
      const behind = await storage.restore(identity(), ATTRIBUTES, READ_COMPATIBILITY);
      expect(behind?.revision).toBe(acknowledging.revision);
      expect(behind?.ordinal).toBe(acknowledging.ordinal - 1);
      behind!.release();

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence-change",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const observed = settledSnapshots(session);
      await observed.failed;

      expect(observed.seen.map((snapshot) => snapshot.status)).toContain("open");
      expect(session.snapshot().value).toMatchObject({
        revision: acknowledging.revision,
        ordinal: acknowledging.ordinal,
        stale: false,
      });
      expect(await storedOrdinal(database)).toBe(acknowledging.ordinal);

      expect(classifyReplicationAdoption(session.snapshot().value, {
        identity: identity(),
        ordinal: acknowledging.ordinal - 1,
      })).toBe("refuse");
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a change the durable replica has already advanced past reconnects at that frame",
  async ({ browser }) => {
    const database = `ramose-layer-change-refused-${browser.uniqueId}`;
    const storage = await IndexedDbReplicaStorage.open(database);
    let session: ReplicationSession | undefined;
    try {
      await installRecorded(storage, "optimistic-fence-change");
      const delayed = await recordedChange();
      expect(await storage.acknowledgeOrdinal({
        identity: identity(),
        revision: recorded.revision,
        ordinal: delayed.ordinal + 1,
        settled: 0,
      })).toEqual({ ordinal: delayed.ordinal + 1, settled: 0 });

      const skipped = await storage.applyChange(delayed);
      expect(skipped?.revision).toBe(recorded.revision);
      expect(skipped?.ordinal).toBe(delayed.ordinal + 1);
      skipped!.release();

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root: "optimistic-fence-change",
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
      });
      const observed = settledSnapshots(session);
      await observed.failed;

      expect(session.snapshot().status).toBe("failed");
      for (const snapshot of observed.seen) {
        expect(snapshot.value?.revision).not.toBe(delayed.revision);
      }
      const durable = await storage.restore(
        identity(),
        ATTRIBUTES,
        READ_COMPATIBILITY,
      );
      expect(durable?.revision).toBe(recorded.revision);
      expect(durable?.ordinal).toBe(delayed.ordinal + 1);
      durable!.release();
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);

browserTest(
  "a change frame continuing the restored revision fences its receipt",
  async ({ browser }) => {
    const database = `ramose-layer-change-fence-${browser.uniqueId}`;
    const root = "optimistic-fence-change";
    const { storage, reconciler, invocation, receiver, activation } =
      await pendingFence(database, root);
    let session: ReplicationSession | undefined;
    try {
      expect(await committedNames(storage, identity()))
        .not.toContain(recorded.change.title);

      session = await ReplicationSession.open({
        activation: {
          server: globalThis.location.origin,
          root,
          graphPath: [],
        },
        credential: CREDENTIAL,
        attributes: ATTRIBUTES,
        readCompatibilityHash: READ_COMPATIBILITY,
        storage,
        onActivationOutcome: reconciler.outcome(activation),
      });
      await fenced(reconciler, session);

      expect(session.snapshot()).toMatchObject({
        status: "open",
        value: { revision: recorded.change.revision, stale: false },
      });
      const authoritative = await committedNames(storage, identity());
      expect(authoritative).toContain(recorded.change.title);
      expect(authoritative).not.toContain("committed-unobserved");
      expect((await storage.outbox().receipt(receiver, invocation))?.observation)
        .toBe("observed");
      await storedSettlement(database, 1);
      await reconciler.refresh();
      expect(await rawLayers(database)).toEqual([]);
      expect(await names(reconciler, storage, identity())).toEqual(authoritative);
    } finally {
      await session?.close();
      storage.close();
      await deleteDatabase(database);
    }
  },
);
