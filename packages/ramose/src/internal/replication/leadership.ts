import { replicaDatabaseKey, type ReplicaDatabaseScope } from "./replica-lifecycle.ts";

export const REPLICA_LEADERSHIP_KEY_VERSION = 1 as const;

const LEADERSHIP_KEY_PREFIX = `ramose-replica-leader-v${REPLICA_LEADERSHIP_KEY_VERSION}:`;

export const replicaLeaderKey = (
  scope: ReplicaDatabaseScope,
  storage: string,
): string =>
  `${LEADERSHIP_KEY_PREFIX}${encodeURIComponent(storage)}:${
    replicaDatabaseKey(scope)
  }`;

export const isLeadershipKey = (key: string): boolean =>
  key.startsWith(LEADERSHIP_KEY_PREFIX);

export type LeadershipFence = {
  readonly key: string;
  readonly epoch: number;
};

export type LeadershipStatus = "waiting" | "leading" | "unelected" | "released";

const ELECTION_RETRY_MS = 1_000;

export type LeadershipOptions = {
  readonly name: string;
  readonly locks: LockManager | undefined;
  readonly claim: () => Promise<number>;
  readonly onLeading: () => void;
};

export const platformLocks = (): LockManager | undefined =>
  (globalThis as { readonly navigator?: { readonly locks?: LockManager } })
    .navigator?.locks;

export class SyncLeadership {
  private state: LeadershipStatus = "waiting";
  private epoch: number | undefined;
  private held: (() => void) | undefined;
  private granted: Promise<unknown> = Promise.resolve();
  private readonly queued = new AbortController();
  private standing: ReturnType<typeof setTimeout> | undefined;

  private constructor(private readonly options: LeadershipOptions) {}

  static begin(options: LeadershipOptions): SyncLeadership {
    const leadership = new SyncLeadership(options);
    leadership.elect();
    return leadership;
  }

  status(): LeadershipStatus {
    return this.state;
  }

  submits(): boolean {
    return this.state === "leading" || this.state === "unelected";
  }

  fence(): LeadershipFence | undefined {
    return this.state === "leading" && this.epoch !== undefined
      ? Object.freeze({ key: this.options.name, epoch: this.epoch })
      : undefined;
  }

  private elect(): void {
    const locks = this.options.locks;
    if (locks === undefined) {
      this.state = "unelected";
      queueMicrotask(() => {
        if (this.state === "unelected") this.options.onLeading();
      });
      return;
    }
    this.granted = locks
      .request(this.options.name, { signal: this.queued.signal }, () => this.lead())
      .catch(() => undefined);
  }

  private stand(): void {
    if (this.state !== "waiting" || this.standing !== undefined) return;
    this.standing = setTimeout(() => {
      this.standing = undefined;
      if (this.state === "waiting") this.elect();
    }, ELECTION_RETRY_MS);
  }

  private async lead(): Promise<void> {
    if (this.state !== "waiting") return;
    let epoch: number;
    try {
      epoch = await this.options.claim();
    } catch {
      this.stand();
      return;
    }
    if (this.state !== "waiting") return;
    const hold = new Promise<void>((resolve) => {
      this.held = resolve;
    });
    this.epoch = epoch;
    this.state = "leading";
    this.options.onLeading();
    await hold;
  }

  async standDown(): Promise<void> {
    if (this.state !== "leading") return;
    this.state = "waiting";
    this.epoch = undefined;
    const release = this.held;
    this.held = undefined;
    release?.();
    await this.granted;
    if (this.state === "waiting") this.elect();
  }

  async release(): Promise<void> {
    if (this.state === "released") return;
    const leading = this.state === "leading";
    this.state = "released";
    this.epoch = undefined;
    if (this.standing !== undefined) clearTimeout(this.standing);
    this.standing = undefined;
    if (leading) this.held?.();
    else this.queued.abort();
    await this.granted;
  }
}
