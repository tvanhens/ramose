# Query

Ripple’s read surface is a **typed navigational query value**. You build it
from catalog attributes (`Todo.done.eq(false)`, `Todo.owner.name`), run it with
`db.q` / `db.live`, and the client lowers it to the datalog + pull IR the engine
already evaluates — filters, shape, order and paging all run on the peer, in one
round trip.

```ts
import * as Ripple from "@ripple/alchemy/db";

const openTodos = Ripple.query(Todo)
  .where(Todo.done.eq(false), Todo.owner.name.startsWith("A"))
  .orderBy(Todo.due, "asc", { empty: "last" })
  .limit(20)
  .select({
    title: Todo.title,
    owner: Todo.owner.select({ name: User.name }),
  });

yield* db.q(openTodos);
// Effect<readonly { title: string; owner: { name: string } }[], DbError>

db.live(openTodos);
// Stream<…, DbError> — same value

yield* db.asOf(t).q(openTodos);
// same value, pinned basis
```

A query is a **value**, not a method on `db`, so one question runs once, live, or
in the past, and can live at module scope (stable dependency for `useLive`).

---

## Schema: targeted refs

Navigation needs a typed ref target. Use `Ripple.Ref(() => Namespace)` or
`Ripple.Ref.self` for self-edges. Untargeted `Ripple.Ref` still works for
`:db.type/ref` storage, but paths like `Todo.owner.name` require a target.

```ts
export const User = Ripple.Namespace("user", {
  name: Ripple.Attr(Schema.String),
  email: Ripple.Attr(Schema.String, { unique: "identity" }),
  friends: Ripple.Attr(Ripple.Ref.self, { cardinality: "many" }),
});

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  due: Ripple.Attr(Ripple.Instant),
  owner: Ripple.Attr(Ripple.Ref(() => User)),
});

export const Todos = Ripple.Catalog({ user: User, todo: Todo });
```

Attribute metadata for navigation uses `attrName` (not `.name`) so a path like
`Todo.owner.name` is not shadowed by the attribute’s own name field. Self-ref
and mutually recursive namespaces use depth-capped / lazy target substitution so
`Todo.owner.friends.name` types under TypeScript without “excessively deep”
instantiation.

---

## Building a query

```ts
Ripple.query(Todo)           // scope: entities that carry at least one :todo/* datom
  .where(...predicates)      // conjunctive filters
  .orderBy(attr, dir?, opts?)
  .limit(n)
  .offset(n)
  .select(shape)             // result shape; omit for a list of Eid
  .build()                   // optional — db.q / db.live accept the builder too
```

`Todo.id` is the `:db/id` pseudo-attribute: selectable, orderable, and
comparable (`Todo.id.eq(eid)`, `Todo.id.gt(n)`).

### Scope

`Ripple.query(N)` denotes entities that carry **at least one** `:n/*` datom. The
lowerer emits an `or` over the namespace’s attributes so membership does not
require a `:db/ns` marker.

### Predicates

Catalog attributes carry the predicate vocabulary. Paths join through refs:

| On | Verbs |
|---|---|
| scalar / string / instant attrs | `eq` `ne` `lt` `lte` `gt` `gte` `in` `exists` `missing` |
| string | `startsWith` `endsWith` `includes` (case-sensitive) `matches` |
| ref | `is` |
| cardinality-many ref | `some` `every` `none` |

```ts
Todo.done.eq(false)                 // asserted false — missing :todo/done does not match
Todo.done.missing()                 // no :todo/done datom
Todo.owner.name.startsWith("A")     // join through owner, then filter
Todo.title.in(["ship", "review"])   // one of
Todo.title.matches(/^ship/)         // regular expression
Todo.owner.is(userId)               // this ref points at that entity
```

`eq` / `ne` / comparisons require the attribute to be present. Use `exists` /
`missing` when absence is the question.

- **`in(values)`** binds the value and filters it with a collection binding, so
  a repeated value is still one row. `in([])` is a clause that matches
  **nothing**, decided on the peer like every other filter — never a client-side
  short-circuit that would make `:limit` lie.
- **`matches`** takes a `RegExp` or a pattern string and lowers to the engine's
  `re-find?`, which compiles the pattern with **no flags**. A flagged `RegExp`
  is *rejected* rather than quietly unflagged — write the behaviour into the
  pattern (`[aA]da`) instead.
- **`is`** is the ref spelling of `eq`: it takes an entity id or an `Eid`
  (`{ id }`), so a row cell can be handed straight back to the next query. It
  is offered on refs only, including the `:db/id` pseudo-attribute.

#### Quantifiers on a cardinality-many ref

A many hop in a path has always been existential — the join matches if *any*
element does. `some` names that; `every` and `none` are the other two. The
inner predicate is rooted at the hop's **target**, not at the query root:

```ts
User.friends.some(User.name.eq("Ada"))          // at least one friend is Ada
User.friends.every(User.email.exists())         // no friend is missing an email
User.friends.none(User.name.missing())          // no friend is anonymous
User.friends.some(User.friends.some(...))       // quantifiers nest
```

`every` and `none` are **vacuously true** of an entity with no elements at all:
"no element fails" and "no element matches" are both true of nothing. A
cardinality-many *scalar* has no target to root an inner predicate at, and does
not need one: a bare predicate on a many scalar already means "some value
matches".

### Combinators

`.where(...)` is conjunctive; `Ripple.or` and `Ripple.not` are how a query says
anything else. Both nest, and both take predicates, quantifiers, or each other:

```ts
Ripple.query(Todo).where(
  Todo.done.eq(false),
  Ripple.or(Todo.owner.name.eq("Ada"), Todo.due.missing()),
  Ripple.not(Todo.title.startsWith("draft")),
);
```

Each is scoped to the query's root entity, so branches need not bind the same
variables and a row matched by two branches still comes back once. `Ripple.or()`
with no branches matches nothing — again, a clause the peer evaluates, not a
client-side short-circuit.

### Reverse refs

`attr.reverse` is the backlink: the same ref hop, read the other way. From a
`User` root, `Todo.owner.reverse` denotes the todos that point at you, and it
works in `where` and in `select`:

```ts
Ripple.query(User)
  .where(Todo.owner.reverse.some(Todo.done.eq(false)))
  .select({
    name: User.name,
    todos: Todo.owner.reverse.select({ title: Todo.title }),
  });
```

- A backlink is always **cardinality-many** — any number of entities may point
  at one — so quantifiers apply to it, and `orderBy` across one is rejected when
  the query is built, like any many hop.
- In a shape it is a **possibly-empty array**: an entity with zero backlinks
  comes back with `[]`, never dropped. It is never turned into a required
  `where` clause.
- A **bare** backlink in a shape is rejected: the peer answers one with
  `{":db/id": n}` objects, which is neither a scalar nor a shape. Ask for the
  shape you want with `.reverse.select({ … })`.
- `.reverse` works on targeted, untargeted and self-refs, and part-way along a
  path. It does not model a `:db/isComponent` ref, whose backlink is
  single-valued; `.reverse` on one throws rather than typing an array the peer
  will not send.
- A path that walks on **through** a backlink keeps that hop backwards:
  `Todo.owner.reverse.owner.name` is "the todos that point at me, then their
  owner, then that owner's name" — one reversed hop, then two forward ones.

### Shape (`select`)

`select` is the result shape. Keys you ask for appear in the type; keys you omit
are absent, not `undefined`.

```ts
.select({
  title: Todo.title,
  due: Todo.due.optional,                              // Date | undefined
  owner: Todo.owner.select({ name: User.name }),       // nested object
})
```

- **Required field** (bare attr): entities missing that datom are dropped from
  the result — on the peer, as a `where` clause, so a `.limit` counts only the
  rows you keep.
- **`.optional`**: types `T | undefined` and keeps the parent when the attr is
  absent.
- **Card-one ref `.select({…})`**: nested object; nested shapes lower to
  `(pull ?e …)` inside `:find` (server-side, not client N+1). A required
  nested select is required through the ref: the parent is dropped when the
  ref is missing or the nested object fails *its* required fields.
- **Card-many `.select({…})`**: an array; a missing many is `[]`, never a drop.
- **Backlink `.reverse.select({…})`**: an array too, resolved on the peer
  through VAET inside `:find`. Zero backlinks is `[]`, never a dropped row; a
  bare `.reverse` without a shape is rejected. A `.reverse` hop is the ref read
  backwards, so the element is the *referring* entity (a `Todo`, for
  `Todo.owner.reverse` from a `User`) — that is what the shape and the nested
  constraints below are written against.

#### Filtering a nested collection

A card-many ref or a backlink is a **collection**, and `.where` / `.orderBy` /
`.limit` / `.offset` chain onto the nav before `.select` to constrain it:

```ts
Ripple.query(User)
  .orderBy(User.name).limit(20)
  .select({
    name: User.name,
    todos: Todo.owner.reverse
      .where(Todo.done.eq(false))
      .orderBy(Todo.due, "asc", { empty: "last" })
      .limit(5)
      .select({ title: Todo.title }),
    friends: User.friends.where(User.email.exists()).limit(3).select({ name: User.name }),
  });
```

These are **pull-phase** constraints: they lower to the nested pull spec's
`:where` / `:order` / `:offset` / `:limit` and the peer evaluates them inside
the pull, *after* the outer `:order` / `:offset` / `:limit` slice. So:

- The nested filter **never drops the parent row**. A collection that filters
  to nothing is `[]`, and the outer `.limit 20` still means twenty rows the
  client keeps. (It is not a client-side post-filter either — that would make
  the outer `:limit` lie in the other direction.)
- The nested `limit` / `offset` count the elements `where` and `orderBy`
  **kept**, in that order: collect → where → order → offset → limit → nested
  shape. Paging past the end is `[]`.
- The row **type is unchanged** — a filtered collection is the same array.
- Inner predicates are rooted at the **element**, so they are written with the
  element's namespace (`Todo.*` inside `Todo.owner.reverse`, the ref's target
  for a forward ref) and may walk on from it: `Todo.owner.name.eq("Ada")`
  inside the backlink means "the element's owner is Ada". A path rooted at
  another namespace is rejected when the query is built.
- `Ripple.or` / `Ripple.not` nest as usual, and `some(…)` on a many hop inside
  the predicate is just a longer path (fan-out is existential); `none(…)` is
  its negation.
- `orderBy` takes a card-one key from the element (`Todo.due`,
  `Todo.owner.name`), several keys tie-break in order, and `empty` defaults to
  `"last"` in both directions — the same rule as the outer `orderBy`.

Not expressible today, and rejected with an error rather than lowered to
something else:

- `every(…)` inside a nested `where` (an element with no value at all fails it,
  which the existential pull-phase predicates cannot say), and `not(…)` /
  `none(…)` *underneath* a `some(…)` (`∃x ¬P` is not `¬∃x P`). Put the
  quantifier in the query's own `.where` when it is the rows you mean to filter.
- Constraints on a **card-one** ref select (there is one entity, not a
  collection — filter it in the query's `.where`), and on a card-many
  **scalar** (`:user/tags`): the engine can filter one by its own values, the
  client has no spelling for "the element" yet. Both are type errors.
- A constrained collection without a `.select({ … })` shape, exactly like a
  bare `.reverse`.

### Order, limit, offset

```ts
.orderBy(Todo.due, "asc", { empty: "last" })
.limit(20)
.offset(0)
```

All three lower to the query AST (`:order` / `:limit` / `:offset`) and run on
the peer: rows are sorted, then paged, *then* pulled, so a `:limit 20` pulls
twenty entities and the client never sees the rows a page dropped.

- `orderBy` takes any card-one path — `Todo.due`, `Todo.owner.name`, `Todo.id`.
  Several `orderBy` calls compose in order; ties fall through to the next key.
- `empty: "first" | "last"` (default `"last"`) says where rows **without** a
  value at that path go — an EAV absence is not SQL `NULL`. It holds in *both*
  directions: `desc` does not float missing values to the top. Multi-hop paths
  keep such rows too (no owner, or an owner with no name, are both "empty").
- Mixed value types sort by a deterministic total order (numbers, then strings,
  booleans, instants, the rest).
- A path that crosses a **cardinality-many** attribute (`User.friends.name`) is
  rejected when you build the query: the sort key would be a set, not a value.
  A backlink (`Todo.owner.reverse`) is a many hop, so it is rejected too.

---

## Running

```ts
db.q(openTodos)            // Effect once
db.live(openTodos)         // Stream; re-runs as the session basis advances
db.asOf(t).q(openTodos)    // pinned basis
db.asOf(t).live(openTodos) // emits once and completes
```

Both `db.q` and `db.live` take a navigational query value or its builder.
Scalars decode through Effect Schema (`Instant` → `Date`, etc.). A query with
no `.select` yields `readonly Eid<C>[]`, typed against the catalog of the `db`
that ran it.

`db.live` re-runs the query at every basis tick and after a local `transact`.
A pass whose rows are identical to the last emission is **not** emitted again —
a write the query does not see is not a re-render.

`db.pull(eid, pattern)` remains the entity-by-id door. Prefer a navigational
query when you need filters, live, or `asOf` on the same artifact:

```ts
Ripple.query(Todo).where(/* … */).select(shape)
```

---

## How lowering works

A navigational query compiles to a find-pull query:

1. **Namespace scope** → `or` over `:n/*` attributes binding the root var `?e`.
2. **Where** → datalog clauses (path joins become fresh vars, a reversed hop
   flipping the datom to `[?j :attr ?e]`; predicates become ground clauses or
   function calls; `:db/id` predicates unify or compare `?e` itself).
   Combinators and quantifiers scope to `?e` so their inner join variables stay
   local: `or` → `(or-join [?e] (and …) …)`, `not` → `(not-join [?e] …)`,
   `none` → `(not-join [?e] <chain> <inner>)`, and `every` → the same with the
   inner half negated again, `(not-join [?x] <inner>)`, which is what makes it
   vacuously true when the hop binds nothing.
3. **Required fields** → one `[?e :attr _]` clause per required card-one field
   of the shape (recursively through required nested selects), so the peer's
   row set is already the one the client keeps.
4. **Order** → each sort key binds a fresh variable through an `or-join`: one
   branch walks the path, the other proves it absent (`not`) and grounds `null`,
   which the engine places per `empty`. The `:order` vector names those
   variables; `:limit` / `:offset` pass through.
5. **Select** → pull pattern embedded in `:find` as `(pull ?e pattern)`.
6. **Nested collection constraints** → the `:where` / `:order` / `:offset` /
   `:limit` fields of *that* pull spec, never the query's own. Each predicate
   becomes a `{path, reverse?, op, value?}` walked from the element (`or` /
   `not` nest; a `some(…)` hop is folded into the path, because fan-out along
   a path is existential), and each sort key a `{path, dir, empty?}`.

The engine sorts the joined relation, pages it, and only then resolves the
pulls — which is exactly why a nested collection's constraints belong to the
pull phase: they change what is *inside* a row, never which rows there are, so
they run once per kept row, after the slice, and cost nothing on the rows the
page dropped. The client's `finalizeNavResult` reshapes rows (pull maps into the
selected shape, bare ids into `Eid`s) and changes neither their number nor
their order.

For example, `query(Todo).orderBy(Todo.owner.name).limit(2).select({ title: Todo.title })`
lowers to:

```clojure
{:find  [(pull ?e [:todo/title])]
 :where [(or [?e :todo/title _] [?e :todo/done _] [?e :todo/due _] [?e :todo/owner _])
         [?e :todo/title _]
         (or-join [?e ?o0]
           (and [?e :todo/owner ?j1] [?j1 :user/name ?o0])
           (and (not [?e :todo/owner ?j2] [?j2 :user/name _])
                [(ground [nil]) [?o0 ...]]))]
 :order [[?o0 :asc :last]]
 :limit 2}
```

---

## Feature completeness

Status of the navigational surface relative to the intended design.

| Area | Shipped | Not yet |
|---|---|---|
| Schema | `Ref(() => N)`, `Ref.self`, navigable attrs | namespace-branded `Eid<N>` cleanup |
| Build | `Ripple.query(N)`, `.where`, `.select`, `.orderBy`, `.limit`, `.offset`, `.build` | `Ripple.params`, `.one` / `.oneOrFail`, `.groupBy`, `.after(cursor)` |
| Predicates | `eq` `ne` `lt` `lte` `gt` `gte` `in` `startsWith` `endsWith` `includes` `matches` `exists` `missing`, ref `is`, card-many-ref `some` / `every` / `none` | card-many *scalar* `every` / `none` (a bare predicate on one already means `some`) |
| Combinators | `Ripple.or` `Ripple.not`, nestable | `Ripple.when` (waits on `Ripple.params`) |
| Shape | nested `ref.select`, `.optional`, backlink `.reverse.select` (same grammar for `db.pull`), nested `where` / `orderBy` / `limit` / `offset` on card-many-ref and backlink collections | nested constraints on card-many *scalars*, `every` inside a nested `where`, `.expand`, `.orDefault`, `Ripple.all(N)`, `.reverse` on `:db/isComponent` refs |
| Aggregates | — | `count` `sum` `avg` `min` `max` `countDistinct`, `having` |
| Graph | — | `.traverse` `.paths` `attr.reaches` `Ripple.either` |
| Runners | `db.q` / `db.live` on query values; find-pull lowering; identical-result suppression on `live` | `db.changes`; `Ripple.explain` / `withBasis` |
| Order/limit | AST + engine `order` / `limit` / `offset`; required-field filtering on the peer, before `limit`; card-many and backlink `orderBy` rejected | — |
| IR hatch | — (the string-var callback builder is retired) | `@ripple/alchemy/db/datalog` typed IR, rules |

---

## Roadmap

Rough priority; nothing here changes the shipped API above without an explicit
cut.

### Next (engine / client gaps that unblock everyday queries)

- Card-many **scalar** `every` / `none`: the engine side is fine — the
  `not-join` lowering the many-ref quantifiers use evaluates correctly over a
  scalar hop too (verified). What is missing is the *client spelling* for the
  element inside the inner predicate: `User.tags.every(???)` has no term for
  "the value". No element cursor in the engine is needed, only a way to write
  one; the same gap is why a card-many scalar takes no nested `where` (see
  Shape). A bare predicate on a many scalar already means `some`.
- `every(…)` inside a **nested** collection `where` (see Shape): the pull-phase
  predicates are existential over the values a path reaches, so `∃x ¬P` — the
  shape `every` needs, since an element with no value at all must fail it —
  cannot be said. Same missing element cursor.

### Later

- **`Ripple.params` + `Ripple.when`** for stable, serializable parameterized
  queries. `when` is deliberately not a build-time boolean today: the doc files
  it under parameterization, and that design comes first.
- **Aggregates / `groupBy`**, `.one()` / `.oneOrFail()`, cursors (`.after`).
- **`.expand`** for bounded recursive trees in shapes; then **`.traverse` /
  `.paths` / `reaches`** for graph walks.
- Typed **`@ripple/alchemy/db/datalog`** escape hatch (logic vars as values,
  rules as P1).
- Live **footprint invalidation**, **`db.changes`**, shape-hash multiplexing.
- Optional **`:db/ns` marker** instead of or-join scope; `db.asOf(date)` /
  tx-instant navigation.

### Design notes still open

- Attribute values + lexical shadowing vs lambdas-everywhere for scope.
- Whether `/db/datalog` is promised public API or an unpromised hatch.
- Unbounded `.expand` typing vs literal-`max` type unrolling.
- Default `select` (eids only today) vs implicit `Ripple.all(N)`.
- Named error for schema-drift decode failures on long-lived clients.

---

## Relation to `docs/API.md`

`docs/API.md` describes the portable client (`Db`, catalog, tx, errors). This
doc is the query language that sits on `db.q` / `db.live`; for how reads are
meant to be written, this file is the source of truth.
