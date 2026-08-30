/**
 * The framework-neutral subscription contract.
 *
 * One shape serves every observable thing the client publishes, and it is
 * exactly the pair React's `useSyncExternalStore` wants:
 *
 * ```ts
 * useSyncExternalStore(subscription.subscribe, subscription.getSnapshot)
 * ```
 *
 * Two properties make that safe, and adapters may rely on both:
 *
 * 1. `subscribe` and `getSnapshot` are bound to the subscription value, so
 *    their identities are stable for as long as the caller holds it.
 * 2. `getSnapshot()` returns the *same* value until the thing it describes
 *    actually changes. Nothing recomputes inside `getSnapshot`; it reads a
 *    value the client already published. A listener is notified only when the
 *    snapshot identity changed, so a notification never means "look again, it
 *    might be the same".
 *
 * There is no framework in here and no framework-shaped lifecycle: an adapter
 * subscribes, reads, and unsubscribes.
 */

/** A value that can be observed and read without recomputation. */
export type Subscription<A> = {
  /** Register `onChange`; returns the idempotent unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** The current value. Stable until it changes. */
  readonly getSnapshot: () => A;
};

/**
 * One published value and its listeners.
 *
 * Publishing compares by identity: callers that want structural equality make
 * that decision before calling {@link Store.publish}, which is what keeps the
 * "identity changes iff the value changed" contract in one place per source
 * rather than spread across the notifiers.
 */
export class Store<A> {
  private readonly listeners = new Set<() => void>();
  private value: A;
  readonly subscription: Subscription<A>;

  constructor(initial: A) {
    this.value = initial;
    this.subscription = Object.freeze({
      subscribe: (onChange: () => void) => this.subscribe(onChange),
      getSnapshot: () => this.getSnapshot(),
    });
  }

  getSnapshot(): A {
    return this.value;
  }

  /** How many listeners are attached. Drives observer refcounting. */
  get size(): number {
    return this.listeners.size;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(onChange);
    };
  }

  /** Publish `next`, notifying only when it is not the value already held. */
  publish(next: A): boolean {
    if (Object.is(next, this.value)) return false;
    this.value = next;
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Observation is downstream of state: one throwing listener must not
        // stop the others, and must never fail the publisher.
      }
    }
  }
}

/**
 * Structural equality over query results.
 *
 * Rows are plain serializable values by construction — the query language
 * returns numbers, strings, booleans, `null`, `Date`, `Uint8Array`, arrays, and
 * plain objects — so this is a complete comparison for what a query can
 * produce, not a heuristic. It is what lets a rerun that found nothing new
 * republish the previous snapshot instead of a new equal one.
 */
export const sameResult = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") {
    // Two NaNs are the same result even though `Object.is` already said so;
    // everything else non-object that differs by identity differs by value.
    return false;
  }
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length &&
      left.every((item, index) => sameResult(item, right[index]));
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date &&
      left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((byte, index) => byte === right[index]);
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.hasOwn(right as Record<string, unknown>, key) &&
    sameResult(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    )
  );
};
