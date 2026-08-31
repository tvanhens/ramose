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
  type InterruptedReason,
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

const UNREPLAYABLE: ReadonlySet<InterruptedReason> = new Set<InterruptedReason>([
  "record-invalid",
  "invocation-conflict",
  "mapping-refused",
]);

const unreplayable = (entry: QueueProgress): boolean =>
  entry.state._tag === "Interrupted" && UNREPLAYABLE.has(entry.state.reason);

const transient = (entry: QueueProgress): boolean =>
  entry.state._tag === "Retry" ||
  (entry.state._tag === "Interrupted" &&
    entry.state.reason !== "scope-fenced" &&
    entry.state.reason !== "leadership-fenced" &&
    !UNREPLAYABLE.has(entry.state.reason));

export const queueUnreplayable = (
  progress: readonly QueueProgress[],
  database: string,
): boolean =>
  progress.some((entry) =>
    replicaDatabaseKey(entry.receiver) === database &&
    (entry.state._tag === "UpdateRequired" || unreplayable(entry))
  );

export type PassOutcome =
  | "withdraw"
  | "stand-down"
  | "again"
  | "later"
  | "obstructed"
  | "settled";

export const passOutcome = (
  progress: readonly QueueProgress[],
): PassOutcome => {
  if (progress.some((entry) => fenced(entry, "scope-fenced"))) return "withdraw";
  if (progress.some((entry) => fenced(entry, "leadership-fenced"))) {
    return "stand-down";
  }
  if (progress.some(advanced)) return "again";
  if (progress.some(transient)) return "later";
  return progress.some(unreplayable) ? "obstructed" : "settled";
};

const RETRY_DELAY_MS = 1_000;

const scopeKey = (scope: ReplicaScope): string =>
  `${scope.server} ${scope.principal}`;

type PassCredential = {
  readonly token: string;
  readonly cacheKey: string;
};

export type SubmissionContext = {
  readonly storage: () => Promise<IndexedDbReplicaStorage>;
  readonly leadership: () => SyncLeadership | undefined;
  readonly credential: () => Promise<PassCredential>;
  readonly endpoint: (
    receiver: ReplicaDatabaseScope,
    credential: PassCredential,
  ) => MutationEndpoint | undefined;
  readonly resolve: (receiver: ReplicaDatabaseScope) => void;
  readonly retire: (receiver: ReplicaDatabaseScope) => void;
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

  untrack(invocation: InvocationId): void {
    this.receipts.delete(invocation);
  }

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
      case "obstructed":
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
