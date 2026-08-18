# Ripple

A modern Effect-native graph database on Cloudflare.

Docs: **[ripple-docs.tvanhens.workers.dev](https://ripple-docs.tvanhens.workers.dev)**.

One Durable Object writes. Immutable segment trees live in R2. Datalog runs
at the edge, next to your app. A database is a name — `ripple.db("acme",
Catalog)` and you're in. No provision step.

## Why it exists

- **Typed catalog.** `@ripple/alchemy/db` is the schema. Attributes, uniqueness,
  cardinality — TypeScript, checked at compile time.
- **Effect-native writes and reads.** Generator `transact`. Navigational
  `Ripple.query` → `db.q` / `db.live`. `db.pull`.
- **Live queries.** `db.live` is a `Stream` on the session socket. Write a
  row, it re-runs. No refetch. No invalidation call at the write site.
- **Db-per-tenant is a function call.** One Alchemy resource, one
  `RIPPLE_TOKEN` (unset = open), or a `RIPPLE_POLICY` that turns JWT
  claims into a per-request filtered `Db` (see
  [Auth and policy](https://ripple-docs.tvanhens.workers.dev/guides/auth/)).
  Every name shares the peer.
- **The invariants are the product.** Single writer. Dense `t`.
  Persist-before-ack. QueryReplicas are first-class — workers never read
  novelty from the transactor.

## Get running with Alchemy

The shortest path is the todos app — React, `Ripple.layer`, `db.live`:

```sh
bun install
bun run dev:todos     # peer on :1337, app on :5173
```

`bun run dev:reef` runs the flagship demo instead — Reef, a Linear-style
multi-tenant issue tracker where every workspace is its own database, with
Better Auth JWTs and a compiled policy.

The long form of `dev:todos`, if you want to set the environment yourself —
each variable is only defaulted when unset, so set your own to override one:

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/todos/alchemy.run.ts   # peer on :1337, Vite on :5173
```

That stack is a peer Worker (R2 + Transactor DO + QueryReplica DO), a
`Ripple.Server` and a `Ripple.Database`. The UI is Vite. Copy
`examples/todos/{resources,alchemy.run,schema}.ts` and you have the same
shape.

```ts
import * as Ripple from "@ripple/alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", {
  className: "TransactorDO",
});
const Replica = Cloudflare.DurableObject("QueryReplicaDO", {
  className: "QueryReplicaDO",
});

export const RippleWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});

export const Server = Ripple.Server("Ripple", { worker: RippleWorker });
export const TodosDb = Ripple.Database("todos", { server: Server, catalog: Todos });
```

`Ripple.Database` is not a cloud object — a database is a name — it is
"install this catalog on that name", so the catalog is on the peer before the
UI connects. Per-tenant names call `db.install()` at tenant-creation instead. `RIPPLE_TOKEN` is the peer's
one bearer token; leave it unset and the peer is open. Set `RIPPLE_POLICY` and
the peer verifies JWTs, ties each token to one database, and filters reads /
checks writes against the policy in
[Auth and policy](https://ripple-docs.tvanhens.workers.dev/guides/auth/).

An app Worker binds the same server (`yield* Ripple.ReadWriteDatabases(Server)`,
under `Ripple.ServerBinding` or `Ripple.ServerHttp`) and calls
`ripple.db(name, catalog)` per request — pure, zero network, so that is
db-per-tenant. `Ripple.ReadDatabases` is the same client with the writes
removed. See `examples/kv-style/`.

Local root stack (no example UI):

```sh
ALCHEMY_STATE=local CLOUDFLARE_ACCOUNT_ID=<32 hex> CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev
```

Any placeholder account id works for miniflare. `bun alchemy deploy` ships
the `$USER` stage; `--stage prod` for production.

## Catalog → db → transact → live

```ts
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
});
export const Todos = Ripple.Catalog({ todo: Todo });

// one client, closed with the page (Effect users: Ripple.layer is the same
// client as a scoped Layer<Databases>)
const token = import.meta.env.VITE_RIPPLE_TOKEN;
const ripple = Ripple.connect({
  url: import.meta.env.VITE_RIPPLE_URL ?? "http://localhost:1337",
  // an open peer has no token: wrapping `undefined` fails on the first request
  token:
    token === undefined || token === ""
      ? undefined
      : Effect.succeed(Redacted.make(token)),
});
const db = ripple.db("todos", Todos);

const todoQuery = Ripple.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select({
    id: Todo.id,
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });
const todos = db.live(todoQuery);
// Stream<readonly { id, title, done, createdAt }[]>
// hoist it, then drain it with Stream.runForEach on its own fiber

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
`Db` returns; see `examples/todos/src/db.ts` and its dozen-line `useLive`.
`@ripple/alchemy/db` is a real `exports` entry and nothing it reaches imports
the deploy engine, so the Vite app needs no alias.

From a Worker the code is identical: `ripple.db("movies", Movies)`, then the
same `transact` / `q` / `pull`. `transact` returns a `TxReport`, and its
`dbAfter` is the same db floored at `report.t` — that is the read-your-write
fence, with no second round trip. `db.asOf(t)` and `db.history` are pure
views.

## Features

- Immutable EAVT graph. Time travel is a view, not a dump.
- Seek-driven datalog at the edge. `Ripple.query` builds a typed value;
  `db.q` and `db.live` run it — once or as a `Stream` on the session socket.
  See [Query and pull](https://ripple-docs.tvanhens.workers.dev/guides/queries/).
- One writer per name, dense `t`, persist-before-ack.
- QueryReplicas hold novelty; workers read through them.
- Privilege is the capability you bind: `Ripple.ReadWriteDatabases` or
  `Ripple.ReadDatabases`; the transport is a Layer.
- Engine in `packages/core`, Cloudflare peer in `packages/worker`, client in
  `packages/alchemy`.

## Commands

```sh
bun install
bun test
bun run typecheck
bun alchemy dev                 # root stack (miniflare)
bun alchemy deploy              # $USER stage
bun alchemy deploy --stage prod
```

Docs: [ripple-docs.tvanhens.workers.dev](https://ripple-docs.tvanhens.workers.dev).
Contributing (tests, CI, Cloudflare e2e): [`CONTRIBUTING.md`](CONTRIBUTING.md).
Ops: [Runbook](https://ripple-docs.tvanhens.workers.dev/reference/runbook/).
Recorded benches:
[`bench/RESULTS.md`](bench/RESULTS.md).
