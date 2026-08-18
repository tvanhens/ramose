# Todos

The consumer proof for navigational query (`docs/QUERY.md`) on
`Ripple.connect` + `db.live`.

## Run it

From the repo root, one command:

```sh
bun run dev:todos
```

That brings up the peer (`:1337`) and the Vite dev server (`:5173`) — the SPA
is a `Command.Dev` resource in the same stack, so it starts once the peer is
serving, is handed `VITE_RIPPLE_URL`, and is torn down with it. Then open
http://localhost:5173. It is shorthand for

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/todos/alchemy.run.ts          # peer on :1337
VITE_RIPPLE_URL=http://localhost:1337 bunx vite examples/todos   # UI on :5173
```

with each variable only defaulted when you have not set it yourself (see
`.cursor/CLOUD.md` for why miniflare wants them). `bunx vite build
examples/todos` builds the same bundle for production.

## The shape

| file | what it is |
|---|---|
| `schema.ts` | the catalog, on `@ripple/alchemy/db` — shared by the stack, a Worker and the browser |
| `resources.ts` / `alchemy.run.ts` | `Ripple.Server` + `Ripple.Database`: the one place the catalog is installed |
| `src/db.ts` | one client, closed with the page. `db`, nothing else |
| `src/todos.ts` | `Ripple.query(Todo).select(…)` and writes, so the test drives exactly what the UI does |
| `src/useLive.ts` | twelve lines of `Stream` → React state. Example code, **not** a shipped name |
| `test/todos.test.ts` | those helpers against a real `@ripple/core` `Connection` over both wires |

`src/db.ts` is the whole client:

```ts
const ripple = Ripple.connect({ url, token });
export const db = ripple.db("todos", Todos);
```

No `await` at module scope (`connect` throws only on a provisioning mistake
and the socket opens lazily), no runtime and no `run` — every `Db` method
needs no environment, so writes are `Effect.runPromise(db.transact(…))` — and
no Vite alias: `@ripple/alchemy/db` is a real `exports` entry and nothing it
reaches imports the deploy engine, so the built bundle contains no `alchemy`
code at all. (Effect users: `Ripple.layer({ url, token })` is the same client
as a scoped `Layer<Databases>`.)

`db.live` is a `Stream` over a **query value**, so it is hoisted once at module
scope and the hook's dependency is stable:

```ts
const todoQuery = Ripple.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select({ id: Todo.id, title: Todo.title, done: Todo.done, createdAt: Todo.createdAt });

const todos = db.live(todoQuery);   // Stream<Ripple.Rows<typeof todoQuery>, Ripple.DbError>
type TodoRow = Ripple.Row<typeof todoQuery>;  // one row, named from the query
```

Teardown is fiber interruption — `useLive`'s cleanup is one
`Fiber.interrupt`. Writes are
`Effect.runPromise(db.transact(function* (tx) { … }))` and one row is
`db.pull(eid, shape)`; a write bumps the connection's basis, so the standing
stream re-runs with no refetch and no invalidation call at the write site.
