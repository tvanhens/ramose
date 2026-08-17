# Ripple: asking a question

Proposal. Breaking. Sits beside `docs/API.md` and replaces its `db.q(build)` / `db.live(build)` / `db.pull`
story. Nothing on `master` is frozen.

## 1. Thesis

**Datalog becomes the IR, not the user language.** You write a typed, navigational query *value* built from
catalog attributes; it compiles to the datalog the engine already evaluates, and the datalog builder survives
as an escape hatch for what the navigational surface cannot phrase.

```ts
const openTodos = Ripple.query(Todo)
  .where(Todo.done.eq(false), Todo.owner.name.startsWith("A"))
  .orderBy(Todo.due, "asc", { empty: "last" }).limit(20)
  .select({ title: Todo.title, owner: Todo.owner.select({ name: User.name }) });
yield* db.q(openTodos);          // Effect<readonly { title: string; owner: { name: string } }[], DbError>
db.live(openTodos);              // Stream<…, LiveError>  — same value, no second builder
yield* db.asOf(t).q(openTodos);  // same value, pinned basis
```

Everything follows. A query is a **value**, not a method on `db` (§4), so one question runs once, live, or in
the past, and hoists out of a React render. Attributes are **values** carrying the predicate and navigation
vocabulary (§4), so `Todo.owner.name` is a join you never named a variable for. `select` is the **shape**,
read back as a type (§9); filtering inside a shape prunes children, in `where` prunes parents. Recursion gets
one verb per cost class (§6); the IR is still there (§7). Today the same question is `db.q((q) =>
q.where("?e", Todo.title, "?t").find("?t"))` — untyped past `?t`, no order, no limit, no join without a second
variable.

Five findings force it, sourced in §13: XTDB shipped EDN datalog for five years, re-litigated it and moved to
SQL plus a pipeline language; DataScript's author, three years inside a datom store, "haven't used a single
query", because UI code wants traversal, not a constraint solver; Datalevin's cost-based planner beats
Postgres on JOB, so clause order is an implementation defect and must never be user-visible; nothing in the
field ships recursion in a typed builder, and nothing in the datalog family ships live.

## 2. Happy path

```ts
export const User = Ripple.Namespace("user", {
  name: Ripple.Attr(Schema.String), email: Ripple.Attr(Schema.String, { unique: "identity" }),
  friends: Ripple.Attr(Ripple.Ref.self, { cardinality: "many" }),
});
export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String), done: Ripple.Attr(Schema.Boolean),
  due: Ripple.Attr(Ripple.Instant), tags: Ripple.Attr(Schema.String, { cardinality: "many" }),
  owner: Ripple.Attr(Ripple.Ref(() => User)),
});
export const Comment = Ripple.Namespace("comment", {
  body: Ripple.Attr(Schema.String), author: Ripple.Attr(Ripple.Ref(() => User)),
  replyTo: Ripple.Attr(Ripple.Ref.self),
});
export const Todos = Ripple.Catalog({ user: User, todo: Todo, comment: Comment });
```

`Ripple.Ref` gains a target (`Ripple.Ref(() => User)`, `Ripple.Ref.self`). Today it is a bare branded
`Schema.Number` (`packages/alchemy/src/db/valueTypes.ts:67-73`), so every ref is untyped past the `Eid` and
there is no navigation and no nested typing: the one schema change this all rests on.

**(a) Filter, order, project — and the one EAV rule.**

```ts
const openTodos = Ripple.query(Todo)
  .where(Todo.done.eq(false), Todo.title.includes("ship"))
  .orderBy(Todo.due, "asc", { empty: "last" }).limit(20)
  .select({ id: Todo.id, title: Todo.title, due: Todo.due.optional });
// Query<readonly { id: Eid<typeof Todo>; title: string; due: Date | undefined }[]>
```

`Todo.done.eq(false)` matches todos that *have* `:todo/done` asserted false; one with no `:todo/done` datom
does not match. The most common real bug in the family, so each meaning is named: `Todo.done.missing()` is "no
`:todo/done` datom", `Ripple.not(Todo.done.eq(true))` is "not asserted true, *including* absent",
`Todo.done.ne(true)` is "asserted, and not true". Absence splits the same three ways in a **shape**: bare
`due: Todo.due` is required, so a todo with no `:todo/due` datom is dropped entirely, while `.optional` types
`Date | undefined` and `.orDefault(d)` (P1) substitutes — hence `.optional` above, since `{ empty: "last" }`
promises missing-`due` todos sort last and a bare `due` would delete them two lines later.

**(b) Join through a ref.** Forward and tabular is §1's example: `Todo.owner.name` is the join, no variable
named. Reverse and nested, filtered and ordered *inside* the nesting — unfiltered, a nested `select` is P0 and
lowers to `(pull ?e …)`:

```ts
const userPage = Ripple.query(User).where(User.email.eq("a@b.c"))
  .select({
    name: User.name,
    todos: Todo.owner.reverse                  // P1 — nested where/orderBy/limit needs `pull*` (§11.8)
      .where(Todo.done.eq(false)).orderBy(Todo.due, "asc").limit(10)
      .select({ id: Todo.id, title: Todo.title, tags: Todo.tags }),
  }).one();   // Query<{ name: string; todos: readonly {…}[] } | null>
```

**(c) Recursion in the shape.** `.expand(opts, nodeShape)` walks a card-many ref and rebuilds it as a tree;
the node shape is a separate value, so the recursive type is nameable and the root reuses it by spreading. The
recursion key is the `select` key the `expand` sits under (`replies`); sibling order inside an `expand` is
unspecified in v1, the same P1 item as (b).

```ts
const replyNode = { id: Comment.id, body: Comment.body,
                    author: Comment.author.select({ name: User.name }) };
const thread = Ripple.query(Comment).where(Comment.id.eq(rootId))
  .select({ ...replyNode, replies: Comment.replyTo.reverse.expand({ max: 20 }, replyNode) }).one();
type Reply = Ripple.Node<typeof thread, "replies">;
// { id: Eid<typeof Comment>; body: string; author: { name: string }; replies: readonly Reply[] }
```

**(d) Run it: once, live, in the past.** `openTodos` is a module-level value, already the stable dependency
`useLive` needs (`docs/API.md` §3), and a `transact` bumps the session basis so every standing `live` re-runs
— read-your-writes is what makes a checkbox work. Time stays on the `Db`; under `db.history` a query ranges
over **datoms** (§4).

```ts
db.live(openTodos);               // Stream<…, LiveError> — same value, no second builder
yield* db.asOf(t).q(openTodos);   // same value, pinned basis; .live on it emits once and completes
yield* db.history.q(Ripple.query(Todo).where(Todo.id.eq(e))
  .select({ title: Todo.title, tx: Todo.title.tx, op: Todo.title.op }));
// readonly { title: string; tx: number; op: boolean }[]
```

**(e) Params, and an optional filter.** `Ripple.when(maybe, fn)` yields a predicate that vanishes when `maybe`
is `undefined`, so a filter bar with three optional inputs is **one** query value with one shape hash instead
of eight.

```ts
const todosFor = Ripple.params(
  { owner: Ripple.Eid(User), tag: Schema.optional(Schema.String) },
  (p) => Ripple.query(Todo)
    .where(Todo.owner.eq(p.owner), Ripple.when(p.tag, (t) => Todo.tags.some(t)))
    .orderBy(Todo.due, "asc", { empty: "last" }).select({ id: Todo.id, title: Todo.title }));
yield* db.q(todosFor, { owner: alice, tag: undefined });   // db.live(todosFor, args) likewise
```

**(f) Aggregate, count, group.** `Ripple.count()` counts the group's scope entity and `orderBy` takes a
`select` key, so an aggregate is never re-spelled; `Ripple.countDistinct(attr)` counts the group's *distinct*
values of `attr`, which is what you want whenever `:with` has restored a card-many multiplicity. Filtering
*after* aggregation (`having`) is P2 — until then, filter the returned rows. Grouping multiplies rows in EAV, so the compiler emits
`:with` for every card-many var in the group; an aggregate over an attribute reachable only *through* a
card-many ref is a compile error, since the count would be the join's — use a nested count (below), which also
keeps the zero rows.

```ts
Ripple.query(Todo).where(Todo.done.eq(false)).groupBy(Todo.owner)
  .select({ owner: Todo.owner.select({ name: User.name }), open: Ripple.count(),
            latest: Ripple.max(Todo.due) })
  .orderBy("open", "desc").limit(10);   // readonly { owner: {name}; open: number; latest: Date }[]
Ripple.query(User).select({ name: User.name,          // users with zero todos survive
  openCount: Ripple.count(Todo.owner.reverse.where(Todo.done.eq(false))) });
```

**(g) Negation and disjunction.** `where` is variadic and conjoins; there is no `Ripple.and`, and `.some(me)`
on a card-many ref is sugar for `.some(User.id.eq(me))`.

```ts
Ripple.query(User).where(Ripple.not(Todo.owner.reverse.some(Todo.done.eq(false))));  // no open todo
Ripple.query(Todo).where(Ripple.or(Todo.owner.eq(me), Todo.owner.friends.some(me)),
                         Todo.tags.none("archived")).select({ title: Todo.title });
```

## 3. Surface: what ships when

Every public name, tagged. §2's happy path uses v1 only, except where a line says `P1`.

| group | v1 | P1 | P2 |
|---|---|---|---|
| schema | `Ref(() => N)` `Ref.self` `Eid(N)` | — | — |
| build | `Ripple.query(N)` `Ripple.params(schemas, fn)` | — | — |
| chain | `.where` `.select` `.orderBy` `.limit` `.offset` `.groupBy` `.one` `.oneOrFail` | `.after(cursor)` `Ripple.cursor(query, row)` | — |
| shape | `refAttr.select` `attr.reverse` `.optional` `.expand(opts, node)` | `.orDefault(v)` `Ripple.all(N)` | — |
| predicates | scalar `eq ne lt lte gt gte in exists missing`; string `startsWith includes`; card-many `some every none`; card-one ref `eq(eid)` `is(pred)` | `endsWith matches` | — |
| combinators | `Ripple.or` `Ripple.not` `Ripple.when` | — | — |
| aggregates | `Ripple.count` `sum avg min max countDistinct` | — | `having` |
| pseudo-attributes | `.id` `.tx` `.op` | `Ripple.depth` `Ripple.parent` | — |
| graph verbs | — | `.traverse` `.paths` `attr.reaches` `Ripple.either` | shortest path |
| transformers | `Ripple.explain` `Ripple.withBasis` | — | — |
| IR (`/db/datalog`) | `Datalog.query`; `q.var match not or orJoin rel select where` | `Datalog.rule` `q.let` | — |
| types | `Query<R, E>` `ParamQuery<A, R, E>` `Pull<P>` `Eid<N>` `LookupRef<C>` `Row<Q>` `Result<Q>` `Node<Q, K>` `Predicate<N>` `Shape<N>` `NotFound` `NotSingle` `LiveError` | `Cursor` | `Change<R>` |
| option keys | `empty` (`first\|last`) `max` `onCycle` (`prune\|idOnly\|fail`) | `min` `mode` (`walk\|trail\|simple\|acyclic`) | — |
| runners | `db.q` `db.live` `db.pull` `db.asOf(t)` `db.history` | `db.asOf(date)` | `db.changes` |

That is **~40 new names in v1**, plus ~10 more behind the `/db/datalog` subpath that are exposure, not
promise, against `docs/API.md`'s whole-client 39. **This proposal adds far more names than §10 removes** —
§10's net public deletions are about five. The trade: the added names are a closed, typed vocabulary a planner
and a live layer can both read where today's five are a string grammar neither can; everything on the P1/P2
lists is additive.

## 4. How a query is built

**A query is a value, not a method on `db`.** `Ripple.query(Todo)`, not `db.from(Todo)`: a query must run
against `db` and `db.asOf(t)` unchanged, hoist out of a React render (`docs/API.md` §3), live in client-free
shared code, and be registerable by name server-side. `db` stays the runner, and transformers are values too,
so `Db` grows no methods: `Ripple.explain(query)` gives `Query<Explained<R>, E>`, `Ripple.withBasis(query)`
gives `Query<{ value: R; t: number }, E>`, and `Ripple.params(schemas, fn)` — not a transformer — takes a
function returning a query.

**What `Ripple.query(N)` denotes.** Nothing marks an entity as belonging to a namespace (`Namespace.ts:45-70`
is an ident prefix), so the scope needs a lowering: **an entity is an `N` if it carries at least one `:n/*`
datom** — an or-join over `N`'s attributes, all of whose branches bind only the scope var, as
`engine.ts:593-609` requires. So `Todo.done.missing()` means "carries some `:todo/*` datom and not
`:todo/done`". The compiler rejects a *nested* scope — a `some`/`every`/`none` body, an `.is` body, a
`Datalog.query` `where` — containing only negative subgoals, because negation is stratified over a bound
scope. A `:db/ns` marker datom is the cheaper alternative (§12).

**Scope binding: nearest enclosing scope wins.** A bare attribute binds to the nearest enclosing scope of its
namespace — lexical shadowing, the rule TypeScript uses for identifiers. The scope-shifting constructs are
`Ripple.query(N)`, `.traverse`, `.expand`, a nested `select` on a ref, and `some`/`every`/`none`/`is`. So in
`Todo.owner.friends.some(User.name.eq("Bob"))` the inner `User` is the friend, while in `.select({ owner:
Todo.owner.select({ name: User.name }) })` it is the owner. A lambda names a scope explicitly, and only to
reach *past* a shadow: in `Ripple.query(Comment).where((c) => c.replyTo.is(Comment.author.eq(c.author)))` —
replies by the parent's own author — `Comment.author` is the parent's, `c.author` the row's.

**Three pseudo-attributes every namespace has.** `Todo.id` is `:db/id`, typed `Eid<typeof Todo>`, usable in
`where`, `select`, `orderBy`, `groupBy`. On any attribute, `.tx` and `.op` are the datom's transaction and
add/retract flag (`ast.ts:19-27`), meaningful only under `db.history`, where the db returns retractions too
and a query ranges over datoms, not entities. Rules there: a `select` may project `.tx`/`.op` from **at most
one** attribute; `.one()` and shape recursion are rejected; history queries lower to find vars, never to pull,
which has no tx/op term.

**The predicate vocabulary is closed** — one vocabulary for card-many whatever the value type, so
`Todo.tags.some("urgent")` and `Todo.owner.friends.none(User.name.eq("Bob"))` are one construct.

| on | verbs |
|---|---|
| any scalar attr | `eq ne lt lte gt gte in exists missing` |
| string | `startsWith includes` |
| card-many attr (scalar or ref) | `some every none` — a predicate, or a bare value/eid as `eq` sugar |
| card-one ref | `eq(eid)`, `is(predicate)` |
| combinators | `Ripple.or`, `Ripple.not`, `Ripple.when` |

`startsWith` is index-backed (AVET prefix); `includes` and `ne` are scans, both case-sensitive — no `ci` in
v1. Closed, so the planner sees every predicate and the live layer can compute a footprint; §7 is the hatch.

**Paths, and shape vs predicate.** `Todo.owner.name.startsWith("A")` is a two-datom join with an implied
existential — dotted paths, typed, compiled to fresh generated variables; through a card-many ref a path means
`some`, and for `every`/`none` you say so. Whether a filter on a child restricts the child set or the parent
set gets two constructs, not one plus an `!inner` modifier: `.select({ todos: Todo.owner.reverse.where(...)
})` is a **shape**, pruning the nested array so parents with no matching children still appear with `[]`;
`.where(Todo.owner.reverse.some(...))` is a **predicate**, pruning parents. Same index scan, different result
types.

**Order, limit, cursor.** The chain is order-free with one exception: **`select` is last**, before
`.one()`/`.oneOrFail()`. `.orderBy(attr, "asc" | "desc", { empty: "first" | "last" })`; in EAV `empty` is not
garnish, because absence is not SQL `NULL` — it lowers to `get-else` (`engine.ts:493-513`) with a sentinel
sorting to the requested end, so missing-attribute entities are ordered, never dropped. Multi-key ordering is
repeated `.orderBy` calls, and `.orderBy("key", dir)` orders by a `select` key — how you order by an
aggregate, `Ripple.depth`, or a nested count. `.limit`/`.offset` are v1; `.after(cursor)` is P1, a cursor
being the opaque encoding of the `orderBy` key tuple plus `:db/id`, `orderBy` mandatory, `Ripple.cursor(query,
row)` minting one — offset paging over dense transaction time is a lie.

**Cardinality.** `.one()` types `T | null` and **fails `NotSingle` on more than one row** — Gel's
`filter_single`, not Zero's silent first; "first" is `.limit(1).one()`. `.oneOrFail()` types `Query<T,
NotFound>`, joined into `db.q`'s error channel; `db.live` accepts only `Query<R, never>`, so `.oneOrFail()`
under `live` is a compile error.

**`select` is the shape.** No `select` yields `readonly Eid<typeof Todo>[]`: an entity has no intrinsic shape
in an EAV store, so shape is produced by the pattern, result shape mirrors query shape, and fields you did not
ask for are *absent from the type*, not `undefined`. A **card-one** ref projects as an object and takes no
`where`/`orderBy`/`limit`; a **card-many** ref, including every reverse ref, takes the full modifier set.
Under a policy-filtered `Db` a required field the viewer cannot see drops the whole entity, so the list looks
*short*, not forbidden, with nothing changed in the type: use `.optional` on cross-entity fields read under
auth, and `limit` applies *after* required-field filtering, server-side (§11.6). `Todo.owner.reverse` is
itself a value — "card-many ref from `User` to `Todo`" — composing everywhere a forward ref does; rejected:
`User.$owner` / `:todo/_owner`, ambiguous once two namespaces have an `owner` ref into `User`. `.orDefault(v)`
(P1) lowers to pull `:default` (`pull.ts:137-142`), which the typed layer cannot emit.

**Params, and why the value matters.** `Ripple.params({ owner: Ripple.Eid(User) }, (p) => …)` is Gel's
`e.params` with Effect Schema decoding — the `Request`/`Result` split of `SqlSchema.findAll`, where
`Ripple.Eid(N)` decodes a wire number into the branded `Eid`. Three consequences: it has a **stable hash**
independent of its arguments, so the server registers the shape once and multiplexes cohorts differing only in
scalars; it is **serializable**, so it can be sent, named, cached and permission-wrapped server-side; and its
**footprint** is statically computable, the basis of §11's P2 work. `db.live(query, args)` returns a stream
**stable for `Equal`-equal args on the same query value**, so a keystroke producing the same args does not
tear down the subscription; ordinary React usage is `useLive(db.live(q, args))`, `args` memoised by value.

## 5. Find + pull: one language, two layers

Today datalog says *which entities* and pull says *what tree*, joined by `.pull(pattern)` (`Query.ts:182-192`)
and executed as a client-side N+1 (`Db.ts:266-280`, concurrency 16, rows dropped when a pull returns `null`);
the pull side cannot filter or order a nested collection at all. XTDB v2 resolved it better — **nesting is a
subquery operator inside the query** — and it is easier in TS than in EDN because an object literal already
expresses tree shape. So a nested `select` on a ref *is* a subquery with its own
`where`/`orderBy`/`limit`/`offset`, more expressive than Datomic pull's lone `:limit`; unfiltered lowers to
`(pull ?e …)` today, filtered needs §11.8's correlated operator. Recursion in a shape is `.expand({ max,
onCycle }, nodeShape)`, `max` mandatory because a cyclic graph produces an infinite tree, `max: 0` yielding
the seed with the recursive key absent; depth exhaustion follows the same knob, so `max` is visible in the
value, not the type.

| `onCycle` | behaviour | node type |
|---|---|---|
| `"prune"` (default) | stop at the repeated entity, omit it | `readonly Node[]` |
| `"idOnly"` | emit `{ id }` and stop — Datomic's documented behaviour, named | `readonly (Node \| { id: Eid<N> })[]` |
| `"fail"` | `DbError` | `readonly Node[]` |

**`db.pull` keeps its job** as the entity-by-id door: "I have an `Eid` from a route param, give me this shape"
should not require a `where`. What changes is that its second parameter is the *same shape grammar* as
`select` — one shape language, not two — renamed `pattern` → `shape`, so `db.pull(eid, shape)` types
`Effect<Pull<typeof shape> | null, DbError>`. The value form, when you need `withBasis`, params or `live`, is
`Ripple.query(Todo).where(Todo.id.eq(eid)).select(shape).one()`; there is no `Ripple.entity`.

## 6. Graph queries — the P1 roadmap

**Everything in this section is P1.** There is no recursion in the engine today beyond pull's `...` (§11), so
`.expand` is v1's only recursion; the design is fixed here so the verbs land additively. Every variable-length
walk resolves to one of four result shapes differing by orders of magnitude in cost, and Ripple makes you pick
by *verb*, so each gets its own static type.

| verb | position | result | engine |
|---|---|---|---|
| `.traverse(step, { min, max })` | scope | moves the scope to the deduped endpoint set | semi-naive fixpoint over the ref index |
| `.paths(step, { max, mode })` | scope | `{ depth, nodes }[]` | per-traverser history; exponential worst case |
| `.expand({ max, onCycle }, node)` | shape | recursive tree | bounded BFS, re-parented (**v1**) |
| `attr.reaches(target, { max })` | predicate | boolean | BFS with early exit |

**Depth is shortest-path depth**: a node sits at the length of its *shortest* path from the seed, so one
reachable at 1 and at 3 hops is a 1-hop node, excluded by `{ min: 2 }`. Hence `.traverse` terminates on cycles
by construction and `Ripple.depth` is well defined; `min: 0` includes the seed, `max: 0` is the seed alone.

```ts
Ripple.query(User).where(User.id.eq(me)).traverse(User.friends, { min: 2, max: 2 })  // fof: no guards
  .select({ id: User.id, name: User.name });        // me is depth 0, direct friends depth 1
Ripple.query(Comment).where(Comment.id.eq(cid))     // ancestors, deepest last
  .traverse(Comment.replyTo, { max: 20 }).orderBy(Ripple.depth, "asc")
  .select({ depth: Ripple.depth, id: Comment.id, body: Comment.body });
Ripple.query(Comment).where(Comment.replyTo.reaches(rootId, { max: 50 }));   // cheap, early exit
.traverse(Ripple.either(Comment.replyTo, Comment.replyTo.reverse), { max: 6 })
.traverse(User.friends.where(User.name.exists()), { max: 4 })   // per-hop filter, on the step
```

`Ripple.depth` is a pseudo-attribute, not a wrapper: the `select` shape keeps meaning "the row", so ordering
by depth falls out for free, and `Ripple.parent` (the hop's predecessor) lets a `traverse` result rebuild into
a tree without paying for `.paths`. A step is a ref attribute, `.reverse` of one, or `Ripple.either(...)` of
several — SPARQL's `^` and `|` inside the quantifier; a per-hop filter is a method on the step, not an option
key. A node failing a hop predicate is **not entered and not marked visited**: predicates are pushed *into*
frontier expansion, so another branch can reach it.

**Cycles are a property of a path, not of a node**, which is why `.paths` takes `mode` (`"walk" | "trail" |
"simple" | "acyclic"`, GQL's four, default `"trail"`) instead of `onCycle`: the question is which repetitions
a *path* may contain, and the four answers are not three prunings of one policy. `.paths` is also the one verb
whose row is not a node (`select` describes each node, the row is `{ depth, nodes }`) and the only one whose
cap we refuse to make optional, since it carries a full history per traverser where `.traverse` carries a
frontier of eids. Unbounded is opt-in as `{ max: "unbounded" }`, never `{}`; there is no `timeout`,
`QueryBudgetExceeded` covers it. Shortest-path (`SHORTEST 1`, `+shortest`) is out: it needs weights and a
different operator, and no result type above answers it. Rejected: ASCII-art patterns in a template literal,
and Dgraph's `@recurse`.

## 7. The escape hatch: the datalog IR

The engine is a fairly complete Datomic-shaped evaluator — predicates, functions, binding forms,
`not`/`not-join`, `or`/`or-join`, aggregates, `:with`, `:keys`, all four find specs, `:in` including
coll/tuple/rel, pull-in-find, as-of/history — and the wire already accepts all of it
(`packages/worker/src/index.ts:243-258`, `packages/replica/src/replica-do.ts:312-347`). Only the typed builder
is narrow, because `toQueryObject` throws the rest away (`Query.ts:212-218`) and `db.q` hardcodes `inputs: []`
(`Db.ts:251`). So the hatch is exposure, not new work, shipped as the subpath `@ripple/alchemy/db/datalog` so
the main entry stays small. Logic variables become **typed values**, and a query is still an expression, never
an accumulator:

```ts
import * as Datalog from "@ripple/alchemy/db/datalog";
// today: db.q((q) => q.where("?e", Todo.title, "?t").find("?t"))
const titles = Datalog.query((q) => {
  const e = q.var(Ripple.Eid(Todo)), t = q.var(Schema.String);
  return q.select({ title: t }).where(q.match(e, Todo.title, t));
});   // Query<readonly { title: string }[]>
```

`q.var(schema)` is branded, so a `string` variable will not unify with a ref slot — the static check EDN
datalog cannot give you — and because variables are values, query fragments become ordinary TS functions.
`q.select` always takes a record, like every other `select` here. Also here and nowhere else:
`q.or`/`q.orJoin` with explicit exported variables, `q.not`, aggregates with `with` for multiplicity control,
`q.rel(rows)` relation inputs (joining server data against local client state), and raw find specs over
arbitrary variables.

Rules are P1, because the parser refuses them outright today (`parse.ts:147`). They are typed TS functions —
Cozo's contribution, rules as *the* primary abstraction — taking a typed head record, a body of the same `q.*`
combinators plus `q.let` for existential intermediates, and the depth and cycle knobs Datomic's rules lack:
`Datalog.rule({ child: Eid(Comment), anc: Eid(Comment) }, (q, h) => […], { max: 100, onCycle: "prune" })`. The
name is optional and explain-only, a rule value is callable inside another body, and multiple bodies with one
head are a disjunction (Datomic's `or`).

## 8. Running: once vs live

```ts
db.q<R, E>(query: Query<R, E>): Effect<R, DbError | E>
db.q<A, R, E>(query: ParamQuery<A, R, E>, args: A): Effect<R, DbError | E>
db.live<R>(query: Query<R, never>): Stream<R, LiveError>
db.live<A, R>(query: ParamQuery<A, R, never>, args: A): Stream<R, LiveError>
db.pull<const P>(subject: Eid<N> | LookupRef<C>, shape: P): Effect<Pull<P> | null, DbError>
```

**Live is the definition; once is a special case.** `db.q(query)` is semantically `db.live(query) |>
Stream.take(1) |> Stream.runHead`, specialised for performance. TanStack DB derives `queryOnce` from the live
path for the same reason: if the two can disagree, they will.

**Full re-emit, whole values.** Every emission is the complete result — what Instant, Zero, Convex and Dgraph
all deliver, and what `Db.ts:345-361` does. Identical consecutive results are suppressed client-side (P0,
client-only; today they are not); a diff channel, `db.changes(query): Stream<Change<R>, LiveError>` with
enter/update/exit, is deliberately P2. A result reflects a `t`, and `Ripple.withBasis(query)` makes it visible
rather than adding a `Db` method — the analogue of Zero's `resultType`, an authoritative server saying
"complete as of `t`".

**Time is a `Db`, not a clause.** `db.asOf(t)` and `db.history` remain pure `Db -> ReadDb` (`Db.ts:373-378`),
and `live` over a pinned view emits once and completes (`Db.ts:329`) — of everything in the datalog family,
the idea that survived every successor.

**Effect-native.** `LiveError` is the four terminal tags — `InvalidRequest`, `Unauthorized`,
`DatabaseNotFound`, `QueryBudgetExceeded` (`Db.ts:296-309`) — not all of `DbError`, so a `catchTags` over a
live stream is exhaustive and transient failures retry in place. `Stream` requirements stay `never`, teardown
is fiber interruption, scalars decode through Effect Schema (a `Ripple.Instant` arrives as a `Date`), and
provisioning mistakes stay defects.

## 9. Typing

The result type is a type-level interpretation of the query value against the catalog — `InstaQLResult<Schema,
Query>` and `co.loaded<Schema, Resolve>` are the same trick under two coats.

| source | effect on the type |
|---|---|
| shape key | the key appears; keys you did not ask for are absent, not `undefined` |
| `cardinality: "many"` / ref target | `readonly T[]` / nested object type from the target namespace |
| `.optional` / `.limit` `.offset` `.orderBy` `.groupBy` | `T \| undefined` / no effect on the type |
| `.one()` / `.oneOrFail()` | `T \| null` (`NotSingle` at runtime on >1) / `Query<T, NotFound>`, rejected by `db.live` |
| `.expand(…, node)` | `readonly Node[]` recursive, depth not tracked; `onCycle: "idOnly"` → `readonly (Node \| { id: Eid<N> })[]` |
| `Ripple.depth` (P1) / `Ripple.params` | a `number` key like any pseudo-attribute / `ParamQuery<A, R, E>`, `A` the decoded args |

**Exported helpers**, because every React prop needs one: `Ripple.Row<typeof q>` (the element),
`Ripple.Result<typeof q>` (the whole thing, so `.one()`'s `| null` survives), `Ripple.Node<typeof q,
"replies">` (an `expand`'s node), plus `Ripple.Predicate<N>` / `Ripple.Shape<N>`.

**Compile errors:** an attribute not in the query's namespace or a reachable path; a predicate whose value
type does not match the attribute; `some`/`every`/`none` on a card-one attr, or `is` on a card-many one;
`where`/`orderBy`/`limit` on a card-one ref's nested select; `.select` on a non-ref; `.expand` or `.paths`
without `max`; `orderBy` on or through a card-many ref; an aggregate over an attribute reachable only through
a card-many ref; `.oneOrFail()` passed to `db.live`; a nested scope with only negative subgoals; the wrong
args for a `ParamQuery`. **Runtime errors:** `QueryBudgetExceeded` (`engine.ts:41-84`), `NotSingle`,
`NotFound`, `InvalidRequest`. Note what moves: today `find("?x")` on a never-bound variable types as `unknown`
and fails at runtime with no compile error (`Query.ts:113-121`); that state is now unconstructible.

**Where inference gives up.** `.expand` types recursion with no depth in it, and a runtime-built shape falls
back to `Pull<Shape>` — the honest escape being `Datalog.query` plus a `Schema` decode. `Ripple.all(N)` is
deferred to P1 precisely because it is *not* the engine's `[*]`, which returns every attribute an entity
carries, card-many and foreign included (`pull.ts:58-68`); "every card-one scalar here" needs client
filtering.

**Risk: the recursive navigation types are the single riskiest claim here.** Mutually recursive namespaces —
`Ripple.Ref(() => User)` in `Todo`, `Ripple.Ref(() => Todo)` in `Comment` — are consts whose inferred types
reference each other through thunks, so each cycle needs an explicit `Namespace<…>` annotation on one member,
and the target substitution must be **lazy** or `Todo.owner.friends.friends.name` re-instantiates the target's
whole attribute map per hop. This repo already hit the ceiling on a *flat* pull: `ValidatePull` collects
idents into a union rather than recursing per field, commented as producing `Type instantiation is excessively
deep` (`Pull.ts:186-215`). **Prototype `Todo.owner.friends.name` under `tsc --extendedDiagnostics` first.**

**Gate result (2026-08-17):** **PASS** — see [`docs/QUERY_TYPING.md`](./QUERY_TYPING.md). Depth-capped
inference and interface-deferred encodings both type `Todo.owner.friends.name` on TypeScript 5.9.3 with
~2.5k instantiations for the isolated prototype. Stamping a public `.name` on attrs shadows navigation and
must not ship.
**Two catalog-level cleanups this forces.** `Eid<C>` narrows from catalog- to namespace-branded — `Eid<typeof
User>` — because a ref target must be a type before navigation works, and the brand is `{ readonly id: number
} & { readonly [Brand]: N["ns"] }` with a **required** unique-symbol key, not a phantom optional field:
otherwise `Eid<typeof User>` and `Eid<typeof Todo>` stay mutually assignable and the compile error for a
mistyped ref predicate never fires. And plain `Schema.Number` still becomes `:db.type/double`
(`valueTypes.ts:31-33`) while `Uuid` reads back as `{ vt: 6, v: string }` (`valueTypes.ts:49-57`) — storage
details leaking into user types.

## 10. What dies

| current | fate |
|---|---|
| `db.q(build)` / `db.live(build)` callback shape | → `db.q(query)` / `db.live(query)`; the query is a value |
| `"?e"` / `"?t"` string vars, `QueryVar`, `QueryBlank`, `EntitySlot` (`Query.ts:16-20`) | gone from the primary surface; typed `q.var(schema)` in the IR |
| `QueryBuilder.where(e, a, v)`; `find(...vars)` returning positional tuples (`Query.ts:113-127`) | → `.where(predicate)` and `select(shape)` returning records; raw triples and tuples only in `/db/datalog` |
| `.explain(...vars)` terminal on the builder | → `Ripple.explain(query)` transformer |
| `FindQuery.pull(pattern)` (`Query.ts:182-192`) and its `SoleEidVar` gate | → nested `select`; server-side, not a second call |
| client-side N+1 pull fan-out (`Db.ts:266-280`), silently dropping rows whose pull returned `null` (`Db.ts:275-279`) | → one query, pull lowered into `:find` (`engine.ts:1186-1194`); `.optional` decides, explicitly, before `limit` |
| pull as a second grammar; `attr.with(pattern)` (`Pull.ts:38-74`) | → `attr.select(shape)`, same grammar as `select` |
| `db.pull`'s second parameter, named `pattern` (`API.md:53`) | → `shape`; one word for one concept |
| `Pull<C, P>`, `Query<C, R>` (`API.md:59`), `Eid<C>` | → `Pull<P>`; `Query<R, E>` with `E` defaulting to `never` and carrying `NotFound`; `Eid<typeof User>` with a required unique-symbol brand |
| `LookupRef<C>` | unchanged — still catalog-branded; it is resolved before a namespace is known |
| untargeted `Ripple.Ref` (`valueTypes.ts:67-73`) | → `Ripple.Ref(() => User)` / `Ripple.Ref.self` |
| ident-array pull escape `[User.name, "*"]` (`Pull.ts:142-178`) | → `Ripple.all(User)` at P1; all-optional typing kept, honestly named |
| `Explained.explain: readonly unknown[]` (`Query.ts:132-139`) | typed plan nodes, or it is not worth shipping |
| `Stream<R, DbError>` from `db.live` | → `Stream<R, LiveError>` — the four terminal tags only |

**Kill-list, honestly.** Those are ~5 net public deletions against §3's ~40 additions. What today's builder
loses — positional tuple results over arbitrary variable combinations, raw `where(e, a, v)` triples with
variables in the attribute slot, blank `_` matching, 5-component datom patterns — is all still expressible in
`@ripple/alchemy/db/datalog`, a superset of today's builder. Nothing that works today becomes impossible; it
moves one import away.

## 11. What the engine must grow

Ranked from the audit. Nothing below changes `docs/API.md` §6's invariants — except item 16's cross-session
form, incompatible with auth-as-a-filtered-`Db`, so only per-session cohorts are in scope. Queries are reads;
`db.q` and `db.live` never mint a `t`.

**P0 — expose what exists, and stop the N+1.**

1. **Reach the engine's existing language from the typed surface**: `not`, `or`/`or-join`, predicates,
   functions, aggregates with `:with`, all four find specs, `:in` inputs, `(pull ?e …)` in `:find`, plus a
   hardened `(q <query> $ ?x)` (`engine.ts:514-522`) for nested counts. Zero engine work — the loss is
   `toQueryObject` (`Query.ts:212-218`) and `inputs: []` (`Db.ts:251`), so `some`/`every`/`none`, `or`,
   `count`, `groupBy` and `params` are exposure, not new evaluation.
2. **Namespace scope**: the or-join over `N`'s attributes (§4) — compiler work plus, worst case, one AEVT
   scan per attribute.
3. **Server-side pull-in-query**: lower the shape into the find spec instead of one pull per row at
   concurrency 16 (`Db.ts:266-280`); the engine side exists (`engine.ts:1186-1194`).
4. **Reverse refs, `:limit`, `:default`, recursion in the pull lowering** — the engine has all four
   (`pull.ts:83-142`), `lowerField` emits none (`Pull.ts:280-302`). `.expand`'s whole lowering.
5. **`order`/`limit`/`offset` in the AST**, absent from `ast.ts:80-86`, so rows come back in join order; `{
   empty }` lowers to `get-else` (`engine.ts:493-513`) with an end-sentinel.
6. **Required-field filtering server-side, before `limit`** — `filterPull` drops entities on the client after
   the query returned (`Pull.ts:330-403`), so a required field and a `limit` disagree.
7. **Suppress identical consecutive results** in `Db.live` (`Db.ts:345-361`) — client-only, and the difference
   between a usable list and one that re-renders at 1 Hz.

**P1 — nested subqueries, the graph work, the planner.**

8. **A correlated nested-relation operator** (XTQL's `pull*`): evaluate an inner query with its own
   `where`/`order`/`limit`/`offset` against a bound outer var, returning a relation-valued column. Pull cannot
   host it (`pull.ts:80-142`); blocks §2(b) and §2(c)'s sibling ordering.
9. **Rules, non-recursive, plus a `:rules` input** — parse and inline before planning; `parse.ts:147` refuses
   them today. Parser plus substitution; executor untouched.
10. **Fixpoint / semi-naive recursion**: `Rel` has no delta (`engine.ts:110-113`) and `execClauses` is one
    pass, so this needs a delta relation, stratification and cycle-safe termination.
11. **Bounded traversal operators**: frontier BFS with shortest-path `min`/`max`, per-hop predicate pushdown,
    VAET as fast as EAVT, then **path enumeration** with a mandatory cap and the four modes. **Cursors**
    encode the `orderBy` key tuple plus `:db/id`.
12. **A planner** — clause order must never be user-visible. Today's is greedy over hand-tuned constants
    (`engine.ts:337-394`) with no join-order search and no statistics, so it mis-plans recursion,
    aggregate-then-join, filtered dbs and deep path joins.
13. **Time as time**: `db.asOf(date)` and `:db/txInstant`, `.tx` navigable as a ref to the tx entity — without
    it, history renders as "changed at tx 91847".

**P2 — live, done properly.**

14. **Query footprint → invalidation.** Index standing queries by the `(attribute, entity-frontier)` set they
    read; today every wake re-runs the query and re-emits everything at up to 1 Hz per client
    (`Db.ts:345-361`). Attributes under `not`, `none`, `missing`, `every` or a fixpoint are over-approximated
    **by attribute, never refined by entity** — a retraction outside the answer can make an entity enter.
15. **Diff stream** (`db.changes`) — needs a socket protocol carrying more than `{op:"t"}`.
16. **Multiplexing** standing queries by shape hash, which §4's params make possible — per-session cohorts
    only, since cross-session cohorts serve one execution to many tenants, which a filtered `Db` forbids.
17. **Policy-aware estimates.** `Db.estimate` is not policy-filtered even when the db is
    (`policy/filter.ts:45-58`), so a low-privilege user can hit `QueryBudgetExceeded` on three rows.

## 12. Open questions

1. **Attribute values vs lambdas as the primary spelling.** This proposal picks attribute values with lexical
   shadowing and lambdas only to reach past a shadow; lambdas everywhere is more uniform and worse to compose.
   Is the two-spelling rule a cost we regret?
2. **Is `@ripple/alchemy/db/datalog` promised API?** Subpathing it means the hatch exists without committing
   to typed logic variables and rules as a public contract. Default: ship it, unpromised.
3. **`.expand` typing depth.** The type is unbounded recursion while the runtime is bounded — accept that, or
   take a literal `max` and unroll the type to it, paying in compile time? And `{ max: "unbounded" }` on
   `traverse`: forbid it until the planner can cost it?
4. **`:db/ns` marker datom instead of the or-join scope lowering.** Cheaper on every read, but a write-path
   change and a migration for existing data.
5. **Should `select` default to something?** No `select` yields eids only; `Ripple.all(N)` as the implicit
   default would be friendlier and would train people into a bad habit.
6. **Tx metadata shape.** Does `.tx` become a ref into a `Tx` pseudo-namespace with `instant`, or a scalar
   with a separate lookup?
7. **Schema-drift decode failure needs a name** — a tab open for a week against a redeployed catalog is the #1
   production incident, and today it has no tagged error.

## 13. Field notes

| family | filter | join | N-hop | live | Ripple takes |
|---|---|---|---|---|---|
| Prisma / Drizzle RQB | `where` data object | `include`/`select` with `some`/`every`/`none` vs `is`; `with: { posts: { where, orderBy, limit } }` | ✗ (TypedSQL) | Pulse (paused) / local driver | the cardinality-aware filter vocabulary; the full modifier set at every nesting level |
| Kysely | `.where(col, op, v)` + `eb` callback | explicit joins, `jsonArrayFrom` | `withRecursive` ✓ | ✗ | one-vs-many decided by the combinator |
| Gel/EdgeDB | shape object in a callback | shapes with nested `filter`/`order`/`limit`, backlinks | ✗ (open issue) | ✗ | `filter_single` → `T \| null`; `e.params`; `order by … empty` |
| Supabase | fluent filters | `select('a, b(c)')` string, `!inner` | ✗ | per-table event feed | the warning: never put the shape in a string |
| Cypher/GQL | `WHERE` | ASCII-art pattern | QPP `{1,3}`, per-hop `WHERE`, path modes | ✗ | per-hop predicates; named path modes |
| Gremlin / SPARQL | `.has(...)` / triple co-occurrence | `.out('owns')` / shared variable | `repeat/until/emit/times`; `elt+`, `^`, `\|` | ✗ | the decomposition, not the string labels; inverse as a composable operator |
| Dgraph DQL | `@filter` | nesting, `~owns` | `@recurse(depth, loop)` → tree | `@withSubscription` | recursion whose result is a tree |
| SurrealQL | `WHERE` | `->edge->node` | `.{1..5}` + `+path`/`+collect`/`+shortest` | `LIVE SELECT` (CDC) | the *idea* one-spec-many-modes; Ripple spells the modes as verbs |
| GraphQL/Hasura | `where: {_eq}` | nesting = join | ✗ | multiplexed live queries | result shape mirrors query shape; card-one refs take no args |
| Datomic / XTDB v2 | `[?e :todo/done false]` / `(from :todos […])` | shared `?e` / `unify` | rules (no depth cap), pull `...` / ✗ (dropped in the rewrite) | ✗ | time as a db value; rules; `:in` relation bindings; pull as a subquery operator, not a second grammar |
| Datalevin / Cozo | Datomic-shaped / `?[x] := *todo{...}` | Datomic-shaped / rule bodies | recursive rules, fixpoint | ✗ | build the planner, clause order is not the user's job; rules as the primary unit, bounds as query options |
| Instant / Zero | `$.where` dotted paths / expression builder | nested object = link / `related(name, q => …)` | ✗ | `useQuery`/`queryOnce`; `useQuery` → `[data, result]` | dotted paths, `InstaQLResult<Schema, Query>`; shape vs predicate (`whereExists`); `.one()` |
| TanStack DB | typed refs in callbacks | `join` + subquery-in-`select` | ✗ | live by default; `queryOnce` derived | closed vocabulary; once defined by live; `createEffect` diffs |
| Convex / Electric / Jazz | `.withIndex` / SQL `where` on one table / n/a | hand-written JS / ✗ / `resolve` graph | manual / ✗ | `useQuery`; shape log; `load` vs `subscribe` | one artifact, two lifetimes; sync unit ≠ query unit; `co.loaded<Schema, Resolve>` — shape as a type-level function |
| Effect SQL | `sql` templates | — | — | — | `SqlSchema.findAll({ Request, Result })` |

**Sources.** Prisma relation queries & type safety · Drizzle RQB v2 · Kysely relations & CTEs · Objection eager methods · Gel `select` docs +
geldata/gel#4168 · Supabase joins and nesting · Hasura live-query execution · Neo4j variable-length patterns & shortest paths · ISO/IEC 39075:2024
(GQL) · Kuzu match clauses · SPARQL 1.1 property paths & negation · TinkerPop reference & recipes · Dgraph `@recurse` · SurrealQL idioms · Datomic
query-pull, best practices, filters · Cognitect "separation of concerns in Datomic query" · XTQL tutorial + xtdb v2.0.0 release notes · tonsky.me
"DataScript 2" · Datalevin · Cozo queries · datalogui/datalog · InstaQL · Zero ZQL · TanStack DB live queries · Electric shapes · Effect `SqlSchema` ·
Jazz subscription and loading
