# ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers +
Durable Objects + R2), built on Effect. Your data model is one TypeScript
value; queries are values too, and a live query re-runs itself when the
database changes.

```sh
bun add ramose
```

`npm install` and `pnpm add` work the same. `effect` comes with this package.
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
| `ramose/better-auth` | The Better Auth plugin that mints the workspace-scoped JWT a peer verifies. Needs optional peers `better-auth` and `zod`. |
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

```ts
import * as Ramose from "ramose/db";
import { Todo, Todos } from "./schema.ts";

const ramose = Ramose.connect({ url });
const db = ramose.db("todos", Todos);
const todos = await db.query(Ramose.Query.from(Todo));
```

## Docs

Full documentation lives at **[ramose.ai](https://ramose.ai)**. Start with
[Getting started](https://ramose.ai/getting-started/quickstart/) — a working
todo app from an empty folder, no Cloudflare account required.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
