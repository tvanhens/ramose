/**
 * HTTP live-query admission and NDJSON output. Authorization and diffs
 * come from {@link executeAuthorizedLive}; this file only frames the stream.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Unauthorized } from "../db/Errors.ts";
import {
  executeAuthorizedLive,
  executeAuthorizedRead,
  isSilentLiveDiff,
  liveDiffFromPrevious,
  OneShotReadError,
  type AuthorizedRequestInput,
  type LiveQueryDiff,
  type OneShotRead,
  type OneShotReadOptions,
} from "../internal/authorization/index.ts";
import { stringifyJson } from "../internal/core/json.ts";

const encoder = new TextEncoder();

const encodeDiff = (diff: LiveQueryDiff): Uint8Array =>
  encoder.encode(`${stringifyJson(diff)}\n`);

export const liveNdjsonStream = <R, EDb>(
  input: AuthorizedRequestInput<R, EDb> & {
    readonly previous?: unknown;
    readonly wakes?: Queue.Dequeue<unknown>;
    readonly watchBasis?: boolean;
  },
  read: OneShotRead,
  opts: OneShotReadOptions,
  context: Context.Context<R>,
): ReadableStream<Uint8Array> =>
  Stream.toReadableStreamWith(
    executeAuthorizedLive(input, read, opts).pipe(
      Stream.map(encodeDiff),
      Stream.catchCause(() => Stream.empty),
    ),
    context,
  );

/**
 * Admit the first authorized result, then stream diffs. Admission failures
 * stay on the Effect channel (401/400). Later renewal failures close the
 * body without a reason frame.
 */
export const authorizedLiveResponse = <R, EDb>(
  input: AuthorizedRequestInput<R, EDb>,
  read: OneShotRead,
  opts: OneShotReadOptions,
  headers: Record<string, string>,
): Effect.Effect<Response, EDb | OneShotReadError | Unauthorized, R> =>
  Effect.gen(function* () {
    const initial = yield* executeAuthorizedRead(input, read, opts);
    const opening = liveDiffFromPrevious(undefined, initial);
    const context = yield* Effect.context<R>();
    const rest = liveNdjsonStream(
      { ...input, previous: initial, watchBasis: true },
      read,
      opts,
      context,
    );
    const first = isSilentLiveDiff(opening) ? new Uint8Array() : encodeDiff(opening);
    const body = first.byteLength === 0
      ? rest
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first);
            const reader = rest.getReader();
            const pump = (): Promise<void> =>
              reader.read().then(({ done, value }) => {
                if (done) {
                  controller.close();
                  return;
                }
                controller.enqueue(value);
                return pump();
              }, (error: unknown) => {
                controller.error(error);
              });
            void pump();
          },
          cancel() {
            void rest.cancel();
          },
        });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        ...headers,
      },
    });
  });
