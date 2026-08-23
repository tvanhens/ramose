/**
 * `ramose/effect` is the Effect escape hatch: re-exports of the same module
 * instances (and `pipe`) so a consumer never has to name `effect` itself.
 */

import { describe, expect, test } from "bun:test";
import { pipe as effectPipe } from "effect/Function";
import * as EffectRedacted from "effect/Redacted";
import * as Ramose from "ramose/db";
import { pipe, Redacted, Schema } from "ramose/effect";

describe("ramose/effect", () => {
  test("re-exports pipe as effect/Function.pipe", () => {
    expect(pipe).toBe(effectPipe);
    expect(pipe(1, (n) => n + 1, (n) => n * 2)).toBe(4);
  });

  test("re-exports Redacted as effect/Redacted", () => {
    expect(Redacted.make).toBe(EffectRedacted.make);
    const secret = Redacted.make("s3cret");
    expect(Redacted.value(secret)).toBe("s3cret");
    expect(String(secret)).not.toContain("s3cret");
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
