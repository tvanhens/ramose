/**
 * Standing-read handle. App code subscribes or iterates; teardown is
 * `close()` (or breaking out of `for await`). Effect users who want a
 * `Stream` use `db.effect.live` / `db.effect.livePull`.
 */

export interface Subscription<A, E = unknown> {
  /**
   * Push each emission into `onValue`. Terminal failures go to `onError`
   * (the tagged error itself, not a Cause). Returns unsubscribe — the
   * standing read keeps running until {@link close}.
   */
  subscribe(
    onValue: (value: A) => void,
    onError?: (error: E) => void,
  ): () => void;
  /** Async iteration over emissions. A terminal failure throws the tagged error. */
  [Symbol.asyncIterator](): AsyncIterator<A>;
  /** Stop the standing read. Idempotent. */
  close(): void;
}
