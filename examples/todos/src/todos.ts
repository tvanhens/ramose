/** The app's queries and writes, in one place so the test can drive them. */

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
export const todoQuery = Ramose.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select(todoShape);

/** One row from {@link todoQuery} — inferred from the query, never restated. */
export type TodoRow = Ramose.Row<typeof todoQuery>;

/** One row, straight from its eid — the same shape, no query. */
export const pullTodo = (db: TodosDb, eid: TodoEid) =>
  db.pull(eid, {
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });

export const addTodo = (db: TodosDb, title: string) =>
  db.transact(function* (tx) {
    const t = yield* tx.entity();
    yield* t.add(Todo.title, title);
    yield* t.add(Todo.done, false);
    yield* t.add(Todo.createdAt, new Date());
  });

export const setDone = (db: TodosDb, eid: TodoEid, done: boolean) =>
  db.transact(function* (tx) {
    yield* tx.add(eid.id, Todo.done, done);
  });

export const deleteTodo = (db: TodosDb, eid: TodoEid) =>
  db.transact(function* (tx) {
    yield* tx.retractEntity(eid.id);
  });
