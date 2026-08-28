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
  /** Already-authorized result used as the first diff baseline. */
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
  readonly epoch: Ref.Ref<number>;
  readonly lastSent: Ref.Ref<unknown | Absent>;
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

  // A membership-only delta cannot represent a reorder or an insertion in
  // the middle. Use the same wire shape as a full replacement when applying
  // the minimal delta would not reproduce the exact one-shot row sequence.
  const reconstructed = new Map(prevKeys);
  for (const row of retracted) reconstructed.delete(stringifyJson(row));
  for (const row of added) reconstructed.set(stringifyJson(row), row);
  const reconstructedOrder = [...reconstructed.keys()];
  const nextOrder = [...nextKeys.keys()];
  if (
    reconstructedOrder.length !== nextOrder.length ||
    reconstructedOrder.some((key, index) => key !== nextOrder[index])
  ) {
    return { added: nextRows, retracted: prevRows };
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
): Effect.Effect<boolean> => {
  if (Duration.toMillis(remaining) <= 0) return Effect.succeed(false);
  return Effect.race(
    Queue.take(wakes).pipe(Effect.as(true)),
    Effect.sleep(remaining).pipe(Effect.as(false)),
  );
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

/** Validate the authorization epoch at the downstream pull boundary. */
const deliverSnapshot = (
  item: QueuedSnapshot,
): Effect.Effect<Result.Result<LiveQueryDiff, void>, Unauthorized> =>
  Effect.gen(function* () {
    yield* atBoundary("live.emit");
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(item.epoch);
    if (item.id !== current || nowMs >= item.expiresAtMs) return Result.fail(undefined);

    const sent = yield* Ref.get(item.lastSent);
    const initial = sent === ABSENT;
    const diff = initial
      ? liveDiffFromPrevious(undefined, item.value)
      : diffAuthorizedResults(sent, item.value);
    if (!initial && isSilentLiveDiff(diff)) {
      yield* Ref.set(item.lastSent, item.value);
      return Result.fail(undefined);
    }

    const still = yield* Ref.get(item.epoch);
    const again = yield* Clock.currentTimeMillis;
    if (still !== item.id || again >= item.expiresAtMs) return Result.fail(undefined);
    yield* Ref.set(item.lastSent, item.value);
    return Result.succeed(diff);
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
  Stream.callback<QueuedSnapshot, Unauthorized | OneShotReadError | EDb, R>(
    (out) =>
      Effect.gen(function* () {
        const wakes = yield* Queue.dropping<void>(1);
        const epoch = yield* Ref.make(0);
        const lastSent = yield* Ref.make<unknown | Absent>(
          input.previous === undefined ? ABSENT : input.previous,
        );
        const limit = leaseLimit(input.interruptAfter);
        const invalidate = Ref.update(epoch, (id) => id + 1);
        const signalBasisChange = invalidate.pipe(
          Effect.andThen(Queue.offer(wakes, undefined)),
          Effect.asVoid,
        );

        if (input.wakes !== undefined) {
          const external = input.wakes;
          yield* Effect.forkChild(
            Effect.forever(Queue.take(external).pipe(Effect.andThen(signalBasisChange))),
          );
        }
        if (input.watchBasis === true) {
          const pollEvery = Duration.fromInputUnsafe(input.pollEvery ?? 250);
          yield* Effect.forkChild(
            Effect.gen(function* () {
              let lastT = Number.NaN;
              while (true) {
                const snapshot = yield* input.currentDb(input.routeDatabase).pipe(Effect.option);
                if (Option.isSome(snapshot)) {
                  const nextT = snapshot.value.basisT;
                  if (lastT !== nextT) {
                    const first = Number.isNaN(lastT);
                    lastT = nextT;
                    if (!first) yield* signalBasisChange;
                  }
                }
                yield* Effect.sleep(pollEvery);
              }
            }).pipe(Effect.ignoreCause),
          );
        }
        const revoked =
          input.revoked === undefined
            ? Effect.never
            : Deferred.await(input.revoked).pipe(Effect.andThen(invalidate), Effect.andThen(Effect.fail(deny())));

        const close = Queue.end(out).pipe(Effect.asVoid);

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
                  yield* Queue.offer(out, { id, expiresAtMs, value, epoch, lastSent });
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
            while (true) {
              const tickNow = yield* Clock.currentTimeMillis;
              if (tickNow >= lease.expiresAtMs) break;
              yield* recompute(caller, id, lease.expiresAtMs);
              const after = yield* Clock.currentTimeMillis;
              if (after >= lease.expiresAtMs) break;
              const basisChanged = yield* waitWakeOrLease(
                wakes,
                remainingOf(lease.expiresAtMs, after),
              );
              if (basisChanged) break;
            }
            yield* invalidate;
          }
        });

        // Always end the callback queue. A failed producer fiber otherwise
        // leaves Stream.callback open, so consumers hang until the test timeout.
        yield* Effect.raceFirst(leaseLoop, revoked).pipe(
          Effect.result,
          Effect.andThen(invalidate),
          Effect.andThen(close),
          Effect.onInterrupt(() => invalidate.pipe(
            Effect.andThen(Queue.shutdown(out)),
            Effect.asVoid,
          )),
        );
      }),
    { bufferSize: 1, strategy: "suspend" },
  ).pipe(Stream.filterMapEffect(deliverSnapshot));
