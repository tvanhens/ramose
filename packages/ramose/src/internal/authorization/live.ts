/**
 * Leased server live queries (#415).
 *
 * One authorization lease/epoch covers recomputation, enqueue, and emission.
 * Each authorized basis rebuilds the filtered {@link Db} through the caller's
 * ordinary request-context constructor and runs the ordinary one-shot read.
 * Output is additions and retractions of that result. Raw transaction
 * datoms, IDs, counts, rule facts, and hidden-only sequence events are
 * never forwarded. There is no second live authorization predicate.
 */

import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Unauthorized } from "../../db/Errors.ts";
import type { Db } from "../core/db.ts";
import { stringifyJson } from "../core/json.ts";
import type { RuntimeBoundaries } from "../runtime-boundaries.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import {
  constructAuthorizedRequestContext,
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

export type LiveBasisEvent = "ready" | "change";

export type AuthorizedLiveControls<R = never> = {
  /** Already-authorized result used as the first diff baseline. */
  readonly previous?: unknown;
  /** Basis-change signals. Extra offers coalesce on a sliding slot. */
  readonly wakes?: Queue.Dequeue<unknown>;
  /** Completing this invalidates the current epoch and closes uniformly. */
  readonly revoked?: Deferred.Deferred<void>;
  /** Revalidate deployment-scoped authority before starting another lease. */
  readonly renew?: Effect.Effect<void, Unauthorized, R>;
  /** Push-only basis notifications from the real replica topology. */
  readonly basisChanges?: Stream.Stream<LiveBasisEvent, Unauthorized, R>;
  /** Optional early invalidation source; bounded renewal remains authoritative. */
  readonly invalidations?: Stream.Stream<unknown, Unauthorized, R>;
  /** Explicit non-production race boundaries; absent in the production graph. */
  readonly boundaries?: RuntimeBoundaries;
};

export type AuthorizedLiveInput<R = never, EDb = unknown> =
  AuthorizedRequestInput<R, EDb> & AuthorizedLiveControls<R>;

/**
 * One generic lease/output gate. Authorization callbacks may construct an
 * ordinary single-database filtered Db or compose that same boundary across
 * a graph path; the lease engine never evaluates authorization itself.
 */
export type AuthorizedLiveLeaseInput<R = never, EAuthorize = unknown> =
  AuthorizedLiveControls<R> & {
    readonly authenticate: Effect.Effect<AuthenticatedCaller, Unauthorized, R>;
    readonly interruptAfter?: Duration.Input;
    readonly authorize: (
      caller: AuthenticatedCaller,
    ) => Effect.Effect<Db, Unauthorized | EAuthorize, R>;
    /** Graph paths reauthorize even while idle; ordinary live reads stay push-only. */
    readonly reauthorizeOnIdle?: boolean;
  };

type QueuedSnapshot = {
  readonly id: number;
  readonly expiresAtMs: number;
  readonly value: unknown;
  readonly epoch: Ref.Ref<number>;
  readonly lastSent: Ref.Ref<unknown | Absent>;
  readonly boundaries?: RuntimeBoundaries;
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

/** A renewed request can extend one stream only for the same principal. */
const principalLeaseIdentity = (caller: AuthenticatedCaller): string =>
  stringifyJson({
    claims: caller.claims,
    classes: [...caller.classes].sort(),
  });

const atBoundary = (
  boundaries: RuntimeBoundaries | undefined,
  name: string,
): Effect.Effect<void, Unauthorized> =>
  boundaries === undefined
    ? Effect.void
    : Effect.tryPromise({
        try: () => boundaries.checkpoint(name),
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
 * Occurrences are compared by canonical JSON; hidden facts and transaction
 * metadata cannot appear because they are not in either result.
 */
export const diffAuthorizedResults = (previous: unknown, next: unknown): LiveQueryDiff => {
  const prevRows = liveResultRows(previous);
  const nextRows = liveResultRows(next);
  const prevCounts = new Map<string, number>();
  const nextCounts = new Map<string, number>();
  for (const row of prevRows) {
    const key = stringifyJson(row);
    prevCounts.set(key, (prevCounts.get(key) ?? 0) + 1);
  }
  for (const row of nextRows) {
    const key = stringifyJson(row);
    nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
  }
  const added: unknown[] = [];
  const retracted: unknown[] = [];
  const remainingPrev = new Map(prevCounts);
  for (const row of nextRows) {
    const key = stringifyJson(row);
    const remaining = remainingPrev.get(key) ?? 0;
    if (remaining === 0) added.push(row);
    else remainingPrev.set(key, remaining - 1);
  }
  const remainingNext = new Map(nextCounts);
  for (const row of prevRows) {
    const key = stringifyJson(row);
    const remaining = remainingNext.get(key) ?? 0;
    if (remaining === 0) retracted.push(row);
    else remainingNext.set(key, remaining - 1);
  }

  // Retractions remove one matching occurrence and additions append. If that
  // minimal bag delta cannot reproduce the exact ordered sequence, use a full
  // replacement. Keeping arrays here is essential for tuple queries whose
  // result contains the same value more than once.
  const reconstructed = [...prevRows];
  for (const row of retracted) {
    const key = stringifyJson(row);
    const index = reconstructed.findIndex((candidate) => stringifyJson(candidate) === key);
    if (index !== -1) reconstructed.splice(index, 1);
  }
  reconstructed.push(...added);
  const reconstructedOrder = reconstructed.map(stringifyJson);
  const nextOrder = nextRows.map(stringifyJson);
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
    yield* atBoundary(item.boundaries, "live.emit");
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
 * The shared authorization-lease and output gate. The supplied callback owns
 * construction of the ordinary filtered Db; this loop owns only lifetime,
 * invalidation, recomputation, enqueue, and emission.
 */
export const executeAuthorizedLiveLease = <R, EAuthorize = unknown>(
  input: AuthorizedLiveLeaseInput<R, EAuthorize>,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
): Stream.Stream<LiveQueryDiff, Unauthorized | OneShotReadError | EAuthorize, R> =>
  Stream.callback<QueuedSnapshot, Unauthorized | OneShotReadError | EAuthorize, R>(
    (out) =>
      Effect.gen(function* () {
        const wakes = yield* Queue.dropping<void>(1);
        const basisReady = yield* Deferred.make<void>();
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
        const revoked =
          input.revoked === undefined
            ? Effect.never
            : Deferred.await(input.revoked).pipe(Effect.andThen(invalidate), Effect.andThen(Effect.fail(deny())));

        const close = Queue.end(out).pipe(Effect.asVoid);

        const recompute = (
          filteredDb: Db,
          id: number,
          expiresAtMs: number,
        ): Effect.Effect<void, Unauthorized | OneShotReadError, R> =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            if (nowMs >= expiresAtMs) return;
            const value = yield* readAuthorized(filteredDb, read, opts);
            yield* atBoundary(input.boundaries, "live.recompute");
            const current = yield* Ref.get(epoch);
            if (current !== id) return;
            yield* atBoundary(input.boundaries, "live.enqueue");
            const still = yield* Ref.get(epoch);
            const enqueueNow = yield* Clock.currentTimeMillis;
            if (still !== id || enqueueNow >= expiresAtMs) return;
            yield* Queue.offer(out, {
              id,
              expiresAtMs,
              value,
              epoch,
              lastSent,
              ...(input.boundaries === undefined
                ? {}
                : { boundaries: input.boundaries }),
            });
          });

        const leaseLoop = Effect.gen(function* () {
          let firstLease = true;
          let basisChanged = true;
          let principalIdentity: string | undefined;
          while (true) {
            if (!firstLease && input.renew !== undefined) {
              const currentDeployment = yield* input.renew.pipe(
                Effect.mapError(() => deny()),
                Effect.result,
              );
              if (Result.isFailure(currentDeployment)) return;
            }
            const admitted = yield* input.authenticate.pipe(
              Effect.mapError(() => deny()),
              Effect.result,
            );
            if (Result.isFailure(admitted)) return;
            const caller = admitted.success;
            const identity = principalLeaseIdentity(caller);
            if (principalIdentity === undefined) principalIdentity = identity;
            else if (principalIdentity !== identity) return;
            const nowMs = yield* Clock.currentTimeMillis;
            const lease = yield* Effect.fromResult(callerLease(caller, nowMs, limit));
            const id = yield* Ref.updateAndGet(epoch, (n) => n + 1);
            const tickNow = yield* Clock.currentTimeMillis;
            if (
              tickNow < lease.expiresAtMs &&
              (basisChanged || input.reauthorizeOnIdle === true)
            ) {
              const leaseWork = input.authorize(caller).pipe(
                Effect.flatMap((filteredDb) =>
                  basisChanged
                    ? recompute(filteredDb, id, lease.expiresAtMs)
                    : Effect.void
                ),
                Effect.timeoutOrElse({
                  duration: remainingOf(lease.expiresAtMs, tickNow),
                  orElse: () => Effect.fail(deny()),
                }),
                Effect.result,
              );
              if (Result.isFailure(yield* leaseWork)) return;
            }
            const after = yield* Clock.currentTimeMillis;
            basisChanged = after < lease.expiresAtMs
              ? yield* waitWakeOrLease(
                wakes,
                remainingOf(lease.expiresAtMs, after),
              )
              : false;
            yield* invalidate;
            firstLease = false;
          }
        });

        const basisWatch = input.basisChanges === undefined
          ? Effect.never
          : Stream.runForEach(input.basisChanges, (event) =>
            event === "ready"
              ? Deferred.succeed(basisReady, undefined).pipe(Effect.asVoid)
              : Deferred.succeed(basisReady, undefined).pipe(
                  // A conflated basis frame proves the ordered ready frame was
                  // received even if the bounded wake queue replaced it.
                  Effect.andThen(signalBasisChange),
                  Effect.asVoid,
                )).pipe(
            Effect.mapError(() => deny()),
            Effect.andThen(Effect.fail(deny())),
          );
        const leaseAndBasis = input.basisChanges === undefined
          ? Effect.raceFirst(leaseLoop, revoked)
          : Effect.raceFirst(
            basisWatch,
            Deferred.await(basisReady).pipe(
              Effect.andThen(Effect.raceFirst(leaseLoop, revoked)),
            ),
          );
        const invalidationWatch = input.invalidations === undefined
          ? Effect.never
          : Stream.runForEach(input.invalidations, () => signalBasisChange).pipe(
            Effect.mapError(() => deny()),
            Effect.andThen(Effect.fail(deny())),
          );
        const authorizedLoop = input.invalidations === undefined
          ? leaseAndBasis
          : Effect.raceFirst(leaseAndBasis, invalidationWatch);

        // Always end the callback queue. A failed producer fiber otherwise
        // leaves Stream.callback open, so consumers hang until the test timeout.
        yield* authorizedLoop.pipe(
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

/**
 * Live output over one ordinary filtered database value. Reuses one-shot
 * query, pull, entity, lookup, refs, graph, aggregation, ordering, and limit
 * behavior without introducing another authorization predicate.
 */
export const executeAuthorizedLive = <R, EDb = unknown>(
  input: AuthorizedLiveInput<R, EDb>,
  read: OneShotRead,
  opts: OneShotReadOptions = {},
): Stream.Stream<LiveQueryDiff, Unauthorized | OneShotReadError | EDb, R> =>
  executeAuthorizedLiveLease({
    ...input,
    authorize: (caller) => constructAuthorizedRequestContext(input, caller).pipe(
      Effect.map((context) => context.filteredDb),
    ),
  }, read, opts);
