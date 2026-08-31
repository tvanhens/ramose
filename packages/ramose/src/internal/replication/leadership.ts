import { replicaDatabaseKey, type ReplicaDatabaseScope } from "./replica-lifecycle.ts";

export const REPLICA_LEADERSHIP_KEY_VERSION = 1 as const;

const LEADERSHIP_KEY_PREFIX = `ramose-replica-leader-v${REPLICA_LEADERSHIP_KEY_VERSION}:`;

/**
 * The lock name and durable epoch key of one storage namespace, server, root
 * database, and principal. Clients that do not share an outbox do not share a
 * leader, so a storage namespace of its own keeps a client submitting.
 */
export const replicaLeaderKey = (
  scope: ReplicaDatabaseScope,
  storage: string,
): string =>
  `${LEADERSHIP_KEY_PREFIX}${encodeURIComponent(storage)}:${
    replicaDatabaseKey(scope)
  }`;

export const isLeadershipKey = (key: string): boolean =>
  key.startsWith(LEADERSHIP_KEY_PREFIX);

/**
 * The epoch a leader-only write revalidates in the transaction that commits
 * its effect, so a leader deposed mid-flight fails instead of landing.
 */
export type LeadershipFence = {
  readonly key: string;
  readonly epoch: number;
};

export type LeadershipStatus = "waiting" | "leading" | "unelected" | "released";

const ELECTION_RETRY_MS = 1_000;

export type LeadershipOptions = {
  readonly name: string;
  /** `navigator.locks`, or undefined to leave every tab unelected. */
  readonly locks: LockManager | undefined;
  /** Takes the durable epoch. Runs once per grant. */
  readonly claim: () => Promise<number>;
  /** Runs once this tab may submit. */
  readonly onLeading: () => void;
};

/** `navigator.locks`, which an insecure or non-browser runtime lacks. */
export const platformLocks = (): LockManager | undefined =>
  (globalThis as { readonly navigator?: { readonly locks?: LockManager } })
    .navigator?.locks;

/**
 * One tab's standing in the election that names a single submitter for one
 * scope.
 *
 * Web Locks is the election: a granted request is leadership, queued requests
 * are followers, and the browser releases the lock when the holding tab closes
 * or crashes, which grants the next tab with no expiry to wait out. Where
 * `navigator.locks` is missing there is no election and every tab submits for
 * itself, which duplicates work but stays correct on write paths that already
 * converge for concurrent same-origin writers.
 */
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

  /** May this tab submit and own server synchronization for the scope? */
  submits(): boolean {
    return this.state === "leading" || this.state === "unelected";
  }

  /** An unelected tab carries no epoch: nothing elected it to depose. */
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

  /**
   * A grant this tab could not record is leadership it does not have, so it
   * gives the lock back and stands again once storage may have recovered.
   */
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

  /**
   * Give up an epoch that no longer fences and stand for the election again.
   *
   * A write refused by the durable epoch says this tab is no longer the leader
   * its epoch named, so retrying under that epoch can only be refused again.
   * Dropping the lock grants whichever tab deposed it, and standing again takes
   * a fresh epoch when this tab is granted the lock next, which is what lets a
   * tab that is still the only one open carry on submitting.
   */
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

  /**
   * Give leadership up: a leader drops the lock, which grants the next queued
   * tab, and a follower stops waiting for one. Resolves once the lock is no
   * longer held.
   */
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
