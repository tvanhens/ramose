/**
 * Client helpers that talk to a real peer and record the traffic.
 *
 * Use these instead of `scriptedPeer`. The recorder forwards; it does
 * not invent replies.
 */

import * as Ramose from "ramose/db";
import { recordingTransport, type RecordingTransport } from "./recorder.ts";

export { recordingFetch, recordingTransport, recordingWebSocket } from "./recorder.ts";
export type {
  RecordedFrame,
  RecordedHttpCall,
  RecordedSocket,
  RecordingTransport,
} from "./recorder.ts";

export interface LiveClient {
  readonly client: Ramose.Client;
  readonly rec: RecordingTransport;
  close(): Promise<void>;
}

/** `Ramose.connect` against `url` with forwarding HTTP/WebSocket recorders. */
export const connectRecorded = (
  url: string,
  options: Omit<Ramose.ClientOptions, "url" | "fetch" | "webSocket"> = {},
): LiveClient => {
  const rec = recordingTransport();
  const client = Ramose.connect({
    url,
    fetch: rec.fetch,
    webSocket: rec.webSocket,
    ...options,
  });
  return {
    client,
    rec,
    close: () => client.close(),
  };
};

/** Every pass is a handful of microtasks; a tick is plenty. */
export const settle = (ms = 20): Promise<void> => Bun.sleep(ms);

/**
 * Poll until `cond` is true, or throw after `timeoutMs`.
 *
 * Use this for live-session assertions. Negative assertions (nothing more
 * arrived) still want a short `settle()`.
 */
export const until = async (cond: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) {
      throw new Error(`until: timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(5);
  }
};
