import { useLive, useTransact } from "ramose/react";
import { useState } from "react";
import { db } from "./db.ts";
import { addTodo, deleteTodo, setDone, todoQuery, type TodoRow } from "./todos.ts";

export const App = () => (
  <main>
    <h1>todos</h1>
    <NewTodo />
    <TodoList />
  </main>
);

// docs:todo-list
const TodoList = () => {
  const { rows, error } = useLive(db, todoQuery);
  if (error !== undefined) return <p>offline…</p>;
  if (rows === undefined) return <p>loading…</p>;
  return (
    <ul>
      {rows.map((row) => (
        <TodoRowView key={row.id} row={row} />
      ))}
    </ul>
  );
};
// enddocs:todo-list

const TodoRowView = ({ row }: { row: TodoRow }) => {
  // docs:todo-row-transact
  const { run } = useTransact();
  // enddocs:todo-row-transact
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={row.done}
          onChange={(e) => void run(setDone(db, row.id, e.target.checked))}
        />
        <span style={{ textDecoration: row.done ? "line-through" : undefined }}>
          {row.title}
        </span>
      </label>
      <button type="button" onClick={() => void run(deleteTodo(db, row.id))}>
        delete
      </button>
    </li>
  );
};

const NewTodo = () => {
  const [title, setTitle] = useState("");
  const { run } = useTransact();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = title.trim();
        if (value === "") return;
        setTitle("");
        void run(addTodo(db, value));
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
