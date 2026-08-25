/** The app's queries and writes, in one place so the test can drive them. */

import { Schema } from "ramose/effect";
import * as Ramose from "ramose/db";
import type { Db, Eid } from "ramose/db";
import { Todo, Todos } from "../schema.ts";

export type TodosDb = Db<typeof Todos>;
export type TodoEid = Eid<typeof Todos>;

export const todoShape = {
  id: Todo.id,
  title: Todo.title,
  done: Todo.done,
  createdAt: Todo.createdAt,
} as const;

/** Standing list query — a value, not a callback builder. */
export const todoQuery = Ramose.Query.from(Todo)
  .select(todoShape)
  .orderBy(Todo.createdAt, "asc");

/** One row from {@link todoQuery} — inferred from the query, never restated. */
export type TodoRow = Ramose.Row<typeof todoQuery>;

/** One row, straight from its eid — the same shape, no query. */
export const pullTodo = (db: TodosDb, eid: TodoEid) =>
  db.pull(eid, {
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });

// docs:add-todo-op
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
// enddocs:add-todo-op

// docs:set-done-op
export const setDoneOp = Ramose.Operation.patch("todo/set-done", Todo, ["done"], {
  doc: "Mark a todo done or not done",
});
// enddocs:set-done-op

// docs:delete-todo-op
export const deleteTodoOp = Ramose.Operation(
  "todo/delete",
  {
    on: Todo,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    doc: "Delete a todo",
  },
  (op) => {
    op.delete(op.self);
    return {};
  },
);
// enddocs:delete-todo-op

export const operations = Ramose.defineOperations(Todos, {
  addTodoOp,
  setDoneOp,
  deleteTodoOp,
});

// docs:add-todo
export const addTodo = (db: TodosDb, title: string) =>
  db.run(addTodoOp, { title });
// enddocs:add-todo

// docs:set-done
export const setDone = (db: TodosDb, eid: TodoEid, done: boolean) =>
  db.run(setDoneOp, eid, { done });
// enddocs:set-done

// docs:delete-todo
export const deleteTodo = (db: TodosDb, eid: TodoEid) =>
  db.run(deleteTodoOp, eid, {});
// enddocs:delete-todo
