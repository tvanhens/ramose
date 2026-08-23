import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Entity("todo", {
  title: Ramose.Field(Schema.String),
  done: Ramose.Field(Schema.Boolean),
  createdAt: Ramose.Field(Ramose.Instant),
});

export const Todos = Ramose.Schema({ todo: Todo });
