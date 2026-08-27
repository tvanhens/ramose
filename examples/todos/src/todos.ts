/** Portable queries and operation declarations used by the peer and fixtures. */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import { Todo, Todos } from "../schema.ts";

export const todoShape = {
  id: Todo.id,
  title: Todo.title,
  done: Todo.done,
  createdAt: Todo.createdAt,
} as const;

export const todoQuery = Ramose.Query.from(Todo)
  .select(todoShape)
  .orderBy(Todo.createdAt, "asc");

export type TodoRow = Ramose.Row<typeof todoQuery>;

export const addTodoOp = Ramose.Operation(
  "todo/add",
  {
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({ id: Ramose.EntityId }),
    doc: "Add a todo",
  },
  (op, input) => {
    const created = op.put(Todo, {
      title: input.title,
      done: false,
      createdAt: new Date(),
    });
    return { id: created };
  },
);

export const setDoneOp = Ramose.Operation.patch("todo/set-done", Todo, ["done"], {
  doc: "Mark a todo done or not done",
});

export const deleteTodoOp = Ramose.Operation(
  "todo/delete",
  { on: Todo, input: Schema.Struct({}), output: Schema.Struct({}), doc: "Delete a todo" },
  (op) => {
    op.delete(op.self);
    return {};
  },
);

export const operations = Ramose.defineOperations(Todos, {
  addTodoOp,
  setDoneOp,
  deleteTodoOp,
});
