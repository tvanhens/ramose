/**
 * Thin live-query consumer for tests. Reads NDJSON `{ added, retracted }`
 * frames from a real Response body. Not a production frontend and not a
 * transport peer.
 */

import { parseJson, stringifyJson } from "../../packages/ramose/src/internal/core/json.ts";

export type LiveQueryDiff = {
  readonly added: readonly unknown[];
  readonly retracted: readonly unknown[];
};

/**
 * A live-query response, plus the one escape hatch a stalled read needs.
 *
 * Abandoning `iterator.next()` is not enough to unstick a stalled stream: the
 * read stays pending inside the generator, so a later `iterator.return()`
 * queues behind it and cleanup hangs. Cancelling the body reader settles the
 * pending read, which lets the generator's own `finally` run and the queued
 * `return()` resolve. `closeObservedStream` in `../support/stream.ts` is the
 * consumer of this.
 */
export type ObservedLiveStream =
  & AsyncGenerator<LiveQueryDiff, void, undefined>
  & { readonly cancelTransport: () => Promise<void> };

export function readLiveNdjson(response: Response): ObservedLiveStream {
  // Assigned once the generator body starts; until the first read there is
  // nothing pending that could need settling.
  let cancelReader: () => Promise<void> = async () => {};
  const diffs = (async function* (): AsyncGenerator<
    LiveQueryDiff,
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
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          yield parseJson(line) as LiveQueryDiff;
        }
        if (done) break;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        reader.releaseLock();
      }
    }
  })();
  return Object.assign(diffs, {
    cancelTransport: (): Promise<void> => cancelReader(),
  });
}

export const collectLive = async (
  response: Response,
  limit?: number,
): Promise<LiveQueryDiff[]> => {
  const out: LiveQueryDiff[] = [];
  for await (const diff of readLiveNdjson(response)) {
    out.push(diff);
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
};

export const applyLiveDiffs = (diffs: readonly LiveQueryDiff[]): unknown[] => {
  const rows: unknown[] = [];
  for (const diff of diffs) {
    for (const row of diff.retracted) {
      const key = stringifyJson(row);
      const index = rows.findIndex((candidate) => stringifyJson(candidate) === key);
      if (index !== -1) rows.splice(index, 1);
    }
    rows.push(...diff.added);
  }
  return rows;
};
