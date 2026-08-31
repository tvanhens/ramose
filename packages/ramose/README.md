# ramose

An immutable, Datomic-inspired graph database for Cloudflare (Workers +
Durable Objects + R2), built on Effect. Your data model is one TypeScript
value; queries and authoritative operations are portable values too.

```sh
bun add ramose effect@rc
```

`npm install` and `pnpm add` work the same. `effect` is a required peer:
operation input and output codecs are Effect Schemas, and declaring the peer
keeps strict dependency resolvers on one compatible Effect instance. Alchemy
comes with Ramose. Apps using `ramose/better-auth` also need the optional
peers `better-auth` and `zod`.

Ramose is pre-release: expect the API to change between minor versions.

## The public entries

| Import | What it is |
| --- | --- |
| `ramose/db` | Portable schema, query, pull, operation, transaction-authoring primitives, and tagged errors. |
| `ramose/client` | The offline-first browser client: `createClient`, one interned root handle, local query execution over a durable authorized replica, and framework-neutral subscriptions. |
| `ramose` | Deploy barrel: everything on `ramose/db` plus `Server`, `Database`, JWT claims, providers, and HTTP error mapping. |
| `ramose/worker` | The peer Worker itself. Hand it to Alchemy as `main: import.meta.resolve("ramose/worker")` — `main` is a path, so a bare specifier there silently resolves to nothing. |
| `ramose/better-auth` | The Better Auth plugin that mints the workspace-scoped JWT a peer verifies. Needs optional peers `better-auth` and `zod`. |

App schemas use `Ramose.string()` / `boolean()` / `Enum([...])`. Operation
codecs import `effect/Schema` from the application's declared Effect peer.

## A first look

```ts
// schema.ts
import * as Ramose from "ramose/db";

export const Todo = Ramose.Entity("todo", {
  title: Ramose.string(),
  done: Ramose.boolean(),
});

export const Todos = Ramose.Schema("todos", { todo: Todo });

Todos.applyPolicy(({ policy }) => {
  policy.todo.read.always();
});
```

## Docs

Full documentation lives at **[ramose.ai](https://ramose.ai)**.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
