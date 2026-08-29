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
    yield decodeLine(final.unfinished);
  }
}

export async function* readReplicationNdjson(
  response: Response,
): AsyncGenerator<ObservedReplicationFrame, void, undefined> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
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
}

export const applyObservedFrame = (
  state: ClientReplicationState,
  observed: ObservedReplicationFrame,
): ClientReplicationState => {
  const next = applyReplicationFrame(state, observed.frame);
  if (Result.isFailure(next)) throw next.failure;
  return next.success;
};

export type CollectedSnapshot = {
  readonly state: ClientReplicationState;
  readonly frames: readonly ObservedReplicationFrame[];
};

export const collectCommittedSnapshot = async (
  iterator: AsyncIterator<ObservedReplicationFrame>,
  initial: ClientReplicationState = emptyClientReplicationState(),
): Promise<CollectedSnapshot> => {
  let state = initial;
  const frames: ObservedReplicationFrame[] = [];
  for (;;) {
    const next = await iterator.next();
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
