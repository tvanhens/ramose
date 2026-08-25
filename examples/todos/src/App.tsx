import { useLiveQuery, useOperation } from "ramose/react";
import { useState } from "react";
import { db } from "./db.ts";
import {
  addTodoOp,
  deleteTodoOp,
  setDoneOp,
  todoQuery,
  type TodoRow,
} from "./todos.ts";

export const App = () => (
  <main>
    <h1>todos</h1>
    <NewTodo />
    <TodoList />
  </main>
);

// docs:todo-list
const TodoList = () => {
  const { data, error } = useLiveQuery(db, todoQuery);
  if (error !== undefined) return <p>offline…</p>;
  if (data === undefined) return <p>loading…</p>;
  return (
    <ul>
      {data.map((row) => (
        <TodoRowView key={row.id} row={row} />
      ))}
    </ul>
  );
};
// enddocs:todo-list

const TodoRowView = ({ row }: { row: TodoRow }) => {
  // docs:todo-row-operation
  const { run } = useOperation(db, setDoneOp);
  // enddocs:todo-row-operation
  const remove = useOperation(db, deleteTodoOp);
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={row.done}
          onChange={(e) => void run(row.id, { done: e.target.checked })}
        />
        <span style={{ textDecoration: row.done ? "line-through" : undefined }}>
          {row.title}
        </span>
      </label>
      <button type="button" onClick={() => void remove.run(row.id, {})}>
        delete
      </button>
    </li>
  );
};

const NewTodo = () => {
  const [title, setTitle] = useState("");
  const { run } = useOperation(db, addTodoOp);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = title.trim();
        if (value === "") return;
        setTitle("");
        void run({ title: value });
      }}
    >
      <input
        value={title}
        placeholder="what needs doing?"
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit">add</button>
    </form>
  );
};
