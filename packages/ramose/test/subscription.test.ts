/**
 * Public `Subscription` / `fromStream` contract: close wakes iterators,
 * for-await ends and errors, onError delivers the tagged error.
 */

import { describe, expect, test } from "bun:test";
import * as Stream from "effect/Stream";
import { Unauthorized } from "../src/db/index.ts";
import { fromStream } from "../src/db/promise.ts";

const timed = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  Promise.race([
    promise,
    new Promise<A>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

describe("fromStream close() wakes parked iterators", () => {
  test("for-await over Stream.never ends when close() runs from another task", async () => {
    const sub = fromStream(Stream.never);
    const done = (async () => {
      for await (const _ of sub) {
        /* Stream.never emits nothing */
      }
    })();
    await Bun.sleep(50);
    sub.close();
    await timed(done, 500);
  });

  test("close() after a value still ends a parked iterator", async () => {
    const sub = fromStream(Stream.make(1).pipe(Stream.concat(Stream.never)));
    const seen: number[] = [];
    const done = (async () => {
      for await (const value of sub) seen.push(value);
    })();
    await Bun.sleep(20);
    expect(seen).toEqual([1]);
    sub.close();
    await timed(done, 500);
    expect(seen).toEqual([1]);
  });
});

describe("fromStream subscribe / iterate", () => {
  test("close() stops further subscribe emissions", async () => {
    const sub = fromStream(
      Stream.make(1, 2).pipe(Stream.concat(Stream.never)),
    );
    const seen: number[] = [];
    sub.subscribe((value) => seen.push(value));
    await Bun.sleep(20);
    expect(seen).toEqual([1, 2]);
    sub.close();
    await Bun.sleep(20);
    expect(seen).toEqual([1, 2]);
  });

  test("for-await ends when the stream completes", async () => {
    const sub = fromStream(Stream.make("a", "b"));
    const seen: string[] = [];
    for await (const value of sub) seen.push(value);
    expect(seen).toEqual(["a", "b"]);
  });

  test("for-await throws the tagged error", async () => {
    const denied = new Unauthorized({ message: "expired" });
    const sub = fromStream(Stream.fail(denied));
    try {
      for await (const _ of sub) {
        /* empty */
      }
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBe(denied);
      expect((error as Unauthorized)._tag).toBe("Unauthorized");
    }
  });

  test("onError delivers the tagged error", async () => {
    const denied = new Unauthorized({ message: "expired" });
    const sub = fromStream(Stream.fail(denied));
    const error = await new Promise<unknown>((resolve) => {
      sub.subscribe(
        () => {},
        (err) => resolve(err),
      );
    });
    expect(error).toBe(denied);
    expect((error as Unauthorized)._tag).toBe("Unauthorized");
  });
});
