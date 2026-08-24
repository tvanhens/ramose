/** The app's queries and writes, in one place so the test can drive them. */

import { Schema } from "ramose/effect";
import * as Ramose from "ramose/db";
import type { Db, Eid } from "ramose/db";
import { Todo, type Todos } from "../schema.ts";

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

export const addTodoOp = Ramose.Operation(
  "todo/add",
  {
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const t = op.entity();
    t.set(Todo.title, input.title);
    t.set(Todo.done, false);
    t.set(Todo.createdAt, new Date());
    return {};
  },
);

export const setDoneOp = Ramose.Operation(
  "todo/set-done",
  {
    on: Todo,
    input: Schema.Struct({ done: Schema.Boolean }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.set(op.self, Todo.done, input.done);
    return {};
  },
);

export const deleteTodoOp = Ramose.Operation(
  "todo/delete",
  {
    on: Todo,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.delete(op.self);
    return {};
  },
);

export const operations = Ramose.Operations({
  addTodoOp,
  setDoneOp,
  deleteTodoOp,
});

export const addTodo = (db: TodosDb, title: string) =>
  db.run(addTodoOp, { title });

export const setDone = (db: TodosDb, eid: TodoEid, done: boolean) =>
  db.run(setDoneOp, eid, { done });

export const deleteTodo = (db: TodosDb, eid: TodoEid) =>
  db.run(deleteTodoOp, eid, {});
