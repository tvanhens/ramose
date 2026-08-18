# Ramose — API ground truth (what actually ships)

Repo `/Users/tvanhens/git/ripple`, branch `master`, HEAD `2659601` ("Rewrite docs for an npm-install audience. (#82)"). Verified 2026-08-18 against `packages/*/src`, `packages/*/test`, `examples/{todos,reef,kv-style}`, `alchemy.run.ts`, `docs/*.md`, `README.md`, and every page under `website/src/content/docs/**`.

Every code block is **copied verbatim** with `file:line`. If an API is not in here it does not exist — do not invent it. Supersedes `website/reviews/shipped-api.md` (HEAD a15b538); where that doc and this one disagree, this one is current.

Legend: ✅ shipped & verified · ⚠️ shipped, sharp edge · ❌ claimed somewhere (site/README/docs) but **not** true of the code.

Toolchain facts writers must not contradict: `effect@4.0.0-rc.109` (peer range `>=4.0.0-beta.105`; Effect **4** spellings — `Effect.catch`, `Effect.catchTags`, `effect/Schema`, `Context.Service`), `alchemy@2.0.0-beta.72`, `react@19` (peer `>=19`), `better-auth@1.6.30` (peer `>=1.6.0`), Bun workspace (`bun install`, `bun test`, `bun alchemy dev`).

---

## 0. Cheat-sheet (the ~30 calls a writer needs)

```ts
// ── imports ── (`@ramose/alchemy/db`: schema+client+errors, portable; `@ramose/alchemy`: that + Server/Database/Policy/authEnv/claims/transports)
import * as Ramose from "@ramose/alchemy/db";   // or "@ramose/alchemy" on the deploy side
import { RamoseProvider, useRamose, useDb, useLive, useQuery, usePull, useBasis, useTransact, errorMessage } from "@ramose/react";
import { ramoseToken, orgClassOf, classOfRole } from "@ramose/better-auth";      // server plugin
import { ramoseTokenClient } from "@ramose/better-auth/client";                  // browser plugin
import * as Schema from "effect/Schema"; import * as Effect from "effect/Effect";
// ── schema ─────────────────────────────────────────────────────────────────
const User = Ramose.Namespace("user", { name: Ramose.Attr(Schema.String, { unique: "identity" }) });
const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String), done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant), owner: Ramose.Attr(Ramose.Ref(() => User)),
  tags: Ramose.Attr(Schema.String, { cardinality: "many" }),
});
const Todos = Ramose.Catalog({ user: User, todo: Todo });
// Attr options: cardinality "one"|"many", unique "identity"|"value", index, isComponent, doc, valueType
// value helpers: Ramose.Instant Long Bytes Uuid UuidString Ref Ref(() => Ns) Ref.self ; plain Schema.String/Number/Boolean
// handles: Todo.title (attr ref, ident ":todo/title"), Todo.id (":db/id" pseudo-attr), Todo.owner.name (hop), Todo.owner.reverse (backlink)

// ── client ── (all Db methods are Effects with R = never → Effect.runPromise(...))
const ramose = Ramose.connect({ url, token?: Ramose.token.static(t) | Ramose.token.jwt(mint) | Effect<Redacted<string>,DbError>, fetch?, webSocket? });
const db = ramose.db("todos", Todos);            // Db<typeof Todos> — pure, no I/O
await ramose.close();                            // Promise<void>
Ramose.layer({ url, token }): Layer<Ramose.Databases>;  const ramose = yield* Ramose.Databases;   // Effect-native twin
Ramose.token.jwt(() => fetch("/api/auth/ramose/token",{method:"POST",body}).then(r=>r.json()), { refreshMargin?: "2 minutes" })  // TokenSource: .token .claims() .invalidate()
Ramose.isDatabaseName(name) / Ramose.DATABASE_NAME_RE  // /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
// ── db ─────────────────────────────────────────────────────────────────────
db.install(): Effect<TxReport, DbError>                          // idempotent catalog upsert (one tx)
db.transact(function* (tx) { const e = yield* tx.entity(); yield* e.add(Todo.title, "x"); }): Effect<TxReport, DbError|E, R>
//   tx.entity() | tx.entity(eid|tempid|[User.name,"Ada"]) → Entity{ eid, add(attr,v), retract(attr,v?), retractEntity() }
//   tx.add(e, attr, v) · tx.retract(e, attr, v?) · tx.retractEntity(e)   (attr = Todo.title or ":todo/title")
//   TxReport = { t, txEid: Eid, datomCount, dbAfter: Db }             (no tempids on TxReport)
db.q(query): Effect<Rows, DbError>            db.live(query): Stream<Rows, DbError>   // live needs the session socket
db.pull({ id } | [User.name,"Ada"], shape): Effect<Pull|null, DbError>   db.livePull(subject, shape): Stream<Pull|null, DbError>
db.basis(): Effect<{ t }, DbError>            db.principal(): Effect<{ eid: Eid|null, class }, DbError>
db.asOf(t): ReadDb  (pure, transaction number not Date)   db.history: ReadDb (pure)   report.dbAfter: Db (read-your-write floor)
// ── query builder (a value; pass builder or .build() to db.q/db.live) ───────
const q = Ramose.query(Todo)
  .where(Todo.done.eq(false), Ramose.or(Todo.title.startsWith("a"), Ramose.not(Todo.owner.missing())))
  .select({ id: Todo.id, title: Todo.title, owner: Todo.owner.select({ name: User.name }).optional,
            tags: Todo.tags, backlinks: Todo.owner.reverse.select({ id: Todo.id }) })
  .orderBy(Todo.createdAt, "asc", { empty: "last" }).limit(20).offset(0);
type Row = Ramose.Row<typeof q>; type Rows = Ramose.Rows<typeof q>;   // no .select → rows are Eid[] ({ id })
// predicates on any attr: eq ne lt lte gt gte in([..]) startsWith endsWith includes matches(re|string) exists() missing()
// refs only: .is(eid|{id})   card-many only: .some(p) .every(p) .none(p) .each (element cursor) .where(...) .orderBy() .limit() .offset()
// select fields must be DIRECT attrs of the queried namespace (or ref.select({...})); { ownerName: Todo.owner.name } is rejected

// ── react (@ramose/react) ──────────────────────────────────────────────────
<RamoseProvider key={tenant} url={url} token={stableTokenSource}>…</RamoseProvider>   // ClientOptions + children
useRamose(): Client   useDb(name, catalog): Db<C>                                       // both throw outside a provider
useLive(db, query) | useLive(stream): { rows: A|undefined, error: Cause|undefined, ticks: number }   // no provider needed
useQuery(db, query): { data, error, loading }        usePull(db, subject, pattern): Live<Pull|null>
useBasis(db): number | undefined                     useTransact({ onError? }): { run(effect): Promise<Exit>, pending, error, clearError }
errorMessage(e): string    // hoist query/pattern to module scope; db.asOf(t) inline is fine (structural key)

// ── policy / auth (deploy side, @ramose/alchemy) ───────────────────────────
const P = Ramose.Policy;
const policy = P.policy(Catalog, { principal: User.sub, classes: ["admin","member","viewer"], claims?: Schema.Struct({...}),
  ns: { todo: { read: P.allow(P.class("member")), create: P.allow(expr), add, retract, retractEntity,
                preset: [P.preset(Todo.owner, P.principal)], attrs: [P.attr(Todo.secret, { read: P.allow(P.class("admin")) })] } } });
// exprs: P.class(c) P.eq(attr, value|P.principal|P.claims.sub|P.claims.attrs.org) P.ref(refAttr, expr|attr) P.and P.or P.not P.constant(b) P.lit(v)
// arms: P.allow(expr) P.deny(expr)   ops: read add retract retractEntity create   compile: P.compile(policy, { pulls?: [shapes] }) → JSON string
Ramose.authEnv({ policy, jwksUrl, auth: { issuer, audience, ttl }, allowedOrigins?, internalSecret? })  → env for the peer Worker
Ramose.claims(auth, { sub, db, class, attrs? }, compiledPolicy?) → MintedClaims   // pure; sign it yourself or use @ramose/better-auth
ramoseToken({ auth, classOf: orgClassOf(), policy? })   // Better Auth plugin: POST {basePath}/ramose/token { db } → { token, class, exp }

// ── deploy (Alchemy 2) ─────────────────────────────────────────────────────
Cloudflare.Worker("Peer", { main: "./packages/worker/src/index.ts", compatibility: { date, flags: ["nodejs_compat"] },
  env: { STORE: R2Bucket, TRANSACTOR: DurableObject("TransactorDO"), REPLICA: DurableObject("QueryReplicaDO"), ...Ramose.authEnv(auth) } })
Ramose.Server("Ramose", { worker, url?, token?, auth?, probe? }) → { url, workerName, token }
Ramose.Database("todos", { server, catalog, name? }) → { name, server, t }         // runs db.install() at deploy; delete is a no-op
yield* Ramose.ReadWriteDatabases(Server) / Ramose.ReadDatabases(Server)  under  Ramose.ServerBinding | Ramose.ServerHttp
Alchemy.Stack("app", { providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers()), state }, Effect.gen(...))
```

---

## 1. Packages, publish status, entry points

### 1.1 ❌ Nothing is on npm (as of 2026-08-18)

All eight workspace packages are `"private": true` and `npm view @ramose/{alchemy,react,worker,better-auth}` → **E404** (`'@ramose/alchemy@*' is not in this registry`). No `dist/`, no build step; `main`/`types` point at `src/index.ts`. The root `README.md:17,32`, `website/.../index.mdx:53,377`, `introduction.md:14`, `quickstart.mdx:16,29` all say `npm install @ramose/…` — **false today**. The only working path is the monorepo (`bun install` at repo root; `examples/*` resolve `@ramose/*` through the root `node_modules` links).

| package | dir | `private` | `exports` | for |
|---|---|---|---|---|
| `@ramose/alchemy` | `packages/alchemy` | true | `"."` → `src/index.ts`, `"./db"` → `src/db/index.ts` (`package.json:9-12`) | the public API (portable `/db` + deploy half) |
| `@ramose/react` | `packages/react` | true | `"."` → `src/index.ts` (`:9-11`) | hooks; peer `react >=19` |
| `@ramose/better-auth` | `packages/better-auth` | true | `"."`, `"./client"` (`:9-12`) | Better Auth mint-route plugin + browser plugin; peer `better-auth >=1.6.0` |
| `@ramose/worker` | `packages/worker` | true | **none** — only `main: "src/index.ts"` (`:6`) | the peer Worker script (HTTP API + DO class re-exports) |
| `@ramose/core` | `packages/core` | true | `"."`, `"./*"` | engine internals (do not document) |
| `@ramose/storage` / `transactor` / `replica` | | true | `"."`, `"./*"` | internals |

Subpath check requested by lead: `@ramose/alchemy/db` ✅, `@ramose/alchemy` ✅, `@ramose/react` ✅, `@ramose/better-auth` + `/client` ✅, `@ramose/worker` ⚠️ (importable only via `main`; no `exports` map).

⚠️ `main: "@ramose/worker"` on a `Cloudflare.Worker` appears in doc-comments (`packages/alchemy/src/index.ts:20`, `Server.ts:27`, `Database.ts:22`, `README.md:129`, several site pages) but is **exercised nowhere**. Every runnable stack uses the relative path:

```ts
export const RamoseWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: { STORE: Store, TRANSACTOR: Transactor, REPLICA: Replica },
});
```
— `examples/todos/resources.ts:8-12` (same at `alchemy.run.ts:72-77`, `examples/reef/src/infra/resources.ts:41-66`, `examples/kv-style/resources.ts`)

### 1.2 The exact public surface (pinned by tests)

`@ramose/alchemy/db` runtime names — `packages/alchemy/test/db-portable.test.ts:139-168` pins exactly: `Attr Namespace Catalog Instant Uuid UuidString Ref Long Bytes query or not connect layer Databases token DATABASE_NAME_RE isDatabaseName TxRejected Unavailable InvalidRequest DatabaseNotFound Unauthorized QueryBudgetExceeded InternalError NetworkError`.
Types: `Attribute Catalog.Any Namespace EidLike NavQuery NavQueryBuilder Not Or Predicate Row Rows Shape WhereNode Client ClientOptions Claims TokenSource Db DbPrincipal QueryInput ReadDb TxReport Eid LookupRef IdentPullPattern Pull ValidatePull Entity Tx DbError` (`packages/alchemy/src/db/index.ts:32-83`).

`@ramose/alchemy` = all of `/db` **plus exactly** (`packages/alchemy/test/surface.test.ts:13-35`): `Server Database ReadWriteDatabases ReadDatabases ServerBinding ServerHttp providers Providers Policy authEnv internalSecret AUTH_ENV_KEYS DEFAULT_JWT_MAX_TTL claims`; types `AuthConfig ClaimsInput MintedClaims PeerAuth` (`src/index.ts:43-54`).

⚠️ `Catalog.merge` exists (`db/Catalog.ts:29-35`) but is **not exported**. `Pull.pick` exists (`db/Pull.ts:97-113`) but is **not exported**. Do not document either.

⚠️ Name collision to warn writers about: `Ramose.claims(auth, input, policy)` (mint payload builder, `Auth.ts:108`), `Ramose.Policy.claims.sub` (claim operand, `Policy.ts:147`), `Ramose.Policy.Claims` (Schema of the verified JWT, `Policy.ts:105`), and `type Claims` on `/db` (decoded-but-unverified payload, `token.ts:26`). Four different things.

### 1.3 Getting started (what actually runs)

```sh
bun run dev:todos
```
= `CI=1 ALCHEMY_STATE=local CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=x bun alchemy dev examples/todos/alchemy.run.ts` (`package.json:19`) — peer on **:1337**, Vite UI on :5173 (`examples/todos/README.md:9-22`; `Command.Dev` resource `examples/todos/alchemy.run.ts:48-57`). ⚠️ `examples/todos/src/db.ts:17` still defaults `VITE_RAMOSE_URL` to `http://localhost:8787` (stale; the site and README say 1337, which is Alchemy's dev default). Reef pins ports in `examples/reef/src/domain/shared.ts:37-39` (`DEV_PEER_PORT = 1337`, `DEV_API_PORT = 1338`, UI `http://localhost:5173`).

---

## 2. Schema definition

### 2.1 Constructors

```ts
export const Attr: {
  <S extends Schema.Top>(schema: S): Attribute<S, "one", undefined, InferDbValueType<S>>;
  <S extends Schema.Top, const O extends AttributeOptions>(schema: S, options: O): Attribute<S, CardOf<O>, UniqueOf<O>, ValueTypeOf<S, O>>;
}
```
— `packages/alchemy/src/db/Attribute.ts:65-72`

```ts
export interface AttributeOptions {
  readonly cardinality?: Cardinality;      // "one" | "many"
  readonly unique?: Uniqueness;            // "identity" | "value"
  readonly index?: boolean;
  readonly isComponent?: boolean;
  readonly doc?: string;
  /** Override `:db.type/*` inference. Required for custom Schemas. */
  readonly valueType?: DbValueType;
}
```
— `Attribute.ts:13-21`. Defaults (`:76-81`): cardinality `"one"`, `index: options?.index ?? options?.unique !== undefined`, `isComponent false`.

```ts
export const Namespace = <const Name extends string, Attrs extends AttributeMap>(name: Name, attributes: Attrs): Namespace<Name, Attrs>
```
— `Namespace.ts:351-357`. Result has `_tag: "Namespace"`, `ns`, `attributes` (stamped map), `id` (the `:db/id` pseudo-attribute, `:151-159`, `:359-370`), and every attribute spread on it — so `User.name` **is** the attr ref, `ident: ":user/name"`, `attrName: "name"`.

```ts
export const Catalog = <const Ns extends NamespaceMap>(namespaces: Ns): Catalog<Ns>
```
— `Catalog.ts:16-21`. `Catalog.Any` is the bound for generics (`:23-26`). The catalog key (`{ todo: Todo }`) is what policy `ns: { todo: … }` is keyed by; the ident prefix comes from `Namespace("todo", …)`.

### 2.2 Value types (`valueTypes.ts`)

Eight `:db.type/*` idents (`:6-14`): string, long, double, boolean, ref, uuid, instant, bytes. Inference (`:170-187`): helper brand wins; else `Schema.String`→string, `Schema.Number`→**double**, `Schema.Boolean`→boolean; anything else → must pass `valueType` or `install()` throws `ramose/schema: cannot infer :db.type/*` (`:194-203`, thrown synchronously from `db.install()` via `ensure.ts:21`).

| helper | schema | lowers to | source |
|---|---|---|---|
| `Ramose.Instant` | `Schema.Date` | `:db.type/instant` | `:157-161` |
| `Ramose.Long` | `Schema.Number` | `:db.type/long` | `:150-154` |
| `Ramose.Bytes` | `Schema.Uint8Array` | `:db.type/bytes` | `:164-168` |
| `Ramose.Uuid` | `Schema.Struct({ vt: Literal(6), v: String })` — ⚠️ **not** a string, not bytes | `:db.type/uuid` | `:52-60` |
| `Ramose.UuidString` | `Schema.String` (canonical uuid string) | `:db.type/uuid` | `:62-67` |
| `Ramose.Ref` (bare) | `Schema.Number` (eid), untargeted, legacy | `:db.type/ref` | `:69-73, 102-125` |
| `Ramose.Ref(() => User)` | targeted → enables `Todo.owner.name` navigation & `.reverse` | `:db.type/ref` | `:88-91` |
| `Ramose.Ref.self` | self-reference (depth budget 6 hops) | `:db.type/ref` | `:92-93, 117-123` |

`Todo.id` is a real pseudo-attribute (`ident ":db/id"`, `valueType ":db.type/ref"`, typed as `number`) usable in `where`/`select`/`orderBy` (`Namespace.ts:146-159`).

### 2.3 Real catalogs (verbatim)

`examples/todos/schema.ts:1-10` (whole file):
```ts
import * as Ramose from "@ramose/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant),
});

export const Todos = Ramose.Catalog({ todo: Todo });
```
Reef (`examples/reef/src/domain/schema.ts:14-60`): `User.sub` `Attr(Schema.String, { unique: "identity", doc })`, `Issue.priority: Attr(Ramose.Long)`, `Issue.rank: Attr(Schema.Number)`, `Issue.creator: Attr(Ramose.Ref(() => User))`, `Issue.labels: Attr(Ramose.Ref(() => Label), { cardinality: "many" })`.

---

## 3. Client

### 3.1 Getting a `db`

```ts
export interface ClientOptions {
  /** Peer base URL (trailing slashes are trimmed). */
  readonly url: string;
  readonly token?: | Effect.Effect<Redacted.Redacted<string>, DbError> | TokenSource | undefined;
  /** Injection seam — defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Injection seam — defaults to the ambient `WebSocket`. */
  readonly webSocket?: typeof WebSocket | undefined;
}
```
— `Databases.ts:65-82` (comment lines elided).

```ts
export interface Client {
  db<C extends AnyCatalog>(name: string, catalog: C): Db<C>;   // pure: no network, no ensure, no socket
  close(): Promise<void>;                                       // idempotent; after close reads FAIL (no POST fallback)
}
export const connect = (options: ClientOptions): Client
```
— `Databases.ts:410-419, 430-442`. ✅ `connect` throws **synchronously** on a malformed URL / no `fetch` (defect, not `DbError`).

Effect-native twin: `export const layer = (options: ClientOptions): Layer.Layer<Databases>` (`:394-402`, scoped — finalizer closes sockets) and `class Databases extends Context.Service<Databases, DatabasesShape>()("Ramose.Databases")` (`:61-63`), `DatabasesShape = { db<C>(name, catalog): Db<C> }` (`:49-51`). Usage: `ManagedRuntime.make(layer({ url, token, fetch?, webSocket? }))` then `runtime.runSync(Databases)` (`packages/alchemy/test/peer.ts:230-238`).

Browser client, verbatim (`examples/todos/src/db.ts:11-22`):
```ts
import * as Ramose from "@ramose/alchemy/db";
import { Todos } from "../schema.ts";

const token = import.meta.env.VITE_RAMOSE_TOKEN;

const ramose = Ramose.connect({
  url: import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:8787",
  // an open peer has no token: pass nothing rather than an empty credential
  token: token ? Ramose.token.static(token) : undefined,
});

export const db = ramose.db("todos", Todos);
```

Name rule: `ramose.db(name, …)` with a name failing `DATABASE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` (`DatabaseName.ts:17`) never reaches the peer — every op fails `InvalidRequest` (`Db.ts:562-565`). Exported: `Ramose.DATABASE_NAME_RE`, `Ramose.isDatabaseName(name)` (`db/index.ts:61`). No slugify.

### 3.2 Token sources (`token.ts`)

```ts
export const token: {
  readonly jwt: (mint: () => Promise<Minted>, options?: { readonly refreshMargin?: Duration.Input }) => TokenSource;
  readonly static: (value: string) => TokenSource;
} = { jwt, static: staticSource };
```
— `:231-245`. `Minted = string | { readonly token: string }` (`:126`) — a mint route's `{ token, class, exp }` passes through. `TokenSource = { token: Effect<Redacted<string>, DbError>; claims(): Promise<Claims>; invalidate(): void }` (`:41-53`). Semantics: mint lazily on first read, single-flight, re-mint within `refreshMargin` (default **2 minutes**) of `exp`; lifetime ≤ margin → re-mint at half-life; no `exp` → static until `invalidate()` (`:131-212`). The credential is re-read on every (re)connect and every `/transact` (`Databases.ts:69-73, 327-328`). A thrown `DbError` (e.g. `Unauthorized`) from `mint` passes through; anything else wraps as `NetworkError` (retried as transient) (`:103-112`). `Claims` (`:26-38`) is decoded, **not verified** — UI hints only.

### 3.3 The `Db` surface

```ts
export interface ReadDb<C extends AnyCatalog = AnyCatalog> {
  readonly name: string;
  readonly catalog: C;
  q<R>(input: QueryInput<R>): Effect.Effect<QueryRows<C, R>, DbError>;
  live<R>(input: QueryInput<R>): Stream.Stream<QueryRows<C, R>, DbError>;
  pull<const P>(subject: Eid<C> | LookupRef<C>, pattern: PullPattern<C, P>): Effect.Effect<Pull<C, P> | null, DbError>;
  livePull<const P>(subject: Eid<C> | LookupRef<C>, pattern: PullPattern<C, P>): Stream.Stream<Pull<C, P> | null, DbError>;
  basis(): Effect.Effect<{ readonly t: number }, DbError>;
  asOf(t: number): ReadDb<C>;
  readonly history: ReadDb<C>;
}
export interface Db<C extends AnyCatalog = AnyCatalog> extends ReadDb<C> {
  principal(): Effect.Effect<DbPrincipal<C>, DbError>;
  transact<Eff extends Effect.Effect<any, any, any>, A = unknown>(body: (tx: Tx<C>) => Generator<Eff, A, never>): Effect.Effect<TxReport<C>, DbError | YieldError<Eff>, YieldContext<Eff>>;
  install(): Effect.Effect<TxReport<C>, DbError>;
}
```
— `Db.ts:116-188` (doc comments elided). `QueryInput<R> = NavQuery<R> | NavQueryBuilder<AnyNamespace, R>` (`:49`). `Eid<C> = { readonly id: number }` (`Eid.ts:12-16`) — a plain object usable as a React key.

```ts
export interface TxReport<C extends AnyCatalog = AnyCatalog> {
  readonly t: number;
  readonly txEid: Eid<C>;
  readonly datomCount: number;
  /** The same db, floored at `t` — no second round trip and no `sync`. */
  readonly dbAfter: Db<C>;
}
export interface DbPrincipal<C extends AnyCatalog = AnyCatalog> {
  readonly eid: Eid<C> | null;
  readonly class: string;
}
```
— `Db.ts:103-109, 97-100`. ⚠️ **No `tempids` on `TxReport`** (the wire has them; the client drops them). To learn a fresh entity's id, query for it (`examples/reef/src/app/mutations.ts:64-73` `ensureSelf`).

`db.principal()`: `eid` is `null` until the policy's principal attribute has a row for this `sub`; `class` is `"admin"` on a peer with no policy (`Db.ts:92-96`); a `null` is never cached (`Databases.ts:251-310`).

`db.basis()`: one `GET /db/:name/info` on a live view; `asOf(t)` answers `t` with no I/O; observing a newer basis bumps the session so standing `live`s re-run (`Db.ts:498-517`).

Every `Db` method has `R = never` → `Effect.runPromise(db.q(q))` works directly (`Databases.ts:404-408`). There is **no Promise-flavoured `db`** — only `Client.close()` returns a Promise; React hooks and `useTransact().run` do the running for you.

### 3.4 Transact

```ts
export interface Tx<C extends AnyCatalog = AnyCatalog> {
  readonly catalog: C;
  readonly spec: TxSpec;
  entity(): Effect.Effect<Entity<C>>;
  entity(id: TxEntity<C>): Effect.Effect<Entity<C>>;
  add<const A extends TxAttr<C>>(e: TxEntity<C>, attr: A, value: TxValue<C, A>): Effect.Effect<void>;
  retract<const A extends TxAttr<C>>(e: TxEntity<C>, attr: A, value?: TxValue<C, A>): Effect.Effect<void>;
  retractEntity(e: TxEntity<C>): Effect.Effect<void>;
}
export interface Entity<C extends AnyCatalog = AnyCatalog> {
  readonly _tag: "Entity";
  readonly eid: EntityRef<C>;
  add<const A extends TxAttr<C>>(attr: A, value: TxValue<C, A>): Effect.Effect<void>;
  retract<const A extends TxAttr<C>>(attr: A, value?: TxValue<C, A>): Effect.Effect<void>;
  retractEntity(): Effect.Effect<void>;
}
```
— `Tx.ts:97-123, 72-88`. `TxAttr` = attr ref (`User.name`) **or** ident string (`":user/name"`) (`:19-21`); unknown idents are type errors. `TxEntity` = `number | tempid string | LookupRef | Entity handle | [User.name, "Ada"]` (`:49-52`, `idents.ts:65-74`). Ops lowered: `[":db/add", e, ident, v]`, `[":db/retract", e, ident(, v)]`, `[":db/retractEntity", e]` (`:56-60`); tempids are `tmp-1`, `tmp-2`… (`:211-218`).

Rules: cardinality-many is **one `add` per value** (`:109`); card-one `add` implicitly retracts the old value (engine); `retract(attr)` without value retracts whatever is there; the generator's yielded Effects compose as in `Effect.gen` — a failure aborts before anything is sent (`Db.ts:174-177, 604-614`); the whole body is one atomic tx. ⚠️ **No `preset` / `upsert` / map-form on the client tx builder** — presets are a *policy* feature the peer applies (§6). ⚠️ `TxValue` for a `Ref` attribute is `number`; passing another handle's tempid (`other.eid`, a string) is a **type error** even though the engine resolves tempid strings for ref attrs (`core/src/tx.ts:296-300`) — untested through the client; document ref writes with known eids (`issue.add(Issue.creator, myEid)`, `mutations.ts:100`).

Verbatim (`examples/todos/src/todos.ts:33-49`):
```ts
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
Read-your-write (`examples/kv-style/app.ts:95-105`): `const report = yield* db.transact(…); const rows = yield* report.dbAfter.q(Ramose.query(User).select({ name: User.name }));`.

`db.install()` = one tx of map forms `{ ":db/ident", ":db/valueType", ":db/cardinality", ":db/unique"?, ":db/index"?, ":db/isComponent"?, ":db/doc"? }` per attribute (`ensure.ts:7-52`); idempotent (`:db/ident` upserts). Under a policy, schema txs are admin-only; a non-admin `install()` whose idents are all already deployed is silently skipped as `{ t, txEid: 0, datoms: 0 }` (`worker/src/auth.ts:322-328`, `index.ts:210-211`).

### 3.5 Query builder (`NavQuery.ts`)

```ts
export const query = <N extends AnyNamespace>(ns: N): NavQueryBuilder<N>
export interface NavQueryBuilder<N extends AnyNamespace, R = readonly Eid[]> {
  readonly ns: N;
  readonly spec: NavQuerySpec;
  where(...preds: WhereNode[]): NavQueryBuilder<N, R>;
  select<const S extends Shape>(shape: S & ValidShape<S>): NavQueryBuilder<N, readonly SelectResult<S>[]>;
  orderBy<K extends PathCarrier>(attr: K & ValidOrderKey<K, never>, dir?: OrderDir, opts?: { readonly empty?: OrderEmpty }): NavQueryBuilder<N, R>;
  limit(n: number): NavQueryBuilder<N, R>;
  offset(n: number): NavQueryBuilder<N, R>;
  build(): NavQuery<R>;
}
```
— `:1415-1429, 1298-1329`. `OrderDir = "asc" | "desc"` (default asc), `OrderEmpty = "first" | "last"` (default `"last"`) (`:253-254, 1385-1400`). `db.q`/`db.live` accept the builder directly (no `.build()` needed, `:1431-1435`). Row types: `Ramose.Row<typeof q>` / `Ramose.Rows<typeof q>` (`:1344-1357`); a query with no `.select` yields `readonly Eid<C>[]` (`{ id }` objects, `:1867-1870`).

Predicates stamped on **every** attr (`:441-505`):
```ts
  eq ne lt lte gt gte : (value: AttrValue<A>) => Predicate
  in: (values: readonly InValue<A>[]) => Predicate      // refs/`:db/id` take eids or { id }
  startsWith endsWith includes: (s: string) => Predicate
  matches: (re: RegExp | string) => Predicate           // ⚠️ flagged RegExp throws (peer compiles with no flags) :512-524
  exists(): Predicate   missing(): Predicate
  is: (ref: EidLike) => Predicate                        // ref attrs only (incl. Todo.id)
  each                                                   // card-many only: element cursor (User.tags.each.startsWith("a"))
  some / every / none: (pred) => Quantified              // card-many only (refs, backlinks AND many scalars via .each)
  where(...preds) / orderBy(key, dir?, {empty}) / limit(n) / offset(n)   // card-many only: per-element constraints INSIDE the pull (CollectionNav :692-710)
  optional                                               // select-field wrapper → T | undefined
  select(shape)                                          // ref attrs only → nested shape (SelectNested :1036-1046)
```
Wire names (`:737-750`): `eq/is → "="`, `ne → "!="`, `startsWith → "starts-with?"`, `endsWith → "ends-with?"`, `includes → "includes?"`, `matches → "re-find?"`.

Combinators: `Ramose.or(...preds)` (or-join, nestable, `or()` matches nothing) and `Ramose.not(pred)` (not-join) (`:140-158`).

Paths: `Todo.owner.name` (hop through a targeted ref), `Todo.owner.reverse` (backlink; always cardinality-many; ⚠️ throws on `isComponent` refs, `Namespace.ts:220-224`), `Todo.owner.reverse.title`. Predicates on a many hop are existential.

Rules enforced at build time: `orderBy` across a cardinality-many hop **throws** (`:1391-1395`); `orderBy(attr.each)` throws (`:1388-1390`); a select field must be a **direct** attribute of the queried namespace or a nested `ref.select({…})` — `{ ownerName: Todo.owner.name }` is a **type error and runtime error** (`:1305-1310`, `ValidShape :245-251`); constraints on a card-one ref select are rejected; `.each` outside its own collection's quantifiers/constraints is rejected (`:230-243`).

Everything is lowered to the peer (server-side): `where`, `orderBy`, `limit`, `offset`, required select fields become `where` clauses so `limit(20)` really is 20 rows; nested collection constraints run inside the pull after the outer slice (`:1-13`, `Pull.ts:13-27`). Client only reshapes (`finalizeNavResult :1857-1871`).

Verbatim (`examples/todos/src/todos.ts:10-23`, `examples/reef/src/domain/queries.ts:24-34, 66-82`):
```ts
export const todoQuery = Ramose.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select(todoShape);
export type TodoRow = Ramose.Row<typeof todoQuery>;
```
```ts
export const boardShape = {
  id: Issue.id,
  title: Issue.title,
  status: Issue.status,
  priority: Issue.priority,
  rank: Issue.rank,
  createdAt: Issue.createdAt,
  creator: Issue.creator.select(personShape),
  assignee: Issue.assignee.select(personShape).optional,
  labels: Issue.labels.select(labelShape),
} as const;
export const commentsQuery = (issueId: number) =>
  Ramose.query(Comment)
    .where(Comment.issue.eq(issueId))
    .orderBy(Comment.at, "asc")
    .select(commentShape);
```

**Not shipped** (`docs/QUERY.md:449-461`, authoritative): aggregates (`count sum avg min max countDistinct having`), `groupBy`, `.one()/.oneOrFail()`, cursors `.after`, `Ramose.params` / `Ramose.when`, `.expand`, `.orDefault`, `Ramose.all(N)`, graph `.traverse/.paths/reaches`, `db.changes`, `Ramose.explain`, typed datalog escape hatch, rules, full-text search, cross-database joins (a query is scoped to one namespace of one db). The string-var callback query builder is **retired** (#30).

### 3.6 Pull

`db.pull(subject, pattern)` — subject is `Eid<C>` (`{ id }`) or a lookup ref `[User.name, "Ada"]` / `[":user/name", "Ada"]` (`Db.ts:306-318`; ⚠️ a bare number is a type error). Pattern is the same shape grammar as `.select` (`{ title: Todo.title, owner: Todo.owner.select({...}).optional, tags: Todo.tags }`) or the ident-array escape `[":todo/title", "*"]` (`Pull.ts:168-171, 268-275`). Result: `Pull<C, P> | null` — `null` when the entity is missing **or a required (non-`.optional`) field is missing** (`Db.ts:132`). Unknown attribute in a pattern → `InvalidRequest` from the peer (`worker/src/index.ts:293-297`). `Ramose.Pull<typeof Todos, typeof shape>` names the result type. `db.livePull` = standing pull; a retracted entity emits `null` and keeps standing (`Db.ts:138-148`).

### 3.7 Live

`db.live(q): Stream<Rows, DbError>` — re-runs on every basis tick the session sees and after a local `transact`; identical results (JSON digest) are not re-emitted; pinned views (`asOf`/`history`) emit once and complete (`Db.ts:120-130, 412-460`). ⚠️ **Requires the session WebSocket**: with no `WebSocket` (HTTPS-only client, e.g. `Ramose.ServerBinding` in a Worker) the stream **dies** (defect, not `DbError`) with `"ramose: db.live needs the session socket — pass \`webSocket\` to Ramose.connect or Ramose.layer (or run where a global WebSocket exists)"` (`:426-435`). Non-terminal failures retry with backoff 250 ms → 5 s (`:273-274`); terminal = `InvalidRequest | DatabaseNotFound | Unauthorized | QueryBudgetExceeded` (**four**, `:281-285`). Reads (`q`, `pull`) travel as frames on the session socket when it exists (`Databases.ts:186-216, 312-319`; frame ops `auth transact q pull entity info`, `worker/src/session.ts:8-16`); writes are always HTTPS `POST /db/:name/transact`. The peer polls the replica basis every 1 s per session — cross-isolate live updates work locally under miniflare (`examples/reef/README.md:38-41`; poll `worker/src/session.ts:105`).

### 3.8 Time travel

`db.asOf(t)` and `db.history` are pure `Db → ReadDb` (`Db.ts:519-524`); no `transact`/`install`/`principal` on them. `t` is a **transaction number** (`report.t`, `db.basis()`), not a `Date`; `db.asOf(date)` is roadmap (`docs/QUERY.md:492`). ⚠️ Retention vs `asOf`: see §8.

### 3.9 Errors and HTTP mapping (`Errors.ts`)

Eight `Data.TaggedError`s (`:22-89`): `TxRejected{message,code}` (409), `Unavailable{message,retryAfterMs}` (503), `InvalidRequest{message}` (400), `DatabaseNotFound{message}` (404), `Unauthorized{message,code?,attr?}` (401/403; policy denials carry `code: "policy"` and the tripped `attr` ident), `QueryBudgetExceeded{message,code,clause,cells,limit}` (413), `InternalError{message}` (5xx), `NetworkError{message,cause?}` (no response). `type DbError` = union. Classification: DO `tag` field wins (`TxRejected|TransactorDead|QueryBudget|BadRequest|NotFound|Internal`), else status (`:133-218`); Cloudflare HTML 404 / 1xxx pages → `Unavailable` (transient). Transient retry: `Unavailable`/`NetworkError` retried **6 attempts**, jittered `min(2000, 150·2ⁿ)·(0.5+rand)` ms (`http.ts:83-113`). Handle with `Effect.catchTags({...})` — canonical block at `examples/kv-style/app.ts:128-143`. `errorMessage(e)` from `@ramose/react` = `message ?? _tag ?? String(e)`.

---

## 4. React (`@ramose/react`, `packages/react/src`)

Exports (`index.ts:18-25`): `RamoseProvider`, `RamoseProviderProps`, `useDb`, `useRamose`, `Live`, `useLive`, `Async`, `useQuery`, `usePull`, `useBasis`, `Transact`, `useTransact`, `errorMessage`. Nothing else (no context export, no UI).

```tsx
export interface RamoseProviderProps extends ClientOptions { readonly children?: ReactNode; }
export const RamoseProvider = (props: RamoseProviderProps)
```
— `RamoseProvider.tsx:33-37`. Owns one `Client` (`connect` in `useMemo` keyed on `[url, token, fetch, webSocket]`), closes on change/unmount, StrictMode-safe. **Rules** (`:5-13`): `token` must be a *stable* `TokenSource` (module scope or `useMemo`), never an Effect built inline; multi-tenant switch = React `key` (`<RamoseProvider key={slug} url={…} token={…}>`, `examples/reef/src/app/App.tsx:146-157`).

```ts
export const useRamose = (): Client                                             // hooks.ts:13 — throws outside a provider
export const useDb = <C extends Catalog.Any>(name: string, catalog: C): Db<C>   // hooks.ts:34 — memo on [client, name, catalog]
```
```ts
export interface Live<A, E = DbError> { readonly rows: A | undefined; readonly error: Cause.Cause<E> | undefined; readonly ticks: number; }
export function useLive<C extends Catalog.Any, R>(db: ReadDb<C>, query: QueryInput<R>): Live<R>;
export function useLive<A, E>(stream: Stream.Stream<A, E>): Live<A, E>;
```
— `useLive.ts:31-56`. Needs **no provider**. View is structural (`db.asOf(t)` inline is fine), `query` is identity (hoist to module scope) (`:5-15`). `error` = terminal failure only; completion of a pinned view is not an error and `rows` stays.
```ts
export interface Async<A, E = DbError> { readonly data: A | undefined; readonly error: Cause.Cause<E> | undefined; readonly loading: boolean; }
export const useQuery = <C extends Catalog.Any, R>(db: ReadDb<C>, query: QueryInput<R>): Async<R>
```
— `useQuery.ts:21-33`. Keeps previous `data` while loading; last-write-wins by issue order.
```ts
export const usePull = <C extends Catalog.Any, const P>(db: ReadDb<C>, subject: Eid<C> | LookupRef<C>, pattern: PullPattern<C, P>): Live<Pull<C, P> | null>
```
— `usePull.ts:48-52`. Subject and view structural (`{ id: 17 }` inline fine); `pattern` identity (hoist).
```ts
export const useBasis = <C extends Catalog.Any>(db: ReadDb<C>): number | undefined
```
— `useBasis.ts:15-17`. `db.basis()` on mount + on every session wake; `asOf(t)` view answers `t` synchronously; HTTPS-only client → one-shot.
```ts
export interface Transact {
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<Exit.Exit<A, E>>;
  readonly pending: boolean;
  readonly error: unknown | undefined;
  readonly clearError: () => void;
}
export const useTransact = (options?: { onError?: (error: unknown) => void }): Transact
```
— `useTransact.ts:16-30, 57-59`. Not tied to the provider — runs any `R = never` Effect (module-singleton `db` works, `examples/todos/src/App.tsx:28-41`).

Verbatim (`examples/todos/src/App.tsx:14-25`):
```tsx
const TodoList = () => {
  const { rows, error } = useLive(db, todoQuery);
  if (error !== undefined) return <p>offline…</p>;
  if (rows === undefined) return <p>loading…</p>;
  return (
    <ul>
      {rows.map((row) => (
        <TodoRowView key={row.id} row={row} />
      ))}
    </ul>
  );
};
```
⚠️ With `.select({ id: Todo.id, … })` the `id` field is a **`number`** → `key={row.id}`; `key={r.id.id}` (site `reference/react.md:69`) is wrong for selected rows (only a `.select`-less query yields `Eid` objects). Reef hook usage: `useDb(slug, Reef)`, `useLive(db, boardQuery)`, `useQuery(t === undefined ? db : db.asOf(t), boardQuery)`, `useQuery(db.history, everyIssueEverQuery)`, `useBasis(db)`, `usePull(db, { id: issueId }, issueExtraShape).rows` (`examples/reef/src/app/screens/BoardScreen.tsx:230-234, 448-454`, `components/IssueDetail.tsx:258`).

---

## 5. Policy (`Ramose.Policy`, `packages/alchemy/src/db/Policy.ts`)

```ts
export interface PolicySpec<C extends AnyCatalog, CF extends Schema.Struct.Fields = Schema.Struct.Fields> {
  /** attribute whose value is the JWT `sub` */
  readonly principal: AttrRef & { readonly ident: CatalogIdent<C> };
  readonly classes: readonly string[];
  /** shape of `ramose.attrs` */
  readonly claims?: Schema.Struct<CF>;
  readonly ns: { readonly [K in keyof C["namespaces"]]?: NsRuleSpec };
}
export type NsRuleSpec = RuleSpec & { readonly preset?: readonly Preset[]; readonly attrs?: readonly AttrRule[]; };
export type RuleSpec = { readonly [K in Op]?: Arm | readonly Arm[]; };   // Op = "read" | "add" | "retract" | "retractEntity" | "create"
```
— `:63-73, 58-61, 48-50`; ops from `@ramose/core/policy/ast.ts:8`; `MAX_REF_DEPTH = 3` (`ast.ts:5`).

Combinators (all `Ramose.Policy.*`): `policy(catalog, spec): Policy` (`:301-384`; throws `PolicyError` on unknown ident/class/ns key, empty or duplicate classes, principal not in catalog, over-deep refs); `compile(policy, { pulls?: readonly unknown[] }): string` (`:474-485`; round-trips through core `parsePolicy`); `checkPulls(policy, pulls)` (`:450-471`; a read-masked attribute pulled as **required** is a deploy-time error — opt-in via `compile(..., { pulls })`); `allow(expr)`, `deny(expr)` (`:222-223`); `eq(attr, value | operand)` (`:176-177`; card-many = membership); `ref(refAttr, expr | attr)` (`:200-211`); `class(c)` (`:214-215`; validated against `classes`); `and/or/not` (`:217-219`); `constant(bool)` (`:220`); `principal` operand (`:156`); `lit(v)` (`:159`); `claims.sub/iss/aud/exp/attrs.<key>` (`:147`); `claimsOf(struct)` typed attrs (`:150-153`); `preset(attr, operand)` (`:226-229`; operand must be `principal` or a claim, never a literal); `attr(a, rules)` (`:232-236`; only under its own namespace). Also `Policy.Claims` schema of the verified JWT (`:105-117`).

Semantics (verified in `worker/src/auth.ts`, `core/src/policy/*`): **deny by default** (a namespace/op with no arm denies); attribute rules **AND** with (narrow) the namespace rule; `admin` class bypasses every rule (`isAdmin` short-circuits in `viewDb`/`checkWrite`); reads are *filtered* (masked datoms vanish), never rejected; writes are checked at the edge against the replica basis (best-effort → `Unauthorized 403 { code: "policy", attr }`, `auth.ts:334`) **and** authoritatively by the transactor before `t` is assigned (→ `TxRejected` 409); `create` = first `add` on a new entity; `preset` attrs are set by the peer on create — a client value identical to the preset is a no-op, a different one is `Unauthorized`; history/asOf reads are filtered by the **current** rules (`auth.ts:277-290`); an `anonymous` class, if declared, admits token-less callers (`auth.ts:35, 169`).

Verbatim (`examples/reef/src/domain/policy.ts:24-77`):
```ts
const P = Ramose.Policy;

const anyone = P.or(P.class("admin"), P.class("member"), P.class("viewer"));
const editor = P.or(P.class("admin"), P.class("member"));
const admin = P.class("admin");

/** `member` may touch an issue they created; `admin` never reaches the rules. */
const ownIssue = P.and(P.class("member"), P.eq(Issue.creator, P.principal));
const ownComment = P.and(P.class("member"), P.eq(Comment.author, P.principal));

export const policy = P.policy(Reef, {
  principal: User.sub,
  classes: CLASSES,
  ns: {
    user: {
      read: P.allow(anyone),
      create: P.allow(editor),
      preset: [P.preset(User.sub, P.claims.sub)],
    },
    label: { read: P.allow(anyone), create: P.allow(editor) },
    issue: {
      read: P.allow(anyone),
      create: P.allow(editor),
      add: P.allow(ownIssue),
      retract: P.allow(ownIssue),
      retractEntity: P.allow(ownIssue),
      preset: [P.preset(Issue.creator, P.principal)],
      attrs: [ P.attr(Issue.privateNote, { read: P.allow(admin) }) ],
    },
    comment: {
      read: P.allow(anyone),
      create: P.allow(editor),
      retract: P.allow(ownComment),
      retractEntity: P.allow(ownComment),
      preset: [P.preset(Comment.author, P.principal)],
    },
  },
});

export const compiledPolicy = (): string => P.compile(policy, { pulls: allShapes });
```
(`label` block collapsed to one line here; otherwise verbatim.)

---

## 6. Auth

### 6.1 Peer modes (selected by env, `worker/src/auth.ts:1-10, 159-172`)

| `RAMOSE_POLICY` | `RAMOSE_TOKEN` | behaviour |
|---|---|---|
| unset | unset | **open**: every caller is class `admin` |
| unset | set | shared bearer: match → `admin`; else 401 |
| set | any | **JWT only**; verification mandatory (missing JWKS/iss/aud → deny every `/db/*`, logged once — fails closed); `RAMOSE_TOKEN` holder becomes class `$token` which no rule can name (reaches only the no-op `ensure` case of `/transact`) |

`/health` needs no principal at all (`index.ts:383-386`). The demo console at `/` is a 404 once a policy is configured (`index.ts:378-382`).

### 6.2 JWT the peer verifies (`auth.ts:178-224`)

Algorithms pinned `["RS256","ES256","EdDSA"]` (`:29`); `iss` ∈ `RAMOSE_JWT_ISS` (comma list), `aud` = `RAMOSE_JWT_AUD`, `exp` required, `exp - iat ≤ RAMOSE_JWT_MAX_TTL` (default **900** s), `sub` non-empty, `ramose: { db: string, class: string, attrs?: object }` required, `ramose.class` must be declared by the policy, `ramose.db` must equal the path's db name (else 401 "token is not valid for this database", `auth.ts:221`, `index.ts:225`). Verified principals memoised 60 s per isolate (`:33`). Keys from `RAMOSE_JWKS_URL` (remote JWKS) or `RAMOSE_JWKS_JSON` (literal JWK set, offline/test seam, `:73-76`). Token carried as `Authorization: Bearer …` or `?token=` (WebSocket upgrade, `:134-150`).

```ts
export interface MintedClaims {
  readonly iss: string; readonly aud: string; readonly sub: string;
  readonly iat: number; readonly exp: number;
  readonly ramose: { readonly db: string; readonly class: string; readonly attrs?: Readonly<Record<string, unknown>>; };
}
export interface AuthConfig { readonly issuer: string; readonly audience: string; readonly ttl: number; }
export const claims = (auth: AuthConfig, input: ClaimsInput, policy?: CompiledPolicy | string): MintedClaims
```
— `Auth.ts:57-68, 24-35, 108-142`. `ClaimsInput = { sub, db, class, attrs?, now? }` (`:38-49`). Pure — no signing; validates `db` name and (given a policy) that `class` is declared; `exp = iat + ttl`.

### 6.3 `@ramose/better-auth`

```ts
export interface RamoseTokenOptions {
  readonly auth: AuthConfig;
  readonly classOf: ClassOf;
  readonly policy?: CompiledPolicy | string;
  readonly path?: string;          // @default "/ramose/token"
}
export const ramoseToken = (options: RamoseTokenOptions)   // BetterAuthPlugin, id "ramose-token"
export type ClassOf = (input: ClassOfInput) => string | ClassGrant | null | Promise<string | ClassGrant | null>;
export const classOfRole = (role: string): "admin" | "member" | "viewer"   // owner|admin→admin, member→member, else viewer
export const orgClassOf = (options?: { readonly map?: (role: string) => string | null }): ClassOf
```
— `packages/better-auth/src/index.ts:82-111, 78-80, 224-268`. Route: `POST {basePath}/ramose/token { db }` with a session cookie → `{ token, class, exp }`; `classOf` returning `null` → 403 (one answer for "no such org" and "not a member"); no session → 401; invalid db name → 400. **Requires Better Auth's `jwt` plugin** (checked at init; signs with the same JWKS the peer's `RAMOSE_JWKS_URL` reads).

```ts
export const ramoseTokenClient = (options?: { readonly path?: string })   // BetterAuthClientPlugin
// adds authClient.ramose.token({ db }): Promise<{ token, class, exp }>; 401/403 → throws Ramose `Unauthorized`
```
— `packages/better-auth/src/client.ts:44-72`.

Verbatim wiring (`examples/reef/src/infra/api.ts:99-115`, `src/app/auth.ts:12-18`, `src/app/ramose.ts:38-40`):
```ts
        jwt({ jwt: { issuer: REEF_AUTH.issuer, audience: REEF_AUTH.audience, expirationTime: `${REEF_AUTH.ttl}s` } }),
        ramoseToken({ auth: REEF_AUTH, policy: compiledPolicy(), classOf: orgClassOf() }),
```
```ts
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}${AUTH_BASE_PATH}`,
  plugins: [organizationClient({ ac, roles }), ramoseTokenClient()],
});
```
```ts
  const token = Ramose.token.jwt(() => authClient.ramose.token({ db: slug }));
  const cls = ((await token.claims()).ramose?.class ?? "viewer") as RamoseClass;
  const ramose = Ramose.connect({ url: RAMOSE_URL, token });
```
`REEF_AUTH = { issuer: "reef-demo-auth", audience: "ramose:reef", ttl: 900 }` (`shared.ts:27-31`).

### 6.4 Env keys (`Server.ts:148-160`, `transactor/src/env.ts:4-52`)

```ts
export const AUTH_ENV_KEYS = {
  policy: "RAMOSE_POLICY", jwksUrl: "RAMOSE_JWKS_URL", issuers: "RAMOSE_JWT_ISS", aud: "RAMOSE_JWT_AUD",
  maxTtl: "RAMOSE_JWT_MAX_TTL", allowedOrigins: "RAMOSE_ALLOWED_ORIGINS", internalSecret: "RAMOSE_INTERNAL_SECRET",
} as const;
export const DEFAULT_JWT_MAX_TTL = 900;
```
Plus `RAMOSE_TOKEN`, `RAMOSE_JWKS_JSON` (offline JWKS), `RAMOSE_STAGE`, `RAMOSE_LOG_LEVEL` (`debug|info|warn|error`, default info), `RAMOSE_QUERY_MAX_CELLS` (default `48 * 32768 = 1,572,864` cells ≈ 48 MB, `core/src/query/engine.ts:58-59`), tuning `RAMOSE_INDEX_INTERVAL_MS RAMOSE_INDEX_TX_THRESHOLD RAMOSE_INDEX_MAX_TXS_PER_RUN RAMOSE_LOG_KEEP_TXS RAMOSE_GC_EVERY_N_INDEXES RAMOSE_RETAIN_ROOTS RAMOSE_MAX_BATCH RAMOSE_TIMING_YIELDS`, read-path `RAMOSE_REPLICA_HINT RAMOSE_CACHE_BASIS RAMOSE_CACHE_MODE`. ⚠️ `RAMOSE_ALLOWED_ORIGINS` is only honoured **once a policy is configured**; without one CORS is `*` (`auth.ts:346-352`). `RAMOSE_INTERNAL_SECRET`: Worker→DO gate; `authEnv` mints one whenever `policy` is set (`Server.ts:236-243`).

Local dev / no-auth: leave `RAMOSE_POLICY` and `RAMOSE_TOKEN` unset → open peer, class `admin`, no token needed (todos example). There is **no dev-token minter CLI**; for a policy-armed local peer use Better Auth (reef) or `RAMOSE_JWKS_JSON` + your own signer.

---

## 7. Deploy / Alchemy (`packages/alchemy/src`)

Resources (both `Resource<…, never, Providers>`; register with `Ramose.providers()`):

```ts
export type ServerProps = {
  worker: ServerWorker;                 // Cloudflare.Worker declaration | { url, workerName? } | bare URL string
  url?: string;                         // override (custom domain)
  token?: Redacted.Redacted<string> | string;   // the peer's RAMOSE_TOKEN, if deployed with one
  auth?: PeerAuth;                      // deploy-time fail-closed consistency check only (does NOT set the Worker's env)
  probe?: ServerProbe | false;          // GET /health with retries: attempts 30, delayMs 2000; false skips
};
export type Server = Resource<"Ramose.Server", ServerProps, { url: string; workerName: string; token: Redacted.Redacted<string> | undefined }, never, Providers>;
```
— `Server.ts:127-145, 269-282, 85-90, 375-376`. Reconcile resolves the URL and probes `/health` (live provider only); `delete` is a **no-op** (`:420-425`).

```ts
export type DatabaseProps = { server: Server; catalog: Catalog.Any; name?: string; };   // name defaults to the logical id
export type Database = Resource<"Ramose.Database", DatabaseProps, { name: string; server: string; t: number }, never, Providers>;
```
— `Database.ts:48-70`. Reconcile = `db.install()` over HTTPS with the server's `url`/`token` (`:133-153`); `delete` is a **no-op** (`:171-175`).

```ts
export interface PeerAuth {
  readonly policy?: string; readonly jwksUrl?: string; readonly issuers?: readonly string[] | string; readonly aud?: string;
  readonly maxTtl?: number; readonly auth?: AuthConfig; readonly allowedOrigins?: readonly string[] | string;
  readonly internalSecret?: Redacted.Redacted<string> | string;
}
export const authEnv = (peerAuth: PeerAuth | undefined): Record<string, string | Redacted.Redacted<string>>
export const internalSecret = (value?: Redacted.Redacted<string> | string): Redacted.Redacted<string>
```
— `Server.ts:102-124, 220-245, 190-201`. Spread `...Ramose.authEnv({...})` into the peer Worker's `env`; `auth: AuthConfig` stands in for `issuers/aud/maxTtl`.

Capabilities & transports:
```ts
export const ReadWriteDatabases = Binding.Service<ReadWriteDatabases>("Ramose.ReadWriteDatabases");  // (server: Server) => Effect<DatabasesShape>
export const ReadDatabases = Binding.Service<ReadDatabases>("Ramose.ReadDatabases");                 // (server) => Effect<ReadDatabasesShape> — db() is ReadDb: no transact/install/principal
export const ServerBinding: Layer.Layer<ReadWriteDatabases | ReadDatabases, never, WorkerEnvironment>  // service binding; synthetic origin https://ramose.internal; NO live (no socket)
export const ServerHttp: Layer.Layer<ReadWriteDatabases | ReadDatabases>                              // public URL over global fetch
export const providers = () => Layer<Providers>
```
— `ReadWriteDatabases.ts:28-30`, `ReadDatabases.ts:27-29`, `ServerBinding.ts:35, 129-142`, `ServerHttp.ts:58-68`, `Providers.ts:28-32`. `ServerBinding` requires the server's `worker` to be a `Cloudflare.Worker` (bare-URL server → die with a message, `ServerBinding.ts:55-61`).

Worker usage verbatim (`examples/kv-style/app.ts:28-33, 146`): `Cloudflare.Worker("App", { main: import.meta.url }, Effect.gen(function* () { const ramose = yield* Ramose.ReadWriteDatabases(Server); … }).pipe(Effect.provide(Ramose.ServerBinding)))`.

Stack (`examples/todos/alchemy.run.ts:59-77`):
```ts
export default Alchemy.Stack(
  "ripple-todos",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Ramose.providers(), Command.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    yield* TodosDb;
    const ui = yield* Ui;
    return { peerUrl: server.url, uiUrl: ui.url };
  }),
);
```
Root stack uses `state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state()` (`alchemy.run.ts:130`).

Bindings the peer Worker needs (fixed names, `transactor/src/env.ts:5-9`): `STORE` (R2 bucket), `TRANSACTOR` (DO class `TransactorDO`), `REPLICA` (DO class `QueryReplicaDO`), optional `ANALYTICS` (Analytics Engine dataset). Both DO classes are re-exported from the peer script (`worker/src/index.ts:46`, single-script). Compatibility flag `nodejs_compat` required.

Commands (repo): `bun alchemy dev <stack>` (miniflare; peer :1337 by default), `bun alchemy deploy <stack> [--stage prod]`, `bun alchemy destroy` (`package.json:19-26`). ⚠️ `npx alchemy …` (site/README) is plausible (`alchemy` has a `bin`) but unexercised. ⚠️ **`alchemy destroy` is destructive** for the stack's `Cloudflare.R2.Bucket` and `DurableObject` resources (alchemy 2.0.0-beta.72 empties+deletes the bucket, deletes DO classes); only the `Ramose.*` resources are no-ops. Local emulator: placeholder `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` + `CI=1 ALCHEMY_STATE=local` (`package.json:19`, `examples/*/README.md`).

---

## 8. Runtime facts writers may cite

- **Single writer per database**: `env.TRANSACTOR.idFromName(db)` (`worker/src/index.ts:221`); group commit; persist-before-ack; dense monotonic `t`; a `TxRejected` consumes no `t` (`transactor/src/transactor.ts` — authorize before commit).
- **"A database is a name"**: no create/list endpoint; first tx materialises it; R2 keys under `db/<name>/` (`storage/src/index.ts:40`): `seg/<hash>` (leaves), `n/<hash>` (dir nodes), `log/<t0>-<t1>` (immutable tx-log chunks), `roots/<t>` (immutable), `root/current` (the one mutable key) (`:8-11`).
- **Indexer/GC defaults** (`transactor/src/host.ts:55-64`): `indexTxThreshold 500`, `indexIntervalMs 5_000`, `indexMaxTxsPerRun 5_000`, `logKeepTxs 20_000`, `gcEveryNIndexes 50`, `retainRoots 20`, `maxBatch 0` (unbounded). Env overrides `RAMOSE_*` (`transactor-do.ts:27-33`).
- ⚠️ **Retention vs `asOf` — the code disagrees with the site and `docs/RUNBOOK.md`.** `asOf(t)` never reads an old root: `dbFromBasis` opens the *current* root + novelty and `Db.asOf(t)` filters `d.t <= t` (`replica/src/basis.ts:44-63`, `core/src/db.ts:88-89`); trees keep every datom, asserts and retracts (`core/src/tree.ts:20-22`); `gcSweep` deletes only `seg/`/`n/` objects unreachable from retained roots + current — i.e. superseded tree versions no reader addresses (`storage/src/index.ts:374-410`). So `RAMOSE_RETAIN_ROOTS` bounds **bucket size**, not how far back `asOf` reaches; there is no excision/pruning of history anywhere. The site (`before-production.md:43-52`, `time-travel.md:84-92`, `for-datomic-users.md:38-41`, `configuration.md:36`, `runbook.md:67-68`, `architecture.md:60-61`), `docs/RUNBOOK.md:71,87` and the old shipped-api §7 all say GC deletes old history. **Get a maintainer ruling before writing either sentence; do not write "N days of history".**
- **Query budget**: 413 `QueryBudgetExceeded` when the planner's intermediate relation exceeds `RAMOSE_QUERY_MAX_CELLS` (default 1,572,864 cells ≈ 48 MB); retry with a narrower query.
- **Throughput**: ⚠️ "low thousands of writes/s per database" (site) comes from **in-process / local miniflare** benches (`docs/RUNBOOK.md:31-34` ← `bench/RESULTS.md:47-80,145`: ~2.5–2.9k tx/s in-process, ~1.7k through the local Worker→DO path). Deployed Cloudflare measurements: **166 tx/s @ 8 clients, 664 @ 64** (`bench/RESULTS.md:175-176`), later 802–879 (`:448`). No deployed measurement supports "low thousands"; cite the deployed numbers or none.
- **Schema change**: `install()` is an upsert of `:db/ident` map forms; adding attributes/namespaces is a plain add; **changing** `valueType`/`cardinality`/`unique` of an existing ident is *not guarded* (card-one implicit retract+add of the schema datom; existing data is neither re-typed nor validated); **removing** an option (e.g. dropping `unique`) emits nothing on the wire so the old datom stays. Under a policy only `admin` may change schema. (`alchemy/src/db/ensure.ts`, `core/src/tx.ts:117,450-465`, `core/src/schema.ts:160-200`.)
- **CORS**: `*` until a policy is set, then `RAMOSE_ALLOWED_ORIGINS` (`worker/src/index.ts:109-124`, `auth.ts:346-352`).
- **Session socket**: `GET /db/:name/session` (Upgrade) — frames `auth|transact|q|pull|entity|info`, unsolicited `{ op: "t", t }` ticks; peer polls the replica basis every `1_000` ms per watch key (`worker/src/session.ts:8-40, 105`).

---

## 9. HTTP API (Worker internals — reference only; `worker/src/index.ts:11-19`)

```
GET  /                                  demo app (404 once a policy is configured)
GET  /health                            → { ok, service: "ramose", stage, time }   (no auth)
POST /db/:name/transact   { tx }        → { t, txEid, tempids, datoms }
POST /db/:name/query      { query, inputs?, asOf?, history?, explain? }   → { t, root, result }   (explain: admin only)
POST /db/:name/pull       { eid, pattern, asOf?, history? }               → { t, result }
GET  /db/:name/entity/:eid[?asOf=]                                        → { t, entity }
GET  /db/:name/info                     → { db, t, principal: { eid, class } } (+ transactor/replica/peer internals for admin)
GET  /db/:name/session    (Upgrade: websocket)
POST /db/:name/admin/index | /admin/gc | /admin/replica/reconnect         (admin only under a policy)
```
Auth: `Authorization: Bearer` or `?token=`. Read-path headers: request `x-ramose-replica-hint`, `x-ramose-cache-basis`, `x-ramose-cache-mode`, `x-ramose-min-t`; response `x-ramose-ms`, `x-ramose-r2-gets`, `x-ramose-cache-hits`, `x-ramose-basis-*`, `x-ramose-colo` (`:4-9, 112-113`). Status mapping: 400 InvalidRequest · 401/403 Unauthorized (`{ error, code: "policy", attr }` for policy denials) · 404 NotFound (unknown route; a database *name* always exists) · 409 TxRejected `{ error, tag, code }` · 413 QueryBudget · 503 TransactorDead/Unavailable (+`retry-after`).

---

## 10. ❌ Claimed on the site / README but false or unverifiable

Format: page:line — quote → correction. (Full per-page audit lives with the two sub-audits; this is the writer-facing list.)

**Publishing / install**
- `index.mdx:53,377`, `introduction.md:14`, `quickstart.mdx:16,29`, `README.md:17,32` — "npm install @ramose/alchemy [@ramose/worker @ramose/react]", "The packages are on npm" → ❌ nothing is published (all `private: true`; npm E404). Only the monorepo works today.
- `index.mdx:56`, `quickstart.mdx:60-61,76`, `introduction.md:20-22`, `permissions.md:155`, `deploy.md:30`, `workers.md:144`, `README.md:129` — `main: "@ramose/worker"` → ⚠️ no `exports` map, unexercised; every stack uses `main: "./packages/worker/src/index.ts"`.
- `deploy.md:72-75`, `permissions.md:185-191`, `README.md:167-168` — `npx alchemy dev/deploy` → ⚠️ repo only ever runs `bun alchemy …`.

**Local emulator**
- `index.mdx:56`, `quickstart.mdx:268-269`, `live-queries.md:124-129` — "On the local emulator writes do not propagate between isolates; a second tab picks them up on reload" → ❌ contradicted by `examples/reef/README.md:38-41` (fixed by #55) and the 1 s basis poll (`worker/src/session.ts:105`).

**Client / query / React**
- `reference/client-api.md:101` — "`Entity<C>` — `{ eid; add; retract }`" → ❌ three verbs: `add`, `retract`, `retractEntity()` (`Tx.ts:72-88`).
- `reference/client-api.md:121-123`, `reference/errors.md:41-43` — `live` fails only on `InvalidRequest | Unauthorized | DatabaseNotFound` → ❌ four terminal tags incl. `QueryBudgetExceeded` (`Db.ts:281-285`).
- `reference/react.md:69` — `key={r.id.id}` → ❌ selected `id: Todo.id` is a `number`; `key={r.id}` (`examples/todos/src/App.tsx:21`).
- `guides/live-queries.md:141-142` — "The socket carries a version number, never rows" → ❌ `q`/`pull` requests and replies ride the socket when a session exists (`Databases.ts:186-216, 312-319`); only writes are always HTTPS. `client-api.md:119-120` has it right.
- `guides/catalog.md:80` — "`Ramose.Uuid` … a UUID, as bytes" → ❌ `Uuid` is `{ vt: 6, v: string }` (`valueTypes.ts:52-59`); `UuidString` is the string form.
- `guides/queries.md:173` — link `#what-you-just-ran` → ❌ no such heading in quickstart.
- `quickstart.mdx:205` — "memoises `db.live(todoQuery)` on `[db, query]`" → ⚠️ on the view's *structural* key `[viewDep(db), query]` (`useLive.ts:67-75`).
- `guides/queries.md:80-85`, `reference/client-api.md:89`, `for-datomic-users.md:42-43` — predicate tables omit `in endsWith matches is .each some/every/none on scalars` and collection `.where/.orderBy/.limit/.offset` → ⚠️ incomplete.
- `guides/transactions.md:97-98` — "`txEid` … attach audit facts to it" → ⚠️ `txEid` is an `Eid` (`{ id }`), not a `TxEntity`; would need `tx.add(txEid.id, …)`; unsupported/undocumented pattern.

**Errors / HTTP**
- `reference/http-api.md:22` — "`/transact` … response is the `TxReport`" → ❌ wire body is `{ t, txEid, tempids, datoms }`; `TxReport` is the client's reshaping (`Db.ts:573-586`).
- `reference/http-api.md:30` — "`/info` reduces to `{ db, t }` for non-admin" → ❌ `{ db, t, principal }` (`index.ts:318-320`).
- `reference/http-api.md:15` — "`/health` … reachable with `RAMOSE_TOKEN` under a policy" → ⚠️ needs no token at all.
- `reference/errors.md:27` — `DatabaseNotFound` for "wrong name on a policy-bound route" → ❌ that is `Unauthorized` ("token is not valid for this database", `auth.ts:221`, `index.ts:225`); `DatabaseNotFound` = peer 404 (unknown route).
- `reference/http-api.md:59-60` — "Errors are JSON bodies with a stable `code`" → ⚠️ only DO-originated errors carry `code`; peer `BadRequest/Internal/NotFound` are `{ error }`.

**Retention / time travel** (six pages)
- `before-production.md:43-52`, `time-travel.md:38-41,77-92`, `for-datomic-users.md:38-41`, `configuration.md:36`, `runbook.md:67-68`, `architecture.md:60-61` — "GC keeps the newest 20 roots … `asOf` at an older `t` no longer resolves; that history is deleted" → ❌ per the read path (`basis.ts:44-63`, `core/db.ts:88-89`, `tree.ts:20-22`, `storage/index.ts:374-410`) `asOf` filters the current tree by `t`; GC only removes superseded tree versions. `docs/RUNBOOK.md:71,87` repeats the site's version — **maintainer ruling needed**, but do not assert the site's version as fact.

**Deploy / ops**
- `deploy.md:127-131`, `before-production.md:53-57` — "`alchemy destroy` does not delete your data … bucket and DO namespaces stay behind, still billable" → ❌ alchemy 2.0.0-beta.72's `R2.Bucket.delete` empties+deletes the bucket and DO removal deletes the class; only `Ramose.Server`/`Ramose.Database` are no-ops.
- `before-production.md:21-24` — "Without a policy … set `RAMOSE_ALLOWED_ORIGINS`" → ❌ ignored without a policy (`auth.ts:346-352`).
- `reference/alchemy-resources.md:15-16` — `ServerBinding`/`ServerHttp` typed `Layer<Providers>` → ❌ `Layer<ReadWriteDatabases | ReadDatabases[, never, WorkerEnvironment]>`.
- `reference/alchemy-resources.md:13` — `ReadWriteDatabases: (server) => Effect<Databases, never, Providers>` → ❌ `Binding.Service`, `(server: Server) => Effect<DatabasesShape>`; requirement is the capability service supplied by a transport layer.
- `reference/alchemy-resources.md:11` — `Server` props table → ⚠️ `worker` is `Cloudflare.Worker | { url; workerName? } | string`; `token` is `Redacted<string> | string`; missing `probe`; outputs `{ url, workerName, token }`.
- `guides/workers.md:63-64` — capability table → ⚠️ omits `live`, `livePull`, `basis`, `principal`; `ReadDatabases` also lacks `principal`.
- `guides/permissions.md:104` — "Ramose ships no token minter" → ⚠️ stale: `@ramose/better-auth` + `Ramose.claims` exist.
- `guides/permissions.md:58-59`, `Policy.ts:225` docstring — "a client that sends a preset value is refused" → ⚠️ identical value is accepted as a no-op; only a differing value is denied.
- `guides/auth.md:326-329` — `internalSecret: process.env.RAMOSE_POLICY === undefined ? …` guard → ⚠️ inert in that snippet (policy always set there).

**Numbers**
- `index.mdx:342`, `introduction.md:65-66`, `workers.md:137`, `before-production.md:65-67`, `databases-are-names.md`, `runbook.md:31-34` — "low thousands of writes per second" → ⚠️ in-process/miniflare bench; deployed measured 166–879 tx/s (§8).
- `reference/configuration.md:29-30` — `RAMOSE_CACHE_BASIS/_MODE/_REPLICA_HINT` default "—" → ⚠️ defaults are on / `ttl` (5 s) / `auto` (`worker/src/index.ts:4-9`).

**Stale in examples (not site)**: `examples/todos/src/db.ts:17` default port `8787` (should be 1337).

---

## 11. Things a writer might be tempted to invent — that do NOT exist

`Ramose.db(...)` at module level without `connect` · Promise-flavoured `db` (`db.q(...).then`) · `db.transact` map forms / `tx.upsert` / `tx.preset` · `TxReport.tempids` · `db.asOf(Date)` · `db.sync()` / public `minT` · aggregates / `groupBy` / `count` · full-text search · cross-db joins · `Catalog.merge` (exists, unexported) · `Ramose.Pull.pick` (unexported) · `useMutation` / `useEntity` / `useSubscription` hooks · a `RamoseContext` export · `db.live` under a Worker service binding · `Ramose.Database` as a per-tenant resource (use `db.install()`) · a create/list/delete-database HTTP route · a CLI or dev-token minter · `Server.delete` erasing data · published npm packages.
