/**
 * `ramose/effect` is the Effect escape hatch: re-exports of the same module
 * instances (and `pipe`) so a consumer never has to name `effect` itself.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { pipe as effectPipe } from "effect/Function";
import * as EffectFunction from "effect/Function";
import * as EffectRedacted from "effect/Redacted";
import * as Ramose from "ramose/db";
import { Function, pipe, Redacted, runPromise, Schema } from "ramose/effect";

describe("ramose/effect", () => {
  test("re-exports pipe as effect/Function.pipe", () => {
    expect(pipe).toBe(effectPipe);
    expect(pipe(1, (n) => n + 1, (n) => n * 2)).toBe(4);
  });

  test("re-exports Function as the effect/Function module instance", () => {
    expect(Function).toBe(EffectFunction);
    expect(Function.pipe).toBe(effectPipe);
  });

  test("re-exports Redacted as effect/Redacted", () => {
    expect(Redacted.make).toBe(EffectRedacted.make);
    const secret = Redacted.make("s3cret");
    expect(Redacted.value(secret)).toBe("s3cret");
    expect(String(secret)).not.toContain("s3cret");
  });

  test("runPromise rejects with the tagged error, not a FiberFailure", async () => {
    try {
      await runPromise(
        Effect.fail(new Ramose.TxRejected({ message: "unique", code: "tx/unique-conflict" })),
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Ramose.TxRejected);
      expect((error as Ramose.TxRejected)._tag).toBe("TxRejected");
      expect((error as Error).name).not.toBe("FiberFailure");
    }
  });

  test("pipe from the escape hatch builds a Query.q value", () => {
    const Todo = Ramose.Entity("todo", {
      title: Ramose.Field(Schema.String),
      done: Ramose.Field(Schema.Boolean),
    });
    const todos = Ramose.Query.q(() =>
      pipe(
        Ramose.Query.entities(Todo),
        Ramose.Query.select({ id: Todo.id, title: Todo.title, done: Todo.done }),
      ),
    );
    expect(todos._tag).toBe("Query");
  });
});
