# ramose

## Unreleased

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
are no pipe aggregate terminals. Note the record form answers **no rows**
over an empty match set (the old scalar `.count()` answered `0`).

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
| `.count()` / `.sum(a)` / …                              | a record cell: `{ n: Q.count(e) }` (empty set → no rows, not `0`)  |
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
