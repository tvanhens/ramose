# Public API Review — top ten problems before launch

Date: 2026-08-22 · ramose 0.3.0 · pre-release, breaking changes on the table

A deep scan of everything a user touches — `ramose/db`, the query language, writes,
policy, React, and deploy — read through the docs and the Reef example the way a
first-time user would. Six parallel review passes (schema, queries, writes,
client/React, policy/auth, server/deploy) produced ~70 findings; these are the ten
that matter most, ranked by user impact, security consequence, and the cost of
fixing after 1.0. Type-level claims were reproduced with `tsc --strict`; runtime
claims by executing the engine or lowering real queries.

> **Decision (2026-08-22):** the Operation API (`Ramose.Operation` / `db.run`) is
> the **only** write path going forward; `db.transact` retires from the public
> surface. Item 1 is therefore framed as the workstream list to make operations
> launch-ready (one issue per bold lead-in), and items 3, 5, and 7 carry the
> follow-on changes.
>
> This report is filed as issues
> [#170](https://github.com/tvanhens/ramose/issues/170)–[#204](https://github.com/tvanhens/ramose/issues/204),
> tracked by [#205](https://github.com/tvanhens/ramose/issues/205).

## The ten

| # | Problem | Severity |
|---|---------|----------|
| 1 | Operations become the only write path — and they aren't ready | critical |
| 2 | Type safety stops at every boundary crossing | critical |
| 3 | Auth & permissions: a hardcoded superuser and fail-open seams | critical |
| 4 | Schema definition can silently corrupt data, and can never evolve | critical |
| 5 | The docs describe a product that doesn't exist | critical |
| 6 | Outside Effect, errors lose their identity | major |
| 7 | The React surface is three APIs wearing one hood | major |
| 8 | The query language hits its ceiling where real apps start | major |
| 9 | Packaging makes everything public and deploys on magic strings | major |
| 10 | The vocabulary fights the user on every page | major |

---

### 1. Operations become the only write path — and they aren't ready — critical

**Decided:** `Operation`/`db.run` is the sole write API; `db.transact` retires
from the public surface. The decision is right — `db.run` already resolves the ids
of created entities (the thing `transact` never could), the peer already has the
`writes: "operations"` enforcement mode, and a named-operation contract is the
natural policy and audit boundary. But today operations are the *least* finished
corner of the write surface: undocumented, untyped, and datom-level verbose. The
workstream list to make the decision true, one issue per bold lead-in:

- **Type the operation surface.** Op bodies are untyped on every position —
  `op.add(e: unknown, attr: unknown, value: unknown)`,
  `OpEntity.add(attr: unknown, value: unknown)` (`db/Operation.ts:76,99`), so
  `op.add(op.self, Issue.status, 42)` compiles; `db.run`'s entity argument is
  `unknown` too (`db/Db.ts:288`), so running an `on: Issue` operation against a
  comment id typechecks. Parameterize `Op` over the catalog and correlate
  `op.self`/the `db.run` entity argument with `on`. The type machinery already
  exists in `Tx` (`db/Tx.ts:110-114`) — it was never threaded through.
- **Entity-level writes on the op handle.** With operations the only path,
  `transact`'s datom-level verbosity moves into every op body: Reef's
  `createIssue` would still be 17 lines of `yield* add(...)` with hand-rolled
  optionality (`examples/reef/src/app/mutations.ts:174-191`). Ship
  `op.put(Issue, {…})` (and `op.put(Issue, id, {…})` for updates) lowering to the
  map form the engine already accepts — `WriteAtIdent`, the exact type needed,
  sits as an unused import in `db/Tx.ts:10`. Add `op.upsert(User.sub, "…")` on
  unique-identity attrs while there: the engine implements upsert
  (`internal/core/tx.ts:293-330`), the API leaves it reachable only by folklore.
- **A low-ceremony path for simple writes.** Every mutation now requires a named
  operation registered with the peer (`createPeer({ operations })`) — a
  client/server contract keyed on string ids like `"issue/move"`, where a client
  running an op the peer build didn't register is a runtime failure. Bless Reef's
  pattern (a shared domain module imported by both the app and `infra/peer.ts`)
  as *the* pattern: a `defineOperations(catalog, {…})` registry both sides
  import, a deploy-time check that the peer's registry covers the client's, and
  an answer for what used to be a three-line `transact` so the floor stays low.
- **Flip the peer default and wire the resource prop.** `writes: "operations"`
  stops being a mode and becomes the default; raw `/transact` becomes the opt-in
  (admin/seed tooling). Which makes the silently-ignored
  `Server({ writes, operations })` props (see 3) a blocker rather than a cleanup:
  the prop must actually lower to `RAMOSE_WRITES`, and `RAMOSE_WRITES` must
  appear in the server reference.
- **Retire `db.transact` cleanly.** Remove it (and `useTransact`'s framing around
  it) from the public surface; keep `Tx` as the internal primitive the op handle
  wraps. Take the dead surface with it: `tx.spec`/`tx.catalog` leaking on the
  builder, unused `TxGenBody`/`TxEffectBody`, and the untyped Effect-callback
  branch (`db/Tx.ts:98-99,145-159`, `db/Db.ts:830-832`).
- **Document `OpReport` and the operation errors.** Keep and document `db.run`'s
  id materialization (`db/Operation.ts:238-261`) — the reason Reef fuzzy-matches
  its own new issue back out of a query
  (`examples/reef/src/app/screens/BoardScreen.tsx:286-301`) disappears with
  `transact`. `OperationRejected` — the primary failure of the primary write
  path — is missing from every error table (`reference/errors.mdx`,
  `client-api.mdx`).
- **Rewrite the teaching layer around operations.** Operations appear *zero*
  times in the docs today, and "Operations" already names the policy verbs in
  `reference/policy.mdx` — rename one of the two before writing the guide. The
  quickstart, the transactions guide ("the four verbs, and that there is no
  fifth"), the client-api reference, the README hero, and Reef's six remaining
  `transact` mutations (`setTitle`, `setPriority`, `setAssignee`, `toggleLabel`,
  `deleteComment`, `createIssue`) all move to operations. Overlaps with 5's
  snippet-extraction fix — do the rewrite on extracted snippets so it can't
  drift again.

**Target shape:**

```ts
const createIssue = Ops.op("issue/create", { input: Draft, output: EntityId }, (op, draft) =>
  op.put(Issue, {                      // typed against the catalog; undefined → omitted
    title: draft.title,
    status: draft.status,
    rank: draft.rank,
    creator: op.principal,
    labels: draft.labelIds ?? [],
  }));

const { id } = yield* db.run(createIssue, draft);   // real eid, no re-query
```

### 2. Type safety stops at every boundary crossing — critical

The pitch is "a wrong write is a red squiggle, not a bad row" — and it holds within
one attribute. But wherever two entities, a param, or a policy meet, the checking
disappears, and the failure mode is almost always silent. All verified with
`tsc --strict`:

- `pipe(Query.entities(Issue), Query.is(User.name, "Ada"))` — cross-namespace
  stages compile and match nothing; same for wrong-namespace `select`, `orderBy`,
  `Q.pull` (`db/query/query.ts:141` carries the namespace only at runtime).
- Params are `any` in every clause position: `is(Issue.title, p.numberParam)`, a
  param from a different query's set, and `limit(p.stringParam)` all compile
  (`db/query/lib.ts:109`, `db/query/kernel.ts:488`), contradicting `Params.ts:38`.
- Ref targets are erased on writes: `Issue.creator: Ref(() => User)` accepts a
  Label eid (`db/idents.ts:36-52`). Any raw string is a valid tempid, so
  `tx.add("oops-typo", …)` creates a stray entity.
- Policy classes are bare strings: `P.class("not-declared")` compiles
  (`db/Policy.ts:396`); Reef hand-maintains a parallel `CLASSES` tuple and casts
  (`examples/reef/src/domain/shared.ts:47-48`). A rule fragment attached to the
  wrong namespace compiles and becomes a silent deny-all (`db/Policy.ts:61`).
- `Eid` is two runtime shapes behind one name — `{ id }` for catalogs, a branded
  number for namespaces (`db/Eid.ts:24-38`) — so the quickstart itself re-wraps
  `setDone(db, { id: row.id }, …)`, and `tx.add` accepts only the bare number
  while `db.pull` accepts both.
- `orderBy("nope")` is an unchecked string that detonates as an Effect defect on
  first execution (`db/query/lib.ts:246`, `db/Db.ts:483-489`).

**Direction:** thread the missing type parameters through, mechanically:
`Pipeline<N, Row>` / `Var<T, N>`; param brands into `Operand`/`ValueIn`; ref
targets into `TxValue`; `const` classes into `Policy<C, CL>` with an exported
`Policy.Class<typeof policy>`; a nominal `tx.tempid()`. Collapse `Eid` to the
branded number everywhere. Much cheaper before 1.0 than after.

### 3. Auth & permissions: a hardcoded superuser and fail-open seams — critical

- **`"admin"` is a hardcoded superuser the policy API doesn't know about.** Total
  bypass keys on the literal string in core (`internal/core/policy/principal.ts:31-33`),
  checked before any rule runs; schema install requires it (`worker/auth.ts:419`).
  Declare classes `["owner","editor","viewer"]` and the database can never install
  schema. Name a benign role `admin` and it silently bypasses everything. Reef's
  `P.attr(Issue.privateNote, { read: P.class("admin") })` is dead code — admins
  skip filtering entirely, everyone else gets false.
- **Field masks gate reads but not writes.** The same `privateNote` mask leaves the
  field fully writable by any member (`internal/core/policy/eval.ts:439-452`).
  There is no `write:` alias covering add/retract/retractEntity, so Reef repeats
  every arm three times (`examples/reef/src/domain/policy.ts:56-58`).
- **`Ramose.Server`'s `writes` and `operations` props are accepted and ignored**
  (`Server.ts:180-187` vs `attributes()` at `:470-493`).
  `Server("R", { writes: "operations" })` deploys green and leaves raw `/transact`
  open — the real knob is `RAMOSE_WRITES`, undocumented in the server reference.
  With operations now the only write path (1), this graduates from cleanup to
  launch blocker: the prop must be wired and the mode made the default.
- **Auth is configured in two places with no cross-check.** Passing `auth` only to
  `Ramose.Server` (not `authEnv` into the Worker) passes the deploy check while the
  worker ships without `RAMOSE_POLICY` — open to everyone. Reef never passes `auth`
  to `Server` at all.
- **Credential lifecycle leaks.** The token lives on `connect()` but authorizes one
  database, so switching workspaces means remounting the provider with `key` (docs
  prescribe it). Reef's sign-out never invalidates the token source, and its
  workspace cache reuses user A's still-valid JWT (≤900 s) for user B on the same
  slug (`examples/reef/src/app/App.tsx:146`). The JWT also rides the WebSocket URL
  query string (`db/session.ts:146-153`) though the peer supports an in-band
  `auth` frame.

**Direction:** explicit `superuser`/`schemaClasses` in the policy head with a
deploy error when no class can install schema; a `write:` ops alias and a warning
when read is narrower than writes; wire or delete the `Server` props and make
`Server({ auth })` the single source of truth; move the token to
`client.db(name, catalog, { token })`, add `client.reauthenticate()`, authenticate
the socket with the first frame; fix Reef's sign-out.

### 4. Schema definition can silently corrupt data, and can never evolve — critical

- An attribute named `id` makes `Post.id.ident === ":post/id"` — every
  `select({ id: N.id })` and every `Eid` silently reads a user string field
  instead of the entity id. An attribute named `ns` makes `install()` emit
  `":[object Object]/id"` idents for the whole namespace (`db/Namespace.ts:218-224`,
  `db/ensure.ts:48`). No reserved-key guard exists; `id` is about the most
  plausible field name there is.
- No name validation (`Namespace("my ns/x", { "a b": … })` installs), no duplicate
  namespace detection, and the catalog key is never checked against `ns.ns` —
  `Catalog({ todos: Todo })` silently splits the policy (`ns.todos`) from the wire
  (`:todo/*`). Contrast `DatabaseName.ts`, which validates rigorously.
- `Schema.Literals([...])` — the obvious enum — typechecks as `":db.type/string"`
  and then throws at install (`db/valueTypes.ts:30-40` vs `:172-189`). Reef gives
  up and types `status` as a bare string. There is no `Ramose.Enum`.
- Type-bearing options silently widen: annotate a shared options const as
  `AttributeOptions` and a cardinality-many component is typed cardinality-one
  (`db/Attribute.ts:79-90` documents its own hazard).
- Schema evolution is unguarded: `install()` unconditionally re-sends every
  attribute (`db/Db.ts:838`), so flipping a value type is a silent, unrecoverable
  data-model split (`guides/catalog.mdx:138` admits it).

**Direction:** reject reserved keys at type and runtime level (or move metadata
behind a symbol); validate names and detect duplicate idents in `Catalog()`; ship
`Ramose.Enum(values)`; move type-bearing options into function identity
(`Attr.many(…)`, `Attr.unique(…)`); make `install()` diff against the installed
attribute set and fail on incompatible changes with an explicit
`allowIncompatible` escape.

### 5. The docs describe a product that doesn't exist — critical

- The README hero calls `Ramose.query(Todo).select(…)` — `ramose/db` exports no
  `query`. The first sample on the repo page doesn't compile.
- **The documented "query by id" idiom is broken at runtime.**
  `Query.is(Comment.id, p.root)` — shown in `guides/queries.mdx:180` and
  `reference/client-api.mdx:372`, with `client-api.mdx:68` promising `Todo.id` is
  usable in `where` — lowers to a `:db/id` pattern the engine rejects
  (`internal/core/schema.ts:245`, reproduced). There is no working spelling of
  "filter a query by entity id," and zero test coverage of the documented one.
- The quickstart's central snippet uses `pipe(...)` without importing it.
- `guides/transactions.mdx` teaches code that no longer exists: `moveIssue` and
  `deleteIssue` shown as transacts are now operations — and the operations
  decision (1) turns this from an anchor fix into a full rewrite of the write
  documentation. `reference/policy.mdx:43-46`
  shows a `user: { add: self }` arm that Reef's own tests assert must not exist.
- Virtually every `title="path:N-M"` anchor across ~20 doc files is stale (all six
  review passes verified their slices); error counts are wrong in three places
  (docs say eight, the union has nine); `db.run` is absent from the client API
  reference entirely. `website/scripts/docs-check.mjs` already reports many of
  these and doesn't block anything.

**Direction:** fix the `is(N.id)` lowering (unify the entity var with the
constant), add `Query.byId` with a test; then extract every doc snippet from
source at build time and make `docs-check.mjs` failures block CI.

### 6. Outside Effect, errors lose their identity — major

- `Effect.runPromise(...).catch(e => …)` rejects with a `FiberFailure`: `e._tag`
  is `undefined`, `instanceof` is `false` (verified against the pinned Effect 4
  beta). Both documented matching strategies (`reference/errors.mdx:11`) silently
  fail for exactly the non-Effect audience they're written for. `useTransact`
  internally does the right dance (`runPromiseExit` + `Cause.findErrorOption`) — a
  trick a plain user can't know.
- `isDatabaseError` exists (`db/Errors.ts:145`) but is unexported; `PolicyError` is
  deliberately killed from the barrel, so policy failures match only by message
  regex.
- Hooks leak Effect at the worst seam: read hooks expose `error` as `Cause<E>`,
  `useTransact.run` resolves to an `Exit`, and `useTransact.error` is `unknown`.

**Direction:** ship `Ramose.runPromise(effect)` (~5 lines) rejecting with the
tagged error and use it in every doc; export `isDatabaseError` and `PolicyError`;
plain typed errors in hook results (keep `cause` as the escape hatch); `run`
resolving to `{ ok, value } | { ok, error }` with `runExit` for Effect users.

### 7. The React surface is three APIs wearing one hood — major

- Three result shapes for three read hooks: `useLive` → `{ rows, error, ticks }`,
  `useQuery` → `{ data, error, loading }`, `usePull` → a single record under a
  field named `rows`. Live-ness isn't in the names: `usePull` is standing,
  `useQuery` is one-shot.
- **No connection state exists anywhere in the public surface.** `Session` tracks
  everything needed (`db/session.ts:101-133`); nothing exposes it. Reef's "live"
  pill is green whenever there's no error, and its terminal state tells the user
  to reload — which is genuinely the only recovery: a terminal `useLive` error
  (e.g. expired token) kills the query forever with no `retry()`
  (`react/useLive.ts:107-128`, `db/Db.ts:387-394`).
- No `usePrincipal`: Reef hand-rolls `useEffect` + `Effect.runPromise` +
  cancellation flags, and reads the role from a second source of truth (decoding
  the unverified JWT) because it needs it before the provider mounts
  (`BoardScreen.tsx:236-256`, `ramose.ts:57`).
- No SSR story: no `"use client"` (hard build error in server components), no
  `initialData`, no Suspense — conspicuous for a Cloudflare-native product.
- Every hook instance is a private subscription: same query in two components runs
  twice per tick; change detection is `JSON.stringify` of the whole result
  (`db/Db.ts:580`); every emission is all-new objects so one changed row
  re-renders every list child.

**Direction:** one `Read` contract for all read hooks (`data`, typed `error`,
`status`, basis `t`, `refetch`/`retry`); names that say liveness; add
`useConnectionStatus()`, `usePrincipal(db)`, and a first-class write hook for
`db.run` (`useOperation`) — with operations the only write path (1), the primary
write hook shouldn't be a generic Effect runner; `"use client"` now, `initialData`
and a Suspense variant next; client-level subscription cache with structural
sharing.

### 8. The query language hits its ceiling where real apps start — major

- **"Top 10 owners by issue count" is inexpressible.** `orderBy`/`limit` are
  pipeline-only; aggregates are generator-only (`db/query/query.ts:295-305`,
  `lib.ts:232-266`). Sorting by a joined field is impossible in either spelling.
  Aggregates always return a rows array — the docs teach `rows[0]!.n`.
- **Case-insensitive substring search cannot be written.** `Q.matches` rejects
  RegExp flags (`query.ts:710-718`); the engine ships `lower-case`, `str`,
  arithmetic and general function-binding clauses the kernel never exposes; no
  raw-datalog escape hatch exists.
- **Record projections silently deduplicate rows** (set semantics; `:with` only
  for aggregates, `query.ts:1140-1157`). Verified: two entities with the same
  title project as one row. Undocumented.
- No `or`/`not` at the pipe level; `where` means "bind and constrain this
  attribute" while every SQL-adjacent TS library uses `where` as the general
  filter.
- Cursors are explicitly non-serializable (no URL pagination); sort key/direction
  can't be params (click-to-sort forks the query and re-subscribes);
  nested-collection `.where` is documented in the types but unimplemented
  (`db/Pull.ts:16-32` vs `db/shapes.ts:230-246`).

**Direction:** move `orderBy`/`limit`/`offset` onto the query value where both
spellings reach them; `orderBy` accepting a bound var; a scalar terminal
(`Q.value(Q.count(e))`); auto-`:with` row provenance with explicit `Q.distinct`;
boolean pipe stages and attr-level comparators; `ignoreCase` on string predicates
backed by a `Q.call` escape hatch; a cursor codec.

### 9. Packaging makes everything public and deploys on magic strings — major

- The `./*` wildcard exports (plus shipping `src/`) make every internal module an
  importable, semver-bound entry point (`packages/ramose/package.json:113-128`) —
  while `src/index.ts:64-66` and `test/surface.test.ts` insist those modules are
  private. Reef's tests already import `ramose/internal/core/policy/ast.ts`. At
  1.0 this is now-or-never.
- `ramose/better-auth` imports from the deploy barrel and drags the whole Alchemy
  engine into the consumer's auth Worker (`better-auth/index.ts:32`; the fix is
  importing from `Auth.ts`). `@effect/platform-bun`/`-node` are dependencies
  imported by nothing; `zod` is a hard dep for an optional plugin; `alchemy`
  floats across future 2.x betas while its types sit in public signatures.
- Standing up the server is five hand-written declarations bound by unchecked
  magic strings — `className: "TransactorDO"`, env keys `STORE`/`TRANSACTOR`/
  `REPLICA`, a copy-pasted compat date already inconsistent across the repo
  (`2025-06-01` vs `2026-03-17`), and the `import.meta.resolve("ramose/worker")`
  footgun with a caution box, a doc paragraph, and a dedicated module compensating
  for it. A typo'd string passes the health probe and fails on first transact.
- Server-side handles lie: `databasesOf` returns a `Db` whose `live`/`livePull`
  typecheck and always die as defects (`Source.ts:46-80`, `db/Db.ts:556-565`) — a
  static fact currently stated in a prose caution box (`guides/workers.mdx:87-91`).

**Direction:** enumerate the exports map; fix the better-auth import and extend
the portability test; drop dead deps and bound `alchemy`. Make `Ramose.Server`
own the peer (Worker, DOs, compat date, binding names) with `{ worker }` as the
escape hatch. Give server transports a type without `live`/`livePull`.

### 10. The vocabulary fights the user on every page — major

The docs teach one vocabulary and the API speaks another; a near-identical
translation apology appears at least six times ("a **record type** — Ramose calls
it a namespace"; "the Ramose server — Ramose's code calls it the *peer*", five
pages in a row). When docs apologize for a name that consistently, the name is
wrong — and pre-release is the only cheap moment to change it.

- `Namespace`/`Catalog`/`Attr` vs the taught "record type"/"schema"/"field";
  `Namespace` collides with the TS keyword; `Attr` is the value but `Attribute`
  the type.
- Datomic leaks: `retract`/`retractEntity` (while a cardinality-one `add` already
  replaces), required `valueType: ":db.type/string"`, undefined
  `unique: "identity" | "value"` distinction, `isComponent`, `Long`/`Instant`,
  `Uuid` exposing the wire encoding `{ vt: 6, v }` publicly.
- `Q` vs `Query` vs `Query.q` vs `db.q`; both namespaces export a `when` with
  different signatures; `Q.pull` (projection) vs `db.pull`/`usePull` (read one
  entity); the same act is `find` on the wire, `select` in the pipe, `pull` in the
  generator.
- `run` means two things, nested, in real code: `run(db.run(moveIssueOp, …))`.
  Four public spellings of the client (`Client`, `Databases`, `ReadDatabases`,
  `ReadWriteDatabases`) with unnameable return shapes; `./workerEntry` is the one
  camelCase subpath; error names inconsistently suffixed.

**Direction:** one naming pass, committed in full — either adopt the docs'
vocabulary in the API (`Record`/`Field`, `tx.set`/`tx.delete`, `Int`/`Timestamp`,
friendly `valueType: "string"`, `ServerAuth`/`createServer`) or commit to Datomic
vocabulary and delete the translation layer from the docs. Fold `Q` under
`Query.*`, rename `useTransact`'s `run`, export one nameable client shape.

---

## Worth fixing, below the fold

- No behavioral policy-testing API — Reef's policy tests assert compiled JSON
  shapes, never "can a viewer write?"; a `Policy.simulate` returning ordinary
  `Db<C>` handles per principal would fix it.
- Claims are unusable inside rule arms, so attribute-based single-database tenant
  isolation ("rows whose `:doc/org` equals the token's `org` claim") is
  inexpressible; the sibling-attribute provisioning bridge is undocumented and
  silently lossy.
- The `pulls` deploy check covers only field masks, not namespace-level read
  rules — the more common tightening the permissions guide promises to catch.
- `useBasis` issues an HTTP `GET /info` per tick for a number the session already
  holds; `Live.ticks` is an emission counter nobody needs where the basis `t`
  would serve.
- Optimistic-write semantics differ silently by transport; a resync discards
  pending optimistic state with no observable signal; writes head-of-line block
  behind one outbox chain.
- Dead or vestigial surface: `Catalog.merge` (never exported), `P.Claims` (never
  read), `TxGenBody`/`TxEffectBody`, `WriteAtIdent` unused import, `tx.spec`
  internals first in IntelliSense.
- Ergonomics: mandatory `Ref(() => …)` thunk even without cycles; per-line
  `Attr()` wrapper where a bare Schema could serve; `ramose/effect` omits `pipe`
  and `Redacted`, the two things every example needs.
- Any `:db/ident`-only transaction from a non-admin is silently swallowed with a
  success response (`worker/auth.ts:414-422`).
