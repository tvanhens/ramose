# ramose

## Unreleased

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
