import type { QuerySnapshot } from "../client/database.ts";
import type { ClientDatabase, QuerySubscription } from "../client/index.ts";
import { PENDING, toQueryState, type QueryState } from "./query-state.ts";

/**
 * How many cached stores may sit unclaimed at once.
 *
 * A store is *claimed* once a mounted component has subscribed to it: from
 * then on React's own refcount decides when it leaves the cache. A store is
 * *unclaimed* between the render that built it and that first subscription —
 * and stays unclaimed forever if the render is abandoned, because React never
 * calls `subscribe` for a component it discarded. Concurrent rendering
 * abandons renders routinely: a descendant suspends, or a transition is
 * interrupted by a newer one, and a search box that queries per keystroke
 * leaves one entry behind per abandoned attempt.
 *
 * Unclaimed entries are evicted oldest-first past this bound. The bound is far
 * above the number of distinct queries one render pass asks, so eviction never
 * separates two components that mounted together on the same question: only a
 * pass with more distinct queries than this could evict an entry a later
 * sibling in the same pass would have shared, and that sibling would then
 * build a second observation rather than lose one.
 */
export const UNCLAIMED_LIMIT = 32;

/**
 * Something observing a store on behalf of a component React has discarded.
 *
 * A suspended component is not alive to hold a subscription, so the value it
 * suspended for would never be computed; the hold observes in its place. It is
 * `settled` once the wait it exists for is over, which is both when it may be
 * evicted and when it may hand its observation to the subscription React
 * finally commits.
 */
export type StoreHold = {
  readonly settled: () => boolean;
  readonly onClaimed: () => void;
  readonly onEvicted: () => void;
};

type DatabaseStores = {
  readonly stores: Map<string, QueryStore<unknown>>;
  readonly unclaimed: Set<string>;
};

const STORES = new WeakMap<ClientDatabase, DatabaseStores>();

class QueryStore<A> {
  private lastSnapshot: QuerySnapshot<A> | undefined;
  private lastState: QueryState<A> = PENDING;
  private listeners = 0;
  private hold: StoreHold | undefined;

  constructor(
    private readonly database: ClientDatabase,
    private readonly key: string,
    private readonly source: QuerySubscription<A>,
  ) {
    adopt(database, key, this.erased());
  }

  /**
   * Observe on behalf of something outside React's lifetime.
   *
   * The returned release is idempotent and drops the store from the cache when
   * it was the last observer, exactly as a component's own release does.
   */
  readonly retain = (onChange: () => void): (() => void) => {
    adopt(this.database, this.key, this.erased());
    const stop = this.source.subscribe(onChange);
    this.listeners++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      stop();
      this.listeners--;
      if (this.listeners === 0) release(this.database, this.key, this.erased());
    };
  };

  /**
   * Observe on behalf of a mounted component, and claim this entry.
   *
   * A hold is told React has taken over only after React's own subscription is
   * wired: a hold that released first would take the observation to zero
   * listeners and retire it between the two.
   */
  readonly subscribe = (onChange: () => void): (() => void) => {
    const stop = this.retain(onChange);
    const stores = STORES.get(this.database);
    if (stores?.stores.get(this.key) === this.erased()) {
      stores.unclaimed.delete(this.key);
    }
    this.hold?.onClaimed();
    return stop;
  };

  /**
   * Take a hold on behalf of a component React discarded.
   *
   * A store a mounted component has already claimed is outside both of a
   * hold's release paths — eviction only reaches unclaimed entries, and the
   * claim that would hand the observation over already happened. So the hold
   * is told at once, which is safe for the same reason the ordering rule in
   * `subscribe` is: a subscriber is already holding this observation open.
   */
  attach(hold: StoreHold): void {
    this.hold = hold;
    const stores = STORES.get(this.database);
    if (
      stores?.stores.get(this.key) === this.erased() &&
      !stores.unclaimed.has(this.key)
    ) {
      hold.onClaimed();
    }
  }

  detach(hold: StoreHold): void {
    if (this.hold === hold) this.hold = undefined;
  }

  held(): StoreHold | undefined {
    return this.hold;
  }

  private erased(): QueryStore<unknown> {
    return this as unknown as QueryStore<unknown>;
  }

  readonly getSnapshot = (): QueryState<A> => {
    const snapshot = this.source.getSnapshot();
    if (snapshot === this.lastSnapshot) return this.lastState;
    this.lastSnapshot = snapshot;
    this.lastState = toQueryState(snapshot, this.lastState);
    return this.lastState;
  };
}

const adopt = (
  database: ClientDatabase,
  key: string,
  store: QueryStore<unknown>,
): void => {
  const stores = STORES.get(database);
  if (stores === undefined) {
    STORES.set(database, {
      stores: new Map([[key, store]]),
      unclaimed: new Set([key]),
    });
    return;
  }
  if (stores.stores.has(key)) return;
  evictUnclaimed(stores, UNCLAIMED_LIMIT - 1);
  stores.stores.set(key, store);
  stores.unclaimed.add(key);
};

/**
 * Drop unclaimed entries, oldest first, until at most `room` remain.
 *
 * A hold that has not settled is skipped: it belongs to a component that is
 * still suspended on it, and releasing its observation would leave that
 * component waiting for a value nothing is computing. If every entry is such a
 * hold the cache exceeds the bound, which is the honest outcome — those are
 * observations an application is actively waiting on.
 */
const evictUnclaimed = (stores: DatabaseStores, room: number): void => {
  if (stores.unclaimed.size <= room) return;
  for (const key of stores.unclaimed) {
    if (stores.unclaimed.size <= room) return;
    const store = stores.stores.get(key);
    const hold = store?.held();
    if (hold !== undefined && !hold.settled()) continue;
    stores.unclaimed.delete(key);
    stores.stores.delete(key);
    hold?.onEvicted();
  }
};

/**
 * Reconsider a database's unclaimed entries.
 *
 * A hold that has just settled became evictable, and nothing else would have
 * looked at the cache until the next render adopted something new.
 */
export const reviewUnclaimed = (database: ClientDatabase): void => {
  const stores = STORES.get(database);
  if (stores !== undefined) evictUnclaimed(stores, UNCLAIMED_LIMIT);
};

const release = (
  database: ClientDatabase,
  key: string,
  store: QueryStore<unknown>,
): void => {
  const stores = STORES.get(database);
  if (stores?.stores.get(key) !== store) return;
  stores.stores.delete(key);
  stores.unclaimed.delete(key);
};

export const queryStore = <A>(
  database: ClientDatabase,
  key: string,
  observe: () => QuerySubscription<A>,
): QueryStore<A> => {
  const existing = STORES.get(database)?.stores.get(key);
  if (existing !== undefined) return existing as unknown as QueryStore<A>;
  return new QueryStore(database, key, observe());
};

/**
 * How many stores this database currently holds.
 *
 * That is the stores mounted components subscribe to, plus at most
 * `UNCLAIMED_LIMIT` that no component has claimed yet.
 */
export const heldStoreCount = (database: ClientDatabase): number =>
  STORES.get(database)?.stores.size ?? 0;

export type { QueryStore };
