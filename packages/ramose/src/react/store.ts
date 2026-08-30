/**
 * The external store `useSyncExternalStore` binds to.
 *
 * React's contract is narrow and unforgiving: `subscribe` must keep the same
 * identity across renders or React tears the subscription down and rebuilds it
 * on every commit, and `getSnapshot` must return a value that is `Object.is`-
 * equal until something actually changed or React re-renders forever. The
 * client already guarantees both for *its* snapshot; this module is the join
 * between that guarantee and React's, and nothing else.
 *
 * It owns no state of its own. Every value it returns is one the client
 * published, narrowed by {@link toQueryState}.
 */

import type { QuerySnapshot } from "../client/database.ts";
import type { ClientDatabase, QuerySubscription } from "../client/index.ts";
import { PENDING, toQueryState, type QueryState } from "./query-state.ts";

/**
 * One database's React stores, keyed by canonical query identity.
 *
 * Weak on the database so a client an application dropped takes its stores with
 * it, and keyed inside by the same canonical identity the client interns
 * observations under, so two components asking the same question share one
 * store — and therefore one `subscribe` identity, one narrowed snapshot object,
 * and one observation underneath.
 *
 * This is the borrowed piece, and the only one: a per-render `db.observe(...)`
 * returns a fresh subscription value by design (it retains nothing until it is
 * subscribed), so binding React directly to it would hand `useSyncExternalStore`
 * a new `subscribe` on every render.
 */
const STORES = new WeakMap<ClientDatabase, Map<string, QueryStore<unknown>>>();

/**
 * One query's React-facing store.
 *
 * The underlying subscription is created once, when the store is, and reused
 * for the store's whole life. That is legal precisely because the client's
 * subscription value is not the observation: it reattaches when it is
 * resubscribed, and answers with what the observation was showing when it is
 * not — which is what makes an unmount/remount cost no `pending` flash.
 */
class QueryStore<A> {
  /** The last snapshot narrowed, so the narrowing runs once per change. */
  private lastSnapshot: QuerySnapshot<A> | undefined;
  private lastState: QueryState<A> = PENDING;
  private listeners = 0;

  constructor(
    private readonly database: ClientDatabase,
    private readonly key: string,
    private readonly source: QuerySubscription<A>,
  ) {}

  /**
   * Bound once, so React sees one identity for the store's whole life.
   *
   * Re-adopting on the way in matters under Strict Mode and under an unmount
   * followed by a remount: the store leaves the cache when its last listener
   * does, and a component still holding it must put it back rather than let a
   * sibling asking the same question build a second one.
   */
  readonly subscribe = (onChange: () => void): (() => void) => {
    if (this.listeners === 0) adopt(this.database, this.key, this.erased());
    this.listeners++;
    const stop = this.source.subscribe(onChange);
    let released = false;
    return () => {
      // Idempotent, matching the neutral contract: React can and does call a
      // cleanup twice, and a second call must not release a listener a later
      // subscribe installed.
      if (released) return;
      released = true;
      stop();
      this.listeners--;
      if (this.listeners === 0) release(this.database, this.key, this.erased());
    };
  };

  /** This store, as the cache holds it. The cache never reads `A`. */
  private erased(): QueryStore<unknown> {
    return this as unknown as QueryStore<unknown>;
  }

  /**
   * Bound once, and allocation-free while nothing changed.
   *
   * The client's snapshot identity changes if and only if the value did, so
   * comparing against the last one it narrowed is a complete check — there is
   * nothing to recompute and nothing to compare structurally.
   */
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
    STORES.set(database, new Map([[key, store]]));
    return;
  }
  // Only into an empty slot: a store that outlived its cache entry must not
  // evict the replacement other components are already subscribed to.
  if (!stores.has(key)) stores.set(key, store);
};

const release = (
  database: ClientDatabase,
  key: string,
  store: QueryStore<unknown>,
): void => {
  const stores = STORES.get(database);
  // Same guard, in the other direction: a release that raced a re-adoption
  // must not drop the store that won.
  if (stores?.get(key) === store) stores.delete(key);
};

/**
 * The store for one query on one database, creating it only on a miss.
 *
 * Safe to call during rendering, including a render React then throws away:
 * a store nothing subscribes to is never adopted into the cache, and the
 * subscription it holds retains no observation.
 */
export const queryStore = <A>(
  database: ClientDatabase,
  key: string,
  observe: () => QuerySubscription<A>,
): QueryStore<A> => {
  const existing = STORES.get(database)?.get(key);
  if (existing !== undefined) return existing as unknown as QueryStore<A>;
  return new QueryStore(database, key, observe());
};

/**
 * How many stores one database currently holds.
 *
 * Not public API and not exported from `ramose/react`: it reads the real cache
 * rather than standing in for it, so a test can assert that unmounting a
 * component left nothing behind.
 */
export const heldStoreCount = (database: ClientDatabase): number =>
  STORES.get(database)?.size ?? 0;

export type { QueryStore };
