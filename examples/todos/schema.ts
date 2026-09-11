// docs:todo-schema
import * as S from "effect/Schema";
import * as Ramose from "ramose/db";

export const Todo = Ramose.Entity("todo", {
  title: Ramose.string(),
  done: Ramose.boolean(),
  createdAt: Ramose.timestamp(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: S.Struct({ title: S.String }),
      output: S.Struct({ id: Ramose.EntityId }),
      doc: "Add a todo",
      run(op, { title }) {
        return { id: op.create({ title, done: false, createdAt: new Date() }) };
      },
    }),
    setDone: Operation({
      input: S.Struct({ done: S.Boolean }),
      output: S.Struct({}),
      doc: "Mark a todo done or not done",
      run(op, { done }) {
        op.self.set(Todo.done, done);
        return {};
      },
    }),
    delete: Operation({
      input: S.Struct({}),
      output: S.Struct({}),
      doc: "Delete a todo",
      run(op) {
        op.self.delete();
        return {};
      },
    }),
  }),
});

export const Todos = Ramose.Schema("todos", { todo: Todo });

Todos.applyPolicy(({ policy }) => {
  policy.todo.read.always();
});
// enddocs:todo-schema
