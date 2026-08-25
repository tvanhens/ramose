# ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers +
Durable Objects + R2), built on Effect. Your data model is one TypeScript
value; queries are values too, and a live query re-runs itself when the
database changes.

```sh
bun add ramose react react-dom
```

`npm install` and `pnpm add` work the same. React is optional — a server-only
app needs neither it nor `react-dom`. `effect` comes with this package.
`alchemy` is owned and pinned to the 2.x beta this release tests
(`>=2.0.0-beta.72 <2.0.0-beta.73`); the pin is bumped per release. Apps
using `ramose/better-auth` also need the optional peers `better-auth` and
`zod`. The zod peer is naming hygiene, not a smaller install —
`better-auth` already depends on zod.

Ramose is pre-release: expect the API to change between minor versions.

## The public entries

| Import | What it is |
| --- | --- |
| `ramose/db` | Schema, the client, `Db<C>`, the tagged errors. Portable — browser, Worker, Node, Bun, a test. |
| `ramose/db/effect` | Effect hatch (`layer`, `Databases`) for the portable client. |
| `ramose` | Deploy barrel: everything on `ramose/db` plus `Server`, `Database`, capabilities, transports, typed policy. Client bundlers honoring `browser` resolve this specifier to `ramose/db` plus alchemy-free `policy` / `Policy` / `claims` — not `Server` / Alchemy. |
| `ramose/worker` | The peer Worker itself. Hand it to Alchemy as `main: import.meta.resolve("ramose/worker")` — `main` is a path, so a bare specifier there silently resolves to nothing. |
| `ramose/react` | `RamoseProvider`, `useLiveQuery`, `useQuery`, `useLivePull`, `usePull`, `useBasis`, `usePrincipal`, `useRamoseClaims`, `useOperation`. Hooks only. |
| `ramose/better-auth` (+ `/client`) | The Better Auth plugin pair that mints and carries the workspace-scoped JWT a peer verifies. Needs optional peers `better-auth` and `zod`. |
| `ramose/effect` | Opt-in Effect escape hatch — re-exports `Effect`, `Function`, `pipe`, `Redacted`, `Schema`, `Layer`, `Stream`, `Cause`, `Exit`. Not the app path. |

App schemas use `Ramose.string()` / `boolean()` / `Enum([...])` and do not
import Effect. `ramose/effect` is the hatch for deploy files and
`db.effect.*` callers; it re-exports the same `effect` module instances
(not copies) for resolvers that refuse undeclared dependencies.

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
import { useLiveQuery } from "ramose/react";
import { db } from "./db.ts";
import { todoQuery } from "./todos.ts";

const TodoList = () => {
  const { data } = useLiveQuery(db, todoQuery);
  return <ul>{data?.map((row) => <li key={row.id}>{row.title}</li>)}</ul>;
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
