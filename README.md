<div align="center">

<a href="https://ramose.ai">
  <img src="./website/public/brand/ramose-lockup-horizontal.svg" alt="Ramose — reactive applications that grow safely" width="440" />
</a>

<br />
<br />

[![npm](https://img.shields.io/npm/v/ramose?style=flat-square&color=42D37A&label=ramose)](https://www.npmjs.com/package/ramose)
[![license](https://img.shields.io/badge/license-Apache%202.0-42D37A?style=flat-square)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-ramose.ai-42D37A?style=flat-square)](https://ramose.ai)

**The typed, realtime database for apps on Cloudflare** — describe your data in
TypeScript, write it through a typed API, and read it with queries that update
themselves in every open tab.

[Docs](https://ramose.ai) · [Getting started](https://ramose.ai/getting-started/quickstart/) · [Tour of Reef](https://ramose.ai/getting-started/tour-of-reef/) · [Examples](./examples)

</div>

---

A schema, a live query, and a typed write — that is the whole app:

```tsx
import * as Ramose from "ramose/db";
import { useLive, useTransact } from "ramose/react";
import { pipe } from "ramose/effect";

const Todo = Ramose.Entity("todo", {
  title: Ramose.string(),
  done: Ramose.boolean(),
});

const ramose = Ramose.connect({ url: import.meta.env.VITE_RAMOSE_URL });
const db = ramose.db("todos", Ramose.Schema({ todo: Todo }));

// A query is a value: declare it once, then run it live.
const todos = Ramose.Query.q(() =>
  pipe(
    Ramose.Query.entities(Todo),
    Ramose.Query.select({ id: Todo.id, title: Todo.title, done: Todo.done }),
  ),
);

const Todos = () => {
  const { rows } = useLive(db, todos);   // re-runs itself whenever the data changes
  const { run } = useTransact();

  const toggle = (todo: Ramose.Row<typeof todos>) =>
    run(
      db.transact(function* (tx) {
        yield* tx.set(todo.id, Todo.done, !todo.done);
      }),
    );

  return (
    <ul>
      {rows?.map((todo) => (
        <li key={todo.id} onClick={() => void toggle(todo)}>
          {todo.title}
        </li>
      ))}
    </ul>
  );
};
```

Nothing refetches after that write, and nothing invalidates a cache: `useLive`
is a query the server keeps up to date, in every tab that is watching it.

---

- **A typed schema.** One TypeScript file your app, your rules, and your deploy
  all import. A wrong write is a red squiggle, not a bad row.
- **Live queries.** `useLive(db, query)` re-runs itself when the data changes.
  No refetch code, no invalidation, no WebSocket server to write.
- **Permissions in the database.** Who may read or write each field is checked
  on the server, deny by default — not middleware you remember to add.
- **A database per customer.** `ramose.db("acme", schema)` is a function call,
  not a provisioning step.
- **Nothing overwritten.** Every version is kept; read the database as it was
  at any earlier point in time.
- **Your Cloudflare account.** One Worker, Durable Objects, and R2, deployed
  with [Alchemy](https://alchemy.run). No Ramose bill, no dashboard, no
  managed service.

```sh
bun add ramose react react-dom
```

One package. `effect`, `alchemy` and the two `@effect/platform-*` packages come
with it at versions that resolve, so there is nothing else to pin. React is an
optional peer — a server-only app installs `ramose` alone.

## Learn more

- [What is Ramose?](https://ramose.ai/getting-started/introduction/) — the one-minute version
- [Getting started](https://ramose.ai/getting-started/quickstart/) — a realtime todo app from an empty folder, in 15 minutes
- [Tour of Reef](https://ramose.ai/getting-started/tour-of-reef/) — a multi-tenant issue tracker whose whole backend is 680 lines
- [How it compares](https://ramose.ai/getting-started/compare/) — against Convex, Supabase, Instant, Firebase, and D1
- [Examples](./examples) — runnable apps in this repository

> **Ramose is pre-release.** The API moves between releases, so pin exact
> versions. Issues and pull requests are welcome.

## Contributing

Ramose itself is a Bun monorepo — `bun install && bun test`. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
