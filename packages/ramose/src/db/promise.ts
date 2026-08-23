/**
 * Run an Effect as a Promise that rejects with the tagged failure itself
 * (not a FiberFailure / Cause wrapper). Defects squash to the defect value.
 *
 * @internal
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Subscription } from "./subscription.ts";

/** The typed failure when there is one; the squashed defect otherwise. */
export const failureOf = (cause: Cause.Cause<unknown>): unknown => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) ? error.value : Cause.squash(cause);
};

export const asPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw failureOf(exit.cause);
  });

/**
 * Drive a Stream as a {@link Subscription}. Interrupt on `close()`. A
 * completion (pinned `asOf` / `history`) ends iteration without error.
 */
export const fromStream = <A, E>(
  stream: Stream.Stream<A, E>,
): Subscription<A, E> => {
  type Listener = {
    readonly onValue: (value: A) => void;
    readonly onError?: (error: E) => void;
    readonly onEnd?: () => void;
  };

  const listeners = new Set<Listener>();
  // Last emission only — a standing live must not retain every pass.
  let latest: A | undefined;
  let hasLatest = false;
  let error: E | undefined;
  let ended = false;
  let closed = false;
  let failed = false;
  let finished = false;

  const finish = (kind: "error" | "end", err?: E): void => {
    if (finished) return;
    finished = true;
    if (kind === "error") {
      failed = true;
      error = err as E;
      for (const listener of listeners) listener.onError?.(error);
    } else {
      ended = true;
      for (const listener of listeners) listener.onEnd?.();
    }
  };

  const fiber = Effect.runFork(
    Stream.runForEach(stream, (value) =>
      Effect.sync(() => {
        latest = value;
        hasLatest = true;
        for (const listener of listeners) listener.onValue(value);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterrupts(cause)) return;
          finish("error", failureOf(cause) as E);
        }),
      ),
      Effect.andThen(
        Effect.sync(() => {
          if (!failed) finish("end");
        }),
      ),
    ),
  );

  const close = (): void => {
    if (closed) return;
    closed = true;
    // Fiber.interrupt does not run catchCause / onEnd, so parked
    // `for await` iterators would hang unless we wake them here.
    finish("end");
    Effect.runFork(Fiber.interrupt(fiber));
  };

  return {
    subscribe(onValue, onError) {
      if (hasLatest) onValue(latest as A);
      if (error !== undefined) onError?.(error);
      const listener: Listener = { onValue, onError };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      type Event =
        | { readonly kind: "value"; readonly value: A }
        | { readonly kind: "error"; readonly error: E }
        | { readonly kind: "end" };
      const queue: Event[] = [];
      let notify: (() => void) | undefined;
      const push = (event: Event): void => {
        queue.push(event);
        notify?.();
        notify = undefined;
      };

      if (hasLatest) queue.push({ kind: "value", value: latest as A });
      if (error !== undefined) queue.push({ kind: "error", error });
      else if (ended) queue.push({ kind: "end" });

      const listener: Listener = {
        onValue: (value) => push({ kind: "value", value }),
        onError: (err) => push({ kind: "error", error: err }),
        onEnd: () => push({ kind: "end" }),
      };
      listeners.add(listener);

      return {
        async next() {
          for (;;) {
            const event = queue.shift();
            if (event !== undefined) {
              if (event.kind === "value") return { value: event.value, done: false };
              if (event.kind === "error") throw event.error;
              return { value: undefined as unknown as A, done: true };
            }
            if (closed) return { value: undefined as unknown as A, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        },
        async return() {
          listeners.delete(listener);
          close();
          return { value: undefined as unknown as A, done: true };
        },
      };
    },
    close,
  };
};
