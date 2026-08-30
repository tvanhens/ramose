import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import { SubmissionLoop } from "../../packages/ramose/src/client/submission.ts";
import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../../packages/ramose/src/internal/replication/leadership.ts";
import type { OutboxDraft } from "../../packages/ramose/src/internal/replication/outbox.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
import {
  REPLICA_GENERATIONS_STORE,
  replicaDatabaseScopeOf,
  replicaScopeOf,
  type ReplicaDatabaseScope,
} from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { browserTest } from "./fixtures.ts";
import type { TabReport } from "./leadership-tab.ts";
import { openTab, type TabHandle } from "./tab-harness.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";

const tabModule = new URL("./leadership-tab.ts", import.meta.url).href;

const opaque = (character: string): string => character.repeat(43);

const SERVER = opaque("s");
const PRINCIPAL = opaque("l");
const ROOT_DATABASE = opaque("d");
const READ_COMPATIBILITY = ReadCompatibilityHash.make(opaque("k"));
const REPLICA_ATTRIBUTES: readonly AttributeSpec[] = [
  { ident: ":item/name", valueType: ":db.type/string", index: true },
];

const identity = (
  overrides: Partial<ReplicationIdentity> = {},
): ReplicationIdentity => ({
  version: 1,
  server: SERVER,
  principal: PRINCIPAL,
  database: ROOT_DATABASE,
  catalog: opaque("c"),
  readView: opaque("v"),
  readCompatibilityHash: READ_COMPATIBILITY,
  graphLineage: [],
  authenticator: opaque("a"),
  ...overrides,
});

const draft = (receiver: ReplicaDatabaseScope): OutboxDraft => ({
  invocation: invocationId(),
  receiver,
  operation: {
    catalog: "movies" as never,
    owner: { kind: "entity", name: "issue" },
    localName: "create",
  },
  operationVersion: "b".repeat(64) as OperationVersion,
  target: { type: "none" },
  input: { title: "offline" },
  allocations: [],
  inputRefs: [],
  enqueuedAt: Date.now(),
});

const COMMITTED = {
  _tag: "Committed",
  output: { id: "opaque" },
  mappings: [],
} as const;

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
  });

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => resolve(), { once: true });
    request.addEventListener("blocked", () => resolve(), { once: true });
  });

const dumpStore = async (name: string, store: string): Promise<unknown[]> => {
  const database = await openNative(name);
  const transaction = database.transaction(store, "readonly");
  const records = await requestResult<unknown[]>(
    transaction.objectStore(store).getAll(),
  );
  await transactionDone(transaction);
  database.close();
  return records;
};

const receiptStates = async (name: string): Promise<readonly string[]> =>
  (await dumpStore(name, "mutation-receipts-v1") as readonly {
    readonly state: string;
  }[]).map((receipt) => receipt.state).sort();

/** A database id of the shape the protocol uses, unique to one test. */
const databaseOf = (uniqueId: string): string =>
  uniqueId.replaceAll("-", "").padEnd(43, "z").slice(0, 43);

/** The durable leadership epoch, read outside every participant. */
const durableEpoch = async (name: string, key: string): Promise<number> => {
  const records = await dumpStore(name, REPLICA_GENERATIONS_STORE) as readonly {
    readonly key: string;
    readonly kind: string;
    readonly generation: number;
  }[];
  const record = records.find((entry) => entry.key === key);
  if (record === undefined) return 0;
  expect(record.kind).toBe("leader");
  return record.generation;
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
  const snapshot = `snapshot-${label}`.padEnd(43, "0");
  const revision = `revision-${label}`.padEnd(43, "0");
  await storage.startSnapshot({
    type: "SnapshotStart",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk",
    protocol: 1,
    identity: selected,
    snapshot,
    index: 0,
    datoms: [{
      entity: `entity-${label}`.padEnd(43, "0"),
      field: ":item/name",
      value: { type: "string", value: label },
      op: "add",
    }],
  }));
  const installed = await storage.commitSnapshot({
    type: "SnapshotCommit",
    protocol: 1,
    identity: selected,
    snapshot,
    revision,
    chunks: 1,
  }, REPLICA_ATTRIBUTES);
  installed?.release();
};

const until = async <A>(
  probe: () => Promise<A>,
  ready: (value: A) => boolean,
  label: string,
): Promise<A> => {
  const deadline = performance.now() + 4_000;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const stand = async (
  tab: TabHandle,
  storageName: string,
  scope: ReplicaDatabaseScope,
): Promise<TabReport> => tab.call<TabReport>("stand", { storageName, scope });

const leading = (tab: TabHandle): Promise<TabReport> =>
  until(
    () => tab.call<TabReport>("report"),
    (report) => report.status === "leading",
    "leadership",
  );

browserTest("two tabs of one scope elect exactly one leader", async ({ browser }) => {
  const name = `ramose-leadership-elect-${browser.uniqueId}`;
  const scope = replicaDatabaseScopeOf(identity({ database: databaseOf(browser.uniqueId) }));
  const first = await openTab(tabModule);
  const second = await openTab(tabModule);
  try {
    const led = await stand(first, name, scope);
    const queued = await stand(second, name, scope);

    // Neither tab was told the name: both derived it from the scope.
    expect(led.key).toBe(replicaLeaderKey(scope));
    expect(queued.key).toBe(led.key);

    const elected = await leading(first);
    expect(elected.epoch).toBe(1);
    expect(await durableEpoch(name, led.key)).toBe(1);

    // The second tab stays a waiting follower for as long as we watch it.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const report = await second.call<TabReport>("report");
      expect([report.status, report.submits, report.epoch]).toEqual([
        "waiting",
        false,
        undefined,
      ]);
    }
    expect(queued.status).toBe("waiting");
  } finally {
    await first.close();
    await second.close();
    await deleteDatabase(name);
  }
});

browserTest("a closing leader hands leadership to a waiting tab", async ({ browser }) => {
  const name = `ramose-leadership-close-${browser.uniqueId}`;
  const scope = replicaDatabaseScopeOf(identity({ database: databaseOf(browser.uniqueId) }));
  const first = await openTab(tabModule);
  const second = await openTab(tabModule);
  try {
    await stand(first, name, scope);
    await leading(first);
    await stand(second, name, scope);
    const key = replicaLeaderKey(scope);

    const started = performance.now();
    const closed = await first.call<TabReport>("release");
    expect([closed.status, closed.submits, closed.epoch]).toEqual([
      "released",
      false,
      undefined,
    ]);

    const took = await leading(second);
    // No expiry to wait out: the release itself grants the queued request.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(took.epoch).toBe(2);
    expect(await durableEpoch(name, key)).toBe(2);
  } finally {
    await first.close();
    await second.close();
    await deleteDatabase(name);
  }
});

browserTest("a crashed leader releases leadership to a waiting tab", async ({ browser }) => {
  const name = `ramose-leadership-crash-${browser.uniqueId}`;
  const scope = replicaDatabaseScopeOf(identity({ database: databaseOf(browser.uniqueId) }));
  const first = await openTab(tabModule);
  const second = await openTab(tabModule);
  try {
    await stand(first, name, scope);
    await leading(first);
    await stand(second, name, scope);
    expect((await second.call<TabReport>("report")).status).toBe("waiting");

    // The tab dies with no chance to release anything.
    first.crash();

    const took = await leading(second);
    expect(took.epoch).toBe(2);
    expect(took.submits).toBe(true);
    expect(await durableEpoch(name, replicaLeaderKey(scope))).toBe(2);
  } finally {
    await second.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a deposed leader's acknowledgement fails its epoch fence and its successor completes the work",
  async ({ browser }) => {
    const name = `ramose-leadership-fence-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver);
    const deposed = await IndexedDbReplicaStorage.open(name);
    const successor = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(deposed, left, "left");
      const queued = await deposed.outbox().enqueue(draft(receiver), { scope });
      const decoyed = await deposed.outbox().enqueue(draft(receiver), { scope });

      expect(await deposed.claimLeadership(key, scope)).toBe(1);
      const submitting = deposed.outbox(() => ({ key, epoch: 1 }));

      // Another tab takes over while this submission is in flight.
      expect(await successor.claimLeadership(key, scope)).toBe(2);

      await expect(submitting.acknowledge(queued, COMMITTED, 1_700_000_000_001))
        .rejects.toMatchObject({
          _tag: "ReplicaFencedError",
          key,
          expected: 1,
          observed: 2,
        });
      expect(await receiptStates(name)).toEqual(["queued", "queued"]);
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(2);

      // The same acknowledgement under the successor's epoch lands, so the
      // fence refused the writer rather than the write.
      const receipt = await successor
        .outbox(() => ({ key, epoch: 2 }))
        .acknowledge(queued, COMMITTED, 1_700_000_000_002);
      expect(receipt.state).toBe("committed");
      expect(await receiptStates(name)).toEqual(["committed", "queued"]);

      // Decoy: a submitter with no epoch to validate lands the write the
      // fence refused, so the fence is what stopped it.
      const unfenced = await deposed.outbox()
        .acknowledge(decoyed, COMMITTED, 1_700_000_000_003);
      expect(unfenced.state).toBe("committed");
      expect(await receiptStates(name)).toEqual(["committed", "committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      deposed.close();
      successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a follower keeps enqueuing durably and submits nothing",
  async ({ browser }) => {
    const name = `ramose-leadership-gate-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver);
    const storage = await IndexedDbReplicaStorage.open(name);
    const leader = SyncLeadership.begin({
      name: key,
      locks: platformLocks(),
      claim: () => storage.claimLeadership(key, scope),
      onLeading: () => undefined,
    });
    const follower = SyncLeadership.begin({
      name: key,
      locks: platformLocks(),
      claim: () => storage.claimLeadership(key, scope),
      onLeading: () => undefined,
    });
    const loops: SubmissionLoop[] = [];
    try {
      await confirm(storage, left, "left");
      await until(
        async () => leader.status(),
        (status) => status === "leading",
        "leadership",
      );
      expect(follower.submits()).toBe(false);

      let credentials = 0;
      const loopFor = (leadership: SyncLeadership): SubmissionLoop => {
        const loop = new SubmissionLoop({
          storage: () => Promise.resolve(storage),
          leadership: () => leadership,
          credential: () => {
            credentials++;
            return Promise.resolve({ token: "token", cacheKey: "cache" });
          },
          endpoint: () => undefined,
          reconcile: () => Promise.resolve(),
          live: () => true,
        });
        loops.push(loop);
        return loop;
      };

      // The follower enqueues durably, exactly as a leader would.
      await storage.outbox().enqueue(draft(receiver), { scope });
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(1);

      loopFor(follower).request(scope);
      await loops[0]!.settled();
      expect(credentials).toBe(0);
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(1);

      loopFor(leader).request(scope);
      await loops[1]!.settled();
      expect(credentials).toBe(1);
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(1);
    } finally {
      for (const loop of loops) loop.close();
      await leader.release();
      await follower.release();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "two unelected clients on one storage name converge without a duplicate commit",
  async ({ browser }) => {
    const name = `ramose-leadership-degraded-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const first = await IndexedDbReplicaStorage.open(name);
    const second = await IndexedDbReplicaStorage.open(name);
    // Without Web Locks there is no election: every client submits for itself.
    const unelected = [first, second].map((storage) =>
      SyncLeadership.begin({
        name: replicaLeaderKey(receiver),
        locks: undefined,
        claim: () => storage.claimLeadership(replicaLeaderKey(receiver), scope),
        onLeading: () => undefined,
      })
    );
    try {
      await confirm(first, left, "left");
      for (const leadership of unelected) {
        expect([leadership.status(), leadership.submits(), leadership.fence()])
          .toEqual(["unelected", true, undefined]);
      }

      const intent = draft(receiver);
      const queued = await first.outbox(() => unelected[0]!.fence())
        .enqueue(intent, { scope });
      const again = await second.outbox(() => unelected[1]!.fence())
        .enqueue(intent, { scope });
      expect(again).toEqual(queued);
      expect((await dumpStore(name, "mutation-outbox-v1")).length).toBe(1);

      const [one, other] = await Promise.all([
        first.outbox(() => unelected[0]!.fence())
          .acknowledge(queued, COMMITTED, 1_700_000_000_001),
        second.outbox(() => unelected[1]!.fence())
          .acknowledge(queued, COMMITTED, 1_700_000_000_001),
      ]);
      expect(one).toEqual(other);
      expect(await dumpStore(name, "mutation-receipts-v1")).toEqual([one]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      for (const leadership of unelected) await leadership.release();
      first.close();
      second.close();
      await deleteDatabase(name);
    }
  },
);
