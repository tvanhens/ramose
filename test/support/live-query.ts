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

export async function* readLiveNdjson(response: Response): AsyncGenerator<LiveQueryDiff> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
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
    reader.releaseLock();
  }
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
  const rows = new Map<string, unknown>();
  for (const diff of diffs) {
    for (const row of diff.retracted) rows.delete(stringifyJson(row));
    for (const row of diff.added) rows.set(stringifyJson(row), row);
  }
  return [...rows.values()];
};
