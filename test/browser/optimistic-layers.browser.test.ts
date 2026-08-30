/**
 * Durable optimistic layers and observation-fenced reconciliation (#476 slice 2).
 *
 * Nothing here is simulated. A real Chromium IndexedDB connection with its real
 * transaction and abort semantics, the real sealed entity-id codec over
 * WebCrypto, the real replica installer, the real `ReplicationSession` over a
 * real HTTP response, and the repository's inert runtime boundary armed only to
 * decide where a crash cut lands.
 *
 * The crash-cut matrix each test in the first group covers:
 *
 * | cut                                   | after restart                          |
 * |---|---|
 * | inside the enqueue                    | no layer and no invocation              |
 * | after the acknowledgement, before the fence | the mapped optimistic view, intact |
 * | inside the fence transaction          | nothing observed, nothing removed       |
 * | after a rejection, before the replay   | exactly that layer gone, the rest kept |
 *
 * The frames the session consumes are a *recording* of the real local Worker,
 * regenerated only by `bun run record:frames`; see
 * `test/browser/frames/PROVENANCE.md`. The identity and the client schema are
 * read back from that recording, so nothing here pins a value of its own.
 */

import * as Result from "effect/Result";
import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import { Index } from "../../packages/ramose/src/internal/core/datom.ts";
import { clientRef, invocationId } from "../../packages/ramose/src/db/refs.ts";
import type { ClientRef, EntityId } from "../../packages/ramose/src/db/refs.ts";
import type { ProjectionTx } from "../../packages/ramose/src/db/Projection.ts";
import {
  sealEntityId,
  type EntityIdScope,
} from "../../packages/ramose/src/internal/replication/entity-id.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import type { OutboxDraft } from "../../packages/ramose/src/internal/replication/outbox.ts";
import { mutationPartitionKey } from "../../packages/ramose/src/internal/replication/outbox.ts";
import { makeClientProjectionCatalog } from "../../packages/ramose/src/internal/replication/projection-binding.ts";
import type { ClientProjectionCatalog } from "../../packages/ramose/src/internal/replication/projection-binding.ts";
import { OptimisticReconciler } from "../../packages/ramose/src/internal/replication/reconciliation.ts";
import { ReplicationSession } from "../../packages/ramose/src/internal/replication/session.ts";
import {
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  decodeReplicationFrame,
  type ReplicationIdentity,
} from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  generateServerIdentityRoot,
  sealingKeyOf,
} from "../../packages/ramose/src/internal/replication/server-identity.ts";
import {
  armCheckpoint,
  resetTestHooks,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import recorded from "./frames/optimistic-fence.client.json";
import { browserTest } from "./fixtures.ts";

/**
 * The identity and client schema of the recorded activation.
 *
 * Read from the recording rather than pinned here: the opaque ids are minted by
 * the real local Worker and change whenever `bun run record:frames` is run
 * again, so a test that spelled them out would be a second, silently drifting
 * copy of the fixture.
 */
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

/** A cardinality-one string field the recording actually carries. */
const TITLE = ":conformanceIssue/title";

const version = "b".repeat(64) as OperationVersion;

const operation = {
  catalog: "issues" as never,
  owner: { kind: "entity", name: "issue" } as const,
  localName: "rename",
};

const name = { ident: TITLE, valueType: "string" } as const;

/** The one installed projection. Trusted client-bundle code; never persisted. */
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

/** Raw layer rows, read outside the adapter so nothing is taken on trust. */
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

/** Release a value this test is done with, so no retention outlives it. */
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

/** Confirm the scope and install a real committed replica for it. */
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
    type: "SnapshotStart", protocol: 1, identity: selected, snapshot, revision,
  });
  await storage.stageSnapshotChunk({
    type: "SnapshotChunk",
    protocol: 1,
    identity: selected,
    snapshot,
    index: 0,
    datoms: [{
      entity: "e".repeat(43),
      field: TITLE,
      value: { type: "string", value },
      op: "add",
    }],
  });
  dropped(await storage.commitSnapshot({
    type: "SnapshotCommit", protocol: 1, identity: selected, snapshot, revision, chunks: 1,
  }, ATTRIBUTES));
};

/** Enqueue one invocation together with its optimistic layer. */
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

/** Every `:item/name` the local view holds, sorted. */
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
    // Fetched through the exact path the session uses, and decoded with the
    // product's own frame codec — so a protocol change the recording predates
    // fails here, loudly, instead of silently weakening every test below.
    // Re-record with `bun run record:frames`; never hand-edit the file.
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
    // The recording and its client half describe one activation, not two.
    for (const frame of frames) {
      expect((frame as { readonly identity?: unknown }).identity)
        .toEqual(recorded.identity);
    }
  },
);

/** Every `title` the committed replica alone holds, with no overlay. */
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

/** The committed local id of the one entity the installed snapshot holds. */
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
      // Addressed by a sealed handle this replica already holds, with the
      // handle-to-local-id binding #477 will supply — so the projection writes
      // over the committed row rather than beside it.
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
      // The requested target replaces the committed value, once.
      expect(await names(reconciler, storage, selected)).toEqual(["requested"]);

      // The server decided otherwise. Its answer is already in the replica; the
      // layer keeps the requested value visible until the fence, and then the
      // authoritative one is what stands — no flash in either direction.
      await outbox.acknowledge(record, {
        _tag: "Committed",
        output: { name: "server-decided" },
        mappings: [],
      });
      await reconciler.refresh();
      expect(await names(reconciler, storage, selected)).toEqual(["requested"]);

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
      // Neither half survived: no layer for an invocation that was never
      // queued, and no queued invocation whose layer is missing.
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
      // The durable row holds no executable form of the projection at all.
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

      // A cold restart: this reconciler has never seen an enqueue, and no
      // changeset crossed the restart — the callbacks are resolved from the
      // installed bundle and run again over the stored inputs.
      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      const after = new OptimisticReconciler(storage.outbox(), receiver, catalog("build-b"));
      await after.refresh();
      expect(await names(after, storage, selected)).toEqual(seen);
      expect(after.snapshot().layers.map((layer) => layer.changeset))
        .toEqual(before.snapshot().layers.map((layer) => layer.changeset));
      // The sidecar is derived from the layers, so it comes back too.
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

      // The authoritative receipt lands, with the exact mapping.
      const entityId = await handleFor(receiver, 41);
      await storage.outbox().acknowledge(record, {
        _tag: "Committed",
        output: null,
        mappings: [{ clientRef: allocation, entityId }],
      });
      await reconciler.refresh();
      // No rollback flash: the layer is retained under its new name, the ref is
      // aliased onto the returned handle, and the entity is presented once.
      expect(await names(reconciler, storage, selected)).toEqual(queued);
      expect(reconciler.snapshot().layers).toMatchObject([
        { invocation: record.invocation, state: "committed-unobserved", activation: 0 },
      ]);
      expect([...reconciler.snapshot().pending.values()].map((entry) => entry.state))
        .toEqual(["committed-unobserved"]);

      // A crash after the receipt persisted but before any observation: the
      // same mapped optimistic view comes back.
      storage.close();
      storage = await IndexedDbReplicaStorage.open(database);
      const restarted = new OptimisticReconciler(storage.outbox(), receiver, catalog());
      await restarted.refresh();
      expect(await names(restarted, storage, selected)).toEqual(queued);
      expect(restarted.snapshot().layers).toMatchObject([
        { state: "committed-unobserved" },
      ]);

      // And it converges once a fresh activation observes it.
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
      // Acknowledged *after* this activation opened, so its own output can
      // never prove the server's stream reached it.
      const late = await commit("late");
      await reconciler.refresh();
      expect(reconciler.snapshot().layers).toHaveLength(2);

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
      // Neither the marker nor the layer moved: the transaction is one write.
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("unobserved");
      expect(await rawLayers(database)).toHaveLength(1);

      // The next settled frame on the same activation fences, exactly as the
      // session's own retry would.
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
      // No replication wait, and no dependency graph: the surviving layers are
      // replayed immediately at their new positions.
      await reconciler.reconcile([{
        partition: mutationPartitionKey(receiver),
        receiver,
        state: { _tag: "Rejected", invocation: first.invocation, code: "operation_rejected" },
      }]);
      expect(reconciler.snapshot().layers.map((layer) => layer.invocation))
        .toEqual([second.invocation]);
      expect(await names(reconciler, storage, selected))
        .toEqual(["authoritative", "unrelated"]);

      // A crash between the rejection and the replay converges: the replay is
      // a function of the durable rows, so a restart derives the same view.
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
        // The author rotated the revision: this build must not execute a
        // projection whose author has said it no longer means the same thing.
        catalog("build-a", 4),
      );
      await drifted.refresh();
      expect(drifted.snapshot().updateRequired)
        .toMatchObject([{ reason: "projection-revision" }]);
      // Data-free: no layer is presented and no entity is named.
      expect(drifted.snapshot().layers).toEqual([]);
      expect(drifted.snapshot().pending.size).toBe(0);
      expect(JSON.stringify(drifted.snapshot().updateRequired)).not.toContain("queued");

      // The committed replica is untouched, and the durable rows are kept.
      expect(await revisionOf(storage.restore(selected, ATTRIBUTES, READ_COMPATIBILITY)))
        .toBe("revision-left".padEnd(43, "0"));
      expect(await names(drifted, storage, selected)).toEqual(["authoritative"]);
      expect(await rawLayers(database)).toHaveLength(1);

      // A build that installs the matching revision again replays them.
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

      // `client.close()` never deletes anything.
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
        output: null,
        mappings: [{ clientRef: allocation, entityId: await handleFor(receiver, 12) }],
      });
      const reconciler = new OptimisticReconciler(outbox, receiver, catalog());
      // Close the prior generation, claim the counter, then open the fresh
      // activation with the driver's own hook. This is the whole composition.
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
      // Waited on the *fence*, not on the session's own status: the session
      // publishes `open` before it invokes the hook, so asserting on the status
      // would race the very transaction under test.
      const fenced = new Promise<void>((resolve, reject) => {
        const stop = reconciler.observe((state) => {
          if (state.layers.length === 0) {
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

      // The session installed the authoritative snapshot and invoked the hook
      // on its own settled `SnapshotCommit`; the hook ran the reconciliation
      // transaction against real IndexedDB.
      expect((await outbox.receipt(receiver, record.invocation))?.observation)
        .toBe("observed");
      expect(await rawLayers(database)).toEqual([]);
      expect(reconciler.snapshot().layers).toEqual([]);
      // What stands is exactly the authoritative snapshot the recording carried
      // — compared against the committed replica itself rather than a pinned
      // list, so re-recording against a different world stays honest.
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
