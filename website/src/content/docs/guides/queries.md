---
title: Query and pull
description: Build a query from your catalog attributes, then run it once, run it live, or run it against yesterday — the same value, three ways.
---

A query is a value you build from your catalog. Because it is a value and not
a method call, you write it once at the top of a module and then run it three
ways: once, standing (so it re-runs itself), or against a past version of the
database. The result type is inferred from the shape you ask for, so a
component's props and the database agree by construction.

Every example on this page uses the todos catalog from [Define your
data](/guides/catalog/#growing-the-catalog):

```ts title="schema.ts"
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const User = Ripple.Namespace("user", {
  sub: Ripple.Attr(Schema.String, { unique: "identity" }),
  name: Ripple.Attr(Schema.String),
  email: Ripple.Attr(Schema.String, { unique: "identity" }),
});

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
  due: Ripple.Attr(Ripple.Instant),
  owner: Ripple.Attr(Ripple.Ref(() => User)),
});

export const Todos = Ripple.Catalog({ user: User, todo: Todo });
```

## One query, three runners

```ts title="src/todos.ts"
import * as Effect from "effect/Effect";
import * as Ripple from "@ripple/alchemy/db";
import type { Db } from "@ripple/alchemy/db";
import { Todo, Todos, User } from "../schema.ts";

export const openTodos = Ripple.query(Todo)
  .where(Todo.done.eq(false), Todo.owner.name.startsWith("A"))
  .select({
    id: Todo.id,
    title: Todo.title,
    due: Todo.due.optional,
    owner: Todo.owner.select({ name: User.name }),
  });

export const report = (db: Db<typeof Todos>) =>
  Effect.gen(function* () {
    const now = yield* db.q(openTodos);
    const earlier = yield* db.asOf(100).q(openTodos);
    return { now, earlier };
  });

// and standing, in a component module:
export const liveOpenTodos = (db: Db<typeof Todos>) => db.live(openTodos);
```

`Ripple.query(Todo)` means "entities that carry at least one `todo` attribute".
Everything after it narrows or shapes that set.

## Filtering

Attributes carry their own predicates, and a reference lets you keep walking:

```ts title="src/todos.ts"
// … same imports as above
Todo.done.eq(false); // asserted false — a todo with no `done` fact does not match
Todo.done.missing(); // no `done` fact at all
Todo.due.lt(new Date()); // overdue
Todo.title.includes("milk"); // case-sensitive
Todo.owner.name.startsWith("A"); // hop through the owner, then filter
```

| on | predicates |
| --- | --- |
| any attribute | `eq` `ne` `lt` `lte` `gt` `gte` `exists` `missing` |
| strings | `startsWith` `includes` |

Several predicates in one `where` are all required to hold. Absence is not a
value: `eq` and the comparisons need the fact to be there, so ask with
`exists` or `missing` when absence is the question.

## Shaping the result

`select` decides both the rows you get and their TypeScript type. Ask for a
key and it is in the type; omit it and it is not there at all.

```ts title="src/todos.ts"
// … same imports as above
Ripple.query(Todo).select({
  id: Todo.id, // the entity id, as a number
  title: Todo.title, // required: a todo with no title is dropped from the results
  due: Todo.due.optional, // Date | undefined — keeps the row
  owner: Todo.owner.select({ name: User.name }), // nested, through the reference
});
```

Nested shapes are resolved by the server inside the same query, so a list of
todos with their owners is one round trip, not one plus one per row.

## Ordering, limiting, paging

`orderBy`, `limit`, and `offset` run on the server: rows are sorted, then
paged, *then* shaped — so `limit(20)` reads twenty entities and the client never
sees the rows a page dropped. Required fields in the shape are enforced before
the limit too, so the page you get is the page you keep.

```ts title="src/todos.ts"
// … same imports as above
Ripple.query(Todo)
  .orderBy(Todo.due, "asc", { empty: "last" })
  .limit(20)
  .offset(0)
  .select({ title: Todo.title, due: Todo.due.optional });
```

`empty: "first" | "last"` places rows that have no value for the sort
attribute; a missing fact is not the same thing as a null.

## Running a query

```ts title="src/todos.ts"
declare const db: Db<typeof Todos>;
declare const t: number;

db.q(openTodos); // Effect — run it once
db.live(openTodos); // Stream — re-runs as the database advances
db.asOf(t).q(openTodos); // once, against version t
db.asOf(t).live(openTodos); // emits once, then completes: the past has no news
```

`db.q` returns an Effect — a description of the work, not the work. From the
browser you hand it to the `run` your `src/db.ts` exports:

```ts title="src/App.tsx"
import { db, run } from "./db.ts";
import { openTodos } from "./todos.ts";

const rows = await run(db.q(openTodos)); // from the app you have running
```

Inside a Worker, or inside another Effect, you `yield*` it instead of calling
`run`. The [Quickstart](/getting-started/quickstart/#what-you-just-ran) has the
short version of why the API is shaped this way.

Values decode on the way out, so a `Ripple.Instant` attribute arrives as a
`Date`.

`db.live` re-runs the query as the database advances and after a local
`transact`, and only emits when the rows actually changed — a write the query
does not see is not a re-render.

## `pull` — one entity by id

When you already know which entity you want, skip the query:

```ts title="src/todos.ts"
import * as Effect from "effect/Effect";
import type { Db } from "@ripple/alchemy/db";
import { Todo, Todos, User } from "../schema.ts";

export const todoDetail = {
  title: Todo.title,
  done: Todo.done,
  due: Todo.due.optional,
  owner: Todo.owner.select({ name: User.name }),
} as const;

export const detail = (db: Db<typeof Todos>, id: number) =>
  Effect.gen(function* () {
    const todo = yield* db.pull({ id }, todoDetail);
    // Ripple.Pull<typeof Todos, typeof todoDetail> | null
    return todo;
  });
```

- The subject is an id (`{ id }`) or a unique-value lookup
  (`[User.email, "grace@acme.dev"]`).
- `pull` resolves to `null` when a **required** field of the pattern is
  missing. Mark a field `.optional` when its absence should keep the row —
  this also matters under a policy, where a field you may not read is simply
  absent.

## Reading the past

Every query composes over the time-travel views unchanged:

```ts title="src/todos.ts"
export const past = (db: Db<typeof Todos>, t: number) =>
  Effect.gen(function* () {
    const then = yield* db.asOf(t).q(openTodos);
    const everything = yield* db.history.q(openTodos);
    return { then, everything };
  });
```

`asOf` takes a version number — the `t` from a write report — not a date. See
[Time travel](/concepts/time-travel/), including how far back it reaches.

## Budgets

Each query runs under a memory guardrail (`RIPPLE_QUERY_MAX_CELLS`, about
48 MB of intermediate results by default). Exceeding it fails the query with
`QueryBudgetExceeded` (HTTP 413) naming the clause that blew up. Narrow the
query rather than raising the ceiling by reflex — and note that a standing
`live` query does not retry this one, because re-running would fail the same
way.

## Where a query runs

Queries execute at the edge, in the Worker nearest the caller. It reads
immutable data from object storage through a cache and merges in the newest
writes from a replica, so a read never queues behind the writer. Response
headers report what it cost: `x-ripple-ms`, `x-ripple-r2-gets`, and
`x-ripple-cache-hits` — all listed in `access-control-expose-headers`, so a
browser can read them.

**Checkpoint.** `bun test examples/todos` — four passing tests, driving the
same `todoQuery` and `addTodo` these examples are built from.
