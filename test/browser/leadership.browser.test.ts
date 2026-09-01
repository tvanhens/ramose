import { expect } from "vitest";
import { ReadCompatibilityHash } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { OperationVersion } from "../../packages/ramose/src/internal/authorization/identities.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import { clientRef, invocationId } from "../../packages/ramose/src/db/refs.ts";
import type { EntityId } from "../../packages/ramose/src/db/refs.ts";
import { SubmissionLoop } from "../../packages/ramose/src/client/submission.ts";
import {
  IndexedDbReplicaStorage,
  REPLICA_DATABASE_VERSION,
} from "../../packages/ramose/src/internal/replication/indexeddb.ts";
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
import type { Settlement, TabReport } from "./leadership-tab.ts";
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
  authenticator: opaque("a"),
  ...overrides,
});

const draft = (
  receiver: ReplicaDatabaseScope,
  overrides: Partial<OutboxDraft> = {},
): OutboxDraft => ({
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
  ...overrides,
});

const COMMITTED = {
  _tag: "Committed",
  settled: 1,
  output: { id: "opaque" },
  mappings: [],
} as const;

const MAPPED = `${"e".repeat(54)}A` as EntityId;

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

const openVersioned = (name: string, version: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("upgrade blocked")), {
      once: true,
    });
  });

const lockHeld = async (key: string): Promise<boolean> => {
  let granted = false;
  await navigator.locks.request(key, { ifAvailable: true }, (lock) => {
    granted = lock !== null;
  });
  return !granted;
};

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

const unobservedIds = (
  state: { readonly unobserved: readonly { readonly invocation: string }[] },
): readonly string[] => state.unobserved.map((marker) => marker.invocation);

const receiptStates = async (name: string): Promise<readonly string[]> =>
  (await dumpStore(name, "mutation-receipts-v1") as readonly {
    readonly state: string;
  }[]).map((receipt) => receipt.state).sort();

const databaseOf = (uniqueId: string): string =>
  uniqueId.replaceAll("-", "").padEnd(43, "z").slice(0, 43);

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
    protocol: 4,
    identity: selected,
    snapshot,
    revision,
  });
  await storage.stageSnapshotChunk(snapshotChunk({
    type: "SnapshotChunk",
    protocol: 4,
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
    protocol: 4,
    identity: selected,
    snapshot,
    revision,
    ordinal: 1,
    settled: 0,
    chunks: 1,
  }, REPLICA_ATTRIBUTES);
  installed?.release();
};

const until = async <A>(
  probe: () => Promise<A>,
  ready: (value: A) => boolean,
  label: string,
  budget = 10_000,
): Promise<A> => {
  const deadline = performance.now() + budget;
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

const leading = (tab: TabHandle, label = "leadership"): Promise<TabReport> =>
  until(
    () => tab.call<TabReport>("report"),
    (report) => report.status === "leading",
    label,
  );

browserTest("two tabs of one scope elect exactly one leader", async ({ browser }) => {
  const name = `ramose-leadership-elect-${browser.uniqueId}`;
  const scope = replicaDatabaseScopeOf(identity({ database: databaseOf(browser.uniqueId) }));
  const first = await openTab(tabModule);
  const second = await openTab(tabModule);
  try {
    const led = await stand(first, name, scope);
    const queued = await stand(second, name, scope);

    expect(led.key).toBe(replicaLeaderKey(scope, name));
    expect(queued.key).toBe(led.key);
    expect(queued.status).toBe("waiting");

    const elected = await leading(first);
    expect(elected.epoch).toBe(1);
    expect(await durableEpoch(name, led.key)).toBe(1);

    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const report = await second.call<TabReport>("report");
      expect([report.status, report.submits, report.epoch]).toEqual([
        "waiting",
        false,
        undefined,
      ]);
    }
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
    const key = replicaLeaderKey(scope, name);

    const started = performance.now();
    const closed = await first.call<TabReport>("release");
    expect([closed.status, closed.submits, closed.epoch]).toEqual([
      "released",
      false,
      undefined,
    ]);

    const took = await leading(second);
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

    first.crash();

    const took = await leading(second);
    expect(took.epoch).toBe(2);
    expect(took.submits).toBe(true);
    expect(await durableEpoch(name, replicaLeaderKey(scope, name))).toBe(2);
  } finally {
    await second.close();
    await deleteDatabase(name);
  }
});

browserTest(
  "a leader that cannot record its epoch stands again once storage recovers",
  async ({ browser }) => {
    const name = `ramose-leadership-claim-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const key = replicaLeaderKey(replicaDatabaseScopeOf(left), name);
    const scope = replicaScopeOf(left);
    let storage = await IndexedDbReplicaStorage.open(name);
    storage.close();
    const leadership = SyncLeadership.begin({
      name: key,
      locks: platformLocks(),
      claim: () => storage.claimLeadership(key, scope),
      onLeading: () => undefined,
    });
    try {
      await until(
        () => lockHeld(key),
        (isHeld) => !isHeld,
        "the ungranted lock to go back",
      );
      expect([leadership.status(), leadership.submits()]).toEqual([
        "waiting",
        false,
      ]);

      storage = await IndexedDbReplicaStorage.open(name);
      await until(
        () => Promise.resolve(leadership.status()),
        (status) => status === "leading",
        "leadership after storage recovers",
      );
      expect(leadership.fence()?.epoch).toBe(1);
      expect(await durableEpoch(name, key)).toBe(1);
    } finally {
      await leadership.release();
      storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader whose storage another version closes gives the lock up",
  async ({ browser }) => {
    const name = `ramose-leadership-invalidated-${browser.uniqueId}`;
    const scope = replicaDatabaseScopeOf(identity({
      database: databaseOf(browser.uniqueId),
    }));
    const tab = await openTab(tabModule);
    let upgraded: IDBDatabase | undefined;
    try {
      await stand(tab, name, scope);
      await leading(tab);

      upgraded = await openVersioned(name, REPLICA_DATABASE_VERSION + 1);

      const released = await until(
        () => tab.call<TabReport>("report"),
        (report) => report.status === "released",
        "the invalidated leader to stand down",
      );
      expect(released.submits).toBe(false);
      await until(
        () => lockHeld(replicaLeaderKey(scope, name)),
        (isHeld) => !isHeld,
        "the leadership lock to be free",
      );
    } finally {
      upgraded?.close();
      await tab.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a deposed leader's acknowledgement fails its epoch fence and its successor completes the work",
  async ({ browser }) => {
    const name = `ramose-leadership-fence-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const deposed = await IndexedDbReplicaStorage.open(name);
    const successor = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(deposed, left, "left");
      const queued = await deposed.outbox().enqueue(draft(receiver), { scope });
      const decoyed = await deposed.outbox().enqueue(draft(receiver), { scope });

      expect(await deposed.claimLeadership(key, scope)).toBe(1);
      const submitting = deposed.outbox(() => ({ key, epoch: 1 }));

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

      const receipt = await successor
        .outbox(() => ({ key, epoch: 2 }))
        .acknowledge(queued, COMMITTED, 1_700_000_000_002);
      expect(receipt.state).toBe("committed");
      expect(await receiptStates(name)).toEqual(["committed", "queued"]);

      const unfenced = await deposed.outbox()
        .acknowledge(decoyed, { ...COMMITTED, settled: 2 }, 1_700_000_000_003);
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
    const key = replicaLeaderKey(receiver, name);
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
          resolve: () => undefined,
          retire: () => undefined,
          revalidate: () => Promise.resolve(),
          reconcile: () => Promise.resolve(),
          live: () => true,
        });
        loops.push(loop);
        return loop;
      };

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
    const unelected = [first, second].map((storage) =>
      SyncLeadership.begin({
        name: replicaLeaderKey(receiver, name),
        locks: undefined,
        claim: () => storage.claimLeadership(replicaLeaderKey(receiver, name), scope),
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

browserTest(
  "a storm of unelected clients still commits one invocation once",
  async ({ browser }) => {
    const name = `ramose-leadership-degraded-storm-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const clients = await Promise.all(
      Array.from({ length: 8 }, () => IndexedDbReplicaStorage.open(name)),
    );
    const unelected = clients.map((storage) =>
      SyncLeadership.begin({
        name: key,
        locks: undefined,
        claim: () => storage.claimLeadership(key, scope),
        onLeading: () => undefined,
      })
    );
    try {
      await confirm(clients[0]!, left, "left");
      for (const leadership of unelected) {
        expect([leadership.status(), leadership.submits(), leadership.fence()])
          .toEqual(["unelected", true, undefined]);
      }
      const outboxes = clients.map((storage, index) =>
        storage.outbox(() => unelected[index]!.fence())
      );

      const allocation = clientRef();
      const intent = draft(receiver, {
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      const queued = await Promise.all(
        outboxes.map((outbox) => outbox.enqueue(intent, { scope })),
      );
      for (const record of queued) expect(record).toEqual(queued[0]!);
      expect(await dumpStore(name, "mutation-outbox-v1")).toHaveLength(1);
      expect(await dumpStore(name, "mutation-client-refs-v1")).toHaveLength(1);

      const settled = await Promise.all(
        outboxes.map((outbox) =>
          outbox.acknowledge(queued[0]!, {
            ...COMMITTED,
            mappings: [{ clientRef: allocation, entityId: MAPPED }],
          }, 1_700_000_000_001)
        ),
      );
      for (const receipt of settled) expect(receipt).toEqual(settled[0]!);
      expect(settled[0]!.state).toBe("committed");
      expect(await dumpStore(name, "mutation-receipts-v1")).toEqual([settled[0]]);
      expect(await dumpStore(name, "mutation-client-ref-mappings-v1"))
        .toHaveLength(1);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      for (const leadership of unelected) await leadership.release();
      for (const storage of clients) storage.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader whose epoch no longer fences stands down and the queued tab leads",
  async ({ browser }) => {
    const name = `ramose-leadership-stand-down-${browser.uniqueId}`;
    const scope = replicaDatabaseScopeOf(
      identity({ database: databaseOf(browser.uniqueId) }),
    );
    const deposed = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(deposed, name, scope);
      expect((await leading(deposed)).epoch).toBe(1);
      await stand(successor, name, scope);

      const stood = await deposed.call<TabReport>("standDown");
      expect([stood.status, stood.submits, stood.epoch])
        .toEqual(["waiting", false, undefined]);

      const took = await leading(successor, "the successor to take the epoch");
      expect(took.epoch).toBe(2);
      expect(await durableEpoch(name, took.key)).toBe(2);

      await successor.call<TabReport>("release");
      const again = await leading(deposed, "the tab that stood down to lead again");
      expect(again.epoch).toBe(3);
      expect(await durableEpoch(name, again.key)).toBe(3);
    } finally {
      await deposed.close();
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed inside its acknowledgement leaves the work for its successor",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-ack-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      expect(await crashing.call<number>("enqueue", {
        scope: receiver,
        drafts: [draft(receiver)],
      })).toBe(1);

      const invocation = await crashing.call<string>("stallAcknowledgement", {
        scope: receiver,
      });
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);

      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const submitting = settling.outbox(() => ({ key, epoch: 2 }));
        const { plans } = await submitting.submissionPlan(scope);
        const head = plans[0]?.head ?? { type: "empty" as const };
        if (head.type === "ready") {
          expect(head.record.invocation).toBe(invocation);
          expect(
            (await submitting.acknowledge(head.record, COMMITTED, 1_700_000_000_002))
              .state,
          ).toBe("committed");
        } else {
          expect(head.type).toBe("empty");
        }
      } finally {
        settling.close();
      }
      expect(await receiptStates(name)).toEqual(["committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed while submitting leaves the queued work for its successor",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-submit-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      await crashing.call<number>("enqueue", {
        scope: receiver,
        drafts: [draft(receiver), draft(receiver)],
      });

      const invocation = await crashing.call<string>("planHead", {
        scope: receiver,
      });
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);
      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const submitting = settling.outbox(() => ({ key, epoch: 2 }));
        const { plans } = await submitting.submissionPlan(scope);
        const head = plans[0]!.head;
        if (head.type !== "ready") {
          throw new Error(`the queued work was left ${head.type}`);
        }
        expect(head.record.invocation).toBe(invocation);
        await submitting.acknowledge(head.record, COMMITTED, 1_700_000_000_002);
        const next = (await submitting.submissionPlan(scope)).plans[0]!.head;
        if (next.type !== "ready") throw new Error(`the queue is ${next.type}`);
        await submitting.acknowledge(next.record, { ...COMMITTED, settled: 2 }, 1_700_000_000_003);
      } finally {
        settling.close();
      }
      expect(await receiptStates(name)).toEqual(["committed", "committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed inside its snapshot install leaves no half replica",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-install-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      expect(await crashing.call<string>("stallInstall", {
        storageName: name,
        identity: left,
        attributes: REPLICA_ATTRIBUTES,
        snapshot: opaque("q"),
        revision: opaque("r"),
        datoms: [{
          entity: opaque("e"),
          field: ":item/name",
          value: { type: "string", value: "crashed" },
          op: "add",
        }],
      })).toBe("replica.install");
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);

      const installed = await dumpStore(name, "replica-committed-v1");
      expect(installed.length).toBeLessThan(2);
      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const restored = await settling.restore(
          left,
          REPLICA_ATTRIBUTES,
          READ_COMPATIBILITY,
        );
        if (installed.length === 0) {
          expect(restored).toBeUndefined();
        } else {
          expect(restored?.handles.size).toBe(1);
          expect(await dumpStore(name, "replica-staging-v1")).toEqual([]);
          expect(await dumpStore(name, "replica-staging-chunks-v1")).toEqual([]);
        }
        restored?.release();
        await confirm(settling, left, "left");
        expect((await dumpStore(name, "replica-committed-v1")).length).toBe(1);
        expect(await dumpStore(name, "replica-staging-v1")).toEqual([]);
        expect(await dumpStore(name, "replica-staging-chunks-v1")).toEqual([]);
      } finally {
        settling.close();
      }
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a settlement storm across a leader handoff commits each invocation once",
  async ({ browser }) => {
    const name = `ramose-leadership-storm-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    const follower = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      const queued = draft(receiver);
      expect(await crashing.call<number>("enqueue", {
        scope: receiver,
        drafts: [queued],
      })).toBe(1);

      expect(await crashing.call<string>("planHead", { scope: receiver }))
        .toBe(queued.invocation);
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);
      const standing = await stand(follower, name, receiver);
      expect([standing.status, standing.submits]).toEqual(["waiting", false]);

      const storm = (): Promise<readonly Settlement[]> =>
        Promise.all(
          [successor, follower].flatMap((tab) =>
            Array.from(
              { length: 6 },
              () => tab.call<Settlement>("acknowledgeHead", { scope: receiver }),
            )
          ),
        );

      const answered = await storm();
      const settled = answered.filter((entry) => entry.outcome === "settled");
      expect(answered).toHaveLength(12);
      expect(settled.length).toBeGreaterThan(0);
      for (const entry of answered) {
        expect(["settled", "empty"]).toContain(entry.outcome);
      }

      for (const entry of settled) {
        expect(entry).toEqual(settled[0]);
        expect(entry).toMatchObject({
          invocation: queued.invocation,
          state: "committed",
        });
      }

      for (const entry of await storm()) expect(entry.outcome).toBe("empty");

      expect(await receiptStates(name)).toEqual(["committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await follower.close();
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed inside its enqueue leaves no partial invocation",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-enqueue-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const scope = replicaScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);

      const allocation = clientRef();
      const queueing = draft(receiver, {
        allocations: [{ slot: "issue", clientRef: allocation }],
      });
      expect(await crashing.call<string>("stallEnqueue", {
        scope: receiver,
        draft: queueing,
      })).toBe(queueing.invocation);
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);

      const queued = await dumpStore(name, "mutation-outbox-v1");
      expect(queued.length).toBeLessThan(2);
      expect((await dumpStore(name, "mutation-client-refs-v1")).length)
        .toBe(queued.length);
      expect((await dumpStore(name, "mutation-queues-v1")).length)
        .toBe(queued.length);
      expect(await dumpStore(name, "mutation-receipts-v1")).toHaveLength(
        queued.length,
      );

      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const submitting = settling.outbox(() => ({ key, epoch: 2 }));
        if (queued.length === 0) await submitting.enqueue(queueing, { scope });
        const head = (await submitting.submissionPlan(scope)).plans[0]!.head;
        if (head.type !== "ready") throw new Error(`the queue head is ${head.type}`);
        expect(head.record.invocation).toBe(queueing.invocation);
        expect(head.record.allocations).toEqual(queueing.allocations);
        expect(
          (await submitting.acknowledge(head.record, {
            ...COMMITTED,
            mappings: [{ clientRef: allocation, entityId: MAPPED }],
          }, 1_700_000_000_002)).state,
        ).toBe("committed");
        expect((await dumpStore(name, "mutation-client-ref-mappings-v1")).length)
          .toBe(1);
      } finally {
        settling.close();
      }
      expect(await receiptStates(name)).toEqual(["committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed inside the activation it began still fences its receipt",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-activation-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      expect(await crashing.call<number>("enqueue", {
        scope: receiver,
        drafts: [draft(receiver)],
      })).toBe(1);

      const invocation = await crashing.call<string>("stallActivation", {
        scope: receiver,
      });
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);

      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const outbox = settling.outbox(() => ({ key, epoch: 2 }));
        const before = await outbox.observationState(receiver);
        expect([0, 1]).toContain(before.activation);
        expect(unobservedIds(before)).toEqual([invocation]);

        const activation = await outbox.beginActivation(receiver);
        expect(activation).toBe(before.activation + 1);
        const outcome = await outbox.fenceActivation(receiver, activation);
        expect(outcome.fenced).toEqual([invocation]);
        expect(unobservedIds(await outbox.observationState(receiver))).toEqual([]);
        expect((await outbox.receipt(receiver, invocation as never))?.observation)
          .toBe("observed");
      } finally {
        settling.close();
      }
      expect(await receiptStates(name)).toEqual(["committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);

browserTest(
  "a leader crashed inside the observation fence converges on the next one",
  async ({ browser }) => {
    const name = `ramose-leadership-crash-fence-${browser.uniqueId}`;
    const left = identity({ database: databaseOf(browser.uniqueId) });
    const receiver = replicaDatabaseScopeOf(left);
    const key = replicaLeaderKey(receiver, name);
    const seeding = await IndexedDbReplicaStorage.open(name);
    try {
      await confirm(seeding, left, "left");
    } finally {
      seeding.close();
    }
    const crashing = await openTab(tabModule);
    const successor = await openTab(tabModule);
    try {
      await stand(crashing, name, receiver);
      expect((await leading(crashing)).epoch).toBe(1);
      expect(await crashing.call<number>("enqueue", {
        scope: receiver,
        drafts: [draft(receiver)],
      })).toBe(1);

      const stalled = await crashing.call<{
        readonly invocation: string;
        readonly activation: number;
      }>("stallObservationFence", { scope: receiver });
      expect(stalled.activation).toBe(1);
      crashing.crash();

      await stand(successor, name, receiver);
      expect((await leading(successor)).epoch).toBe(2);

      const settling = await IndexedDbReplicaStorage.open(name);
      try {
        const outbox = settling.outbox(() => ({ key, epoch: 2 }));
        const before = unobservedIds(await outbox.observationState(receiver));
        expect([[], [stalled.invocation]]).toContainEqual(before);
        expect((await outbox.receipt(receiver, stalled.invocation as never))?.state)
          .toBe("committed");

        const activation = await outbox.beginActivation(receiver);
        expect(activation).toBe(2);
        const outcome = await outbox.fenceActivation(receiver, activation);
        expect(outcome.fenced).toEqual(before);
        expect(unobservedIds(await outbox.observationState(receiver))).toEqual([]);
        expect(
          (await outbox.receipt(receiver, stalled.invocation as never))?.observation,
        ).toBe("observed");
      } finally {
        settling.close();
      }
      expect(await receiptStates(name)).toEqual(["committed"]);
      expect(await dumpStore(name, "mutation-outbox-v1")).toEqual([]);
    } finally {
      await successor.close();
      await deleteDatabase(name);
    }
  },
);
