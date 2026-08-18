# Ramose

**Reactive applications that grow safely.**

A modern Effect-native graph database on Cloudflare — a typed, realtime
database that runs next to your app at the edge.

Docs: **[ramose.ai](https://ramose.ai)**.

One Durable Object writes. Immutable segment trees live in R2. Datalog runs
at the edge, next to your app. A database is a name — `ramose.db("acme",
Catalog)` and you're in. No provision step.

## Install

```sh
npm install @ramose/alchemy
```

`bun add` and `pnpm add` work the same. `@ramose/alchemy` is the package:

- `@ramose/alchemy/db` — the catalog and the client (browser, tests, anything
  that should never see the deploy engine)
- `@ramose/alchemy` — all of `/db`, plus `Ramose.Server`, `Ramose.Database`,
  and `Policy`

A React app also takes `@ramose/react`. The peer — the Worker that serves
your databases — is `@ramose/worker`: you name it as `main` on a
`Cloudflare.Worker` (via `import.meta.resolve`, since `main` is a path), you
do not copy it into your repo.

```sh
npm install @ramose/alchemy @ramose/worker @ramose/react alchemy effect
```

The [Quickstart](https://ramose.ai/getting-started/quickstart/)
adds those packages to a Vite app, stands up a local peer, and gets a live
query on the page.

## Why it exists

- **Typed catalog.** `@ramose/alchemy/db` is the schema. Attributes, uniqueness,
  cardinality — TypeScript, checked at compile time.
- **Effect-native writes and reads.** Generator `transact`. Navigational
  `Ramose.query` → `db.q` / `db.live`. `db.pull`.
- **Live queries.** `db.live` is a `Stream` on the session socket. Write a
  row, it re-runs. No refetch. No invalidation call at the write site.
- **Db-per-tenant is a function call.** One Alchemy resource, one
  `RAMOSE_TOKEN` (unset = open), or a `RAMOSE_POLICY` that turns JWT
  claims into a per-request filtered `Db` (see
  [Auth and policy](https://ramose.ai/guides/auth/)).
  Every name shares the peer.
- **The invariants are the product.** Single writer. Dense `t`.
  Persist-before-ack. QueryReplicas are first-class — workers never read
  novelty from the transactor.

## Catalog → db → transact → live

```ts
import * as Ramose from "@ramose/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant),
});
export const Todos = Ramose.Catalog({ todo: Todo });

const token = import.meta.env.VITE_RAMOSE_TOKEN;
const ramose = Ramose.connect({
  url: import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337",
  token: token ? Ramose.token.static(token) : undefined,
});
const db = ramose.db("todos", Todos);

const todoQuery = Ramose.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select({
    id: Todo.id,
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });
const todos = db.live(todoQuery);
// Stream<readonly { id, title, done, createdAt }[]>

await Effect.runPromise(
  db.transact(function* (tx) {
    const t = yield* tx.entity();
    yield* t.add(Todo.title, "ship it");
    yield* t.add(Todo.done, false);
    yield* t.add(Todo.createdAt, new Date());
  }),
);
```

Every signature's `R` is `never`, so `Effect.runPromise` runs anything a
`Db` returns; in React the shipped hooks do it for you — `useLive(db, todoQuery)`
and `useTransact()` from `@ramose/react`. `@ramose/alchemy/db` is a real
`exports` entry and nothing it reaches imports the deploy engine, so the Vite
app needs no alias.

From a Worker the code is identical: `ramose.db("movies", Movies)`, then the
same `transact` / `q` / `pull`. `transact` returns a `TxReport`, and its
`dbAfter` is the same db floored at `report.t` — that is the read-your-write
fence, with no second round trip. `db.asOf(t)` and `db.history` are pure
views.

## Stand up a peer

```ts
import * as Ramose from "@ramose/alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", {
  className: "TransactorDO",
});
const Replica = Cloudflare.DurableObject("QueryReplicaDO", {
  className: "QueryReplicaDO",
});

export const RamoseWorker = Cloudflare.Worker("Peer", {
  main: import.meta.resolve("@ramose/worker"),
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});

export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
export const TodosDb = Ramose.Database("todos", { server: Server, catalog: Todos });
```

`Ramose.Database` is not a cloud object — a database is a name — it is
"install this catalog on that name", so the catalog is on the peer before the
UI connects. Per-tenant names call `db.install()` at tenant-creation instead.
`RAMOSE_TOKEN` is the peer's one bearer token; leave it unset and the peer is
open. Set `RAMOSE_POLICY` and the peer verifies JWTs, ties each token to one
database, and filters reads / checks writes against the policy in
[Auth and policy](https://ramose.ai/guides/auth/).

An app Worker binds the same server (`yield* Ramose.ReadWriteDatabases(Server)`,
under `Ramose.ServerBinding` or `Ramose.ServerHttp`) and calls
`ramose.db(name, catalog)` per request — pure, zero network, so that is
db-per-tenant. `Ramose.ReadDatabases` is the same client with the writes
removed.

`npx alchemy dev` runs the stack locally under miniflare (peer on `:1337`).
`npx alchemy deploy` ships it; `--stage prod` for production. Local miniflare
accepts placeholder Cloudflare credentials — see the
[Quickstart](https://ramose.ai/getting-started/quickstart/).

## Features

- Immutable EAVT graph. Time travel is a view, not a dump.
- Seek-driven datalog at the edge. `Ramose.query` builds a typed value;
  `db.q` and `db.live` run it — once or as a `Stream` on the session socket.
  See [Query and pull](https://ramose.ai/guides/queries/).
- One writer per name, dense `t`, persist-before-ack.
- QueryReplicas hold novelty; workers read through them.
- Privilege is the capability you bind: `Ramose.ReadWriteDatabases` or
  `Ramose.ReadDatabases`; the transport is a Layer.

## Examples

Complete apps that use the same packages, in this repository:

- [`examples/todos`](examples/todos) — catalog, live query, typed writes
- [`examples/reef`](examples/reef) — multi-tenant issue tracker, Better Auth, policy
- [`examples/kv-style`](examples/kv-style) — one Worker, one database per customer

## Contributing

Working on Ramose itself is a Bun monorepo. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

```sh
bun install
bun test
bun run typecheck
bun run dev:todos     # peer on :1337, app on :5173
```

Ops: [Runbook](https://ramose.ai/reference/runbook/).
Recorded benches: [`bench/RESULTS.md`](bench/RESULTS.md).
Brand assets (mark, on-dark mark, horizontal and stacked lockups, app icon):
[`website/public/brand/`](website/public/brand/).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Contributions require signing the [CLA](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
