# ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers +
Durable Objects + R2), built on Effect. Your data model is one TypeScript
value; queries are values too, and a live query re-runs itself when the
database changes.

```sh
bun add ramose react react-dom
```

`npm install` and `pnpm add` work the same. React is optional — a server-only
app needs neither it nor `react-dom`. Everything else Ramose runs on
(`effect`, `alchemy`, the two `@effect/platform-*` packages) comes with this
package at a version that resolves, so there is nothing else to pin.

Ramose is pre-release: expect the API to change between minor versions.

## The five entries

| Import | What it is |
| --- | --- |
| `ramose/db` | Schema, the client, `Db<C>`, the tagged errors. Portable — browser, Worker, Node, Bun, a test. |
| `ramose` | Everything on `ramose/db` plus the deploy-time half: the `Server` and `Database` resources, the capabilities, the transports, typed policy. |
| `ramose/worker` | The peer Worker itself. Hand it to Alchemy as `main: import.meta.resolve("ramose/worker")` — `main` is a path, so a bare specifier there silently resolves to nothing. |
| `ramose/react` | `RamoseProvider`, `useLive`, `useQuery`, `usePull`, `useBasis`, `useTransact`. Hooks only. |
| `ramose/better-auth` (+ `/client`) | The Better Auth plugin pair that mints and carries the workspace-scoped JWT a peer verifies. |

App schemas use `Ramose.string()` / `boolean()` / `Enum([...])` and do not
import Effect. Two conveniences for the hatch path: `ramose/schema` re-exports
`effect/Schema` and `ramose/effect` re-exports the Effect modules Ramose's own
API hands you. They are re-exports of the same module instances, not copies.

## A first look

```ts
// schema.ts
import * as Ramose from "ramose/db";

export const Todo = Ramose.Entity("todo", {
  title: Ramose.string(),
  done: Ramose.boolean(),
});

export const Todos = Ramose.Schema({ todo: Todo });
```

```tsx
// App.tsx
import { useLive } from "ramose/react";
import { db } from "./db.ts";
import { todoQuery } from "./todos.ts";

const TodoList = () => {
  const { rows } = useLive(db, todoQuery);
  return <ul>{rows?.map((row) => <li key={row.id}>{row.title}</li>)}</ul>;
};
```

Nothing refetches after a write and nothing invalidates a cache; the list
updates itself, in every open tab.

## Docs

Full documentation lives at **[ramose.ai](https://ramose.ai)**. Start with
[Getting started](https://ramose.ai/getting-started/quickstart/) — a working
todo app from an empty folder, no Cloudflare account required.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
