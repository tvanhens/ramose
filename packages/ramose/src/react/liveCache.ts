/**
 * Refcounted standing-query cache for `useLive(db, q[, params])`.
 *
 * Two hook sites with the same `(viewKey, astKey[, paramsKey])` share one
 * `db.live` handle. The last `close()` tears it down. The subscription
 * form (`useLive(sub)`) does not go through this — the caller owns that
 * handle.
 */

import type { Subscription } from "../db/index.ts";

interface Entry {
  readonly sub: Subscription<unknown, unknown>;
  refs: number;
}

const cache = new Map<string, Entry>();

/**
 * Hold a shared subscription for `key`. `create` runs only on the first
 * retain; each caller gets a wrapper whose `close()` drops one ref.
 */
export const retainLive = (
  key: string,
  create: () => Subscription<unknown, unknown>,
): Subscription<unknown, unknown> => {
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = { sub: create(), refs: 0 };
    cache.set(key, entry);
  }
  entry.refs += 1;
  const held = entry;
  return {
    subscribe: (onValue, onError) => held.sub.subscribe(onValue, onError),
    [Symbol.asyncIterator]: () => held.sub[Symbol.asyncIterator](),
    close() {
      held.refs -= 1;
      if (held.refs > 0) return;
      if (cache.get(key) === held) cache.delete(key);
      held.sub.close();
    },
  };
};
