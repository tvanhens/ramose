# Ripple — what actually ships

Ground truth for docs writers. Every code block below is **copied verbatim from the repo**
with `file:line` provenance. If an API is not in here, it does not exist — do not invent it.

Repo state: branch `feat/docs-site`, HEAD `a15b538`. Verified 2026-08-17 against
`packages/*/src`, `examples/todos`, `examples/kv-style`, `docs/`, root `README.md`.

Legend: ✅ = shipped and verified in source · ⚠️ = shipped but with a sharp edge ·
❌ = claimed somewhere in the repo/site but **not** true of the code.

---

## 1. Packages, and how a user gets them today

### 1.1 Nothing is published to npm

All six workspace packages are `"private": true`. There is no `npm install @ripple/...`,
no registry entry, no `dist/`, and no build step.

| package | dir | `private` | `main` / `types` |
|---|---|---|---|
| `@ripple/core` | `packages/core` | `true` (`packages/core/package.json:4`) | `src/index.ts` |
| `@ripple/storage` | `packages/storage` | `true` (`:4`) | `src/index.ts` |
| `@ripple/transactor` | `packages/transactor` | `true` (`:4`) | `src/index.ts` |
| `@ripple/replica` | `packages/replica` | `true` (`:4`) | `src/index.ts` |
| `@ripple/worker` | `packages/worker` | `true` (`:4`) | `src/index.ts` |
| `@ripple/alchemy` | `packages/alchemy` | `true` (`:4`) | `src/index.ts` |

The root package is also private:

```json
{
  "name": "ripple",
  "version": "0.1.0",
  "private": true,
  "description": "Ripple — an immutable, Datomic-inspired database for Cloudflare (Workers + Durable Objects + R2).",
  "type": "module",
  "workspaces": [
    "packages/*",
    "website"
  ],
```
— `package.json:1-10`

⚠️ **`main`/`types` point at raw `.ts`.** Consumers must be able to import TypeScript source
(Bun, Vite, a bundler). There is no compiled output. Do not write "install the package" docs.

⚠️ `examples/*` are **not** workspaces (`workspaces` is `["packages/*", "website"]`). They
resolve `@ripple/alchemy` through the root `node_modules` links that `bun install` creates
at the repo root, which is why every command in the repo is run *from the repo root*.

### 1.2 The two import specifiers a consumer actually types

```json
  "exports": {
    ".": "./src/index.ts",
    "./db": "./src/db/index.ts"
  },
```
— `packages/alchemy/package.json:9-12`

- **`@ripple/alchemy/db`** — the portable half. Browser, Worker, Node/Bun, tests. Nothing
  reachable from it imports `alchemy` (the deploy engine) or the `@ripple/core` barrel;
  `packages/alchemy/test/db-portable.test.ts` fails the build if that stops being true.
- **`@ripple/alchemy`** — all of `/db`, plus the deploy-time half (resources, capabilities,
  transports, `Policy`, `authEnv`).

`@ripple/core`, `@ripple/worker`, `@ripple/transactor`, `@ripple/replica`, `@ripple/storage`
are internals. The only place a user names `@ripple/worker` in practice is the Worker's `main`,
and both examples spell it as a **repo-relative path**, not a package specifier:

```typescript
export const RippleWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});
```
— `examples/todos/resources.ts:8-12` (identical at `examples/kv-style/resources.ts:44-48`)

⚠️ `docs/API.md:106`, `packages/alchemy/src/index.ts:20` and `packages/alchemy/src/Database.ts:22`
show `main: "@ripple/worker"`. That form is not exercised anywhere in the repo — the two runnable
examples both use the relative path. Prefer the relative path in docs.

### 1.3 The whole getting-started path

```sh
bun install
bun alchemy dev examples/todos/alchemy.run.ts
VITE_RIPPLE_URL=http://localhost:8787 bunx vite examples/todos
```
— `README.md:29-33` — ❌ **the port is wrong here**, see §9.4.

The correct, self-consistent version is the example's own README:

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/todos/alchemy.run.ts          # peer on :1337
VITE_RIPPLE_URL=http://localhost:1337 bunx vite examples/todos   # UI on :5173
```
— `examples/todos/README.md:6-12`

### 1.4 The exact public surface (pinned by a test)

`@ripple/alchemy/db` exports exactly these (`packages/alchemy/src/db/index.ts:31-64`):

`Attr`, `Attribute` (type), `Catalog`, `Namespace`, `Bytes`, `Instant`, `Long`, `Ref`, `Uuid`,
`UuidString`, `query`, `NavQuery`/`NavQueryBuilder`/`Predicate`/`Shape` (types),
`ClientOptions` (type), `Databases`, `layer`, `Db`/`ReadDb`/`TxReport` (types), `Eid` (type),
`LookupRef` (type), `Pull` (type), `Entity`/`Tx` (types), and the eight errors
`DatabaseNotFound`, `DbError` (type), `InternalError`, `InvalidRequest`, `NetworkError`,
`QueryBudgetExceeded`, `TxRejected`, `Unauthorized`, `Unavailable`.

`@ripple/alchemy` = all of the above **plus exactly** (`packages/alchemy/test/surface.test.ts:13-33`):

```javascript
const ADDS = [
  // resources
  "Server",
  "Database",
  // capabilities
  "ReadWriteDatabases",
  "ReadDatabases",
  // transports
  "ServerBinding",
  "ServerHttp",
  // the stack
  "providers",
  "Providers",
  // deploy-time policy
  "Policy",
  // the server Worker's auth env
  "authEnv",
  "internalSecret",
  "AUTH_ENV_KEYS",
  "DEFAULT_JWT_MAX_TTL",
];
```

⚠️ `Catalog.merge` exists in `packages/alchemy/src/db/Catalog.ts:29-35` but is **not re-exported**
from either entry point. Do not document it.

---

## 2. Catalog definition

### 2.1 The three constructors

```typescript
/** Compose namespaces into a catalog. Address attrs via `User.name`. */
export const Catalog = <const Ns extends NamespaceMap>(
  namespaces: Ns,
): Catalog<Ns> => ({
  _tag: "Catalog",
  namespaces,
});
```
— `packages/alchemy/src/db/Catalog.ts:15-21`

```typescript
/** Group attributes under one ident prefix. */
export const Namespace = <
  const Name extends string,
  Attrs extends AttributeMap,
>(
  name: Name,
  attributes: Attrs,
): Namespace<Name, Attrs> => {
```
— `packages/alchemy/src/db/Namespace.ts:220-227`

```typescript
/** Declare an attribute. File it under a namespace key to stamp `:ns/name`. */
export const Attr: {
  <S extends Schema.Top>(
    schema: S,
  ): Attribute<S, "one", undefined, InferDbValueType<S>>;
  <S extends Schema.Top, const O extends AttributeOptions>(
    schema: S,
    options: O,
  ): Attribute<S, CardOf<O>, UniqueOf<O>, ValueTypeOf<S, O>>;
} = ((schema: Schema.Top, options?: AttributeOptions) => ({
  _tag: "Attribute" as const,
  schema,
  cardinality: options?.cardinality ?? "one",
  unique: options?.unique,
  index: options?.index ?? options?.unique !== undefined,
  isComponent: options?.isComponent ?? false,
  doc: options?.doc,
  valueType: tryInferDbValueType(schema, options?.valueType),
})) as typeof Attr;
```
— `packages/alchemy/src/db/Attribute.ts:64-82`

Note the defaults, verbatim from that body: `cardinality` defaults to `"one"`,
`index` defaults to *"true iff `unique` was set"*, `isComponent` defaults to `false`.

### 2.2 Attribute options — exact type

```typescript
export type Cardinality = "one" | "many";
export type Uniqueness = "identity" | "value";

export interface AttributeOptions {
  readonly cardinality?: Cardinality;
  readonly unique?: Uniqueness;
  readonly index?: boolean;
  readonly isComponent?: boolean;
  readonly doc?: string;
  /** Override `:db.type/*` inference. Required for custom Schemas. */
  readonly valueType?: DbValueType;
}
```
— `packages/alchemy/src/db/Attribute.ts:10-21`

### 2.3 Value types

```typescript
export type DbValueType =
  | ":db.type/string"
  | ":db.type/long"
  | ":db.type/double"
  | ":db.type/boolean"
  | ":db.type/ref"
  | ":db.type/uuid"
  | ":db.type/instant"
  | ":db.type/bytes";
```
— `packages/alchemy/src/db/valueTypes.ts:6-14`

Inference (`tryInferDbValueType`, `valueTypes.ts:170-187`): explicit `options.valueType` wins,
then the branded helpers, then the Schema AST tag — `String → :db.type/string`,
`Number → :db.type/double`, `Boolean → :db.type/boolean`. **Anything else is `undefined`**
unless you pass `valueType` or use a helper.

Helpers exported: `Bytes`, `Instant` (`Schema.Date` → `:db.type/instant`), `Long` (integer, vs.
plain `Schema.Number` which is `double`), `Ref`, `Uuid`, `UuidString`.

Targeted refs, needed for navigational paths like `Todo.owner.name`:

```typescript
type RefFn = {
  /** Untargeted ref (legacy). Prefer `Ref(() => User)` / `Ref.self`. */
  (schema?: undefined): typeof RefUntargeted;
  /** Targeted ref: `Attr(Ref(() => User))`. */
  <const N extends { readonly attributes: object }>(
    target: () => N,
  ): TargetedRef<N["attributes"]>;
  /** Self-ref; `Namespace` substitutes the enclosing attr map. */
  readonly self: TargetedRef<SelfMarker>;
} & typeof RefUntargeted &
  RippleVt<":db.type/ref">;
```
— `packages/alchemy/src/db/valueTypes.ts:85-95`

### 2.4 `:db/id` is a real pseudo-attribute

Every namespace carries `.id`, usable in `where` / `select` / `orderBy`:

```typescript
  /**
   * Pseudo-attribute `:db/id`, usable in `where` / `select` / `orderBy`.
   * Typed as a stamped attr so it is a valid {@link ShapeField}.
   */
  readonly id: AttrNav<
```
— `packages/alchemy/src/db/Namespace.ts:106-110`. Its `SelectResult` type is `number`
(`NavQuery.ts:306-307`), **not** `Eid<C>`.

### 2.5 The real todos catalog (whole file, verbatim)

```typescript
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
});

export const Todos = Ripple.Catalog({ todo: Todo });
```
— `examples/todos/schema.ts:1-10`

And the kv-style one, showing `unique`:

```typescript
export const User = Ripple.Namespace("user", {
  name: Ripple.Attr(Schema.String, { unique: "identity" }),
});
export const Movies = Ripple.Catalog({ user: User });
```
— `examples/kv-style/schema.ts:10-13`

---

## 3. Getting a db handle

### 3.1 `ripple.db(name, catalog)` — pure

```typescript
/** One method, because a database is a name. */
export interface DatabasesShape {
  db<C extends AnyCatalog>(name: string, catalog: C): Db<C>;
}
```
— `packages/alchemy/src/db/Databases.ts:38-41`

It is **pure**: no request, no schema ensure, no socket
(`Databases.ts:222-226`, `Db.ts:436`). Naming a database per tenant per request is free.

Names are validated client-side; a bad name never reaches the peer:

```typescript
/** A Ripple database name, as the peer Worker validates it (`validDbName`). */
export const DATABASE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
```
— `packages/alchemy/src/DatabaseName.ts:14-15`. A non-matching name makes **every** operation
on that db fail `InvalidRequest` (`Db.ts:443-446`).

### 3.2 Client construction — `Ripple.layer` + `Ripple.Databases`

```typescript
export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  /**
   * The bearer credential, in the one form the client takes. It is re-read on
   * every (re)connect and every `/transact`, so a refresh needs no API of its
   * own. Static: `Effect.succeed(Redacted.make(t))`.
   */
  readonly token?: Effect.Effect<Redacted.Redacted<string>> | undefined;
  /** Injection seam — defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injection seam — defaults to the ambient `WebSocket`. */
  readonly webSocket?: typeof WebSocket | undefined;
}
```
— `packages/alchemy/src/db/Databases.ts:55-68`

```typescript
export const layer = (options: ClientOptions): Layer.Layer<Databases> =>
```
— `packages/alchemy/src/db/Databases.ts:271`. Scoped: its finalizer closes every socket it
opened. Getting a `Databases` **cannot fail** (`Layer<Databases, never, never>`); a malformed
URL or a missing `fetch` is `Effect.die`, i.e. a defect, not a `DbError`
(`Databases.ts:234-264`).

### 3.3 The browser client, verbatim (`examples/todos/src/db.ts`, whole file)

```typescript
/**
 * One runtime for the page, disposed with it.
 *
 * `Ripple.layer` is scoped — the session socket is its finalizer — and getting
 * a `Databases` out of it cannot fail, so `runSync` is honest here.
 * `ripple.db("todos", Todos)` is pure: naming a database costs no request, and
 * a browser never installs schema (`alchemy.run.ts` does that at deploy).
 */

import * as Ripple from "@ripple/alchemy/db";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { Todos } from "../schema.ts";

const token = import.meta.env.VITE_RIPPLE_TOKEN;

const runtime = ManagedRuntime.make(
  Ripple.layer({
    url: import.meta.env.VITE_RIPPLE_URL ?? "http://localhost:8787",
    token:
      token === undefined || token === ""
        ? undefined
        : Effect.succeed(Redacted.make(token)),
  }),
);

export const run = runtime.runPromise;
export const db = runtime.runSync(Ripple.Databases).db("todos", Todos);
```
— `examples/todos/src/db.ts:1-29`

⚠️ The `http://localhost:8787` fallback on line 20 is stale (see §9.4). In practice the example
is always run with `VITE_RIPPLE_URL=http://localhost:1337`.

### 3.4 From a Worker: the binding *is* the client

```typescript
    const ripple = yield* Ripple.ReadWriteDatabases(Server);
```
— `examples/kv-style/app.ts:33`, inside `Cloudflare.Worker(..., Effect.gen(...))`, with
`.pipe(Effect.provide(Ripple.ServerBinding))` at `app.ts:146`.

`Ripple.ReadDatabases` is the least-privilege half: its `db()` returns `ReadDb<C>` —
no `transact`, no `install` (`packages/alchemy/src/ReadDatabases.ts:1-8`).
Transports: `Ripple.ServerBinding` (Worker service binding, synthetic origin
`https://ripple.internal`, `ServerBinding.ts:35`) or `Ripple.ServerHttp` (public URL over the
ambient `fetch`; also what `Alchemy.Action` and `alchemy dev` use, `ServerHttp.ts:1-19`).

⚠️ **`ServerBinding` supplies no `webSocket`**, so `db.live` is unavailable under it
(`Databases.ts:82-85`, `Db.ts:369-378`). Live queries are a browser/`Ripple.layer` feature.

---

## 4. Transact

### 4.1 Signatures

```typescript
export interface Db<C extends AnyCatalog = AnyCatalog> extends ReadDb<C> {
  /**
   * The one write. The generator's yielded Effects compose as they do in
   * `Effect.gen`, so a failure in the body aborts before anything is sent.
   */
  transact<Eff extends Effect.Effect<any, any, any>, A = unknown>(
    body: (tx: Tx<C>) => Generator<Eff, A, never>,
  ): Effect.Effect<
    TxReport<C>,
    DbError | YieldError<Eff>,
    YieldContext<Eff>
  >;

  /** Idempotent catalog upsert, as an ordinary transaction. */
  install(): Effect.Effect<TxReport<C>, DbError>;
}
```
— `packages/alchemy/src/db/Db.ts:124-139`

```typescript
export interface Tx<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly spec: TxSpec;

  /**
   * Allocate a tempid, or wrap an existing eid / tempid / lookup ref.
   * `tx.entity()` → new handle; `tx.entity(1001)`; `tx.entity("ada")`;
   * `tx.entity([User.name, "Ada"])`.
   */
  entity(): Effect.Effect<Entity<C>>;
  entity(id: TxEntity<C>): Effect.Effect<Entity<C>>;

  /** Assert one datom. Cardinality-many is one call per value. */
  add<const A extends TxAttr<C>>(
    e: TxEntity<C>,
    attr: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  retract<const A extends TxAttr<C>>(
    e: TxEntity<C>,
    attr: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  retractEntity(e: TxEntity<C>): Effect.Effect<void>;
}
```
— `packages/alchemy/src/db/Tx.ts:97-123`

The entity handle (`tx.entity()`'s result) has the same three verbs, minus the entity argument:

```typescript
export interface Entity<C extends AnyCatalog = AnyCatalog> {
  readonly _tag: "Entity";
  /** What this handle names: a fresh tempid, an eid, or a lookup ref. */
  readonly eid: EntityRef<C>;

  add<const A extends TxAttr<C>>(
    attr: A,
    value: TxValue<C, A>,
  ): Effect.Effect<void>;

  retract<const A extends TxAttr<C>>(
    attr: A,
    value?: TxValue<C, A>,
  ): Effect.Effect<void>;

  retractEntity(): Effect.Effect<void>;
}
```
— `packages/alchemy/src/db/Tx.ts:72-88`

**That is the complete verb list.** There is no `tx.assert`, no `tx.upsert`, no `tx.merge`,
no map-form entity literal on the typed builder. The wire ops it emits:

```typescript
export type TxOp =
  | readonly [":db/add", unknown, string, unknown]
  | readonly [":db/retract", unknown, string]
  | readonly [":db/retract", unknown, string, unknown]
  | readonly [":db/retractEntity", unknown];
```
— `packages/alchemy/src/db/Tx.ts:56-60`

### 4.2 `TxReport`

```typescript
/** What a committed transaction reports back. `dbAfter` reads your own writes. */
export interface TxReport<C extends AnyCatalog = AnyCatalog> {
  readonly t: number;
  readonly txEid: Eid<C>;
  readonly datomCount: number;
  /** The same db, floored at `t` — no second round trip and no `sync`. */
  readonly dbAfter: Db<C>;
}
```
— `packages/alchemy/src/db/Db.ts:83-90`

⚠️ **Tempids are not returned to the caller.** `tx.entity()` mints an internal string
(`` `tmp-${++next}` ``, `Tx.ts:211-218`), and the peer's `/transact` response *does* include a
`tempids` map (`packages/worker/src/index.ts:13`), but the client drops it — `submit` reads
only `t`, `txEid` and `datoms` (`Db.ts:454-467`). To learn the eid of a newly created entity
today you must query for it (e.g. via a unique attribute) after the write. Do not document a
`report.tempids`.

### 4.3 Real writes (verbatim)

```typescript
export const addTodo = (db: TodosDb, title: string) =>
  db.transact(function* (tx) {
    const t = yield* tx.entity();
    yield* t.add(Todo.title, title);
    yield* t.add(Todo.done, false);
    yield* t.add(Todo.createdAt, new Date());
  });

export const setDone = (db: TodosDb, eid: TodoEid, done: boolean) =>
  db.transact(function* (tx) {
    yield* tx.add(eid.id, Todo.done, done);
  });

export const deleteTodo = (db: TodosDb, eid: TodoEid) =>
  db.transact(function* (tx) {
    yield* tx.retractEntity(eid.id);
  });
```
— `examples/todos/src/todos.ts:38-53`

Read-your-own-write via `dbAfter`:

```typescript
        const { t, dbAfter } = yield* tenant.transact(function* (tx) {
          const ada = yield* tx.entity();
          yield* ada.add(User.name, "Ada");
        });
        // `dbAfter` carries the min-`t` floor, so this reads its own write
        const names = yield* dbAfter.q(
          Ripple.query(User).select({ name: User.name }),
        );
```
— `examples/kv-style/app.ts:61-68`

Writes always go over HTTPS `POST /db/:name/transact`, never the socket
(`Db.ts:72-76`, `Databases.ts:206-219`). A successful write bumps the session basis so every
standing `live` re-runs (`Db.ts:458`).

---

## 5. Query

### 5.1 Two accepted inputs

```typescript
/** Callback builder (legacy) or navigational query value / builder. */
export type QueryInput<C extends AnyCatalog, R> =
  | ((q: QueryBuilder<C, {}>) => Query<C, R>)
  | NavQuery<R>
  | NavQueryBuilder<AnyNamespace, R>;
```
— `packages/alchemy/src/db/Db.ts:52-56`

```typescript
export interface ReadDb<C extends AnyCatalog = AnyCatalog> {
  readonly name: string;
  readonly catalog: C;

  /** Run a query once — callback builder or navigational {@link NavQuery}. */
  q<R>(input: QueryInput<C, R>): Effect.Effect<R, DbError>;
```
— `packages/alchemy/src/db/Db.ts:97-102`

### 5.2 `Ripple.query` — the navigational builder

```typescript
export interface NavQueryBuilder<N extends AnyNamespace, R = unknown> {
  readonly ns: N;
  readonly spec: NavQuerySpec;

  where(...preds: Predicate[]): NavQueryBuilder<N, R>;
  select<const S extends Shape>(
    shape: S,
  ): NavQueryBuilder<N, readonly SelectResult<S>[]>;
  orderBy(
    attr: PathCarrier,
    dir?: OrderDir,
    opts?: { readonly empty?: OrderEmpty },
  ): NavQueryBuilder<N, R>;
  limit(n: number): NavQueryBuilder<N, R>;
  offset(n: number): NavQueryBuilder<N, R>;

  /** Freeze into a runnable query value. */
  build(): NavQuery<R>;
}
```
— `packages/alchemy/src/db/NavQuery.ts:315-333`

That is the **entire** builder: `where`, `select`, `orderBy`, `limit`, `offset`, `build`.
No `groupBy`, no `one()`, no `count()`, no `after()`, no `params`. `.build()` is optional —
`db.q` / `db.live` accept the builder directly (`NavQuery.ts:376-378`).

The predicate vocabulary, exactly (`NavQuery.ts:28-38`, methods attached at `:144-157`):

```typescript
export type PredTag =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "startsWith"
  | "includes"
  | "exists"
  | "missing";
```

Nested shapes come from `attr.select({...})` on a `:db.type/ref` attribute, and optionality from
`attr.optional` (`NavQuery.ts:126-132`).

Scope: `Ripple.query(N)` means "entity carries at least one `:n/*` datom" — lowered as an
`or` over the namespace's idents (`NavQuery.ts:424-430`).

### 5.3 Real query (verbatim)

```typescript
export const todoShape = {
  id: Todo.id,
  title: Todo.title,
  done: Todo.done,
  createdAt: Todo.createdAt,
} as const;

/** One row from {@link todoQuery}. */
export type TodoRow = {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
  readonly createdAt: Date;
};

/** Standing list query — a value, not a callback builder. */
export const todoQuery = Ripple.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select(todoShape);
```
— `examples/todos/src/todos.ts:10-28`

### 5.4 `db.pull`

```typescript
  /** Project one entity. `null` when a required field is missing. */
  pull<const P>(
    subject: Eid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Effect.Effect<Pull<C, P> | null, DbError>;
```
— `packages/alchemy/src/db/Db.ts:112-116`

```typescript
/** One row, straight from its eid — the same shape, no query. */
export const pullTodo = (db: TodosDb, eid: TodoEid) =>
  db.pull(eid, {
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });
```
— `examples/todos/src/todos.ts:30-36`

Pull-pattern grammar (`packages/alchemy/src/db/Pull.ts`):
- bare attr = **required** — a missing datom drops the whole entity (top level → `null`)
- `attr.optional` = `T | undefined`, keeps the parent
- `attr.select({ ... })` = nested object (same grammar as query `select`)
- an ident-string array escape hatch (`[":user/name", ...]`) exists (`Pull.ts:143-152`)

Subjects: an `Eid<C>` (`{ id: number }`) or a `LookupRef<C>` — `[User.name, "Ada"]` or
`[":user/name", "Ada"]`, only on a `unique` attribute (`idents.ts:57-71`, lowering at
`Db.ts:185-197`).

### 5.5 Client-side vs server-side — the honest split

| stage | where it runs | source |
|---|---|---|
| `where` predicates, namespace scope | **server** (datalog) | `NavQuery.ts:410-502` |
| `select` shape | **server** — lowered to `[["pull", "?e", pattern]]` inside `:find`, so no client N+1 | `NavQuery.ts:436-443` |
| `orderBy` | **client** | `NavQuery.ts:528-530`, `sortRows` `:539-563` |
| `limit` / `offset` | **client**, after the full result set arrives | `NavQuery.ts:532-534` |
| required-field filtering | **client** (`reshapePullResult`) | `NavQuery.ts:516-523` |
| legacy `.pull(...)` on the callback builder | **client N+1**, concurrency 16 | `Db.ts:273-285`, `PULL_CONCURRENCY = 16` at `:151` |

```typescript
 * `.orderBy` / `.limit` are applied client-side on the projected rows until
 * the core AST gains top-level order/limit (QUERY.md §11 P0 #5).
```
— `packages/alchemy/src/db/NavQuery.ts:9-10`

⚠️⚠️ **`orderBy` only works on an attribute you also `select`ed, at path depth 1.**
`keyForOrder` matches the order path against the *select keys* and returns `undefined` otherwise,
and an undefined key makes every row compare "missing", i.e. **the sort silently no-ops**:

```typescript
/** Match an order path to a select key when possible. */
const keyForOrder = (
  order: OrderBy,
  pullMap: Record<string, unknown>,
): string | undefined => {
  for (const [key, field] of Object.entries(pullMap)) {
    const info = inspectPullField(field);
    const ident = lowerAttr(info.attr);
    if (order.path.length === 1 && ident === order.path[0]) return key;
  }
  return undefined;
};
```
— `packages/alchemy/src/db/NavQuery.ts:565-576`

Also: sorting is skipped entirely when there is no `select` (`NavQuery.ts:528`), and
`limit` does **not** reduce server work or the query budget.

### 5.6 Legacy callback builder — status: still shipped

```typescript
export interface QueryBuilder<
  C extends AnyCatalog = AnyCatalog,
  B extends object = {},
> {
  readonly catalog: C;
  readonly spec: QuerySpec;
```
— `packages/alchemy/src/db/Query.ts:220-226`, with `where(e, a, v)` (`:232-240`),
`find(...vars)` (`:247-249`), `explain(...vars)` (`:252-254`), and `.pull(pattern)` on the
result of `find` (`:187-191`).

It is reachable and tested — `db.q((q) => q.where("?e", User.name, "?n").find("?n"))`
(`packages/alchemy/src/Server.ts:41`). `docs/QUERY.md:8-9` says "still works. Prefer the
navigational form for new code." Document it as legacy, not as removed.

`explain` is admin-only on the peer (`docs/AUTH_LAYER.md:86`).

---

## 6. Live

```typescript
  /**
   * Stand a query up: re-run on every basis tick this session sees,
   * and after a local `transact`. Requirements are `never` — teardown is fiber
   * interruption — and a pinned view (`asOf` / `history`) emits once and
   * completes. Accepts a callback builder or navigational {@link NavQuery}.
   */
  live<R>(input: QueryInput<C, R>): Stream.Stream<R, DbError>;
```
— `packages/alchemy/src/db/Db.ts:104-110`

### 6.1 Semantics, from the implementation

- **Re-run, not incremental.** Each tick re-runs the whole query (`Db.ts:380-390`).
  There is no diffing and no identical-emission suppression (`docs/QUERY.md:193`, "Not yet").
- **Needs the session socket.** Without one it fails as a **defect**, not a `DbError`:

```typescript
          if (!pinned && session === undefined) {
            return yield* Queue.failCause(
              queue,
              Cause.die(
                new Error(
                  "ripple: db.live needs the session socket — pass `webSocket` to Ripple.layer (or run where a global WebSocket exists)",
                ),
              ),
            );
          }
```
— `packages/alchemy/src/db/Db.ts:369-378`

- **Reconnect is built in.** Transient failures retry with exponential backoff 250 ms → 5 s;
  only four tags are terminal:

```typescript
const PULL_CONCURRENCY = 16;
const RETRY_MIN = 250;
const RETRY_MAX = 5000;

/**
 * Failures a standing query must not retry: re-running them changes nothing.
 * `Unauthorized` reaches here only after the session already re-read the token
 * and re-authenticated in place, so a second one is terminal.
 */
const terminal = (e: DbError): boolean =>
  e._tag === "InvalidRequest" ||
  e._tag === "DatabaseNotFound" ||
  e._tag === "Unauthorized" ||
  e._tag === "QueryBudgetExceeded";
```
— `packages/alchemy/src/db/Db.ts:150-164`

  The socket itself reconnects lazily on the next request, re-reading the token, and a 401/403
  triggers an in-place `{ op: "auth", token }` re-auth without tearing down standing streams
  (`packages/alchemy/src/db/session.ts:9-21`).
- **A pinned view emits once and completes** (`Db.ts:383-384`).
- **A local `transact` bumps the basis**, so `live` re-runs with no refetch call at the write
  site (`Db.ts:458`).
- ⚠️ **The stream must be hoisted** — built once outside render — because it is the effect's
  dependency.

### 6.2 `useLive` — example code, **not** a shipped export

```typescript
/**
 * Example-app code, not a shipped name: `db.live` is a `Stream`, and this is
 * the twelve lines that turn one into React state.
 *
 * The stream must be hoisted (built once, outside render), because it is the
 * effect's dependency.
 */

import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { useEffect, useState } from "react";

export const useLive = <A, E>(stream: Stream.Stream<A, E>) => {
  const [s, set] = useState<{ rows?: A; error?: Cause.Cause<E> }>({});
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (rows) => Effect.sync(() => set({ rows }))).pipe(
        Effect.catchCause((error) =>
          Effect.sync(() => set((p) => ({ ...p, error }))),
        ),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }, [stream]);
  return s;
};
```
— `examples/todos/src/useLive.ts:1-28` (whole file)

Used as:

```typescript
// hoisted, so the hook's dependency is stable across renders
const todos = db.live(todoQuery);
```
— `examples/todos/src/App.tsx:6-7`

**There is no React package, no `@ripple/react`, no provider component, no `useQuery`.**

---

## 7. Time travel

```typescript
  /** Read-only view as of transaction `t`. Pure. */
  asOf(t: number): ReadDb<C>;
  /** History view — asserts *and* retracts. Pure. */
  readonly history: ReadDb<C>;
```
— `packages/alchemy/src/db/Db.ts:118-121`

Both are pure `Db -> ReadDb` — zero I/O (`Db.ts:402-407`). They lower to `asOf` / `history`
flags on the read body (`Db.ts:234-239`, `:307-312`). You cannot transact into the past: the
views are `ReadDb`, which has no `transact`.

`t` is only ever *read* — from `report.t` or `dbAfter`. No API mints, skips or supplies one.

⚠️ `db.asOf` takes a **transaction number**, not a `Date`. `db.asOf(date)` is on the roadmap
(`docs/QUERY.md:227`), not shipped.

### Retention — how far back `asOf` works

`asOf` only works as far back as the retained *roots*. GC sweeps everything unreachable from
them.

```typescript
export const DEFAULT_CONFIG: TransactorConfig = {
  indexTxThreshold: 500,
  indexIntervalMs: 5_000,
  indexMaxTxsPerRun: 5_000,
  logKeepTxs: 20_000,
  gcEveryNIndexes: 50,
  retainRoots: 20,
  maxBatch: 0,
  timingYields: false,
};
```
— `packages/transactor/src/host.ts:55-64`

- `RIPPLE_RETAIN_ROOTS` (default **20**) — how many published roots survive GC
  (`transactor-do.ts:32`).
- The retention function is literally "keep the newest N":

```typescript
/** Default retention: keep the newest `n` roots plus every root newer than `maxAgeT` transactions ago. */
export function retainNewest(n: number): (ts: number[]) => number[] {
  return (ts) => ts.slice(-n);
}
```
— `packages/storage/src/index.ts:414-417`
⚠️ Note the docstring mentions a `maxAgeT` the body does not implement — the shipped behaviour
is purely "newest N".

- `RIPPLE_GC_EVERY_N_INDEXES` (default **50**) — GC cadence; the sweep is mark-and-sweep against
  the retained roots (`indexer.ts:154`).
- A root is published per index run, so "20 roots" is roughly "the last 20 index runs", i.e.
  a function of `RIPPLE_INDEX_TX_THRESHOLD` (500) / `RIPPLE_INDEX_INTERVAL_MS` (5000), **not**
  a wall-clock window. Do not promise users "N days of history".
- Manual sweep: `POST /db/:name/admin/gc` (`docs/RUNBOOK.md:117-119`).

---

## 8. Auth & policy

### 8.1 Three modes, selected by env

```
 *   unset  legacy — open, or a shared `RIPPLE_TOKEN` if one is set; class `admin`
 *   set    JWT only; `RIPPLE_TOKEN` is not a data-plane principal on `/db/:name`
```
— `packages/worker/src/auth.ts:3-5`

| `RIPPLE_POLICY` | `RIPPLE_TOKEN` | result |
|---|---|---|
| unset | unset | **open** — every caller is `service`/`admin` |
| unset | set | shared-token mode — matching bearer = one service principal, class `admin`; anything else `Unauthorized` |
| set | either | **JWT only.** `RIPPLE_TOKEN` becomes class `$token` and reaches only `/health` and the no-op `ensure` case |

```typescript
export async function principalForToken(env: RippleEnv, token: string | undefined, dbName: string): Promise<Principal> {
  const st = authState(env);
  if (!st.configured) {
    if (!env.RIPPLE_TOKEN || token === env.RIPPLE_TOKEN) return serviceAdmin(dbName);
    throw new Unauthorized({});
  }
  if (st.broken !== undefined || st.policy === undefined || st.keys === undefined) throw new Unauthorized({});
  if (token === undefined) {
    if (st.policy.classes.includes(ANONYMOUS_CLASS)) return anonymousPrincipal(dbName);
    throw new Unauthorized({});
  }
  if (env.RIPPLE_TOKEN && token === env.RIPPLE_TOKEN) return tokenOnly(dbName);
  return verify(st, token, dbName);
}
```
— `packages/worker/src/auth.ts:161-174`

Tokenless callers get in **only** if the policy declares an `anonymous` class
(`auth.ts:36-37`, `:168-171`).

### 8.2 Env vars

```typescript
export const AUTH_ENV_KEYS = {
  policy: "RIPPLE_POLICY",
  jwksUrl: "RIPPLE_JWKS_URL",
  issuers: "RIPPLE_JWT_ISS",
  aud: "RIPPLE_JWT_AUD",
  maxTtl: "RIPPLE_JWT_MAX_TTL",
  allowedOrigins: "RIPPLE_ALLOWED_ORIGINS",
  internalSecret: "RIPPLE_INTERNAL_SECRET",
} as const satisfies Record<keyof PeerAuth, string>;

/** Cap on a token's lifetime when `RIPPLE_JWT_MAX_TTL` is unset, in seconds. */
export const DEFAULT_JWT_MAX_TTL = 900;
```
— `packages/alchemy/src/Server.ts:139-151`

Plus, only on the Worker side (not in `AUTH_ENV_KEYS`, not settable via `authEnv`):

```typescript
  /** test/offline seam: a literal JWK Set, used when RIPPLE_JWKS_URL is unset */
  RIPPLE_JWKS_JSON?: string;
```
— `packages/transactor/src/env.ts:18-19`

Verifier: algorithms are pinned, never taken from the token header —
`const ALGS = ["RS256", "ES256", "EdDSA"];` (`auth.ts:31`). Verified principals are memoized
per isolate for `PRINCIPAL_MEMO_MS = 60_000` (`auth.ts:35`).

Fail-closed at deploy: `Ripple.Server`'s `checkAuth` refuses a stack where `auth.policy` is set
but `jwksUrl` / `issuers` / `aud` are not (`Server.ts:223-237`). Fail-closed at runtime:
a malformed policy or incomplete verifier sets `broken` and denies every `/db/*`
(`auth.ts:77-97`), and the writer substitutes a `DENY_ALL` policy
(`packages/transactor/src/policy.ts:42-53`).

CORS: with no policy, today's `*`. With a policy, `RIPPLE_ALLOWED_ORIGINS` narrows it; an empty
list means **no** `access-control-allow-origin` header at all (`auth.ts:321-332`).

A configured policy also disables the demo console at `/` (`packages/worker/src/index.ts:348`).

### 8.3 The claims shape

```typescript
export const Claims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.String,
  exp: Schema.Number,
  iat: Schema.optional(Schema.Number),
  ripple: Schema.Struct({
    db: Schema.String,
    class: Schema.String,
    attrs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
```
— `packages/alchemy/src/db/Policy.ts:105-116`

`ripple.db` must equal the `/db/:name` in the route (`auth.ts:221`, `allows`). `ripple.class`
must be one the policy declared, else `Unauthorized` with
`"token class is not declared by this peer's policy"` (`auth.ts:204`).

### 8.4 The policy DSL — exact API

`Ripple.Policy` (deploy-time only; not on `@ripple/alchemy/db`).

| export | signature | source |
|---|---|---|
| `policy` | `(catalog, spec: PolicySpec) => Policy<C>` | `Policy.ts:301-307` |
| `compile` | `(p: Policy, options?: { pulls?: readonly unknown[] }) => string` | `Policy.ts:474` |
| `checkPulls` | `(p: Policy, pulls: readonly unknown[]) => void` | `Policy.ts:450` |
| `allow` / `deny` | `(expr: Expr) => Arm` | `Policy.ts:222-223` |
| `eq` | `(attr, value: Operand \| ValueOf<A>) => Expr` | `Policy.ts:176-177` |
| `ref` | `(attr: RefAttrRef, target: Expr \| AttrRef) => Expr` | `Policy.ts:200-211` |
| `class` | `(c: string) => Expr` (exported as `classExpr` → `class`) | `Policy.ts:213-215` |
| `and` / `or` / `not` / `constant` | boolean composition | `Policy.ts:217-220` |
| `preset` | `(attr, operand) => Preset` | `Policy.ts:226-229` |
| `attr` | `(a, rules: RuleSpec) => AttrRule` | `Policy.ts:232-236` |
| `principal` | `Operand` — the principal's resolved eid | `Policy.ts:156` |
| `lit` | `(value) => Operand` | `Policy.ts:159` |
| `claims` / `claimsOf(struct)` | `.sub` `.iss` `.aud` `.exp` `.attrs.<key>` | `Policy.ts:147-153` |
| `Claims` | the JWT `Schema.Struct` | `Policy.ts:105` |

The five ops and the combination rule come from core:

```typescript
export type PolicyOp = "read" | "add" | "retract" | "retractEntity" | "create";
export const POLICY_OPS: readonly PolicyOp[] = ["read", "add", "retract", "retractEntity", "create"];
```
— `packages/core/src/policy/ast.ts:7-8`

```typescript
/** Arms per op. Allow arms OR; any true deny wins; no arms → deny. */
export type PolicyRules = { readonly [K in PolicyOp]?: readonly PolicyArm[] };
```
— `packages/core/src/policy/ast.ts:34-36`

```typescript
export const MAX_REF_DEPTH = 3;
```
— `packages/core/src/policy/ast.ts:5`

**Namespace vs attribute rules.** A namespace rule is shorthand for "every attribute the catalog
declares under that prefix"; an attribute rule **narrows (ANDs with)** its namespace rule
(`Policy.ts:231`, and the lowering comment at `:395-402`). A namespace with no rule denies.
`asOf` / `history` are `read` under the same filter — there is no `history` op.

`policy()` validates at deploy: unknown idents, undeclared classes, unknown namespace keys,
attribute/preset idents outside the namespace prefix, empty or duplicated `classes`, and
over-deep `ref` nesting all `throw PolicyError` (`Policy.ts:300-384`).

### 8.5 The verbatim policy example

From `docs/AUTH_LAYER.md:30-60` (the design doc; this is the canonical authoring example):

```typescript
import * as Ripple from "@ripple/alchemy";   // `Policy` is deploy-time, so it is not on `@ripple/alchemy/db`

const User    = Ripple.Namespace("user", { sub: Ripple.Attr(Schema.String, { unique: "identity" }) });
const Org     = Ripple.Namespace("org",  { members: Ripple.Attr(Ripple.Ref, { cardinality: "many" }) });
const Project = Ripple.Namespace("project", { org: Ripple.Attr(Ripple.Ref) });
const Doc     = Ripple.Namespace("doc", { title: Ripple.Attr(Schema.String), owner: Ripple.Attr(Ripple.Ref),
                                            project: Ripple.Attr(Ripple.Ref), audit: Ripple.Attr(Schema.String) });
export const App = Ripple.Catalog({ user: User, org: Org, project: Project, doc: Doc });

const P = Ripple.Policy;
const inOrg = P.ref(Doc.project, P.ref(Project.org, Org.members));   // doc → project → org → members ∋ principal
export const policy = P.policy(App, {
  principal: User.sub,                              // JWT `sub` → eid
  classes: ["anonymous", "member", "admin"],
  claims:  Schema.Struct({ org: Schema.String }),   // shape of `ripple.attrs`
  ns: {
    doc: {
      read:          P.allow(P.or(P.eq(Doc.owner, P.principal), inOrg)),
      create:        P.allow(inOrg),                // parent ref asserted in the same tx
      add: P.allow(P.eq(Doc.owner, P.principal)), retract: P.allow(P.eq(Doc.owner, P.principal)),
      retractEntity: P.allow(P.eq(Doc.owner, P.principal)),
      preset:        [P.preset(Doc.owner, P.principal)],
      attrs:         [P.attr(Doc.audit, { read: P.allow(P.class("admin")) })],
    },
    project: { read: P.allow(P.ref(Project.org, Org.members)) },
    org:     { read: P.allow(P.eq(Org.members, P.principal)) },
    user:    { read: P.allow(P.eq(User.sub, P.claims.sub)) },
  },
});
```

Wiring it into a deploy (`packages/alchemy/src/Server.ts:186-192`):

```typescript
 * export const RippleWorker = Cloudflare.Worker("RippleWorker", {
 *   main: "./packages/worker/src/index.ts",
 *   env: { STORE: Store, ...Ripple.authEnv({ policy, jwksUrl, issuers, aud }) },
 * });
```

The root stack does it from the environment (`alchemy.run.ts:53-64`, `:83`):

```typescript
const auth: Ripple.PeerAuth = {
  policy: process.env.RIPPLE_POLICY,
  jwksUrl: process.env.RIPPLE_JWKS_URL,
  issuers: process.env.RIPPLE_JWT_ISS,
  aud: process.env.RIPPLE_JWT_AUD,
  maxTtl: process.env.RIPPLE_JWT_MAX_TTL === undefined ? undefined : Number(process.env.RIPPLE_JWT_MAX_TTL),
  allowedOrigins: process.env.RIPPLE_ALLOWED_ORIGINS,
```

### 8.6 Enforcement points

1. **Reads — a filtered `Db`.** `viewDb` builds the data view at the requested `t` and filters
   it with rules read from the *current* basis, so history cannot re-grant:

```typescript
export async function viewDb(
  env: RippleEnv,
  principal: Principal,
  store: NodeSource,
  basis: Basis,
  opts: { asOf?: number; history?: boolean } = {},
): Promise<Db> {
  const st = authState(env);
  if (st.configured && st.policy === undefined) throw new Unauthorized({});
  const data = await dbFromBasis(store, basis, opts);
  if (st.policy === undefined || isAdmin(principal)) return data;
  const current = opts.asOf === undefined && !opts.history ? data : await dbFromBasis(store, basis);
  return filterDb(data, current, st.policy, await withEid(st.policy, principal, current));
}
```
— `packages/worker/src/auth.ts:256-269`

2. **Writes, stage (a) — ingress pre-check**, best-effort, against the replica basis:

```typescript
export async function checkWrite(env: RippleEnv, principal: Principal, store: NodeSource, basis: Basis, tx: unknown[]): Promise<WriteCheck> {
```
— `packages/worker/src/auth.ts:295`, denial at `:313`:
```typescript
  if (!res.ok) throw new Unauthorized({ status: 403, message: `${res.op} denied on ${res.attr}`, code: res.code, attr: res.attr });
```

3. **Writes, stage (b) — the authority**, inside the Transactor's commit loop against the exact
   db the tx will apply to; a denial rejects as **`TxRejected`** and consumes no `t`
   (`docs/AUTH_LAYER.md:94`, `packages/transactor/src/transactor.ts` commit loop,
   `packages/transactor/src/policy.ts:49-53`).

### 8.7 What a denial actually looks like

| situation | shipped behaviour |
|---|---|
| write denied at ingress | HTTP **403** `{ error, code: "policy", attr }` → client `Unauthorized` with `code`/`attr` (`worker/src/errors.ts:87-91`, `alchemy/src/db/Errors.ts:180-182`) |
| write denied in the commit loop | **`TxRejected`** (409) |
| read of a masked attribute | ⚠️ **the datom is simply invisible** — `pull` returns the entity without that key, and the client's `reshapePullResult` then drops the whole row (→ `null`) if the key was pulled as *required* |
| list query | filtered, possibly empty, **no error** |
| no/invalid token | **401** `Unauthorized` |

❌ `docs/AUTH_LAYER.md:110` says "Single entity or `pull` → `NotFound`". That is design intent;
the shipped `/pull` route returns `{ t, result }` off the filtered db
(`packages/worker/src/index.ts:265-277`) and never raises `NotFound` for a policy miss.
Document the `null`/omitted-key behaviour instead.

### 8.8 The compile-time masked-required-attribute check

This one is real and shipped:

```typescript
/**
 * `reshapePullResult` drops an entity that is missing a *required* key, so a
 * read-masked attribute pulled as required would delete the row instead of
 * redacting the field. Deploy-time error, not a printed list.
 */
export const checkPulls = (p: Policy, pulls: readonly unknown[]): void => {
```
— `packages/alchemy/src/db/Policy.ts:445-450`, error message at `:462-465`:

```typescript
        fail(
          `${where}.${key}: ${ident} has a narrowed read rule and must be pulled as \`.optional\``,
          ident,
        );
```

It runs when you pass `pulls` to `compile`:

```typescript
export const compile = (p: Policy, options?: CompileOptions): string => {
  if (p?._tag !== "Policy") fail("compile() expects a P.policy(...) value");
  if (options?.pulls) checkPulls(p, options.pulls);
```
— `packages/alchemy/src/db/Policy.ts:474-476`

⚠️ It is **opt-in**: `Ripple.Policy.compile(policy)` without `{ pulls: [...] }` skips it entirely.
Docs should show `compile(policy, { pulls: [todoShape, ...] })`.

`compile` also round-trips the JSON through core's `parsePolicy` and fails if core rejects it
(`Policy.ts:479-484`).

### 8.9 Running a policy locally / minting a test JWT

❌ **There is no shipped helper to mint a JWT.** Ripple verifies, never issues
(`docs/AUTH_LAYER.md:130`). The only minting code in the repo is a test fixture:

```typescript
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  JWKS = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "test" }] });
  sign = async (claims, over = {}) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test" });
    jwt = jwt.setIssuer((over.iss as string) ?? ISS).setAudience((over.aud as string) ?? AUD);
    jwt = jwt.setSubject((over.sub as string) ?? "user_ada");
    jwt = jwt.setIssuedAt((over.iat as number) ?? undefined).setExpirationTime((over.exp as string | number) ?? "5m");
    return jwt.sign(privateKey);
  };
});

/** A token for `db` with `class` (and optional app attrs). */
const token = (db: string, cls: string, sub = "user_ada", attrs?: Record<string, unknown>, over?: Record<string, unknown>) =>
  sign({ ripple: { db, class: cls, ...(attrs === undefined ? {} : { attrs }) } }, { sub, ...over });
```
— `packages/worker/test/auth.test.ts:22-36`

The offline path it uses is the shipped `RIPPLE_JWKS_JSON` seam: set it to a literal JWK Set
instead of `RIPPLE_JWKS_URL` (`auth.ts:72-75`). That is the honest "run a policy locally"
recipe — write ~15 lines with `jose`, feed the public JWK to the peer, and hand-sign tokens.
There is no `ripple mint-token` CLI, and there is no CLI at all.

---

## 9. Deploy

### 9.1 The two Alchemy resources

```typescript
export type Server = Resource<
  "Ripple.Server",
  ServerProps,
  {
    /** Base URL, no trailing slash. */
    url: string;
    /** The server Worker's script name, or `""` when it was given as a URL. */
    workerName: string;
    /** The bearer token, when one was configured. */
    token: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;
```
— `packages/alchemy/src/Server.ts:239-252`

```typescript
export type ServerProps = {
  /** The Worker that serves `/db/:name/*` (or a URL, when it is not ours to deploy). */
  worker: ServerWorker;
  /** Override the URL resolved from `worker` — a custom domain, say. */
  url?: string;
  ...
  token?: Redacted.Redacted<string> | string;
  /** The server's auth configuration, for a deploy-time consistency check only. */
  auth?: PeerAuth;
  /** Liveness probe on deploy; `false` skips it. */
  probe?: ServerProbe | false;
};
```
— `packages/alchemy/src/Server.ts:118-137` (elided where noted). `ServerProbe` is
`{ attempts?: number; delayMs?: number }`, defaults **30 attempts / 2000 ms**
(`Server.ts:83-89`, `:341-350`). The probe is `GET {url}/health` and runs on live deploys only,
never under `alchemy dev` (`Server.ts:398-408`).

```typescript
export type DatabaseProps = {
  /** The server that serves this name. */
  server: Server;
  /** The catalog to install. `Ripple.Catalog({ … })`, shared with the app. */
  catalog: Catalog.Any;
  /** The database name. @default the resource's logical id */
  name?: string;
};
```
— `packages/alchemy/src/Database.ts:47-55`

`Ripple.Database` provisions nothing — its `reconcile` runs `db.install()` (one idempotent
transaction) and its `delete` is a **no-op** so forgetting the resource never erases a log
(`Database.ts:160-176`). Outputs: `{ name, server, t }` (`Database.ts:57-70`).

### 9.2 The full runnable stack (verbatim)

```typescript
import * as Ripple from "@ripple/alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", { className: "TransactorDO" });
const Replica = Cloudflare.DurableObject("QueryReplicaDO", { className: "QueryReplicaDO" });

export const RippleWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});

export const Server = Ripple.Server("Ripple", { worker: RippleWorker });
```
— `examples/todos/resources.ts:1-14` (whole file)

```typescript
export const TodosDb = Ripple.Database("todos", { server: Server, catalog: Todos });

export default Alchemy.Stack(
  "ripple-todos",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ripple.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    yield* TodosDb;
    return { peerUrl: server.url };
  }),
);
```
— `examples/todos/alchemy.run.ts:18-31`

Note `Ripple.providers()` **must** be merged alongside `Cloudflare.providers()`
(`packages/alchemy/src/Providers.ts:28-32`).

⚠️ The examples pin `state: Alchemy.localState()` unconditionally; the root stack switches on
`ALCHEMY_STATE` instead:

```typescript
    state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state(),
```
— `alchemy.run.ts:122`

### 9.3 Commands

```json
    "dev": "bun alchemy dev",
    "deploy": "bun alchemy deploy",
    "deploy:prod": "bun alchemy deploy --stage prod",
    "destroy": "bun alchemy destroy"
```
— `package.json:25-28`. Stage defaults to `ALCHEMY_STAGE ?? STAGE ?? USER ?? "dev"`
(`alchemy.run.ts:28`).

Local env for offline dev (`examples/todos/README.md:7-9`, `README.md:77-80`):
`CI=1`, `ALCHEMY_STATE=local`, `CLOUDFLARE_ACCOUNT_ID=<32 hex>` (any placeholder works for
miniflare), `CLOUDFLARE_API_TOKEN=x`.

### 9.4 Ports — **1337 is right, 8787 is wrong**

`alchemy dev` (and its Vite child) default to **1337**:

```typescript
export const DEFAULT_DEV_PORT = 1337;
```
— `node_modules/alchemy/src/Cloudflare/Workers/ViteChild.shared.ts:17`, and
`node_modules/alchemy/src/Cloudflare/Workers/Worker.ts:898-903` (`port?: number` `@default 1337`).

8787 is *wrangler's* default and is stale everywhere it appears in this repo.

| says 1337 ✅ | says 8787 ❌ |
|---|---|
| `examples/todos/README.md:10-11` | `README.md:32` |
| `CONTRIBUTING.md:24` | `examples/todos/alchemy.run.ts:2` |
| `bench/read-do.bench.ts:5` | `examples/todos/src/db.ts:20` (fallback) |
| | `test/e2e/ripple.e2e.test.ts:5` |
| | `bench/write-do.bench.ts:5` |

**For `examples/todos`: use `http://localhost:1337`.** The Vite UI is on `:5173`.

---

## 10. Errors and HTTP status mapping

### 10.1 The eight client errors (all `Data.TaggedError`)

| tag | fields beyond `message` | HTTP |
|---|---|---|
| `TxRejected` | `code: string` | 409 |
| `Unavailable` | `retryAfterMs: number` | 503 |
| `InvalidRequest` | — | 400 |
| `DatabaseNotFound` | — | 404 |
| `Unauthorized` | `code?: string`, `attr?: string` | 401 / 403 |
| `QueryBudgetExceeded` | `code`, `clause`, `cells`, `limit` | 413 |
| `InternalError` | — | 500 |
| `NetworkError` | `cause?: unknown` | *no response at all* |

— `packages/alchemy/src/db/Errors.ts:22-79`; the union `DbError` at `:81-89`.

Classification is by the DO-supplied `tag` field first, then by status
(`Errors.ts:133-218`). Two non-obvious behaviours to document:

- A Cloudflare HTML 404 / edge platform error is rewritten to **`Unavailable`** with
  `retryAfterMs: 200`, so callers can wait it out (`Errors.ts:186-192`, `:203-215`).
- `Unauthorized` on 401/403 carries `code` and `attr` through verbatim when present
  (`Errors.ts:180-182`).

### 10.2 Peer-side mapping (verbatim)

```typescript
/** Tagged failure → status + body fields. Pure; index.ts turns it into a `Response`. */
export function toHttp(err: RippleError): HttpError {
  switch (err._tag) {
    case "NotFound":
      return { status: 404, body: { error: text(err.message, "not found") } };
    case "BadRequest":
      return { status: 400, body: { error: err.message, stack: err.trace } };
    case "Unauthorized":
      return {
        status: err.status ?? 401,
        body: { error: text(err.message, "unauthorized"), ...(err.code === undefined ? {} : { code: err.code }), ...(err.attr === undefined ? {} : { attr: err.attr }) },
      };
    case "UpstreamError":
      // an upstream refusal is re-stated, never passed through: its body may name rows this caller cannot read
      if (err.status === 401 || err.status === 403) {
        const code = codeOf(err.body);
        return { status: err.status, body: { error: "unauthorized", ...(code === undefined ? {} : { code }) }, headers: err.headers };
      }
      return { status: err.status, raw: err.body, headers: err.headers };
    case "QueryBudgetExceeded":
      return { status: 413, body: { error: err.message, code: err.code, clause: err.clause, cells: err.cells, limit: err.limit } };
    case "Internal":
      return { status: 500, body: { error: err.message, stack: err.trace } };
  }
}
```
— `packages/worker/src/errors.ts:80-104`

⚠️ The peer's own error classes (`NotFound`, `BadRequest`, `Unauthorized`, `UpstreamError`,
`QueryBudgetExceeded`, `Internal`) are **Worker internals**, not client exports. Never document
them as things a user catches. The eight in §10.1 are what users see.

### 10.3 The canonical catch-all, verbatim from the example

```typescript
        Effect.catchTags({
          TxRejected: (e) =>
            HttpServerResponse.json({ error: e.message, code: e.code }, { status: 409 }),
          Unavailable: (e) =>
            HttpServerResponse.json(
              { error: e.message },
              { status: 503, headers: { "retry-after": String(Math.ceil(e.retryAfterMs / 1000)) } },
            ),
          QueryBudgetExceeded: (e) =>
            HttpServerResponse.json({ error: e.message, clause: e.clause }, { status: 413 }),
          InvalidRequest: (e) => HttpServerResponse.json({ error: e.message }, { status: 400 }),
          Unauthorized: (e) => HttpServerResponse.json({ error: e.message }, { status: 401 }),
          DatabaseNotFound: (e) => HttpServerResponse.json({ error: e.message }, { status: 404 }),
          InternalError: (e) => HttpServerResponse.json({ error: e.message }, { status: 500 }),
          NetworkError: (e) => HttpServerResponse.json({ error: e.message }, { status: 502 }),
        }),
```
— `examples/kv-style/app.ts:128-143`

### 10.4 HTTP API (Worker internals — document only in a reference page, if at all)

```
 *   GET  /                                  demo app (CRUD + as-of history view)
 *   GET  /health
 *   POST /db/:name/transact   { tx }        → { t, txEid, tempids, datoms }
 *   POST /db/:name/query      { query, inputs?, asOf?, history? }   → { t, result }
 *   POST /db/:name/pull       { eid, pattern, asOf?, history? }     → { t, result }
 *   GET  /db/:name/entity/:eid[?asOf=]                              → { t, entity }
 *   GET  /db/:name/info                                            → transactor + replica + basis info
 *   GET  /db/:name/session    (Upgrade: websocket)                 → the session socket (session.ts)
 *   POST /db/:name/admin/index | /admin/gc                         → indexer controls
```
— `packages/worker/src/index.ts:11-19`

Read-path request headers (`packages/worker/src/index.ts:4-9`): `x-ripple-replica-hint`,
`x-ripple-cache-basis`, `x-ripple-cache-mode`, `x-ripple-min-t`. Response header `x-ripple-ms`.

---

## 11. Limits and honest caveats

Put these in the docs; they are all load-bearing.

1. **One writer per database, low thousands of tx/s.**
   > Measured ceiling of one database on dev hardware (`bench/RESULTS.md`):
   > ~2.5–2.9k small tx/s with group commit in-process, ~1.7k tx/s through the
   > local Worker → DO path; ~600–850 tx/s with group commit disabled.
   — `docs/RUNBOOK.md:29-33`. The answer to the ceiling is to **split the logical database**
   (`RUNBOOK.md:54-72`), never to add a second writer.

2. **No cross-database joins.**
   > Reads that need a union across partitions run one query per database and merge in the
   > application (there is no cross-database join; that is the price of the split).
   — `docs/RUNBOOK.md:67-69`. Also: no cross-database policy rules
   (`docs/AUTH_LAYER.md:130`).

3. **Query memory budget → 413.** `RIPPLE_QUERY_MAX_CELLS`, default **1,572,864 cells (~48 MB)**
   (`packages/core/src/query/engine.ts:60`, `docs/RUNBOOK.md:85`). Over-budget queries fail
   `QueryBudgetExceeded` and are **terminal for `live`** — the stream will not retry them
   (`Db.ts:160-164`).

4. **`orderBy` / `limit` / `offset` are client-side**, and `orderBy` silently no-ops unless the
   attribute is in the `select` shape at depth 1. See §5.5.

5. **`limit` does not bound server work.** The whole result set is materialised and shipped,
   then sliced. Budget applies to the unlimited query.

6. **`db.live` requires a WebSocket.** Not available over `ServerBinding` (Worker→Worker).
   Under local miniflare, cross-connection live wake does not propagate:
   > Against local miniflare, the cross-connection `db.live` wake case fails
   > consistently (novelty does not propagate across isolates).
   — `CONTRIBUTING.md:29-31`

7. **`dbAfter`'s freshness floor is best-effort.**
   > The server polls its replica ~100ms for the basis, then serves the freshest it has;
   > `asOf(t)` by contrast pins an exact past view.
   — `docs/API.md:193`

8. **Tempids are not returned.** See §4.2.

9. **`asOf` reach is bounded by `RIPPLE_RETAIN_ROOTS` (20 roots)**, not by time. See §7.

10. **Against an uninstalled database**, behaviours differ per operation:
    > `q` fails `InvalidRequest`, `transact` fails `TxRejected`, `pull` silently omits the
    > attribute — that last one is a bug to fix, not a contract.
    — `docs/API.md:199` (the peer now rejects unknown pull attrs with `BadRequest`,
    `packages/worker/src/index.ts:274`, so this line is partly stale).

11. **Provisioning mistakes are defects, not errors.** Malformed URL, no `fetch`, missing socket
    → `Effect.die`. Every public signature's `R` is `never` (`Databases.ts:234-264`, `Db.ts:371`).

12. **Database names are capped**: `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`.

13. **`explain` and `/admin/*` require class `admin`** under a policy
    (`docs/AUTH_LAYER.md:86`, `:106`).

14. **`estimate` is not policy-filtered**, and 413 bodies plus timing headers are an accepted,
    unclosed side channel on invisible data (`docs/AUTH_LAYER.md:86`).

15. **The engine's aggregate/graph surface is not exposed navigationally.** No `count`, `sum`,
    `groupBy`, `traverse`, reverse refs, `in`, `some`/`every`/`none`, `endsWith`/`matches`,
    `Ripple.or`/`not`/`when`/`params`, `db.changes` — all listed under "Not yet"
    (`docs/QUERY.md:184-196`).

16. **One policy per deployed Worker**, one catalog. Per-db policy variants are an open question
    (`docs/AUTH_LAYER.md:74`, `:136`).

17. **Deleting a `Ripple.Database` or `Ripple.Server` resource deletes no data.** Dropping data
    is a separate manual act — empty the bucket, delete the DO namespaces
    (`Database.ts:171-175`, `Server.ts:389-395`).

---

## 12. Where the current website docs are wrong

Audited all 19 files under `website/src/content/docs/` against source. The site is in good
shape overall — the schema, transaction, error and architecture pages are accurate. These are
the defects, worst first.

### 12.1 🔴 Blocker — the quickstart's client snippet crashes on the default open peer

```ts
    token: Effect.succeed(Redacted.make(import.meta.env.VITE_RIPPLE_TOKEN)),
```
— `website/src/content/docs/getting-started/quickstart.md:104`

With no `VITE_RIPPLE_TOKEN` set (the documented default — the local peer is open), this is
`Redacted.make(undefined)`. The client then does:

```typescript
        Effect.map((t) => {
          const value = Redacted.value(t);
          return value.length > 0 ? value : undefined;
        }),
```
— `packages/alchemy/src/db/Databases.ts:96-100`

`undefined.length` → **TypeError on the first request**. The real example guards for it:

```typescript
const token = import.meta.env.VITE_RIPPLE_TOKEN;
...
    token:
      token === undefined || token === ""
        ? undefined
        : Effect.succeed(Redacted.make(token)),
```
— `examples/todos/src/db.ts:16-24`

Fix: copy `examples/todos/src/db.ts` verbatim. (`README.md:102` has the same bug — the site
inherited it from there.)

### 12.2 🔴 Wrong port — 8787 should be 1337

- `quickstart.md:20` — `VITE_RIPPLE_URL=http://localhost:8787 bunx vite examples/todos`
- `quickstart.md:103` — `url: import.meta.env.VITE_RIPPLE_URL ?? "http://localhost:8787"`

`alchemy dev` defaults to **1337** (`node_modules/alchemy/src/Cloudflare/Workers/ViteChild.shared.ts:17`,
`.../Worker.ts:898-903`). 8787 is wrangler's default. See §9.4 for the full table of which repo
files are right. A reader following the quickstart gets a peer on `:1337` and a UI pointed at
`:8787`, i.e. nothing works.

### 12.3 🔴 `pull` denial is **not** `NotFound`

> denied `pull` is **`NotFound`** — `guides/auth.md:120`

`NotFound` is not one of the eight client errors (the same site page set says so at
`reference/errors.md:23-32`), and the shipped `/pull` route never raises it for a policy miss —
it runs `pull` against the filtered `Db` and returns `{ t, result }` (`packages/worker/src/index.ts:265-277`).
A masked attribute is simply **absent**; if it was pulled as required, the client's
`reshapePullResult` drops the row and `db.pull` resolves to **`null`**. `docs/AUTH_LAYER.md:110`
is the (design-doc) source of this error. See §8.7.

### 12.4 🟠 `guides/workers.md` snippet does not compile

`website/src/content/docs/guides/workers.md:13-37`:
- imports `{ Movies }` but the body uses **`Movie`** (`Movie.title` at :26, `Ripple.query(Movie)` at :30) — never imported.
- uses `HttpServerRequest.HttpServerRequest` (:25) and `HttpServerResponse.json` (:34) with no imports.

The working original imports both explicitly (`examples/kv-style/app.ts:18-21`). Either import
them or elide the body with a comment; do not ship a snippet that fails `tsc`.

### 12.5 🟠 `guides/workers.md:48` overstates `ReadWriteDatabases`

> `Ripple.ReadWriteDatabases(Server)` grants `q`, `pull`, `live`, `asOf`, `history`, `transact`, `install`

`live` is in the *type*, but under `Ripple.ServerBinding` (the transport that same page
recommends at :59) there is no `webSocket`, so calling it **dies** with
`"ripple: db.live needs the session socket"` (`Db.ts:369-378`, `Databases.ts:82-85`). Add the
caveat: live queries are a browser / `Ripple.layer` feature.

### 12.6 🟠 Wrong type signatures in `reference/alchemy-resources.md`

| line | says | actually |
|---|---|---|
| `:11` | `Server` outputs `{ url, workerName }` | `{ url, workerName, token }` (`Server.ts:242-249`) |
| `:11` | `token?: Secret` | there is no `Secret` type; it is `Redacted.Redacted<string> \| string` (`Server.ts:132`) |
| `:13` | `ReadWriteDatabases: (server) => Effect<Databases, never, Providers>` | `(server: Server) => Effect.Effect<DatabasesShape>` (`ReadWriteDatabases.ts:22-26`) — requirements are not `Providers`, and it yields the *shape*, not the `Databases` tag |
| `:15-16` | `ServerBinding` / `ServerHttp` — `Layer<Providers>` | `Layer.Layer<ReadWriteDatabases \| ReadDatabases>` (`ServerHttp.ts:58`) |

All four are inherited from the stale table in `docs/API.md:75-79`. Do not treat `docs/API.md`
as a signature source — it is a design proposal ("Proposal. Breaking." at `docs/API.md:3`).

### 12.7 🟠 `reference/http-api.md:22` — `/transact`'s response is not a `TxReport`

The HTTP response is `{ t, txEid, tempids, datoms }` (`packages/worker/src/index.ts:13`).
`TxReport` is a *client-side* value with `datomCount` and `dbAfter`, neither of which is on the
wire (`Db.ts:454-467`). Conversely `tempids` is on the wire and is **not** on `TxReport`.

### 12.8 🟡 `guides/auth.md:111` — denial is not always `TxRejected`

There are two enforcement stages and they fail differently:
- ingress pre-check → **`Unauthorized`** 403 with `code`/`attr` (`packages/worker/src/auth.ts:313`)
- commit loop (the authority) → **`TxRejected`**, no `t` consumed

The page states only the second. Both should be documented, along with the honest note that
stage (a) can spuriously deny a write stage (b) would allow (`docs/AUTH_LAYER.md:135`).

### 12.9 🟡 `guides/auth.md:124-126` — the masked-attribute check is opt-in

It only runs when you pass `pulls` to `compile` (`packages/alchemy/src/db/Policy.ts:474-476`).
`Ripple.Policy.compile(policy)` alone silently skips it. The page implies it is automatic. Show
`compile(policy, { pulls: [shape1, shape2] })`.

### 12.10 🟡 `guides/auth.md:138` mints an internal secret unconditionally

```ts
  internalSecret: Ripple.internalSecret(process.env.RIPPLE_INTERNAL_SECRET),
```

The repo guards it on a policy being configured:

```typescript
  internalSecret: process.env.RIPPLE_POLICY === undefined ? undefined : Ripple.internalSecret(process.env.RIPPLE_INTERNAL_SECRET),
```
— `alchemy.run.ts:63`

As written, an unpinned `RIPPLE_INTERNAL_SECRET` mints a fresh random secret on **every deploy**
even with no policy, arming the Worker→DO gate (`Server.ts:212-216`). Harmless in the
single-script layout but it is not what the repo does.

### 12.11 🟡 `index.mdx:116-129` drops the compatibility flags

```ts
  const Worker = Cloudflare.Worker("Peer", {
    main: "./packages/worker/src/index.ts",
  });
```

Every working stack in the repo passes
`compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] }`
(`examples/todos/resources.ts:10`, `examples/kv-style/resources.ts:46`, `alchemy.run.ts:72`).
The peer Worker imports `jose` (`packages/worker/package.json:14`), so `nodejs_compat` is not
decorative. Even on a landing page, ship the flags or mark the block as elided.

### 12.12 🟡 `reference/configuration.md:29-30` — "no default" is wrong

`RIPPLE_CACHE_BASIS`, `RIPPLE_CACHE_MODE` and `RIPPLE_REPLICA_HINT` all have effective defaults:

```
 * `x-ripple-replica-hint: wnam|enam|…|auto|continent` picks the replica DO placement
 * (hint is part of the DO id; default `auto` = colo→hint); `x-ripple-cache-basis: 0|1`
 * (default 1) reuses an isolate-cached basis instead of calling the replica each read;
 * `x-ripple-cache-mode: ttl|peer` (default ttl = 5 s) picks the cache's consistency story;
```
— `packages/worker/src/index.ts:5-8`

### 12.13 🟡 Incomplete: `Entity<C>` has three verbs, not two

`reference/client-api.md:64` and `guides/transactions.md:24` both give
`Entity<C>` as `{ eid; add; retract }`. It also has `retractEntity()` (`Tx.ts:87`).
Likewise `reference/client-api.md:52` omits `.build()` from the query builder.

### 12.14 🟢 Internal inconsistencies (cosmetic)

- `concepts/architecture.md:51-55` storage table omits the `n/` prefix that
  `reference/runbook.md:88` sweeps. Both come from repo docs; `n/` is real
  (`docs/RUNBOOK.md:117`).
- `guides/live-queries.md:33` says `useLive` is "twelve lines"; the function is 13
  (`examples/todos/src/useLive.ts:15-27`). The repo says twelve too — leave it or say "a dozen".
- `reference/alchemy-resources.md` and `reference/client-api.md` never mention `Ripple.Policy`,
  though `guides/auth.md` uses ~12 of its combinators. Add it to the exported-name table.

### 12.15 ✅ Claims I checked that are correct (don't "fix" these)

- `git clone https://github.com/tvanhens/ripple` — matches `git remote -v`.
- `tx/invalid` as a wire code — real, it is the default in `packages/core/src/tx.ts:44`.
- `POST /db/:name/admin/replica/reconnect` — real (`packages/worker/src/index.ts:226`), even
  though the Worker's own header comment at `index.ts:19` forgets to list it.
- Upsert-on-`unique: "identity"` via `tx.entity()` + `add` — real
  (`packages/core/src/tx.ts:18`, `:460`).
- All env-var names and defaults in `reference/configuration.md` (0 / 500 / 5000 / 5000 / 20000 /
  1,572,864 / 20 / 50 / 900 / info) — every one matches
  `packages/transactor/src/host.ts:55-64`, `packages/core/src/query/engine.ts:60`,
  `packages/alchemy/src/Server.ts:151`.
- The eight error tags, their fields, and their status codes.
- `Eid<C>` is `{ readonly id: number }`; `Todo.id` is a real selectable pseudo-attribute.
- The write-ceiling numbers, the Alchemy stack block in `guides/deploy.md`, and the
  `useLive` hook body.

---

## 13. Shipped but missing from the site — things a newcomer needs

Ranked by how much pain the omission causes.

1. **Nothing is on npm.** No page says this. `index.mdx` and `introduction.md` read like a
   product you can install. The only way in is `git clone` + `bun install` + work inside the
   repo, and `main`/`types` point at raw `.ts` so there is no consumable build. This belongs in
   the first paragraph of the quickstart *and* on the landing page. See §1.1.

2. **`orderBy` silently no-ops unless the attribute is in `select` at depth 1.**
   `guides/queries.md:92-94` correctly says ordering is client-side but not that it *fails
   silently*. `.orderBy(Todo.due, "asc")` with a `select` that omits `due` returns unsorted rows
   and no error (`NavQuery.ts:565-576`). This is the single most likely "why is my data wrong"
   bug. See §5.5.

3. **`limit` does not bound server work.** The full result set is materialised, shipped, and
   then sliced client-side (`NavQuery.ts:532-534`). So `limit(20)` on a huge query still trips
   the 413 budget. Nobody would guess this.

4. **`db.live` is unavailable without a WebSocket** — i.e. in a Worker under `ServerBinding`,
   and in Node/Bun without a `WebSocket` global. It fails as a **defect** (`Effect.die`), not a
   catchable `DbError`. Also: under local miniflare the cross-isolate live wake does not
   propagate at all (`CONTRIBUTING.md:29-31`), so a reader testing live queries locally may see
   them not fire. See §6.1.

5. **Tempids are not returned.** `TxReport` has no `tempids`, even though the wire does. There
   is no documented way to get the eid of an entity you just created other than querying for it.
   `guides/transactions.md` should say so outright. See §4.2.

6. **`asOf` reach is bounded by `RIPPLE_RETAIN_ROOTS` (20 roots), and it is roots, not days.**
   `concepts/time-travel.md:46-47` mentions the var but not that GC *deletes* the segments
   behind older roots, that retention is literally `ts.slice(-n)`
   (`packages/storage/src/index.ts:414-417`), or that "20 roots" ≈ "the last 20 index runs",
   which depends on `RIPPLE_INDEX_TX_THRESHOLD`. Users will assume history is forever.

7. **`db.asOf` takes a transaction number, not a `Date`.** Nowhere stated. `asOf(date)` is
   roadmap only (`docs/QUERY.md:227`).

8. **`Ripple.query(...).offset(n)` and `.build()`** exist and are absent from the reference
   table (`reference/client-api.md:52`). `offset` appears in `guides/queries.md:44` but with no
   explanation that it too is client-side.

9. **The `Attr` options nobody documents**: `index`, `isComponent`, `doc`, `valueType`.
   `guides/catalog.md:60-66` covers only `unique` and `cardinality`. Notably `index` defaults to
   *"true iff `unique` is set"* (`Attribute.ts:78`), and `valueType` is **required** for any
   Schema that is not string/number/boolean or a Ripple helper (`valueTypes.ts:194-202` throws).
   A user who writes `Attr(Schema.Struct({...}))` gets a runtime throw with no doc coverage.

10. **`attrName`, not `name`.** Navigational attribute metadata uses `attrName` so a path like
    `Todo.owner.name` isn't shadowed by the attribute's own name field (`docs/QUERY.md:61-63`).
    Anyone with a `name` attribute needs to know this.

11. **`Ripple.Policy`'s exported surface is undocumented as a reference.** `guides/auth.md`
    uses `P.policy`, `P.allow`, `P.deny`, `P.eq`, `P.ref`, `P.or`, `P.and`, `P.not`, `P.class`,
    `P.preset`, `P.attr`, `P.principal`, `P.claims` — none appear in any reference table.
    Missing entirely: `P.constant`, `P.lit`, `P.claimsOf(struct)`, `P.Claims`, `P.checkPulls`,
    and the fact that `compile` takes `{ pulls }`. See §8.4.

12. **There is no way to mint a JWT and no CLI.** `guides/auth.md` explains policies at length
    but never tells a reader how to actually get a token to test with. The shipped seam is
    `RIPPLE_JWKS_JSON` (a literal JWK Set, `auth.ts:72-75`) plus ~15 lines of `jose`. A
    "run a policy locally" recipe based on `packages/worker/test/auth.test.ts:22-36` would be
    high-value. See §8.9.

13. **`anonymous` is a magic class name.** Tokenless callers are refused unless the policy
    declares a class literally named `anonymous` (`packages/worker/src/auth.ts:36-37`,
    `:168-171`). `guides/auth.md:48-49` mentions it in passing; it deserves to be a callout,
    because it is how you build public-read apps.

14. **`$token` is also magic.** Under a policy, `RIPPLE_TOKEN`'s holder gets class `$token`,
    which is deliberately undeclarable, so every rule denies it (`auth.ts:38-42`). Explains the
    otherwise-baffling "my `RIPPLE_TOKEN` stopped working when I turned on a policy".

15. **Deploy-time fail-closed check.** Setting `auth.policy` without `jwksUrl`/`issuers`/`aud`
    **fails the deploy** with a specific message (`Server.ts:223-237`). Worth documenting as a
    feature so the error is recognisable.

16. **`Ripple.Server`'s health probe defaults** — 30 attempts × 2000 ms, `probe: false` to skip
    (`Server.ts:83-89`, `:341-350`). A slow first workers.dev propagation looks like a hang
    otherwise.

17. **Destroying a resource destroys no data.** `Ripple.Database.delete` and
    `Ripple.Server.delete` are deliberate no-ops (`Database.ts:171-175`, `Server.ts:389-395`).
    Both a safety guarantee and a footgun (`alchemy destroy` leaves R2 + DOs behind, and you pay
    for them). Not mentioned on `guides/deploy.md`.

18. **`Ripple.ReadDatabases` has no write-only twin, by design** (`ReadDatabases.ts:5-8`) — a
    one-line answer to an obvious question.

19. **Legacy builder extras.** `explain(...)` and `find(...).pull(pattern)` exist on the callback
    builder (`Query.ts:187-191`, `:252-254`); `explain` is admin-only under a policy
    (`docs/AUTH_LAYER.md:86`) and `find().pull()` is a client-side N+1 at concurrency 16
    (`Db.ts:273-285`). `reference/client-api.md:57` shows the legacy builder without either.

20. **`Catalog.Any`** is listed at `reference/client-api.md:19` but never explained — it is the
    bound you need for catalog-generic helper functions (`Catalog.ts:23-26`), which is the first
    thing anyone writing a shared utility hits.

21. **The `x-ripple-min-t` / `x-ripple-cache-*` request headers** are documented as *response*
    headers only (`reference/http-api.md:48-52`). They are inbound knobs
    (`packages/worker/src/index.ts:4-9`), which matters for anyone tuning read freshness.
