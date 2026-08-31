import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../../packages/ramose/src/internal/replication/leadership.ts";
import type { ReplicaDatabaseScope } from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import {
  armCheckpoint,
  checkpointStatus,
  testRuntimeBoundaries,
} from "../../packages/ramose/src/internal/test-hooks.ts";
import type { ReplicationIdentity } from "../../packages/ramose/src/internal/replication/protocol.ts";
import type { AttributeSpec } from "../../packages/ramose/src/internal/core/schema.ts";
import type { OutboxDraft } from "../../packages/ramose/src/internal/replication/outbox.ts";
import { snapshotChunk } from "../../packages/ramose/test/replication-fixtures.ts";
import { serveTab } from "./tab-harness.ts";

type Standing = {
  readonly storageName: string;
  readonly scope: ReplicaDatabaseScope;
};

type Staging = {
  readonly storageName: string;
  readonly identity: ReplicationIdentity;
  readonly attributes: readonly AttributeSpec[];
  readonly snapshot: string;
  readonly revision: string;
  readonly datoms: readonly unknown[];
};

export type TabReport = {
  readonly status: string;
  readonly submits: boolean;
  readonly key: string;
  readonly epoch: number | undefined;
};

let storage: IndexedDbReplicaStorage | undefined;
let leadership: SyncLeadership | undefined;
let key = "";

const report = (): TabReport => ({
  status: leadership?.status() ?? "absent",
  submits: leadership?.submits() ?? false,
  key,
  epoch: leadership?.fence()?.epoch,
});

const scopeOf = (scope: ReplicaDatabaseScope) => ({
  server: scope.server,
  principal: scope.principal,
});

const stalled = async (
  checkpoint: string,
  failed: () => string | undefined,
): Promise<string> => {
  const deadline = performance.now() + 4_000;
  for (;;) {
    if (checkpointStatus()[checkpoint]?.pending === true) return checkpoint;
    const failure = failed();
    if (failure !== undefined) throw new Error(failure);
    if (performance.now() > deadline) {
      throw new Error(`${checkpoint} was never reached`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** The tab entry point: `openTab` loads this module and calls it. */
export const serve = (id: string): void =>
  serveTab(id, {
    stand: async ({ storageName, scope }: Standing): Promise<TabReport> => {
      const opened = await IndexedDbReplicaStorage.open(
        storageName,
        testRuntimeBoundaries,
      );
      storage = opened;
      key = replicaLeaderKey(scope, storageName);
      const standing = SyncLeadership.begin({
        name: key,
        locks: platformLocks(),
        claim: () => opened.claimLeadership(key, scope),
        onLeading: () => undefined,
      });
      leadership = standing;
      opened.onInvalidated(() => void standing.release());
      return report();
    },
    report: (): TabReport => report(),

    /** Give up an epoch a durable write refused and stand for a fresh one. */
    standDown: async (): Promise<TabReport> => {
      await leadership?.standDown();
      return report();
    },

    /** Queue work this tab's leader, or its successor, has to carry. */
    enqueue: async (
      { scope, drafts }: {
        readonly scope: ReplicaDatabaseScope;
        readonly drafts: readonly OutboxDraft[];
      },
    ): Promise<number> => {
      const outbox = storage!.outbox();
      for (const draft of drafts) {
        await outbox.enqueue(draft, { scope: scopeOf(scope) });
      }
      return drafts.length;
    },

    /** Plan the head of the queue the way a submitting leader plans it. */
    planHead: async (
      { scope }: { readonly scope: ReplicaDatabaseScope },
    ): Promise<string> => {
      const { plans } = await storage!.outbox(() => leadership?.fence())
        .submissionPlan(scopeOf(scope));
      const head = plans[0]!.head;
      if (head.type !== "ready") throw new Error(`the queue head is ${head.type}`);
      return head.record.invocation;
    },

    /**
     * Stall this leader inside the transaction that acknowledges the head of
     * the queue, and stay there until the tab is destroyed.
     */
    stallAcknowledgement: async (
      { scope }: { readonly scope: ReplicaDatabaseScope },
    ): Promise<string> => {
      const submitting = storage!.outbox(() => leadership?.fence());
      const { plans } = await submitting.submissionPlan(scopeOf(scope));
      const head = plans[0]!.head;
      if (head.type !== "ready") throw new Error(`the queue head is ${head.type}`);
      armCheckpoint("outbox.acknowledge", "wait");
      let failure: string | undefined;
      void submitting.acknowledge(head.record, {
        _tag: "Committed",
        output: {},
        mappings: [],
      }, 1_700_000_000_001).catch((error: unknown) => {
        failure = String(error);
      });
      await stalled("outbox.acknowledge", () => failure);
      return head.record.invocation;
    },

    /**
     * Stall this leader inside the transaction that installs a snapshot, and
     * stay there until the tab is destroyed.
     */
    stallInstall: async (
      { identity, attributes, snapshot, revision, datoms }: Staging,
    ): Promise<string> => {
      const opened = storage!;
      await opened.startSnapshot({
        type: "SnapshotStart", protocol: 1, identity, snapshot, revision,
      });
      await opened.stageSnapshotChunk(snapshotChunk({
        type: "SnapshotChunk", protocol: 1, identity, snapshot, index: 0,
        datoms: datoms as never,
      }));
      armCheckpoint("replica.install", "wait");
      let failure: string | undefined;
      void opened.commitSnapshot({
        type: "SnapshotCommit", protocol: 1, identity, snapshot, revision, chunks: 1,
      }, attributes).then(
        (installed) => installed?.release(),
        (error: unknown) => {
          failure = String(error);
        },
      );
      return stalled("replica.install", () => failure);
    },

    release: async (): Promise<TabReport> => {
      await leadership?.release();
      return report();
    },
    close: async (): Promise<TabReport> => {
      await leadership?.release();
      storage?.close();
      return report();
    },
  });
