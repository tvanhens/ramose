import type { QuerySnapshot } from "../client/database.ts";
import type { ClientDatabase, QuerySubscription } from "../client/index.ts";
import { PENDING, toQueryState, type QueryState } from "./query-state.ts";

const STORES = new WeakMap<ClientDatabase, Map<string, QueryStore<unknown>>>();

class QueryStore<A> {
  private lastSnapshot: QuerySnapshot<A> | undefined;
  private lastState: QueryState<A> = PENDING;
  private listeners = 0;

  constructor(
    private readonly database: ClientDatabase,
    private readonly key: string,
    private readonly source: QuerySubscription<A>,
  ) {
    adopt(database, key, this.erased());
  }

  readonly subscribe = (onChange: () => void): (() => void) => {
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
    STORES.set(database, new Map([[key, store]]));
    return;
  }
  if (!stores.has(key)) stores.set(key, store);
};

const release = (
  database: ClientDatabase,
  key: string,
  store: QueryStore<unknown>,
): void => {
  const stores = STORES.get(database);
  if (stores?.get(key) === store) stores.delete(key);
};

export const queryStore = <A>(
  database: ClientDatabase,
  key: string,
  observe: () => QuerySubscription<A>,
): QueryStore<A> => {
  const existing = STORES.get(database)?.get(key);
  if (existing !== undefined) return existing as unknown as QueryStore<A>;
  return new QueryStore(database, key, observe());
};

export const heldStoreCount = (database: ClientDatabase): number =>
  STORES.get(database)?.size ?? 0;

export type { QueryStore };
