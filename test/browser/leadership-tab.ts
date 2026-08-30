import { IndexedDbReplicaStorage } from "../../packages/ramose/src/internal/replication/indexeddb.ts";
import {
  platformLocks,
  replicaLeaderKey,
  SyncLeadership,
} from "../../packages/ramose/src/internal/replication/leadership.ts";
import type { ReplicaDatabaseScope } from "../../packages/ramose/src/internal/replication/replica-lifecycle.ts";
import { serveTab } from "./tab-harness.ts";

type Standing = {
  readonly storageName: string;
  readonly scope: ReplicaDatabaseScope;
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

/** The tab entry point: `openTab` loads this module and calls it. */
export const serve = (id: string): void =>
  serveTab(id, {
    stand: async ({ storageName, scope }: Standing): Promise<TabReport> => {
      const opened = await IndexedDbReplicaStorage.open(storageName);
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
