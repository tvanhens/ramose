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
  OneShotReadError,
  type AuthorizedLiveInput,
  type LiveQueryDiff,
  type OneShotRead,
  type OneShotReadOptions,
} from "../internal/authorization/index.ts";
import { stringifyJson } from "../internal/core/json.ts";

const encoder = new TextEncoder();

const encodeDiff = (diff: LiveQueryDiff): Uint8Array =>
  encoder.encode(`${stringifyJson(diff)}\n`);

export const liveNdjsonStream = <R, EDb>(
  input: AuthorizedLiveInput<R, EDb> & {
    readonly wakes?: Queue.Dequeue<unknown>;
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
  input: AuthorizedLiveInput<R, EDb>,
  read: OneShotRead,
  opts: OneShotReadOptions,
  headers: Record<string, string>,
): Effect.Effect<Response, EDb | OneShotReadError | Unauthorized, R> =>
  Effect.gen(function* () {
    // Resolve the first read before returning headers so admission and read
    // failures retain their ordinary HTTP status. The live scope recomputes
    // this value under its own lease at the downstream emission boundary.
    yield* executeAuthorizedRead(input, read, opts);
    const context = yield* Effect.context<R>();
    const body = liveNdjsonStream(input, read, opts, context);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        ...headers,
      },
    });
  });
