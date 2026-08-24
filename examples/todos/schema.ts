// docs:todo-schema
import * as Ramose from "ramose/db";

export const Todo = Ramose.Entity("todo", {
  title: Ramose.string(),
  done: Ramose.boolean(),
  createdAt: Ramose.timestamp(),
});

export const Todos = Ramose.Schema({ todo: Todo });
// enddocs:todo-schema
