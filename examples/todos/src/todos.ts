import * as Ramose from "ramose/db";
import { Todo } from "../schema.ts";

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
