import type { ReplicationIdentity } from "./protocol.ts";
import {
  replicaDatabaseKey,
  replicaDatabaseScopeOf,
  replicaScopeKey,
  replicaScopeOf,
  type ReplicaDatabaseScope,
  type ReplicaScope,
} from "./replica-lifecycle.ts";

export const REPLICA_NOTICE_CHANNEL_VERSION = 1 as const;

const NOTICE_CHANNEL_PREFIX =
  `ramose-replica-notice-v${REPLICA_NOTICE_CHANNEL_VERSION}:`;

/**
 * The channel name of one storage namespace, derived the way the leadership
 * lock name is: every tab computes the same string, and clients that keep
 * separate storage namespaces share no durable state and no channel.
 */
export const replicaNoticeChannelName = (storage: string): string =>
  `${NOTICE_CHANNEL_PREFIX}${encodeURIComponent(storage)}`;

/**
 * What durably changed, named coarsely enough that a receiver knows which
 * durable records to read again.
 */
export type ReplicaNoticeKind =
  | "replica"
  | "layer"
  | "receipt"
  | "fence"
  | "reset"
  | "selector";

const NOTICE_KINDS: ReadonlySet<string> = new Set<ReplicaNoticeKind>([
  "replica",
  "layer",
  "receipt",
  "fence",
  "reset",
  "selector",
]);

/**
 * One change notice.
 *
 * It carries a kind and the durable keys it happened under, never a value: a
 * receiver re-reads IndexedDB, which is the source of truth, and a receiver
 * that never gets the notice reads the same records later and reaches the same
 * state. Nothing here orders anything — the IndexedDB transactions that
 * produced the change carry all the ordering there is.
 */
export type ReplicaNotice = {
  readonly kind: ReplicaNoticeKind;
  readonly scope: string;
  readonly database?: string;
};

export const replicaNotice = (
  kind: ReplicaNoticeKind,
  scope: ReplicaScope,
  database?: ReplicaDatabaseScope | undefined,
): ReplicaNotice =>
  Object.freeze({
    kind,
    scope: replicaScopeKey(scope),
    ...(database === undefined ? {} : { database: replicaDatabaseKey(database) }),
  });

export const identityNotice = (
  kind: ReplicaNoticeKind,
  identity: ReplicationIdentity,
): ReplicaNotice =>
  replicaNotice(
    kind,
    replicaScopeOf(identity),
    replicaDatabaseScopeOf(identity),
  );

export const isReplicaNotice = (value: unknown): value is ReplicaNotice => {
  if (value === null || typeof value !== "object") return false;
  const notice = value as { readonly kind?: unknown; readonly scope?: unknown; readonly database?: unknown };
  return typeof notice.kind === "string" && NOTICE_KINDS.has(notice.kind) &&
    typeof notice.scope === "string" && notice.scope.length > 0 &&
    (notice.database === undefined || typeof notice.database === "string");
};

export type ReplicaNoticeListener = (notice: ReplicaNotice) => void;

export type BroadcastConstructor = new (name: string) => BroadcastChannel;

/** `BroadcastChannel`, which some runtimes and older browsers lack. */
export const platformBroadcast = (): BroadcastConstructor | undefined =>
  (globalThis as { readonly BroadcastChannel?: BroadcastConstructor })
    .BroadcastChannel;

/**
 * The wake-up channel of one storage namespace.
 *
 * Delivery is best effort by construction. A dropped, delayed, or reordered
 * notice costs a receiver latency and nothing else, and where
 * `BroadcastChannel` is missing the channel posts nothing at all: every
 * consumer reaches the same state from the durable records on its next
 * activation.
 */
export class ReplicaNoticeChannel {
  private readonly listeners = new Set<ReplicaNoticeListener>();
  private channel: BroadcastChannel | undefined;
  private closed = false;

  private constructor(channel: BroadcastChannel | undefined) {
    this.channel = channel;
  }

  static begin(options: {
    readonly name: string;
    readonly broadcast: BroadcastConstructor | undefined;
  }): ReplicaNoticeChannel {
    let channel: BroadcastChannel | undefined;
    try {
      channel = options.broadcast === undefined
        ? undefined
        : new options.broadcast(options.name);
    } catch {
      channel = undefined;
    }
    const notices = new ReplicaNoticeChannel(channel);
    channel?.addEventListener("message", (event) => {
      notices.deliver((event as MessageEvent).data);
    });
    return notices;
  }

  /** Whether this runtime has a channel to post on at all. */
  announces(): boolean {
    return this.channel !== undefined;
  }

  post(notice: ReplicaNotice): void {
    if (this.closed) return;
    try {
      this.channel?.postMessage(notice);
    } catch {
    }
  }

  subscribe(listener: ReplicaNoticeListener): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deliver(data: unknown): void {
    if (this.closed || !isReplicaNotice(data)) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch {
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.channel?.close();
    this.channel = undefined;
  }
}
