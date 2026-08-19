import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant),
});

export const Todos = Ramose.Catalog({ todo: Todo });
