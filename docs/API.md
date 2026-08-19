# Ramose: a smaller Effect-native client

Proposal. Breaking. No shims. Nothing on `master` is frozen.

## 1. Goal

One `db`, typed from the catalog, no codegen. It looks like Alchemy in a Worker
and like a client in a browser — same names, same `Db<C>`, different transport.
Everything that exists only because the implementation grew that way (`SchemaFx`,
`RuntimeContext`, `create` vs `connect`, the capability trio, nine transport
layers, the untyped `Client.*` twin, the `/schema` Vite alias) is deleted rather
than renamed. What is left is **41 names** across two entry points, both
imported as `* as Ramose`.

## 2. The names a consumer imports

- **`ramose/db`** — portable: browser, Node/Bun, tests. A real `exports`
  entry, so the Vite alias dies. It must not import `alchemy` (implementation:
  deep-import the `ramose/internal/core` codec, not the barrel; `sideEffects: false`).
- **`ramose`** — all of `/db`, plus the resources, the capability and
  the two transport layers.

### `ramose/db`

**Schema**

| name | signature |
|---|---|
| `Attr` | `(schema: Schema.Top, options?) => Attribute` |
| `Namespace` | `(name: string, attrs: Record<string, Attribute>) => Namespace` |
| `Catalog` | `(namespaces: Record<string, Namespace>) => Catalog` |
| `Instant` `Uuid` `UuidString` `Ref` `Long` `Bytes` | branded `Schema`s carrying a `:db.type/*` TS cannot infer |
| `Attribute` `Namespace` `Catalog` `Catalog.Any` | types (`Catalog.Any` for catalog-generic helpers) |

**Connecting**

| name | signature |
|---|---|
| `layer` | `(options: ClientOptions) => Layer<Databases>` |
| `Databases` | `Context.Service<Databases, { db<C>(name: string, catalog: C): Db<C> }>` — the key *is* the client |
| `ClientOptions` | `{ url: string; token?: Effect<Redacted<string>>; fetch?: typeof fetch; webSocket?: typeof WebSocket }` |
| `DATABASE_NAME_RE` `isDatabaseName` | the peer's database-name rule (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`), as a `RegExp` and a predicate — validate a user-minted name before the peer does. Not a slugify |

Static token: `Effect.succeed(Redacted.make(t))`. The layer is scoped, the socket a finalizer; getting a `Databases` cannot fail.

**The database**

| name | signature |
|---|---|
| `Db<C>` | `ReadDb<C> & { transact; install }` |
| `ReadDb<C>` | `{ name; catalog; q; pull; live; basis; asOf; history }` |
| `db.q` | `<R>(query: NavQuery\<R\> \| NavQueryBuilder\<_, R\>) => Effect<R, DbError>` — a `Ramose.query(N)` value (see `docs/QUERY.md`); with no `.select`, `R` is `readonly Eid<C>[]` |
| `db.live` | same input as `db.q` → `Stream<R, DbError>` |
| `db.pull` | `<const P>(subject: Eid<C> \| LookupRef<C>, shape: P) => Effect<Pull<C, P> \| null, DbError>` |
| `db.transact` | `<A, E, R>(body: (tx: Tx<C>) => Generator<Effect<unknown, E, R>, A>) => Effect<TxReport<C>, DbError \| E, R>` |
| `db.install` | `() => Effect<TxReport<C>, DbError>` — idempotent catalog upsert |
| `db.basis` | `() => Effect<{ t: number }, DbError>` — the basis this view reads at: one `GET /db/:name/info` for a live db; `asOf(t)` answers `{ t }` with no request |
| `db.principal` | `() => Effect<DbPrincipal<C>, DbError>` — who this session is, resolved by the peer (`/info`'s `principal`, also on the session `auth` ack): `{ eid: Eid<C> \| null, class }`, `eid: null` until the policy's principal attribute has a row; a `null` is never cached, a resolved eid is cached per session generation and re-read on reconnect |
| `db.asOf` | `(t: number) => ReadDb<C>` |
| `db.history` | `ReadDb<C>` |
| `query` | `Ramose.query(N)` — navigational query builder (`.where` `.select` `.orderBy` `.limit` `.offset`); order and paging run on the peer |
| `Pull<C, P>` | result of shape `P`. Nest with `attr.select({…})`, maybe with `.optional` |
| `Eid<C>` | `{ readonly id: number }`, catalog-branded. Data — no methods, no I/O |
| `LookupRef<C>` | `[AttrRef, value]` on a unique attribute |
| `Tx<C>` | `.entity()` `.add(e, a, v)` `.retract(e, a, v?)` `.retractEntity(e)`; `Entity<C>` is the handle `.entity()` returns |
| `Entity<C>` | `{ eid; add; retract }` |
| `TxReport<C>` | `{ t; txEid: Eid<C>; datomCount: number; dbAfter: Db<C> }` |

**Errors** — `Data.TaggedError`, matched with `Effect.catchTags`.

`TxRejected` `Unavailable` `InvalidRequest` `DatabaseNotFound` `Unauthorized`
`QueryBudgetExceeded` `InternalError` `NetworkError`, and the union `DbError`.

### `ramose` (adds)

| name | signature |
|---|---|
| `Server` | `(id: string, props: { worker: Cloudflare.Worker; url?: string; token?: Secret }) => Server` — outputs `{ url, workerName }` |
| `Database` | `(id: string, props: { server: Server; catalog: C; name?: string }) => Database` — installs the catalog at deploy |
| `ReadWriteDatabases` | `(server: Server) => Effect<Databases, never, Providers>` — `Binding.Service` tag; the binding **is** the client |
| `ServerBinding` | `Layer<Providers>` — Worker service binding |
| `ServerHttp` | `Layer<Providers>` — public URL; also `Alchemy.Action` and `alchemy dev` |
| `providers` | `() => Layer<Providers>` |
| `Providers` | the resource-provider service |

## 3. Happy path

**schema.ts** — shared by the stack, the Worker and the browser.

```ts
import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant),
});
export const Todos = Ramose.Catalog({ todo: Todo });
```

**alchemy.run.ts** — the server, and the one place the catalog is installed.

```ts
import * as Ramose from "ramose";
import * as Cloudflare from "alchemy/Cloudflare";
import { Todos } from "./schema.ts";

const RamoseWorker = Cloudflare.Worker("RamoseWorker", { main: import.meta.resolve("ramose/worker") });
export const Server = Ramose.Server("Ramose", { worker: RamoseWorker });
export const TodosDb = Ramose.Database("todos", { server: Server, catalog: Todos });
```

`main` is a **path**, not a module specifier — Alchemy `realpath`s it before
bundling — so the package name goes through `import.meta.resolve`. A bare
`"ramose/worker"` resolves against the working directory, finds nothing, and
leaves a peer that binds its port and never answers.
`Ramose.workerEntry()` from `ramose/workerEntry` is the same
resolution with an error worth reading when the package is not installed.

**An app Worker** — db-per-tenant is a function call.

```ts
export default Cloudflare.Worker("App", { main: import.meta.url },
  Effect.gen(function* () {
    const ramose = yield* Ramose.ReadWriteDatabases(Server);   // once, at init
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const db = ramose.db(tenantOf(request), Todos);
        const { dbAfter } = yield* db.transact(function* (tx) {
          const todo = yield* tx.entity();
          yield* todo.add(Todo.title, "ship it");
          yield* todo.add(Todo.done, false);
        });
        const rows = yield* dbAfter.q(
          Ramose.query(Todo).select({ title: Todo.title }),
        );
        return yield* HttpServerResponse.json(rows);           // readonly { title: string }[]
      }),
    };
  }).pipe(Effect.provide(Ramose.ServerBinding)));
```

**Browser** — no `run`, no `RuntimeContext.phantom`, no Vite alias, no `await`.

```ts
// db.ts — one client, closed with the page
import * as Ramose from "ramose/db";
import { Todos } from "./schema.ts";

const token = Effect.succeed(Redacted.make(import.meta.env.VITE_RAMOSE_TOKEN));
const ramose = Ramose.connect({ url: import.meta.env.VITE_RAMOSE_URL, token });
export const db = ramose.db("todos", Todos);
// Effect users: Ramose.layer({ url, token }) is the same client as a scoped
// Layer<Databases>.
```

```tsx
// App.tsx — query value hoisted so the hook's dep is stable
const todoQuery = Ramose.query(Todo).select({
  id: Todo.id,
  title: Todo.title,
  done: Todo.done,
  createdAt: Todo.createdAt,
});
const todos = db.live(todoQuery);
//    Stream<readonly { id; title; done; createdAt }[], Ramose.DbError>

const add = (title: string) =>
  Effect.runPromise(db.transact(function* (tx) {
    const todo = yield* tx.entity();
    yield* todo.add(Todo.title, title);
    yield* todo.add(Todo.createdAt, new Date());
  }));

const one = (e: Ramose.Eid<typeof Todos>) =>
  Effect.runPromise(
    db.pull(e, { title: Todo.title, done: Todo.done, createdAt: Todo.createdAt }),
  );
```

```tsx
// useLive is example-app code, not a shipped name.
export const useLive = <A, E>(stream: Stream.Stream<A, E>) => {
  const [s, set] = useState<{ rows?: A; error?: Cause.Cause<E> }>({});
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (rows) => Effect.sync(() => set({ rows }))).pipe(
        Effect.catchCause((error) => Effect.sync(() => set((p) => ({ ...p, error })))),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }, [stream]);   // `stream` must be hoisted, not built in render
  return s;
};
```

## 4. Semantics that matter

- **A db is a value.** `db.asOf(t)` and `db.history` are `Db -> ReadDb`: pure, zero I/O; `q` / `pull` / `live` compose over them unchanged, and you cannot transact into the past.
- **`transact` returns `TxReport`.** `dbAfter` is the same `Db` carrying a min-`t` floor of `report.t` — read-your-writes with no second round trip and no `sync`.
- **That floor is best-effort.** The server polls its replica ~100ms for the basis, then serves the freshest it has; `asOf(t)` by contrast pins an exact past view.
- **A write advances the whole connection.** `transact` bumps the session basis to `report.t`, so every standing `live` re-runs against it — writes go over HTTPS `/transact`, reads and `t` ticks over the socket.
- **`live` requires nothing.** Its `Stream`'s requirements channel is `never` — no `Scope` in the type; teardown is fiber interruption.
- **`live` survives the network.** Dropped sockets, 5xx and `NetworkError` are retried with backoff and the socket reconnects in place; the stream fails only on terminal `InvalidRequest`, `Unauthorized` or `DatabaseNotFound`.
- **`live` over `asOf(t)` / `history` emits once and completes** — a pinned view has no news.
- **Install is explicit and once.** `Ramose.Database(...)` at deploy, or `db.install()` at tenant-creation; `ramose.db(name, catalog)` is pure, so a Worker binding does zero network per request and a browser never installs schema.
- **Against an uninstalled database:** `q` fails `InvalidRequest`, `transact` fails `TxRejected`, `pull` silently omits the attribute — that last one is a bug to fix, not a contract.
- **Token is one form.** `Effect<Redacted<string>>`, re-read on every (re)connect and every `/transact`; socket auth is handshake-scoped, so `Unauthorized` on the socket re-reads and reconnects in place.
- **Capability is the client, transport is a Layer.** `yield* Ramose.ReadWriteDatabases(Server)` hands back `Databases`; `ServerBinding` or `ServerHttp` decides the wire, and the Worker body is identical under either.
- **Provisioning mistakes are defects.** A missing binding or a malformed URL is `Effect.die`, not a `DbError` — every signature's `R` is `never`.

## 5. Kill-list

| current export | fate |
|---|---|
| `Client.*` namespace (13 exports) | deleted; untyped twin |
| `Typed{Read,Write,ReadWrite}{Database,System}Client` and their untyped `*Client` twins | → `Db<C>` / `ReadDb<C>` / `Databases` |
| `DatabaseEndpoint`, `DatabaseSource`, `SystemEndpoint`, `SystemSource`, `QueryMeta`, `QueryOptions`, `QueryResponse` | internal |
| `FetchLike`, `WebSocketLike`, `TxAck` | → `typeof fetch`/`WebSocket`, `TxReport<C>` |
| `TransactorDead`, `BadRequest`, `NotFound`, `Internal`, `DatabaseError`, `OpenError`, `IoError` | renamed → `DbError`; eight tagged errors stay |
| `isDatabaseError`, `HeaderLike`, `fromResponse`, `ProviderRequirements`, `Equal`, `Expect`, `Extends` | internal or test-only |
| `ReadSystem`, `WriteSystem`, `ReadWriteSystem` | → `ReadWriteDatabases`; `ReadDatabases` returns with #14 |
| 9 × `{Read,Write,ReadWrite}System{Binding,Http,Local}` | → `ServerBinding`, `ServerHttp` |
| `System`, `SystemProps`, `SystemPeer`, `SystemProbe` | → `Ramose.Server`, prop `worker` |
| `isSystem`, `resolvePeer`, `ProviderLive`, `ProviderLocal`, `SystemProvider` | internal; bad name is `InvalidRequest` |
| `DATABASE_NAME_RE` | public again, on `/db` with `isDatabaseName` (#37) |
| `openSession`, `Session`, `SessionOptions`, `sessionUrl`, `TypedSession`, `TypedSessionOptions`, `Session.connect`'s `{ session, db }` | internal; `layer` provides `Databases` |
| `SchemaFx` (the namespace name) | deleted; flattened into `/db` |
| `create` / `connect` on a system | → `ramose.db(name, catalog)`, pure |
| `fromRead`, `fromWrite`, `fromReadWrite`, `makeSystem`, `make*SystemClient` (×6), `unsafe*Database` (×3) | deleted or internal fixtures |
| `AnyAttribute`, `AttributeOptions`, `Cardinality`, `Uniqueness`, `ValueOf` | internal, inferred |
| `AnyCatalog`, `AnyNamespace`, `NamespaceMap`, `NamespaceOf`, `AttributeMap`, `AttrOf`, `IdentOf`, `merge`, `Stamped*` | → `Catalog.Any`; rest internal |
| `DbValueType`, `RamoseVt`, `InferDbValueType`, `tryInferDbValueType`, `inferDbValueType` | internal |
| `SchemaEnsureError`, `MissingPeer`, `missingPeer`, `noPeer` | deleted; provisioning is a defect |
| `schemaTx`, `attributeTx`, `SchemaAttrTx` | internal; `db.install()` is the door |
| `Eid.of`, `makeEid`, `isEid`, `EidPull`, `EidPullError`, `eid.pull` | deleted; `Eid<C>` is data |
| `entity(eid)` read op, socket `op:"entity"`, `info()`, `health()`, `DatabaseHealth` | deleted; `db.pull`, deploy-time probe |
| all `Live*` (`LiveStore`, `LiveFn`, `LiveQuery*`, `LiveFind`, `LiveRow`, `TypedLiveDatabaseClient`, `EidVar`, `LiveRun`, `makeLive`) | deleted; `db.live` is a `Stream` |
| `PullResult`, `pick`, `ValidatePull`, `PullOptional`, `PullNested`, `AttrPull`, `IdentPull*`, `StructPullResult`, `isPull*`, `lowerPullPattern`, `reshapePullResult` | → `Pull<C, P>`; rest internal |
| the callback query builder (`db.q((q) => q.where("?e", …).find("?e"))`, `Query<C, R>`, `QueryBuilder`, `QueryVar`, `QueryBlank`, `*Slot`, `FindRow(s)`, `Bind*`, `ValueFromAttr`, `AttrRef`, `QuerySpec`, `toQueryObject`, `queryBuilder`) | deleted; `Ramose.query(N)` is the one read surface |
| `q(string \| object)`, `db.query`, `builder.query`, the `explain` terminal | deleted |
| all `Tx*` builder & wire types (`TxBuilder`, `EntityHandle`, `TxAttr/Value/Entity`, `TxOp`, `TxSpec`, `AttrRefLookup`, `Yield*`, `Tx*Body`, `txBuilder`, `lowerWireTx`) | → `Tx<C>` / `Entity<C>`; rest internal |
| `WireTx*`, `WireEntity`, `AddOp`, `RetractOp`, `RetractEntityOp`, `transactWire`, `transactUntyped` | deleted; one tx form, the generator |
| `Ident`, `EntityRef`, `CatalogIdent`, `AttrAtIdent`, `ValueAtIdent`, `CardAtIdent`, `WriteAtIdent`, `ReadAtIdent` | internal; `LookupRef` stays |
| admin (`/admin/{index,gc,replica/reconnect}`, `RamoseDb.{index,gc,reconnectReplica}`) | Worker routes; `docs/RUNBOOK.md` |
| the separate client package (`RamoseClient`, `RamoseDb`, `RamoseError`, `ClientOptions`, `TxAck`, `QueryResponse`, `attribute`) | package deleted; zero real consumers |
| `RuntimeContext` requirement, `RuntimeContext.phantom`, hand-rolled `run` | deleted from every signature |
| Vite `/schema` alias + tsconfig path | deleted; `"./db"` is a real `exports` entry |

## 6. Invariants preserved

- **One writer.** `transact` is the only write and still `POST /db/:name/transact`; nothing in the surface names or reaches a Transactor.
- **Dense `t`.** `t` is only ever read (`report.t`, `db.asOf(t)`); no API mints, skips or supplies one.
- **Persist-before-ack.** `transact` resolves only with a `TxReport`, and `dbAfter` carries that `t`.
- **QueryReplica first-class.** Reads take their basis from the server's replica path; no replica selection, no novelty access.
- **A database is a name.** `ramose.db(name, catalog)` is the whole creation step — no create / list / delete, one resource for N tenants.
- **HTTP is Worker internals.** No endpoint, source, URL or admin type is exported; the two transports are Layers, not clients.
- **Browser sockets terminate in the Worker isolate.** The client speaks only `GET /db/:name/session`; no DO route is reachable or nameable.
- **Write-WS is not the default, and `processTx` / `SortedNovelty.flush` are untouched.** Writes go over HTTPS `/transact`; `install()` is an ordinary transaction.

## 7. Resolved: subpaths, not packages

The open question was whether to ship the portable half as the `ramose/db`
subpath or as its own package. 0.2.0 answers it for the whole product, not just
that half: everything is one `ramose` package with subpath exports, and the
engine (`core`, `storage`, `transactor`, `replica`) is folders under
`src/internal/` rather than four more published names. One package, one version,
one install line — and re-splitting costs nothing later, because a subpath is
the same import a package would have been.
