# The query language

Settled 2026-08-22. This is the implementation map for the query redesign
(the design record supersedes issues #141–#148); the nav surface
(`Ramose.query(N).where(...)`) still ships and its migration onto this
language is follow-up work (old #144).

## One kind of object

A query is a rule: a **head** (its declared params) plus a **body** (its
clauses and its projection). One constructor builds it — `Query.q(params?,
body)` — and the body has two spellings of the same value:

```ts
import { pipe } from "effect/Function";
import { Q, Query, entities, is, none, select, orderBy, limit, updatedSince } from "ramose/query";

// pipe spelling — most everyday code
export const inbox = Query.q(
  { me: Ramose.EidOf(User), since: Schema.Number },
  (p) => pipe(
    entities(Issue),
    is(Issue.done, false),
    none(Comment.issue, is(Comment.author, p.me)),
    updatedSince(p.since),
    select({ id: Issue.id, title: Issue.title }),
    orderBy("title"), limit(50),
  ),
);

// generator spelling — the same (head, body) value, written directly
export const inbox = Query.q(
  { me: Ramose.EidOf(User), since: Schema.Number },
  function* (p) {
    const issue = yield* entities(Issue);
    yield* is(Issue.done, false)(issue);
    yield* none(Comment.issue, is(Comment.author, p.me))(issue);
    yield* updatedSince(p.since)(issue);
    return Q.pull(issue, { id: Issue.id, title: Issue.title });
  },
);
```

Escalating from pipe to generator is un-sugaring, never rewriting.

## The kernel is inert data

`src/db/query/kernel.ts`. Primitives are typed clause *descriptions*, not
Effects — serializability is definitional, and there is no build runtime,
ambient collector, or cast:

- `Q.fact(e, attr, v?)` — the one pattern clause, five positions. Unbound
  positions mint typed vars (lazily: reading `f.t` is what puts the tx
  position on the wire); the handle exposes `{ e, v, t, tx, op }`, so
  time-based questions are ordinary clauses (`f.t` reads as the basis `t`,
  converted through the stable tx partition base).
- Value comparisons — `Q.eq`, `Q.gt`, `Q.startsWith`, `Q.in`, … over bound
  vars.
- `Q.or` / `Q.not` — take sub-generators; closure capture over outer
  handles supplies the join-variable lists. No explicit var lists, ever.
- Rule invocation — yielding a rule application records an inert call
  descriptor.
- `Q.var` / `Q._` — naming devices; they contribute nothing to the IR.

`yield*` is the collector: you cannot obtain a clause's binding without
contributing the clause (the orphaned-clause bug is structurally gone),
clauses accumulate implicitly while bindings return explicitly, and every
inclusion re-runs the build function — fresh vars make self-joins hygienic
with no alpha-renaming machinery. Variables are identities, not names.

## Inputs declared, output inferred

The declared params record is the query's binding type — a collision is a
compile error at the merge site, and the public interface moves only when
the head moves. `db.q(q, bindings)` validates bindings at run time.
`Ramose.EidOf(N)` declares an entity-valued hole. Output goes the other
way: it is the type of the body's one return expression — `Q.pull(focus,
shape)` for one root, `Q.rows({ … })` (or a plain record of handles) for
several, a bare focus var for ids — so inference is sound and there is no
declared `find`.

## Membership is derived

There is no entity table: `entities(ns)` mints a branded var and invokes a
catalog-generated membership rule (`isIssue(e) := or [e :issue/… _]`) —
library, not kernel. When the query already constrains the focus through a
namespace attr, membership is entailed and lowering emits nothing; the
rule name is a planner hook.

## Rules and the engine

`Query.rule(name, body)` is the named form; the body's parameters are the
bound head vars and a returned var joins the head — so promotion of an
instantiated fragment is one mechanical call
(`Query.rule("issue/ownerOf", follow(Issue.owner))`). Invocation is a
clause value expanded by the *engine*, which is what makes recursion work.

On the wire the query gains a `rules` section
(`[[name ?arg…] clause…]`, same-named defs are disjunctive branches);
`internal/core/query/{ast,parse,engine}.ts` implement it. A non-recursive
call inlines to an or-join (bound arguments still seek); a recursive call
is answered from a memoized bottom-up fixpoint whose every round — and
cumulative expansion work — is charged against the existing query budget,
so a runaway recursion is a `QueryBudgetExceeded`, never a hang.

## Composition is delegation, at three altitudes

1. `yield* frag(handle)` — a fragment's clauses flow into the enclosing
   build; native JS delegation. A fragment is a rule with modes: bound
   vars are its arguments, the free var its return — the dataflow that
   makes pipe thread. `Query.stage(frag)` lifts a userland fragment with
   the same adapter the shipped combinators use.
2. `yield* q.open(p)` — a whole closed query as a subquery: clauses
   inline, declared params rebind from `p` (a bound handle correlates, an
   outer token forwards, a literal fixes), and `{ focus, cols }` comes
   back to keep constraining. Cursor terminals don't delegate — extend
   then order, or strip explicitly with `q.logic()`. `Query.enrich` /
   `Query.refine` are derived from `open`.
3. `Query.rule` — engine-expanded, recursive, budgeted; serializes with
   the query.

## Effect stops at the boundary

Query building is synchronous, pure, and total; Effect appears where
computation becomes real — `db.q` returns an Effect with typed failures,
`db.live` is a Stream. Because built queries are inert data they are
hashable for live-query identity and stable as hook dependencies; the
same wire form runs on the peer and on the local session overlay.

Surfaces: `Ramose.Q` / `Ramose.Query` on `ramose/db`, or flat from
`ramose/query`. Tests: `test/db/kernel-query.test.ts` (surface, lowering,
end-to-end) and `test/internal/core/query.rules.test.ts` (engine rules).
