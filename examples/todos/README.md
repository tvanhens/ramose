# Todos

The smallest Ramose peer example: a catalog, typed operations, and a local
Alchemy stack. No auth and no policy.

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
| `schema.ts` | the catalog, on `ramose/db` — shared by the stack and the Worker |
| `resources.ts` / `alchemy.run.ts` | `Ramose.Server({ databases: { todos: Todos } })`: the owned peer and the catalog seeder |
| `src/todos.ts` | `Ramose.Query.from` + writes used by the peer and local-stack fixtures |
| `peer.ts` | the Worker entry |

`src/todos.ts` hoists the query once at module scope:

```ts
export const todoQuery = Ramose.Query.from(Todo)
  .select(todoShape)
  .orderBy(Todo.createdAt, "asc");

export type TodoRow = Ramose.Row<typeof todoQuery>;
```
