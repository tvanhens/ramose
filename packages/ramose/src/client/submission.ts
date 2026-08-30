
import type { InvocationId } from "../db/refs.ts";
import type { IndexedDbReplicaStorage } from "../internal/replication/indexeddb.ts";
import type { SyncLeadership } from "../internal/replication/leadership.ts";
import {
  replicaDatabaseKey,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "../internal/replication/replica-lifecycle.ts";
import {
  runSubmissionPass,
  type MutationEndpoint,
  type QueueProgress,
} from "../internal/replication/submission.ts";
import { submitMutation } from "../internal/replication/transport.ts";
import type { ReceiptDriver } from "./receipt.ts";

const advanced = (entry: QueueProgress): boolean =>
  entry.state._tag === "Committed" || entry.state._tag === "Rejected";

const transient = (entry: QueueProgress): boolean =>
  entry.state._tag === "Retry" || entry.state._tag === "Interrupted";

const RETRY_DELAY_MS = 1_000;

const scopeKey = (scope: ReplicaScope): string =>
  `${scope.server} ${scope.principal}`;

type PassCredential = {
  readonly token: string;
  readonly cacheKey: string;
};

/** What the loop needs from the client that owns it. */
export type SubmissionContext = {
  readonly storage: () => Promise<IndexedDbReplicaStorage>;
  /**
   * This tab's sync leadership, once a confirmed scope has one to elect for.
   * A follower keeps enqueuing durably and submits nothing.
   */
  readonly leadership: () => SyncLeadership | undefined;
  readonly credential: () => Promise<PassCredential>;
  readonly endpoint: (
    receiver: ReplicaDatabaseScope,
    credential: PassCredential,
  ) => MutationEndpoint | undefined;
  readonly reconcile: (
    receiver: ReplicaDatabaseScope,
    progress: readonly QueueProgress[],
  ) => Promise<void>;
  readonly live: () => boolean;
};

/** The receipts this session is holding, and the passes that settle them. */
export class SubmissionLoop {
  private readonly receipts = new Map<InvocationId, ReceiptDriver>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new AbortController();

  constructor(private readonly context: SubmissionContext) {}

  track(driver: ReceiptDriver): void {
    this.receipts.set(driver.receipt.invocation, driver);
  }

  request(scope: ReplicaScope): void {
    const key = scopeKey(scope);
    if (this.pending.has(key)) {
      this.again.add(key);
      return;
    }
    const run = this.pass(scope)
      .catch(() => this.later(scope))
      .finally(() => {
        this.pending.delete(key);
        if (this.again.delete(key)) this.request(scope);
      });
    this.pending.set(key, run);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()]);
    }
  }

  private async pass(scope: ReplicaScope): Promise<void> {
    if (!this.context.live()) return;
    const leadership = this.context.leadership();
    if (leadership === undefined || !leadership.submits()) return;
    const storage = await this.context.storage();
    const credential = await this.context.credential();
    if (!this.context.live() || !leadership.submits()) return;
    const progress = await runSubmissionPass({
      store: storage.outbox(() => leadership.fence()),
      scope,
      endpoints: (receiver) => this.context.endpoint(receiver, credential),
      transport: submitMutation,
      signal: this.inflight.signal,
    });
    await this.settle(progress);
    if (progress.some(advanced)) {
      this.request(scope);
      return;
    }
    if (progress.some(transient)) this.later(scope);
  }

  private later(scope: ReplicaScope): void {
    const key = scopeKey(scope);
    if (this.retries.has(key)) return;
    this.retries.set(
      key,
      setTimeout(() => {
        this.retries.delete(key);
        if (this.context.live()) this.request(scope);
      }, RETRY_DELAY_MS),
    );
  }

  close(): void {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.inflight.abort();
  }

  private async settle(progress: readonly QueueProgress[]): Promise<void> {
    for (const entry of progress) {
      const state = entry.state;
      if (state._tag === "Committed") {
        this.receipts.get(state.invocation)?.commit();
        this.receipts.delete(state.invocation);
      } else if (state._tag === "Rejected") {
        this.receipts.get(state.invocation)?.reject(state.code);
        this.receipts.delete(state.invocation);
      }
    }
    const byReceiver = new Map<string, ReplicaDatabaseScope>();
    for (const entry of progress) {
      byReceiver.set(replicaDatabaseKey(entry.receiver), entry.receiver);
    }
    for (const receiver of byReceiver.values()) {
      await this.context.reconcile(receiver, progress).catch(() => undefined);
    }
  }
}
