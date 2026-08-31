import type { ClientDatabase, SyncStatus } from "../client/index.ts";
import { reviewUnclaimed, type QueryStore, type StoreHold } from "./store.ts";

const delivers = (status: SyncStatus): boolean =>
  status === "idle" || status === "connecting" || carries(status);

const carries = (status: SyncStatus): boolean =>
  status === "live" || status === "stale";

const decided = (status: SyncStatus): boolean =>
  status === "closed" || status === "authentication-required" ||
  status === "update-required";

const LOCAL = new WeakSet<ClientDatabase>();

const WATCHED = new WeakSet<ClientDatabase>();

export const watchLocal = (database: ClientDatabase): void => {
  if (WATCHED.has(database)) return;
  WATCHED.add(database);
  const note = (): void => {
    const status = database.sync.getSnapshot().status;
    if (carries(status)) LOCAL.add(database);
    else if (status === "connecting") LOCAL.delete(database);
  };
  database.sync.subscribe(note);
  note();
};

const reads = (database: ClientDatabase): boolean => {
  watchLocal(database);
  const status = database.sync.getSnapshot().status;
  return !decided(status) && (LOCAL.has(database) || delivers(status));
};

class QuerySuspension implements StoreHold {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private done = false;
  private claimed = false;
  private released = false;
  private stopStore: (() => void) | undefined;
  private stopSync: (() => void) | undefined;

  constructor(
    private readonly database: ClientDatabase,
    private readonly store: QueryStore<unknown>,
    private readonly waiting: Map<string, QuerySuspension>,
    private readonly key: string,
  ) {
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
    const check = (): void => this.check();
    this.stopStore = store.retain(check);
    this.stopSync = database.sync.subscribe(check);
    store.attach(this);
    this.check();
  }

  settled(): boolean {
    return this.done;
  }

  gone(): boolean {
    return this.released;
  }

  private check(): void {
    if (this.done) return;
    if (this.store.getSnapshot().status === "pending" && reads(this.database)) {
      return;
    }
    this.done = true;
    this.resolve();
    if (this.claimed) this.stop();
    else reviewUnclaimed(this.database);
  }

  onClaimed(): void {
    this.claimed = true;
    if (this.done) this.stop();
  }

  onEvicted(): void {
    this.stop();
  }

  private stop(): void {
    this.released = true;
    this.store.detach(this);
    if (this.waiting.get(this.key) === this) this.waiting.delete(this.key);
    this.stopSync?.();
    this.stopSync = undefined;
    this.stopStore?.();
    this.stopStore = undefined;
    if (!this.done) {
      this.done = true;
      this.resolve();
    }
  }
}

const SUSPENSIONS = new WeakMap<ClientDatabase, Map<string, QuerySuspension>>();

export const suspend = (
  database: ClientDatabase,
  key: string,
  store: QueryStore<unknown>,
): Promise<void> | undefined => {
  const waiting = SUSPENSIONS.get(database) ?? new Map<string, QuerySuspension>();
  SUSPENSIONS.set(database, waiting);
  const existing = waiting.get(key);
  if (existing !== undefined) {
    return existing.settled() ? undefined : existing.promise;
  }
  if (!reads(database)) return undefined;
  const created = new QuerySuspension(database, store, waiting, key);
  if (!created.gone()) waiting.set(key, created);
  return created.settled() ? undefined : created.promise;
};

export const suspendedQueryCount = (database: ClientDatabase): number =>
  SUSPENSIONS.get(database)?.size ?? 0;
