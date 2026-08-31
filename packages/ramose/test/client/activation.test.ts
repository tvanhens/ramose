import { describe, expect, test } from "bun:test";
import { observeActivation } from "../../src/client/activation.ts";

/**
 * The triggers are read from the real global event target, which is what a
 * browser dispatches into: no shim stands in for it, and `document` is simply
 * absent here, which is the degraded case the observer already tolerates.
 */
const dispatch = (type: string): void => {
  globalThis.dispatchEvent(new Event(type));
};

describe("observeActivation", () => {
  test("wakes on every way a tab is activated again", () => {
    let woke = 0;
    const release = observeActivation(() => {
      woke += 1;
    });
    try {
      dispatch("focus");
      expect(woke).toBe(1);
      dispatch("pageshow");
      expect(woke).toBe(2);
      // A device that dropped its network and picked it up again. A tab that
      // never lost focus never regains it, so without this a foreground tab
      // would wait for a transition that is not coming.
      dispatch("online");
      expect(woke).toBe(3);
    } finally {
      release();
    }
  });

  test("stops on release, and releasing twice is inert", () => {
    let woke = 0;
    const release = observeActivation(() => {
      woke += 1;
    });
    dispatch("online");
    expect(woke).toBe(1);
    release();
    release();
    dispatch("focus");
    dispatch("pageshow");
    dispatch("online");
    expect(woke).toBe(1);
  });
});
