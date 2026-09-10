# Todos

The smallest Ramose peer example: a named schema, typed operations, an open
read policy, and a local Alchemy stack. It does not configure authentication.

## Run it

From the repo root:

```sh
bun run dev:todos
```

That brings up the peer on http://localhost:1337. It is shorthand for

```sh
bun alchemy dev examples/todos/alchemy.run.ts
```

`bun run dev:todos` sets CI / ALCHEMY_STATE and placeholder Cloudflare
credentials the local emulator wants (see `.cursor/CLOUD.md`).

## The shape

| file | what it is |
|---|---|
| `schema.ts` | the schema and owned operations, authored with `ramose/db` |
| `resources.ts` / `alchemy.run.ts` | the local peer deployment |
| `src/todos.ts` | a reusable `Ramose.Query.from` projection |
| `peer.ts` | the Worker entry |

`src/todos.ts` hoists the query once at module scope:

```ts
export const todoQuery = Ramose.Query.from(Todo)
  .select(todoShape)
  .orderBy(Todo.createdAt, "asc");

export type TodoRow = Ramose.Row<typeof todoQuery>;
```
