/**
 * Refcounted standing-query cache for `useLive(db, q[, params])`.
 *
 * Two hook sites with the same `(viewKey, astKey[, paramsKey])` share one
 * `db.live` handle. The last `close()` tears it down. The subscription
 * form (`useLive(sub)`) does not go through this — the caller owns that
 * handle.
 *
 * A terminal error stays on the shared handle until refs hit 0. A later
 * mount while a sibling still holds it replays that error (pre-cache,
 * each hook retried independently).
 */

import type { Subscription } from "../db/index.ts";

interface Entry {
  readonly sub: Subscription<unknown, unknown>;
  refs: number;
}

const cache = new Map<string, Entry>();

/**
 * Hold a shared subscription for `key`. `create` runs only on the first
 * retain; each caller gets a wrapper whose `close()` drops one ref and is
 * idempotent — a second close does not decrement again.
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
  let done = false;
  return {
    subscribe: (onValue, onError) => held.sub.subscribe(onValue, onError),
    [Symbol.asyncIterator]: () => held.sub[Symbol.asyncIterator](),
    close() {
      if (done) return;
      done = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      if (cache.get(key) === held) cache.delete(key);
      held.sub.close();
    },
  };
};
