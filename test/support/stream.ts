/**
 * The bounds the local suites rely on to survive a stalled transport.
 *
 * A `test/local` file shares one Alchemy dev stack across ~96 tests, so the
 * cost of a stalled request is not that one test fails. It is that reaching
 * Bun's 90s default budget makes Bun kill the processes spawned under the
 * timed-out test — the dev stack itself — after which every remaining test in
 * the file fails `ConnectionRefused`. Eight conformance runs in the #564
 * window read exactly that way: one hang, then ~40 unrelated failures. Both
 * helpers here exist to keep a stall inside its own test.
 *
 * They live outside `test/local/fixtures.ts` so they can be exercised
 * directly: importing that module registers a stack deploy.
 */

/**
 * Ceiling on one request/response exchange against the local stack.
 *
 * Nothing these suites send is a long poll — the whole file finishes in about
 * a minute — so anything still outstanding here is wedged.
 */
export const REQUEST_DEADLINE_MS = 45_000;

/**
 * Bound one exchange with a timer this module owns.
 *
 * Arming `AbortSignal.timeout` on the `fetch` was not enough. Eight
 * conformance runs in the #564 window show a `POST /db/graph-path-root/op`
 * parked behind a mid-read replication stream (#551) burning the caller's
 * entire 90s budget with that signal armed and never firing. Racing the
 * exchange against a plain timer bounds it whatever `fetch` does with the
 * signal, and the `AbortController` still fires so the socket is released
 * rather than left pending.
 *
 * This is a deadline, never a retry: the request is abandoned and the failure
 * names the path that hung.
 */
export const withRequestDeadline = async <A>(
  exchange: (signal: AbortSignal) => Promise<A>,
  label: string,
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<A> => {
  const controller = new AbortController();
  let expired: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = new Error(`${label} did not answer within ${deadlineMs}ms`);
      controller.abort(expired);
      reject(expired);
    }, deadlineMs);
  });
  try {
    return await Promise.race([
      // When `fetch` does honour the signal the abort surfaces here first;
      // report the deadline that caused it rather than the raw abort.
      exchange(controller.signal).catch((error) => {
        throw expired ?? error;
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** A stream that can settle its own pending read. */
export type CancellableStream = {
  readonly cancelTransport?: () => Promise<void>;
};

/** Ceiling on abandoning one stream. A healthy close settles immediately. */
const CLOSE_DEADLINE_MS = 5_000;

/**
 * Bounded cleanup for the NDJSON streams these suites hold open.
 *
 * Closing one is not the trivial step it looks like. Every reader here is an
 * async generator parked in `await reader.read()`, so an `iterator.return()`
 * queues *behind* that pending read and only resolves when a frame arrives —
 * which, for the stalled stream a test is abandoning, is never. An awaited
 * close in a `finally` therefore consumes the caller's whole 90s budget, and
 * reaching that budget is what takes the shared dev stack down with it.
 *
 * So: cancel the transport first, which settles the pending read and lets the
 * generator's own `finally` run, then wait only briefly for the queued
 * `return()`. A close that still has not settled is abandoned rather than
 * awaited — cleanup must never cost more than the assertions it follows, and
 * a test that already failed must not lose its own diagnosis to a hung close.
 */
export const closeObservedStream = async (
  iterator:
    & Partial<Pick<AsyncIterator<unknown>, "return">>
    & CancellableStream,
  deadlineMs: number = CLOSE_DEADLINE_MS,
): Promise<void> => {
  // Both steps are inside the bound. Cancelling first is what lets the queued
  // `return()` resolve at all, but a cancel on a wedged transport can stall
  // too, and a bound that only covers the second step is no bound.
  const closed = (async () => {
    await iterator.cancelTransport?.();
    await iterator.return?.(undefined);
    // Nobody is waiting on the outcome; the caller only needs to move on.
  })().then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([closed, abandoned]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
