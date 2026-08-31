import type { ClientDatabase, SyncStatus } from "../client/index.ts";
import { reviewUnclaimed, type QueryStore, type StoreHold } from "./store.ts";

/**
 * Whether a session in this state could still produce a first local value.
 *
 * `idle` and `connecting` are on their way to one, and `live` and `stale` have
 * one. An offline session does not, and a query with no local answer would
 * wait on it forever. That is not a failure — offline with nothing cached is a
 * steady state Ramose is built to sit in — so it is reported as `pending` for
 * the component to render rather than suspended on.
 */
const delivers = (status: SyncStatus): boolean =>
  status === "idle" || status === "connecting" || carries(status);

/**
 * Whether a session in this state says a local value for its scope exists.
 *
 * `live` and `stale` are both published over a value the session has; `stale`
 * is a restored replica this session has not confirmed.
 */
const carries = (status: SyncStatus): boolean =>
  status === "live" || status === "stale";

/**
 * Whether no later session state could change what this scope can answer.
 *
 * A closed handle, a refused credential and a build the queue is ahead of are
 * all decided: an application recovers by signing in again, reloading, or
 * constructing another client, not by this query waiting longer.
 */
const decided = (status: SyncStatus): boolean =>
  status === "closed" || status === "authentication-required" ||
  status === "update-required";

/**
 * The databases whose session has reported a local value at least once.
 *
 * A connection that drops after that says nothing about whether a query's
 * first answer is coming: what an unanswered query is then waiting for is a
 * local computation over a value that is already here, which always publishes
 * something. Without this, a restored replica whose session fails a moment
 * before the query finishes running would be read as "offline and nothing
 * cached" and flash an empty scope over data that was about to arrive.
 */
const LOCAL = new WeakSet<ClientDatabase>();

const reads = (database: ClientDatabase): boolean => {
  const status = database.sync.getSnapshot().status;
  if (carries(status)) LOCAL.add(database);
  return !decided(status) && (LOCAL.has(database) || delivers(status));
};

/**
 * The wait one suspended component is doing, held where React cannot discard
 * it.
 *
 * React throws away the component that suspends, so nothing in its own
 * lifetime is left observing the query it suspended for and the value would
 * never be computed. This observes in its place, from the render that suspends
 * until the commit that replaces it — or until the cache evicts it, which is
 * what bounds a wait whose component was unmounted while its fallback was on
 * screen.
 */
class QuerySuspension implements StoreHold {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private done = false;
  private claimed = false;
  private stopStore: (() => void) | undefined;
  private stopSync: (() => void) | undefined;

  constructor(
    private readonly database: ClientDatabase,
    private readonly store: QueryStore<unknown>,
    private readonly forget: () => void,
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

  /**
   * React committed a subscription of its own.
   *
   * The observation is only handed over once the wait is over: releasing it
   * while a component is still suspended would leave that component waiting
   * for a value nothing is computing.
   */
  onClaimed(): void {
    this.claimed = true;
    if (this.done) this.stop();
  }

  /** The cache dropped this entry; the observation goes with it. */
  onEvicted(): void {
    this.stop();
  }

  private stop(): void {
    this.store.detach(this);
    this.forget();
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

/**
 * What a component with no local answer should wait on, or nothing.
 *
 * `undefined` means do not suspend: either the session cannot produce a first
 * value right now, or the wait for this query is already over and the render
 * that resumes it reads the store directly.
 */
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
  const created = new QuerySuspension(database, store, () => {
    if (waiting.get(key) === created) waiting.delete(key);
  });
  waiting.set(key, created);
  return created.settled() ? undefined : created.promise;
};

export const suspendedQueryCount = (database: ClientDatabase): number =>
  SUSPENSIONS.get(database)?.size ?? 0;
