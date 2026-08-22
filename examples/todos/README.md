# Todos

The consumer proof for navigational query (website
[Read data](https://ramose.ai/guides/queries/)) on
`Ramose.connect` + `ramose/react` — every name in it is shipped.

## Run it

From the repo root, one command:

```sh
bun run dev:todos
```

That brings up the peer (`:1337`) and the Vite dev server (`:5173`) — the SPA
is a `Command.Dev` resource in the same stack, so it starts once the peer is
serving, is handed `VITE_RAMOSE_URL`, and is torn down with it. Then open
http://localhost:5173. It is shorthand for

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/todos/alchemy.run.ts          # peer on :1337
VITE_RAMOSE_URL=http://localhost:1337 bunx vite examples/todos   # UI on :5173
```

with each variable only defaulted when you have not set it yourself (see
`.cursor/CLOUD.md` for why miniflare wants them). `bunx vite build
examples/todos` builds the same bundle for production.

## The shape

| file | what it is |
|---|---|
| `schema.ts` | the catalog, on `ramose/db` — shared by the stack, a Worker and the browser |
| `resources.ts` / `alchemy.run.ts` | `Ramose.Server` + `Ramose.Database`: the one place the catalog is installed |
| `src/db.ts` | one client, closed with the page. `db`, nothing else |
| `src/todos.ts` | `Ramose.query(Todo).select(…)` and writes, so the test drives exactly what the UI does |
| `src/App.tsx` | the UI on `useLive` + `useTransact` from `ramose/react` — no hand-rolled hooks |
| `test/todos.test.ts` | those helpers against a real engine `Connection` over both wires |

`src/db.ts` is the whole client:

```ts
const ramose = Ramose.connect({ url, token: token ? Ramose.token.static(token) : undefined });
export const db = ramose.db("todos", Todos);
```

No `await` at module scope (`connect` throws only on a provisioning mistake
and the socket opens lazily), no runtime and no `run` — every `Db` method
needs no environment, so the shipped hooks run them directly — and
no Vite alias: `ramose/db` is a real `exports` entry and nothing it
reaches imports the deploy engine, so the built bundle contains no `alchemy`
code at all. (Effect users: `Ramose.layer({ url, token })` is the same client
as a scoped `Layer<Databases>`.)

The query is a **value**, so it is hoisted once at module scope in
`src/todos.ts`, and one row is named from it, never restated:

```ts
export const todoQuery = Ramose.Query.q(() =>
  pipe(
    Ramose.Query.entities(Todo),
    Ramose.Query.select(todoShape),
    Ramose.Query.orderBy(Todo.createdAt, "asc"),
  ),
);

export type TodoRow = Ramose.Row<typeof todoQuery>;
```

`src/App.tsx` renders it with the shipped hooks — `useLive(db, todoQuery)`
memoises `db.live(todoQuery)` on `[db, query]` and tears down by fiber
interruption; `useTransact().run` runs a write from an event handler:

```tsx
const { rows, error } = useLive(db, todoQuery);
// …
const { run } = useTransact();
onChange={(e) => void run(setDone(db, { id: row.id }, e.target.checked))}
```

A write bumps the connection's basis, so the standing stream re-runs with no
refetch and no invalidation call at the write site; one row without a query
is `db.pull(eid, shape)`.
