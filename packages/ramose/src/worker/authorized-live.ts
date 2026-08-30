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
  input: AuthorizedLiveInput<R, EDb> & {
    readonly wakes?: Queue.Dequeue<unknown>;
  },
  read: OneShotRead,
  opts: OneShotReadOptions,
  context: Context.Context<R>,
): ReadableStream<Uint8Array> =>
  liveDiffNdjsonStream(executeAuthorizedLive(input, read, opts), context);

export const liveDiffNdjsonStream = <R, E>(
  stream: Stream.Stream<LiveQueryDiff, E, R>,
  context: Context.Context<R>,
): ReadableStream<Uint8Array> =>
  Stream.toReadableStreamWith(
    stream.pipe(
      Stream.map(encodeDiff),
      Stream.catchCause(() => Stream.empty),
    ),
    context,
  );

export const liveResponseFromStream = <R, E>(
  stream: Stream.Stream<LiveQueryDiff, E, R>,
  headers: Record<string, string>,
): Effect.Effect<Response, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const body = liveDiffNdjsonStream(stream, context);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        ...headers,
      },
    });
  });

export const authorizedLiveResponse = <R, EDb>(
  input: AuthorizedLiveInput<R, EDb> & {
    readonly admissionCurrentDb?: AuthorizedRequestInput<R, EDb>["currentDb"];
  },
  read: OneShotRead,
  opts: OneShotReadOptions,
  headers: Record<string, string>,
): Effect.Effect<Response, EDb | OneShotReadError | Unauthorized, R> =>
  Effect.gen(function* () {
    yield* executeAuthorizedRead(
      input.admissionCurrentDb === undefined
        ? input
        : { ...input, currentDb: input.admissionCurrentDb },
      read,
      opts,
    );
    return yield* liveResponseFromStream(
      executeAuthorizedLive(input, read, opts),
      headers,
    );
  });
