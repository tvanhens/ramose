import type { QuerySnapshot } from "../client/database.ts";
import type { ClientDatabase, QuerySubscription } from "../client/index.ts";
import { PENDING, toQueryState, type QueryState } from "./query-state.ts";

export const UNCLAIMED_LIMIT = 32;

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

  readonly subscribe = (onChange: () => void): (() => void) => {
    const stop = this.retain(onChange);
    const stores = STORES.get(this.database);
    if (stores?.stores.get(this.key) === this.erased()) {
      stores.unclaimed.delete(this.key);
    }
    this.hold?.onClaimed();
    return stop;
  };

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

export const heldStoreCount = (database: ClientDatabase): number =>
  STORES.get(database)?.stores.size ?? 0;

export type { QueryStore };
