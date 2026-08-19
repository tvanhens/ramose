# Query

Ramose’s read surface is a **typed navigational query value**. You build it
from catalog attributes (`Todo.done.eq(false)`, `Todo.owner.name`), run it with
`db.q` / `db.live`, and the client lowers it to the datalog + pull IR the engine
already evaluates — filters, shape, order and paging all run on the peer, in one
round trip.

```ts
import * as Ramose from "ramose/db";

const openTodos = Ramose.query(Todo)
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

Navigation needs a typed ref target. Use `Ramose.Ref(() => Namespace)` or
`Ramose.Ref.self` for self-edges. Untargeted `Ramose.Ref` still works for
`:db.type/ref` storage, but paths like `Todo.owner.name` require a target.

```ts
export const User = Ramose.Namespace("user", {
  name: Ramose.Attr(Schema.String),
  email: Ramose.Attr(Schema.String, { unique: "identity" }),
  friends: Ramose.Attr(Ramose.Ref.self, { cardinality: "many" }),
});

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  due: Ramose.Attr(Ramose.Instant),
  owner: Ramose.Attr(Ramose.Ref(() => User)),
});

export const Todos = Ramose.Catalog({ user: User, todo: Todo });
```

Attribute metadata for navigation uses `attrName` (not `.name`) so a path like
`Todo.owner.name` is not shadowed by the attribute’s own name field. Self-ref
and mutually recursive namespaces use depth-capped / lazy target substitution so
`Todo.owner.friends.name` types under TypeScript without “excessively deep”
instantiation.

---

## Building a query

```ts
Ramose.query(Todo)           // scope: entities that carry at least one :todo/* datom
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

`Ramose.query(N)` denotes entities that carry **at least one** `:n/*` datom. The
lowerer emits an `or` over the namespace’s attributes so membership does not
require a `:db/ns` marker.

### Predicates

Catalog attributes carry the predicate vocabulary. Paths join through refs:

| On | Verbs |
|---|---|
| scalar / string / instant attrs | `eq` `ne` `lt` `lte` `gt` `gte` `in` `exists` `missing` |
| string | `startsWith` `endsWith` `includes` (case-sensitive) `matches` |
| ref | `is` |
| cardinality-many (ref or scalar) | `some` `every` `none` |
| cardinality-many | `each` — one element, for the predicate inside them |

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

#### Quantifiers on a cardinality-many attribute

A many hop in a path has always been existential — the join matches if *any*
element does. `some` names that; `every` and `none` are the other two. The
inner predicate is rooted at the hop's **element**: the ref's target, or the
value itself for a many scalar (see `.each` below).

```ts
User.friends.some(User.name.eq("Ada"))          // at least one friend is Ada
User.friends.every(User.email.exists())         // no friend is missing an email
User.friends.none(User.name.missing())          // no friend is anonymous
User.friends.some(User.friends.some(...))       // quantifiers nest

User.tags.every(User.tags.each.startsWith("a")) // every tag starts with "a"
User.tags.none(User.tags.each.eq("spam"))       // no tag is "spam"
```

`every` and `none` are **vacuously true** of an entity with no elements at all:
"no element fails" and "no element matches" are both true of nothing. So a user
with no `:user/tags` at all matches `User.tags.every(…)`, exactly as a user with
no friends matches `User.friends.every(…)`.

#### Element spelling: `.each`

`attr.each` is **one element** of a cardinality-many attribute, and it is what
the inner predicate of a quantifier over a many *scalar* is written against —
there is no target entity to root a path at, because the element is the value:

```ts
User.tags.each.startsWith("a")   // the value itself, as a predicate
User.scores.each.gt(3)
```

- It keeps the attribute's **value schema**, so the predicates stay typed
  (`User.tags.each.eq(42)` is a type error) and the whole vocabulary applies.
- Its path is **empty**: lowered, it compares the element variable the hop
  binds (`?x`), or the pull's `path: []` — the value itself.
- Only a cardinality-many attribute has one; `.each` on a card-one attr is a
  type error (and throws if forced).
- It is in scope **only inside its own collection**: `attr.every` / `.none` /
  `.some` / `.where` / `.orderBy`, and inside `Ramose.or` / `Ramose.not` within
  them. `User.tags.each` in the query's own `.where`, in `User.friends.every(…)`,
  as a sort key of another collection, or as a select field is a type error and
  a runtime error — the element of a collection means nothing where there is no
  collection.

A bare predicate on a many scalar (`User.tags.eq("x")`) still means "some value
matches"; `User.tags.some(User.tags.each.eq("x"))` is the same thing, said out
loud.

### Combinators

`.where(...)` is conjunctive; `Ramose.or` and `Ramose.not` are how a query says
anything else. Both nest, and both take predicates, quantifiers, or each other:

```ts
Ramose.query(Todo).where(
  Todo.done.eq(false),
  Ramose.or(Todo.owner.name.eq("Ada"), Todo.due.missing()),
  Ramose.not(Todo.title.startsWith("draft")),
);
```

Each is scoped to the query's root entity, so branches need not bind the same
variables and a row matched by two branches still comes back once. `Ramose.or()`
with no branches matches nothing — again, a clause the peer evaluates, not a
client-side short-circuit.

### Reverse refs

`attr.reverse` is the backlink: the same ref hop, read the other way. From a
`User` root, `Todo.owner.reverse` denotes the todos that point at you, and it
works in `where` and in `select`:

```ts
Ramose.query(User)
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
- **A select field is a direct attribute.** Every key names an attribute of the
  namespace being pulled (or a nested `.select` through one of its refs). A
  flattened path is rejected — at compile time and when the query lowers:
  `select({ ownerName: Todo.owner.name })` is an error, because the pull would
  ask the *todo* for `:user/name`. Write the hop as the shape it is:
  `select({ owner: Todo.owner.select({ name: User.name }) })`. This holds
  through `.optional` (`Todo.owner.name.optional` is the same path) and for a
  nested select rooted more than one hop away. Paths remain fine in `.where`
  and `.orderBy`, which join rather than pull.
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

Any cardinality-many attribute is a **collection** — a many ref, a backlink, or
a many scalar — and `.where` / `.orderBy` / `.limit` / `.offset` chain onto the
nav to constrain it:

```ts
Ramose.query(User)
  .orderBy(User.name).limit(20)
  .select({
    name: User.name,
    todos: Todo.owner.reverse
      .where(Todo.done.eq(false))
      .orderBy(Todo.due, "asc", { empty: "last" })
      .limit(5)
      .select({ title: Todo.title }),
    friends: User.friends.where(User.email.exists()).limit(3).select({ name: User.name }),
    tags: User.tags
      .where(User.tags.each.startsWith("a"))
      .orderBy(User.tags.each, "desc")
      .limit(3),
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
- A **card-many scalar** is a collection of values, so its element is
  `attr.each` and nothing else: `User.tags.where(User.tags.each.startsWith("a"))`,
  `.orderBy(User.tags.each, "desc")`. It has no shape to ask for — a string is
  not an entity — so the constrained nav *is* the select field, and the row
  type is unchanged: still `readonly string[]`, with fewer values in it. A bare
  `User.tags` is still the whole collection.
- `Ramose.or` / `Ramose.not` nest as usual, and `some(…)` on a many hop inside
  the predicate is just a longer path (fan-out is existential); `none(…)` is
  its negation.
- `every(…)` works here too, and so does a negation *underneath* a `some(…)`
  (`∃x ¬P`, which is not `¬∃x P`): the pull phase walks the hop element by
  element rather than folding it into a path. `every` is **vacuously true** of
  an element that reaches nothing — `User.friends.where(User.tags.every(…))`
  keeps a friend with no tags at all — the same rule as the query's own
  `every`.
- `orderBy` takes a card-one key from the element (`Todo.due`,
  `Todo.owner.name`), several keys tie-break in order, and `empty` defaults to
  `"last"` in both directions — the same rule as the outer `orderBy`.

Not expressible today, and rejected with an error rather than lowered to
something else:

- Constraints on a **card-one** ref select: there is one entity, not a
  collection — filter it in the query's `.where`.
- A constrained card-many **ref** collection without a `.select({ … })` shape,
  exactly like a bare `.reverse`.
- An element cursor out of its collection: `User.tags.each` only means
  something inside `User.tags`'s own quantifiers and constraints.

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
Ramose.query(Todo).where(/* … */).select(shape)
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
   vacuously true when the hop binds nothing. An `attr.each` predicate has no
   path to walk, so it becomes a ground clause on the element variable the
   chain bound: `[(starts-with? ?x "a")]`.
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
   a path is existential), and each sort key a `{path, dir, empty?}`. A
   card-many scalar's element is the value, so its predicates and sort keys
   carry `path: []`. A quantifier the fan-out cannot absorb — `every(…)`, or a
   negation underneath a `some(…)` — becomes an explicit
   `{every: {path, pred}}` / `{some: {path, pred}}` node, which the engine
   evaluates per reached element.

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
| Build | `Ramose.query(N)`, `.where`, `.select`, `.orderBy`, `.limit`, `.offset`, `.build` | `Ramose.params`, `.one` / `.oneOrFail`, `.groupBy`, `.after(cursor)` |
| Predicates | `eq` `ne` `lt` `lte` `gt` `gte` `in` `startsWith` `endsWith` `includes` `matches` `exists` `missing`, ref `is`, card-many `some` / `every` / `none` on refs **and scalars** (`attr.each` names the element) | — |
| Combinators | `Ramose.or` `Ramose.not`, nestable | `Ramose.when` (waits on `Ramose.params`) |
| Shape | nested `ref.select`, `.optional`, backlink `.reverse.select` (same grammar for `db.pull`), nested `where` / `orderBy` / `limit` / `offset` on every card-many collection — refs, backlinks and *scalars* (via `attr.each`) — including `every` and `not` under `some` inside one | `.expand`, `.orDefault`, `Ramose.all(N)`, `.reverse` on `:db/isComponent` refs. Rejected by design: a **flattened path** as a select field (`{ ownerName: Todo.owner.name }` — write the nested select), constraints on a card-one ref select (one entity, not a collection), and an element cursor outside its collection |
| Aggregates | — | `count` `sum` `avg` `min` `max` `countDistinct`, `having` |
| Graph | — | `.traverse` `.paths` `attr.reaches` `Ramose.either` |
| Runners | `db.q` / `db.live` on query values; find-pull lowering; identical-result suppression on `live` | `db.changes`; `Ramose.explain` / `withBasis` |
| Order/limit | AST + engine `order` / `limit` / `offset`; required-field filtering on the peer, before `limit`; card-many and backlink `orderBy` rejected | — |
| IR hatch | — (the string-var callback builder is retired) | `ramose/db/datalog` typed IR, rules |

---

## Roadmap

Rough priority; nothing here changes the shipped API above without an explicit
cut.

### Next (engine / client gaps that unblock everyday queries)

- **`.orDefault`** in a shape, so a missing scalar reads as a value rather than
  `undefined` — the pull spec's `default` is already there, the client has no
  spelling for it.
- **`Ramose.all(N)`** / a default `select`: a query with no shape yields ids
  today, and the wildcard pull the peer already answers has no client term.
- **`.reverse` on a `:db/isComponent` ref**, whose backlink is single-valued:
  it throws rather than typing an array the peer will not send.
- **Namespace-branded `Eid<N>`** cleanup, so a row cell handed to the next
  query carries the namespace it came from.

### Later

- **`Ramose.params` + `Ramose.when`** for stable, serializable parameterized
  queries. `when` is deliberately not a build-time boolean today: the doc files
  it under parameterization, and that design comes first.
- **Aggregates / `groupBy`**, `.one()` / `.oneOrFail()`, cursors (`.after`).
- **`.expand`** for bounded recursive trees in shapes; then **`.traverse` /
  `.paths` / `reaches`** for graph walks.
- Typed **`ramose/db/datalog`** escape hatch (logic vars as values,
  rules as P1).
- Live **footprint invalidation**, **`db.changes`**, shape-hash multiplexing.
- Optional **`:db/ns` marker** instead of or-join scope; `db.asOf(date)` /
  tx-instant navigation.

### Design notes still open

- Attribute values + lexical shadowing vs lambdas-everywhere for scope.
- Whether `/db/datalog` is promised public API or an unpromised hatch.
- Unbounded `.expand` typing vs literal-`max` type unrolling.
- Default `select` (eids only today) vs implicit `Ramose.all(N)`.
- Named error for schema-drift decode failures on long-lived clients.

---

## Relation to `docs/API.md`

`docs/API.md` describes the portable client (`Db`, catalog, tx, errors). This
doc is the query language that sits on `db.q` / `db.live`; for how reads are
meant to be written, this file is the source of truth.
