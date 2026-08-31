
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

const fenced = (
  entry: QueueProgress,
  reason: "scope-fenced" | "leadership-fenced",
): boolean =>
  entry.state._tag === "Interrupted" && entry.state.reason === reason;

const transient = (entry: QueueProgress): boolean =>
  entry.state._tag === "Retry" ||
  (entry.state._tag === "Interrupted" &&
    entry.state.reason !== "scope-fenced" &&
    entry.state.reason !== "leadership-fenced");

export type PassOutcome = "withdraw" | "stand-down" | "again" | "later" | "settled";

/**
 * What a submission pass leaves behind it.
 *
 * A pass refused by a durable fence never retries, because the epoch or
 * generation it wrote under is not the one that stands and the same pass can
 * only be refused again. Which fence refused it decides what follows. A
 * leadership epoch another tab took means this tab is no longer the submitter,
 * so it gives the lock up and stands again. A scope generation means the scope
 * itself was withdrawn — cleared, or given to another principal — and standing
 * for its leadership again would take that work back up under a principal that
 * no longer holds it, so the tab re-reads what it is holding instead.
 */
export const passOutcome = (
  progress: readonly QueueProgress[],
): PassOutcome => {
  if (progress.some((entry) => fenced(entry, "scope-fenced"))) return "withdraw";
  if (progress.some((entry) => fenced(entry, "leadership-fenced"))) {
    return "stand-down";
  }
  if (progress.some(advanced)) return "again";
  return progress.some(transient) ? "later" : "settled";
};

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
  /**
   * Open a receiver this tab has queued work for but has not resolved. A
   * confirmation is what turns it into an endpoint, so this returns nothing.
   */
  readonly resolve: (receiver: ReplicaDatabaseScope) => void;
  /** Let go of a receiver this tab opened only to drain its queue. */
  readonly retire: (receiver: ReplicaDatabaseScope) => void;
  /**
   * Re-read the durable generations every handle of this client adopted, so a
   * scope withdrawn while this pass ran stops being submitted for.
   */
  readonly revalidate: () => Promise<void>;
  readonly reconcile: (
    receiver: ReplicaDatabaseScope,
    progress: readonly QueueProgress[],
  ) => Promise<void>;
  readonly live: () => boolean;
};

type TrackedReceipt = {
  readonly receiver: ReplicaDatabaseScope;
  readonly driver: ReceiptDriver;
};

/** The receipts this session is holding, and the passes that settle them. */
export class SubmissionLoop {
  private readonly receipts = new Map<InvocationId, TrackedReceipt>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new AbortController();

  constructor(private readonly context: SubmissionContext) {}

  track(receiver: ReplicaDatabaseScope, driver: ReceiptDriver): void {
    this.receipts.set(driver.receipt.invocation, { receiver, driver });
  }

  /**
   * Settle the receipts this tab is holding from their durable records.
   *
   * Only the leader submits, so a follower's invocation is acknowledged by
   * another tab: the durable receipt is where its outcome lands, and this is
   * how the follower's own receipt reaches it.
   */
  async settleFromDurable(): Promise<void> {
    if (this.receipts.size === 0 || !this.context.live()) return;
    const outbox = (await this.context.storage()).outbox();
    for (const [invocation, tracked] of [...this.receipts]) {
      const record = await outbox.receipt(tracked.receiver, invocation)
        .catch(() => undefined);
      if (record === undefined || record.state === "queued") continue;
      this.receipts.delete(invocation);
      if (record.state === "committed") tracked.driver.commit();
      else tracked.driver.reject(record.failure?.code ?? "rejected");
    }
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
    const fence = leadership.fence();
    const progress = await runSubmissionPass({
      store: storage.outbox(() => fence),
      scope,
      endpoints: (receiver) => this.context.endpoint(receiver, credential),
      transport: submitMutation,
      signal: this.inflight.signal,
    });
    for (const entry of progress) {
      if (entry.state._tag === "Offline") this.context.resolve(entry.receiver);
      else if (entry.state._tag === "Empty") this.context.retire(entry.receiver);
    }
    await this.settle(progress);
    switch (passOutcome(progress)) {
      case "withdraw":
        await this.context.revalidate();
        return;
      case "stand-down":
        await leadership.standDown();
        return;
      case "again":
        this.request(scope);
        return;
      case "later":
        this.later(scope);
        return;
      case "settled":
        return;
    }
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
        this.receipts.get(state.invocation)?.driver.commit();
        this.receipts.delete(state.invocation);
      } else if (state._tag === "Rejected") {
        this.receipts.get(state.invocation)?.driver.reject(state.code);
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
