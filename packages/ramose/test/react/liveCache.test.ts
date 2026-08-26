/**
 * Refcount close() is idempotent so a double-close cannot tear down a
 * sibling's shared handle. Finalize is per wrapper: a NotOne stays on
 * that subscriber.
 */

import { describe, expect, test } from "bun:test";
import { NotOne } from "../../src/db/Errors.ts";
import type { Subscription } from "../../src/db/index.ts";
import { retainLive } from "../../src/react/liveCache.ts";

const handle = (
  onClose: () => void,
  listeners: Array<(value: unknown) => void> = [],
): Subscription<unknown> => ({
  subscribe(onValue) {
    listeners.push(onValue);
    return () => {};
  },
  async *[Symbol.asyncIterator]() {},
  close: onClose,
});

describe("retainLive", () => {
  test("a second close on one wrapper does not drop the other ref", () => {
    let closed = 0;
    let created = 0;
    const a = retainLive("k", () => {
      created += 1;
      return handle(() => {
        closed += 1;
      });
    });
    const b = retainLive("k", () => {
      created += 1;
      return handle(() => {
        closed += 1;
      });
    });
    expect(created).toBe(1);

    a.close();
    a.close();
    expect(closed).toBe(0);

    b.close();
    expect(closed).toBe(1);
    b.close();
    expect(closed).toBe(1);
  });

  test("a shared terminal error evicts so the next retain creates a new handle", () => {
    const listeners: Array<{
      onValue: (value: unknown) => void;
      onError?: ((error: unknown) => void) | undefined;
    }> = [];
    let created = 0;
    const make = (): Subscription<unknown> => {
      created += 1;
      return {
        subscribe(onValue, onError) {
          listeners.push({ onValue, onError });
          return () => {};
        },
        async *[Symbol.asyncIterator]() {},
        close() {},
      };
    };

    const a = retainLive("term", make);
    const b = retainLive("term", make);
    expect(created).toBe(1);
    let err: unknown;
    a.subscribe(
      () => {},
      (e) => {
        err = e;
      },
    );
    b.subscribe(() => {});

    listeners[0]!.onError?.(new Error("unauthorized"));
    expect(err).toBeInstanceOf(Error);

    const c = retainLive("term", make);
    expect(created).toBe(2);
    c.close();
    a.close();
    b.close();
  });

  test("finalize runs per wrapper; NotOne stays on that subscriber", () => {
    const listeners: Array<(value: unknown) => void> = [];
    const raw = handle(() => {}, listeners);
    const rows = retainLive("take", () => raw, (r) => r);
    const fail = retainLive(
      "take",
      () => raw,
      () => new NotOne({ message: "expected one", found: 2 }),
    );

    let seen: unknown;
    let err: unknown;
    rows.subscribe((v) => {
      seen = v;
    });
    fail.subscribe(
      () => {},
      (e) => {
        err = e;
      },
    );

    const payload = [[1], [2]];
    for (const onValue of listeners) onValue(payload);

    expect(seen).toEqual(payload);
    expect(err).toBeInstanceOf(NotOne);
  });
});
