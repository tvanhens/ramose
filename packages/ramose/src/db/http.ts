/**
 * @internal The HTTPS half of the transport.
 *
 * One request: JSON in (`toJson`, so instants / bytes / uuids survive), the
 * body out through `fromJson`, and a non-2xx classified into one of the eight
 * tagged failures by {@link fromResponse}. Writes always come through here —
 * `POST /db/:name/transact` is the one writer — and reads fall back to it when
 * the client was given no `WebSocket`.
 *
 * Nothing here is on the `ramose/db` barrel: HTTP is Worker
 * internals, not a second public API.
 */

import { fromJson, toJson } from "../internal/core/json.ts";
import * as Effect from "effect/Effect";
import { type DbError, fromResponse, NetworkError } from "./Errors.ts";

/**
 * The `fetch` seam, narrowed to what the client actually calls.
 *
 * `typeof fetch` fits it, and so does a Cloudflare service binding
 * (`(url, init) => env.Peer.fetch(url, init)`), which is how a Worker reaches
 * the peer without a public hop.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
  },
) => Promise<Response>;

/** The ambient `fetch`, bound once. */
export const globalFetch: FetchLike = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body });

/** Adapt a standard `fetch` (what {@link ClientOptions} takes) to the seam. */
export const fromStandardFetch = (f: typeof fetch): FetchLike =>
  (url, init) =>
    f(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    } as RequestInit);

/** Drop `undefined` fields — JSON would otherwise send them as `null`. */
export const compact = (
  o: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

export const record = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

/** The read fence, as the header the peer reads it from. */
export const minTHeader = (
  minT: number | undefined,
): Record<string, string> =>
  minT === undefined ? {} : { "x-ramose-min-t": String(minT) };

export interface RawResult {
  readonly body: unknown;
  readonly headers: { get(name: string): string | null };
}

export interface SendOptions {
  readonly fetch: FetchLike;
  /** Peer base URL, no trailing slash. */
  readonly url: string;
  readonly method: string;
  /** Path under the base (`/db/movies/transact`). */
  readonly path: string;
  readonly token?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown;
}

/** How many times one request is attempted before a transient failure surfaces. */
const TRANSIENT_ATTEMPTS = 6;

/**
 * The one transient-retry policy, for every transport. `Unavailable` and
 * `NetworkError` are retried on a jittered exponential ladder (~150ms
 * doubling to 2s; ~4s of sleep in total); anything else surfaces at once.
 * `attempt` receives the attempt index, `0` first. `while` ends the ladder
 * early when a retry cannot help — a closed client, where nothing reopens.
 */
export const retryTransient = <A>(
  attempt: (n: number) => Effect.Effect<A, DbError>,
  options?: { readonly while?: (() => boolean) | undefined },
): Effect.Effect<A, DbError> => {
  const go = (n: number): Effect.Effect<A, DbError> =>
    attempt(n).pipe(
      Effect.catch((e: DbError) => {
        if (
          n + 1 >= TRANSIENT_ATTEMPTS ||
          !isTransientPlatform(e) ||
          options?.while?.() === false
        ) {
          return Effect.fail(e);
        }
        // Jittered so concurrent callers do not retry in lockstep.
        const ms = Math.round(
          Math.min(2000, 150 * 2 ** n) * (0.5 + Math.random()),
        );
        return Effect.sleep(`${ms} millis`).pipe(Effect.andThen(() => go(n + 1)));
      }),
    );
  return go(0);
};

/** One request, classified. The only place the client touches `fetch`. */
export const send = (
  options: SendOptions,
): Effect.Effect<RawResult, DbError> =>
  retryTransient((n) => sendOnce(options, n > 0));

// Platform errors arrive classified: Errors.ts maps workers.dev HTML 404s,
// Cloudflare 1xxx pages and "Worker not found" onto Unavailable.
const isTransientPlatform = (e: DbError): boolean =>
  e._tag === "Unavailable" || e._tag === "NetworkError";

const sendOnce = (
  options: SendOptions,
  fresh = false,
): Effect.Effect<RawResult, DbError> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    };
    // A transient platform error is often pinned to one pooled socket (one
    // edge server keeps serving it). Retries send `Connection: close` so the
    // next attempt dials a fresh server. Ignored where it has no meaning
    // (browsers strip it; service bindings have no connection).
    if (fresh) headers.connection = "close";
    if (options.token !== undefined && options.token.length > 0) {
      headers.authorization = `Bearer ${options.token}`;
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        options.fetch(options.url + options.path, {
          method: options.method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(toJson(options.body)),
        }),
      catch: (cause) =>
        new NetworkError({
          message: `ramose: ${options.method} ${options.path} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new NetworkError({
          message: "ramose: response body could not be read",
          cause,
        }),
    });

    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text };
    }

    if (!response.ok) {
      return yield* Effect.fail(
        fromResponse(response.status, parsed, response.headers),
      );
    }
    return { body: fromJson(parsed), headers: response.headers };
  });
