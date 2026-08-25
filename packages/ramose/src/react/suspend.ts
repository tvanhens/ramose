/**
 * First-emission / first-run thenables for `{ suspense: true }`.
 *
 * Suspense cannot wait on a `useEffect` — the component is not committed
 * while it throws, so the effect never starts. These helpers begin the
 * work during render, keyed on the same structural identity the hooks
 * already use, and stash the first value so the remount hydrates.
 */

import type { Subscription } from "../db/index.ts";

type Thenable<A> = Promise<A> & {
  status: "pending" | "fulfilled" | "rejected";
  value?: A;
  reason?: unknown;
};

export interface SuspendSlot<A, E> {
  promise: Thenable<A>;
  data?: A;
  t?: number;
  error?: E;
}

const slots = new Map<string, SuspendSlot<unknown, unknown>>();

const asThenable = <A>(promise: Promise<A>): Thenable<A> => {
  const thenable = promise as Thenable<A>;
  thenable.status = "pending";
  promise.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
    },
    (reason: unknown) => {
      thenable.status = "rejected";
      thenable.reason = reason;
    },
  );
  return thenable;
};

export const peekSuspend = <A, E>(
  key: string,
): SuspendSlot<A, E> | undefined =>
  slots.get(key) as SuspendSlot<A, E> | undefined;

export const evictSuspend = (key: string): void => {
  slots.delete(key);
};

/**
 * First emission of a standing read. `acquire` runs on the first call
 * per key; the handle is closed after that emission so the hook's
 * effect can own the live subscription.
 */
export const ensureLive = <A, E>(
  key: string,
  acquire: () => {
    readonly sub: Subscription<A, E>;
    readonly owned: boolean;
  },
): SuspendSlot<A, E> => {
  const held = slots.get(key) as SuspendSlot<A, E> | undefined;
  if (held !== undefined) return held;

  const { sub, owned } = acquire();
  const slot: SuspendSlot<A, E> = {
    promise: undefined as unknown as Thenable<A>,
  };
  slot.promise = asThenable(
    new Promise<A>((resolve, reject) => {
      const off = sub.subscribe(
        (data) => {
          slot.data = data;
          off();
          if (owned) sub.close();
          resolve(data);
        },
        (error) => {
          slot.error = error;
          off();
          if (owned) sub.close();
          reject(error);
        },
      );
    }),
  );
  slot.promise.catch(() => {});
  slots.set(key, slot as SuspendSlot<unknown, unknown>);
  return slot;
};

/** First settlement of a one-shot `run()`. */
export const ensureOneShot = <A, E>(
  key: string,
  run: () => Promise<A>,
  basis: () => number | undefined,
): SuspendSlot<A, E> => {
  const held = slots.get(key) as SuspendSlot<A, E> | undefined;
  if (held !== undefined) return held;

  const slot: SuspendSlot<A, E> = {
    promise: undefined as unknown as Thenable<A>,
  };
  slot.promise = asThenable(
    run().then(
      (data) => {
        slot.data = data;
        slot.t = basis();
        return data;
      },
      (error: E) => {
        slot.error = error;
        throw error;
      },
    ),
  );
  slot.promise.catch(() => {});
  slots.set(key, slot as SuspendSlot<unknown, unknown>);
  return slot;
};
