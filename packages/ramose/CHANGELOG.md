# ramose

## Unreleased

### Inline values are the documented query spelling (part of #228, tracker #205)

App queries put changing values in `.where` (`where({ issue: issueId })`).
`useLive(db, q)` and `db.query(q)` are documented without a bindings
argument; the argument stays accepted. `Ramose.params`, `optional`,
`EidOf`, and `Query.when` stay exported. `where({ done, rank })` and
`where({ rank, done })` now lower to the same clause order so #227 cache
keys are construction-order independent.

### Dependency hygiene (part of #202, tracker #205)

`@effect/platform-bun` and `@effect/platform-node` are removed — nothing
in the package imported them. `zod` is an optional peer next to
`better-auth` (kept as a devDependency for tests); apps that import
`ramose/better-auth` need `zod`. `alchemy` is pinned to the tested 2.x
beta (`>=2.0.0-beta.72 <2.0.0-beta.73`), bumped per release, instead of
`>=2.0.0-beta.72 <3.0.0` which admitted every future 2.x beta.

The workspace root pins the same tested alchemy (`2.0.0-beta.72`) so
`bun update alchemy` cannot split two copies. `scripts/check-release.ts`
fails if the root pin is not the package range's floor.

The root `ramose` entry has a `browser` condition that resolves to
`dist/browser.js` — `ramose/db` plus alchemy-free `policy` / `Policy` /
`claims` — so `import * as Ramose from "ramose"` in a client bundle does
not pull Alchemy. Types stay on the deploy barrel so an isomorphic
`import type { AuthConfig } from "ramose"` still resolves. Worker / SSR
deploy files keep the default target. No `bun` condition points at
`src` (the tarball does not ship `src`). The zod peer is naming hygiene,
not a smaller install — `better-auth` already depends on zod.

`ramose/effect` stays the opt-in Effect hatch (`pipe`, `Function`,
`Redacted`, and the modules Ramose's API already handed you). Schema
shorthands stay on `ramose/db`; `ramose/schema` stays cut.

### The `bun` export condition is gone — the tarball is importable under Bun

Follow-up to the enumerated exports map below, which dropped `src` from
`files` while every `exports` entry still led with `"bun": "./src/**/*.ts"`.
Bun always applies the `bun` condition and does not fall back to `default`
when the target is missing, so the published package could not be imported
under Bun at all — `import "ramose"` included — while Node resolved fine.

Every entry now resolves to `dist`. The checkout keeps resolving to source
through the `paths` block in the root `tsconfig.json`, which Bun honors at
runtime for both `import` and `Bun.resolveSync`, so `bun test` stays instant.

`scripts/check-release.ts` now fails on any `exports` target that `files`
does not ship — a manifest check that needs no build. Docs that still
imported the cut `ramose/schema` and `ramose/query` subpaths now use
`ramose/effect` and `ramose/db`.

`sideEffects` keeps its `./src/**` globs, now with a `//sideEffects` note
saying why: the peer Worker is bundled from source in this workspace, so
dropping them lets esbuild tree-shake the Durable Object classes out and
Cloudflare rejects the upload.

### Enumerated exports map (part of #201, tracker #205)

Wildcard subpaths (`./*`, `./*.ts`, `./*.js`) are gone. The public set is
`ramose`, `ramose/db`, `ramose/db/effect`, `ramose/worker`, `ramose/react`,
`ramose/better-auth`, `ramose/better-auth/client`, and `ramose/effect`.
Cut: `ramose/query` (duplicate of `Query`), `ramose/schema` (shorthands
replaced its app-path role), `ramose/workerEntry` (folded into #203 later).
`src` no longer ships in the tarball — `dist` includes declaration maps.
`ramose/internal/*` does not resolve. Types a consumer needs
(`AnyEntity` / `Entity.Any`, `ValueOf`, `FieldOptions`, `DbValueType`,
`DatabasesShape`, `ReadDatabasesShape`, `pick`, `RamoseEnv`) are on the
public barrels.

### Fluent query builder (part of #208, tracker #205)

`Query.from(Entity).where({…}).select(…).orderBy(…)` is the primary app
spelling — immutable, hoistable, no `pipe`. Object-literal `.where` is a
conjunction of equality filters; fragments (`Query.some`, `Query.matching`)
pass to the same method. Hoist `Ramose.params({ issueId: Issue.id })`;
`Issue.id` is a branded `Eid` (no recased `idOf`). A select-less fluent
query returns the full entity (friendly keys; refs as `{ id: Eid<Target> }`
cells — `Comment.issue` is `{ id: Eid<Issue> }`). Required scalars stay
required in the type; the pull still marks card-one fields `.optional` so a
missing fact does not drop the row. The serialized form is that expanded
shape, not `[*]`. `.ids()` is today's cheap id-only subscription. `Query.q`
+ pipe remain the generator/kernel spelling. Bind-attr `Query.where` is
renamed `Query.matching`.

### Schema value shorthands (part of #207, tracker #205)

App schemas use `Ramose.string()`, `boolean()`, `int()`, `float()`,
`timestamp()`, `uuid()`, `bytes()`, `Enum([...])`, and `Ref(Entity)` —
no `effect/Schema` import. Shorthands take the field option bag and
compose with `Field.many` / `Field.unique`. A raw Effect Schema remains
the advanced form (`Field(schema)`); inference is fail-closed (unknown
AST shapes do not become the wrong `valueType`).

**Breaking:** `Field(Ramose.Uuid)` row types are now `string`, aligning
the TypeScript type with runtime — server reads already materialized
plain strings. The `{ vt: 6, v }` / `$uuid` tagged form stays
wire-internal.

`Long`, `Instant`, `Uuid`, and `Bytes` are branded schemas the
shorthands wrap (the advanced-form vocabulary). `UuidString` is a
deprecated alias of `Uuid` for one release.

### Split the Effect hatch out of the connect module (part of #219, tracker #205)

`connect` / `Client` / `ClientOptions` stay on `ramose/db`. Hatch types
(`layer`, `Databases`, `DatabasesShape`, `EffectToken`,
`EffectClientOptions`) live only on `ramose/db/effect`. The client `.d.ts`
gate scans `connect.d.ts` with no allowlist exemption.

### Public vocabulary (part of #204, tracker #205)

App surface names: `Entity` / `Field` / `Schema`, `set` / `remove` /
`delete`, `unique: "upsert" | "strict"`, `owned`, `valueType: "string"`,
`ServerAuth` / `createServer` / `ServerOptions`, `db.query` (hatch
`db.effect.query`). One `Claims` type; policy operand `P.claim` /
`P.field`. Hatch tx handle is `TxHandle`. Wire protocol stays
Datomic-shaped. Schema shorthands (#207), fluent `Query.from` (#208),
and the full docs rewrite (#175) are separate.

### Policy clause-level pushdown (#157)

A namespace read rule is conjoined into the caller's query **before
planning**, so visibility rides the same indexes and joins. The crux is a
two-view join: rule-originated clauses bind against the unfiltered rule
db (they follow `:doc/owner` even when the caller cannot read it); caller
clauses bind against the filtered view. Provenance is carried on each
clause (`origin: "rule" | "caller"`), never inferred.

Conjunction is per entity-var whose namespace has a rule, skipped when
the arm is `true`, the principal is admin, or the caller's `:where`
already entails the rule. It always lives in `:where` — a `count` cannot
include a row the caller could not see. `FilteredDb` remains the
enforcement backstop for pull, history, raw datom access, and
attribute-level narrowing.

Rule clauses ride the caller's query budget. `QueryBudgetExceeded` now
carries `spentBy: "caller" | "policy"` so a policy regression is not
billed as an app bug. Equivalence (pushdown ≡ filtered-only) is the
merge gate.

### Policy rules are query fragments (#153)

The `P.*` expression language (`eq`, `ref`, `and`, `or`, `allow`, …) is
gone. A policy is head/body shaped like `Query.q`: `Ramose.policy(head,
arms)` takes `principal: User.sub` in the head (that attr derives `me`)
and every arm is a fragment, an array of fragments (OR), or `true` (the
empty fragment — public). `P.class` survives as a JWT claims gate in
config, checked before the rule runs.

Compile promotes each fragment to a named `Query.rule` and serializes it
into a `rules` section of the policy JSON (wire version 2). Deploy-time
validation walks rule bodies through the query validator. Installed
policies recompile at deploy — no data migration.

### Visible-set materialization (#156)

On a read, a named fragment rule is evaluated **once** with the focus
free — every `e` visible to `me` — and cached on the request's
`PolicyMemo`. The per-datom check in `FilteredDb` is then a set-membership
lookup. Same rule, same engine, same unfiltered basis as the per-entity
path (#154); only the binding pattern changes.

A set larger than `visibleSetMax` (default 10,000) or that blows the
query-cell budget falls back to per-entity evaluation for that request
and emits `policy.visible-set-fallback` (the telemetry #157 uses).
`true` arms, admins, and write verbs never materialize a set.

### Fragment-rule evaluation (#154)

A named fragment arm is one engine query over the unfiltered rule db,
with the focus bound to the entity and `?me` bound to `Principal.eid`.
Non-empty result = allow. Results are memoized per `(rule, e)` on the
existing `PolicyMemo`. Create arms keep the in-tx ref overlay so a
parent asserted in the same transaction is visible to the rule; add /
retract / retractEntity evaluate against db-before only.

Unresolved principals fail closed (relational rules cannot match; only
`true` arms apply). A rule that blows the query memory budget throws
`PolicyBudgetError` (`policy/budget-exceeded`) — a deploy-time smell,
not a silent deny. v1 expression policies still evaluate as before.

#### Old → new spellings

| old                                              | new                                                          |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `P.policy(Catalog, { principal, classes, ns })`  | `Ramose.policy({ catalog, principal, classes }, arms)`       |
| `P.eq(Doc.owner, P.principal)`                   | `(me) => Query.is(Doc.owner, me)`                            |
| `P.ref(Doc.project, P.ref(Project.org, Org.members))` | `(me) => { const p = yield* follow(Doc.project)(e); … }` |
| `P.allow(expr)` / `P.deny(expr)`                 | the fragment itself, or omit the arm (deny by default)       |
| `P.or(a, b)`                                     | `[fragA, fragB]`                                             |
| `P.class("admin")` as an expression              | `P.class("admin")` as a claims gate, or `{ class, rule }`    |
| `P.and(P.class("member"), own)`                  | `{ class: "member", rule: own }`                             |

`P.preset`, `P.attr`, `P.claims` / `P.principal` (preset operands),
`P.compile` and `P.checkPulls` are unchanged.

### One query language (#149)

The navigational query surface is gone; the kernel query language that
landed in #150 (`Q`, `Query.q`, the pipeable stdlib) is the one constraint
language. Pre-release, no shims — the old spellings are removed, not
deprecated.

The kernel surface gained the three spellings the migration needed first:

- **Keyset paging** — `q.after(cursor)` on any sorted `Query.q` value;
  resolves to `Page<Row>` (`{ rows, cursor }`). The sort-key cells ride in
  `find`, the entity id joins the order as a tie-breaker, and the next
  cursor is minted from the last row.
- **Single-row terminals** — `q.one()` (`Row | null`, forced `limit 1`)
  and `q.oneOrFail()` (`Row`, forced `limit 2`, `NotOne` on zero or two).
- **Param-gated clauses** — `Q.when(gate, body)` / `Query.when(gate,
  …filters)`: a clause group gated on a `Param<boolean>` or a
  `Ramose.optional` param, spliced or dropped at lowering.

Aggregates keep one spelling: an aggregate cell in a record projection
(`Q.count`, `Q.countDistinct`, `Q.sum`, `Q.avg`, `Q.min`, `Q.max`); there
are no pipe aggregate terminals. An aggregate-only record keeps the old
scalar semantics: exactly one row even over an empty match set (`count` /
`countDistinct` / `sum` are `0`, `avg` / `min` / `max` are `null`); a
grouped record is `[]` over no rows.

#### Old → new spellings

| old (navigational)                                     | new (kernel)                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `Ramose.query(N)`                                       | `Query.q(() => pipe(Query.entities(N), …))`                        |
| `Ramose.query(N, P)` + `Ramose.params({ k: decl })`     | `Query.q({ k: decl }, (p) => pipe(…))` — same decls (`attr`, Schema, `EidOf`, `optional`) |
| `.where(A.eq(v))` / ref `.is(v)`                        | `Query.is(A, v)`                                                   |
| `.where(A.exists())` / `.where(A.missing())`            | `Query.has(A)` / `Query.missing(A)`                                |
| `.where(A.gt(v))` and the other comparisons             | `Query.where(A, (x) => Q.gt(x, v))` — `Q.eq/ne/lt/lte/gt/gte/in/startsWith/endsWith/includes/matches` |
| `Ramose.or(…)` / `Ramose.not(…)`                        | `Q.or(…)` / `Q.not(…)` (generator spelling)                        |
| `Ramose.when(gate, …clauses)`                           | `Query.when(gate, …filters)` / `Q.when(gate, body)`                |
| path predicates (`Issue.owner.name.startsWith("A")`)    | traversals: `Query.follow(Issue.owner)` then constrain the focus   |
| `.reverse` in a *predicate* path                        | `Query.backlink(ref)`                                              |
| many-ref `.some/.every/.none(pred)`                     | `Query.some/every/none(ref, …preds)` (backlink form); a forward-ref ∃ is just the join, ∀/∄ via `Q.not` |
| `attr.each` element cursors                             | removed — a many scalar's values are `Q.fact(e, A)` bindings       |
| `.select(shape)` / `.orderBy` / `.limit` / `.offset`    | `Query.select/orderBy/limit/offset` stages (same shapes)           |
| `.one()` / `.oneOrFail()`                               | `q.one()` / `q.oneOrFail()` on the built value                     |
| `.after(cursor)` → `Page`                               | `q.after(cursor)` → `Page` (same `Page`/`Cursor` values)           |
| `.count()` / `.sum(a)` / …                              | a record cell: `{ n: Q.count(e) }` — ungrouped, still one row over the empty set |
| `.aggregate({ … })` / `.groupBy({ … }).aggregate({ … })`| a record projection: non-aggregate cells are the group keys        |
| `.having((g) => …)`                                     | removed — filter the grouped rows client-side (post-group filters may return in kernel terms) |
| nested collection `.where(pred)` in a shape             | removed — per-element pull filters may return in kernel terms      |
| nested collection `.orderBy/.limit/.offset` in a shape  | kept: `ref.orderBy(key, dir).limit(n).offset(n).select({ … })`     |
| `Ramose.Row<typeof q>` / `Rows`                         | same names, now over `Query.q` values                              |

#### Kept

Attr refs (they carry the types `Q.fact` correlates on), pull shaping
(select shapes, `.optional`, `.orDefault`, nested `ref.select`, `.reverse`
backlink shapes, `all(N)`, `again(n)`, nested collection order/paging),
`db.q` / `db.live` / `asOf` / `history` / `pull` / `livePull`, params
binding, query budgets, and the react-hook seam. `db.q` / `db.live` and
the hooks now take `QueryObject` values only; the result type follows the
terminal (`readonly Row[]`, `Row | null`, `Row`, `Page<Row>`).

#### Removed exports

From `ramose/db`: `query`, `or`, `not`, `when`, `count`, `countDistinct`,
`sum`, `avg`, `min`, `max`, and the nav types (`NavQuery`,
`NavQueryBuilder`, `Predicate`, `WhereNode`, `Or`, `Not`, `When`, `Agg*`,
`Group*`, `Having*`, `QueryInput`). `Cursor`, `Page`, `Row`, `Rows`,
`Shape`, `EidLike` remain, now defined by the kernel surface.
