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

export const replicaNoticeChannelName = (storage: string): string =>
  `${NOTICE_CHANNEL_PREFIX}${encodeURIComponent(storage)}`;

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

export const platformBroadcast = (): BroadcastConstructor | undefined =>
  (globalThis as { readonly BroadcastChannel?: BroadcastConstructor })
    .BroadcastChannel;

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
