/**
 * Refcount close() is idempotent so a double-close cannot tear down a
 * sibling's shared handle.
 */

import { describe, expect, test } from "bun:test";
import type { Subscription } from "../../src/db/index.ts";
import { retainLive } from "../../src/react/liveCache.ts";

const handle = (onClose: () => void): Subscription<unknown> => ({
  subscribe() {
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
});
