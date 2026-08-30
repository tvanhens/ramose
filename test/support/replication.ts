/**
 * Thin consumer for the real replication response used by local acceptance
 * tests. It decodes the frozen public codec and applies the pure client state
 * machine; it does not implement a peer or substitute any infrastructure.
 */

import * as Result from "effect/Result";
import {
  MAX_REPLICATION_FRAME_BYTES,
  applyReplicationFrame,
  decodeReplicationFrame,
  emptyClientReplicationState,
  type ClientReplicationState,
  type ReplicationFrame,
} from "../../packages/ramose/src/internal/replication/index.ts";

const utf8 = new TextEncoder();

export type ObservedReplicationFrame = {
  readonly wire: string;
  readonly frame: ReplicationFrame;
};

const decodeLine = (wire: string): ObservedReplicationFrame => {
  const decoded = decodeReplicationFrame(wire);
  if (Result.isFailure(decoded)) throw decoded.failure;
  return Object.freeze({ wire, frame: decoded.success });
};

const assertFrameBound = (wire: string): void => {
  if (utf8.encode(wire).byteLength > MAX_REPLICATION_FRAME_BYTES) {
    throw new RangeError("replication frame exceeded its public bound");
  }
};

const splitDecoded = (
  unfinished: string,
  decoded: string,
): { readonly lines: readonly string[]; readonly unfinished: string } => {
  const pieces = decoded.split("\n");
  if (pieces.length === 1) {
    const next = unfinished + decoded;
    assertFrameBound(next);
    return { lines: [], unfinished: next };
  }
  const lines = [unfinished + pieces[0]!, ...pieces.slice(1, -1)];
  for (const line of lines) assertFrameBound(line);
  const next = pieces.at(-1)!;
  assertFrameBound(next);
  return { lines, unfinished: next };
};

/** Decode arbitrary transport chunks while bounding each NDJSON frame alone. */
export async function* decodeReplicationNdjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<ObservedReplicationFrame, void, undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  for await (const chunk of chunks) {
    const split = splitDecoded(buffer, decoder.decode(chunk, { stream: true }));
    buffer = split.unfinished;
    for (const wire of split.lines) {
      if (wire.length > 0) yield decodeLine(wire);
    }
  }
  const final = splitDecoded(buffer, decoder.decode());
  for (const wire of final.lines) {
    if (wire.length > 0) yield decodeLine(wire);
  }
  if (final.unfinished.trim().length > 0) {
    // The Worker writes every frame newline-terminated
    // (`src/worker/authorized-replication.ts`), and the product decoder in
    // `internal/replication/transport.ts` fails an unterminated tail with
    // "replication stream ended without a newline". A leftover fragment is
    // therefore a truncated transport, never a frame. Decoding it produced a
    // `ReplicationProtocolError { reason: "malformed" }` that read as a
    // protocol violation by the product when the connection had merely been
    // cut mid-frame. Report the truncation so `malformed` keeps meaning
    // exactly one thing: a complete frame the product got wrong.
    throw new Error("replication stream ended without a newline");
  }
}

/**
 * A live replication response, plus the one escape hatch a stalled read
 * needs.
 *
 * Abandoning `iterator.next()` is not enough to unstick a stalled stream:
 * the read stays pending inside the generator, and a later
 * `iterator.return()` queues *behind* it, so cleanup hangs and the test
 * still burns its whole timeout. Cancelling the body reader settles the
 * pending read, which lets the generator's own `finally` run and the queued
 * `return()` resolve.
 */
export type ObservedReplicationStream =
  & AsyncGenerator<ObservedReplicationFrame, void, undefined>
  & { readonly cancelTransport: () => Promise<void> };

export const readReplicationNdjson = (
  response: Response,
): ObservedReplicationStream => {
  // Assigned once the generator body starts; until the first read there is
  // nothing pending that could need settling.
  let cancelReader: () => Promise<void> = async () => {};
  const frames = (async function* (): AsyncGenerator<
    ObservedReplicationFrame,
    void,
    undefined
  > {
    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    cancelReader = async () => {
      try {
        await reader.cancel();
      } catch {
        // A stalled or already-errored reader needs no further cancellation.
      }
    };
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    })();
    try {
      yield* decodeReplicationNdjson(chunks);
    } finally {
      try {
        await chunks.return?.(undefined);
      } catch {
        // The adapter's finally already released the reader lock.
      }
    }
  })();
  return Object.assign(frames, {
    cancelTransport: (): Promise<void> => cancelReader(),
  });
};

export const applyObservedFrame = (
  state: ClientReplicationState,
  observed: ObservedReplicationFrame,
): ClientReplicationState => {
  const next = applyReplicationFrame(state, observed.frame);
  if (Result.isFailure(next)) throw next.failure;
  return next.success;
};

const withDeadline = async <A>(
  promise: Promise<A>,
  milliseconds: number,
  message: string,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export type CollectedSnapshot = {
  readonly state: ClientReplicationState;
  readonly frames: readonly ObservedReplicationFrame[];
};

/**
 * Every other read in these suites is bounded (`withTimeout(next, 7_000)`).
 * This one was not, so a stalled transport spent the caller's whole 90s
 * default test budget and then reported only "timed out after 90000ms" with
 * no indication of where. Bound the whole collection instead: a snapshot for
 * these fixtures commits in milliseconds, so the deadline never fires on a
 * healthy stack, and when the transport does stall the failure names itself
 * with time left for the rest of the file.
 */
const SNAPSHOT_DEADLINE_MS = 20_000;

export const collectCommittedSnapshot = async (
  iterator:
    | AsyncIterator<ObservedReplicationFrame>
    | ObservedReplicationStream,
  initial: ClientReplicationState = emptyClientReplicationState(),
  deadlineMs: number = SNAPSHOT_DEADLINE_MS,
): Promise<CollectedSnapshot> => {
  let state = initial;
  const frames: ObservedReplicationFrame[] = [];
  const expiry = Date.now() + deadlineMs;
  const expired = `replication snapshot did not commit within ${deadlineMs}ms`;
  const cancelTransport =
    (iterator as Partial<ObservedReplicationStream>).cancelTransport;
  for (;;) {
    const remaining = expiry - Date.now();
    if (remaining <= 0) throw new Error(expired);
    const pending = iterator.next();
    let next: IteratorResult<ObservedReplicationFrame>;
    try {
      next = await withDeadline(pending, remaining, expired);
    } catch (error) {
      // Stopping the await is not enough: the read is still pending inside
      // the generator, so the caller's `closeIterator` would queue its
      // `return()` behind it and hang to the 90s default anyway — the exact
      // cascade this bound exists to prevent. Cancel the reader so the
      // pending read settles, and swallow its late outcome, which nobody is
      // waiting for any more.
      void pending.catch(() => undefined);
      await cancelTransport?.();
      throw error;
    }
    if (next.done) throw new Error("replication closed before snapshot commit");
    frames.push(next.value);
    state = applyObservedFrame(state, next.value);
    if (next.value.frame.type === "SnapshotCommit") {
      if (state.committed === undefined) {
        throw new Error("snapshot commit did not install a complete value");
      }
      return Object.freeze({ state, frames: Object.freeze(frames) });
    }
  }
};
