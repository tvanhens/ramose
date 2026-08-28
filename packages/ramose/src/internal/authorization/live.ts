/**
 * Leased server live queries (#415).
 *
 * One authorization lease/epoch covers recomputation, enqueue, and emission.
 * Each authorized basis rebuilds the filtered {@link Db} through
 * {@link executeAuthorizedRequest} and runs the ordinary one-shot read.
 * Output is additions and retractions of that result. Raw transaction
 * datoms, IDs, counts, rule facts, and hidden-only sequence events are
 * never forwarded. There is no second live authorization predicate.
 */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Unauthorized } from "../../db/Errors.ts";
import { stringifyJson } from "../core/json.ts";
import { checkpoint } from "../test-hooks.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import {
  executeAuthorizedRequest,
  type AuthenticatedCaller,
  type AuthorizedRequestInput,
} from "./request.ts";
import {
  OneShotReadError,
  runOneShotRead,
  type OneShotRead,
  type OneShotReadOptions,
} from "./reads.ts";

const deny = (): Unauthorized => new Unauthorized({});

const ABSENT: unique symbol = Symbol("ramose/live/absent");
type Absent = typeof ABSENT;

export type LiveQueryDiff = {
  readonly added: readonly unknown[];
  readonly retracted: readonly unknown[];
};

export type AuthorizedLiveInput<R = never, EDb = unknown> = AuthorizedRequestInput<R, EDb> & {
  /** Already-authorized result; the stream waits for a wake or lease renew. */
  readonly previous?: unknown;
  /** Basis-change signals. Extra offers coalesce on a sliding slot. */
  readonly wakes?: Queue.Dequeue<unknown>;
  /** Completing this invalidates the current epoch and closes uniformly. */
  readonly revoked?: Deferred.Deferred<void>;
  /** Poll `currentDb` for `basisT` changes. Worker live output sets this. */
  readonly watchBasis?: boolean;
  readonly pollEvery?: Duration.Input;
};

type QueuedSnapshot = {
  readonly id: number;
  readonly expiresAtMs: number;
  readonly value: unknown;
};

const leaseLimit = (interruptAfter: Duration.Input | undefined): Duration.Duration =>
  Duration.min(
    Duration.fromInputUnsafe(interruptAfter ?? MAX_READ_LEASE_MS),
    Duration.millis(MAX_READ_LEASE_MS),
  );

const callerLease = (
  caller: AuthenticatedCaller,
  nowMs: number,
  limit: Duration.Duration,
): Result.Result<{ readonly duration: Duration.Duration; readonly expiresAtMs: number }, Unauthorized> => {
  if (!Number.isSafeInteger(caller.exp)) return Result.fail(deny());
  const remainingMs = caller.exp * 1_000 - nowMs;
  if (remainingMs <= 0) return Result.fail(deny());
  const duration = Duration.min(limit, Duration.millis(remainingMs));
  return Result.succeed({ duration, expiresAtMs: nowMs + Duration.toMillis(duration) });
};

const atBoundary = (name: string): Effect.Effect<void, Unauthorized> =>
  Effect.tryPromise({
    try: () => checkpoint(name),
    catch: () => deny(),
  });

/** Query / pull / entity / lookup results as a bag of comparable rows. */
export const liveResultRows = (value: unknown): readonly unknown[] => {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

export const isSilentLiveDiff = (diff: LiveQueryDiff): boolean =>
  diff.added.length === 0 && diff.retracted.length === 0;

/**
 * Additions and retractions between two authorized one-shot results.
 * Membership is by canonical JSON; hidden facts and transaction metadata
 * cannot appear because they are not in either result.
 */
export const diffAuthorizedResults = (previous: unknown, next: unknown): LiveQueryDiff => {
  const prevRows = liveResultRows(previous);
  const nextRows = liveResultRows(next);
  const prevKeys = new Map<string, unknown>();
  const nextKeys = new Map<string, unknown>();
  for (const row of prevRows) prevKeys.set(stringifyJson(row), row);
  for (const row of nextRows) nextKeys.set(stringifyJson(row), row);
  const added: unknown[] = [];
  const retracted: unknown[] = [];
  for (const [key, row] of nextKeys) {
    if (!prevKeys.has(key)) added.push(row);
  }
  for (const [key, row] of prevKeys) {
    if (!nextKeys.has(key)) retracted.push(row);
  }
  return { added, retracted };
};

export const liveDiffFromPrevious = (
  previous: unknown | undefined,
  next: unknown,
): LiveQueryDiff =>
  previous === undefined ? { added: liveResultRows(next), retracted: [] } : diffAuthorizedResults(previous, next);

const remainingOf = (expiresAtMs: number, nowMs: number): Duration.Duration =>
  Duration.millis(Math.max(0, expiresAtMs - nowMs));

const waitWakeOrLease = (
  wakes: Queue.Dequeue<unknown>,
  remaining: Duration.Duration,
): Effect.Effect<void> => {
  if (Duration.toMillis(remaining) <= 0) return Effect.void;
  return Effect.race(Queue.take(wakes), Effect.sleep(remaining)).pipe(Effect.asVoid);
};

const readAuthorized = (
  db: Parameters<typeof runOneShotRead>[0],
  read: OneShotRead,
  opts: OneShotReadOptions,
): Effect.Effect<unknown, OneShotReadError> =>
  Effect.tryPromise({
    try: () => runOneShotRead(db, read, opts),
    catch: (cause) => new OneShotReadError({ cause }),
  });

/**
 * Live output over ordinary filtered values. Reuses one-shot query, pull,
 * entity, lookup, refs, graph, aggregation, ordering, and limit behavior.
 */
export const executeAuthorizedLive = <R, EDb = unknown>(
  input: AuthorizedLiveInput<R, EDb>,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
): Stream.Stream<LiveQueryDiff, Unauthorized | OneShotReadError | EDb, R> =>
  Stream.callback<LiveQueryDiff, Unauthorized | OneShotReadError | EDb, R>(
    (out) =>
      Effect.gen(function* () {
        const pending = yield* Queue.sliding<QueuedSnapshot, Cause.Done>(1);
        const wakes = yield* Queue.dropping<void>(1);
        const epoch = yield* Ref.make(0);
        const lastSent = yield* Ref.make<unknown | Absent>(
          input.previous === undefined ? ABSENT : input.previous,
        );
        const limit = leaseLimit(input.interruptAfter);
        let seeded = input.previous !== undefined;

        if (input.wakes !== undefined) {
          const external = input.wakes;
          yield* Effect.forkChild(
            Effect.forever(Queue.take(external).pipe(Effect.andThen(Queue.offer(wakes, undefined)))),
          );
        }
        if (input.watchBasis === true) {
          const pollEvery = Duration.fromInputUnsafe(input.pollEvery ?? 250);
          yield* Effect.forkChild(
            Effect.gen(function* () {
              let lastT = Number.NaN;
              while (true) {
                yield* Effect.sleep(pollEvery);
                const snapshot = yield* input.currentDb(input.routeDatabase).pipe(Effect.option);
                if (Option.isNone(snapshot)) continue;
                const nextT = snapshot.value.basisT;
                if (lastT === nextT) continue;
                const first = Number.isNaN(lastT);
                lastT = nextT;
                if (!first) yield* Queue.offer(wakes, undefined);
              }
            }).pipe(Effect.ignoreCause),
          );
        }
        const invalidate = Ref.update(epoch, (id) => id + 1);
        const revoked =
          input.revoked === undefined
            ? Effect.never
            : Deferred.await(input.revoked).pipe(Effect.andThen(invalidate), Effect.andThen(Effect.fail(deny())));

        const close = Queue.end(pending).pipe(Effect.andThen(Queue.end(out)), Effect.asVoid);
        const emitLoop = Effect.forever(
          Effect.gen(function* () {
            const item = yield* Queue.take(pending);
            yield* atBoundary("live.emit");
            const nowMs = yield* Clock.currentTimeMillis;
            const current = yield* Ref.get(epoch);
            if (item.id !== current || nowMs >= item.expiresAtMs) return;
            const sent = yield* Ref.get(lastSent);
            const diff =
              sent === ABSENT
                ? liveDiffFromPrevious(undefined, item.value)
                : diffAuthorizedResults(sent, item.value);
            if (isSilentLiveDiff(diff)) {
              yield* Ref.set(lastSent, item.value);
              return;
            }
            const still = yield* Ref.get(epoch);
            const again = yield* Clock.currentTimeMillis;
            if (still !== item.id || again >= item.expiresAtMs) return;
            yield* Queue.offer(out, diff);
            yield* Ref.set(lastSent, item.value);
          }),
        ).pipe(Effect.ignoreCause);

        const recompute = (
          caller: AuthenticatedCaller,
          id: number,
          expiresAtMs: number,
        ): Effect.Effect<void, Unauthorized | OneShotReadError | EDb, R> =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const left = remainingOf(expiresAtMs, nowMs);
            if (Duration.toMillis(left) <= 0) return;
            yield* executeAuthorizedRequest(
              {
                ...input,
                authenticate: Effect.succeed(caller),
                interruptAfter: left,
              },
              (filteredDb) =>
                Effect.gen(function* () {
                  const value = yield* readAuthorized(filteredDb, read, opts);
                  yield* atBoundary("live.recompute");
                  const current = yield* Ref.get(epoch);
                  if (current !== id) return;
                  yield* atBoundary("live.enqueue");
                  const still = yield* Ref.get(epoch);
                  const enqueueNow = yield* Clock.currentTimeMillis;
                  if (still !== id || enqueueNow >= expiresAtMs) return;
                  yield* Queue.offer(pending, { id, expiresAtMs, value });
                }),
            );
          });

        const leaseLoop = Effect.gen(function* () {
          while (true) {
            const admitted = yield* input.authenticate.pipe(
              Effect.mapError(() => deny()),
              Effect.result,
            );
            if (Result.isFailure(admitted)) return;
            const caller = admitted.success;
            const nowMs = yield* Clock.currentTimeMillis;
            const lease = yield* Effect.fromResult(callerLease(caller, nowMs, limit));
            const id = yield* Ref.updateAndGet(epoch, (n) => n + 1);
            if (seeded) {
              seeded = false;
              yield* waitWakeOrLease(wakes, lease.duration);
              const afterWait = yield* Clock.currentTimeMillis;
              if (afterWait >= lease.expiresAtMs) continue;
            }
            while (true) {
              const tickNow = yield* Clock.currentTimeMillis;
              if (tickNow >= lease.expiresAtMs) break;
              yield* recompute(caller, id, lease.expiresAtMs);
              const after = yield* Clock.currentTimeMillis;
              if (after >= lease.expiresAtMs) break;
              yield* waitWakeOrLease(wakes, remainingOf(lease.expiresAtMs, after));
            }
            yield* invalidate;
          }
        });

        yield* Effect.forkChild(emitLoop);
        // Always end the callback queue. A failed producer fiber otherwise
        // leaves Stream.callback open, so consumers hang until the test timeout.
        yield* Effect.race(leaseLoop, revoked).pipe(
          Effect.result,
          Effect.andThen(close),
          Effect.onInterrupt(() => close),
        );
      }),
    { bufferSize: 16, strategy: "suspend" },
  );
