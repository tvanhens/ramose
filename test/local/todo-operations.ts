import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import * as InternalOperations from "../../packages/ramose/src/db/Operation.ts";
import { Todo } from "../../examples/todos/schema.ts";

export const addTodoOp = InternalOperations.Operation(
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

export const setDoneOp = InternalOperations.Operation.patch("todo/set-done", Todo, ["done"], {
  doc: "Mark a todo done or not done",
});

export const deleteTodoOp = InternalOperations.Operation(
  "todo/delete",
  { on: Todo, input: Schema.Struct({}), output: Schema.Struct({}), doc: "Delete a todo" },
  (op) => {
    op.delete(op.self);
    return {};
  },
);
