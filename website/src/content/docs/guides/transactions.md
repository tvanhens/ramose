---
title: Write data
description: One function writes — db.transact. It is all-or-nothing, it is typed against your catalog, and it tells you exactly where the database landed.
---

Every write goes through one function, and it either lands completely or not at
all. Nothing partial ever reaches the database, and the reply tells you the
exact version of the database your write produced, so the next read can see it.

```ts title="src/todos.ts"
import * as Ripple from "@ripple/alchemy/db";
import type { Db } from "@ripple/alchemy/db";
import { Todo, type Todos } from "../schema.ts";

export const addTodo = (db: Db<typeof Todos>, title: string) =>
  db.transact(function* (tx) {
    const todo = yield* tx.entity();
    yield* todo.add(Todo.title, title);
    yield* todo.add(Todo.done, false);
    yield* todo.add(Todo.createdAt, new Date());
  });
```

From the browser, run it with `Effect.runPromise` — no environment is needed:
`await Effect.runPromise(addTodo(db, "buy milk"))`. In a Worker it is an
ordinary Effect you `yield*`.

## The four verbs

That is the entire write vocabulary — there is no update, no upsert call, no
merge:

| call | does |
| --- | --- |
| `tx.entity()` | hands back a handle for a brand-new entity |
| `tx.add(e, attr, value)` | states a fact about an entity |
| `tx.retract(e, attr, value?)` | takes one value back, or every value of that attribute |
| `tx.retractEntity(e)` | takes back everything about an entity, and its components |

The handle from `tx.entity()` carries the same three verbs without the first
argument: `todo.add(…)`, `todo.retract(…)`, `todo.retractEntity()`.

`e` is an entity id as a plain number, a handle from this transaction, or a
lookup by unique value (`[User.email, "grace@acme.dev"]`). Query results hand
you ids as `{ id }`, so pass `row.id` here. Values are checked against the
catalog as you type them — `todo.add(Todo.done, "yes")` does not compile, and neither does
`todo.add(Todo.title, 3)`.

```ts title="src/todos.ts"
export const setDone = (db: Db<typeof Todos>, id: number, done: boolean) =>
  db.transact(function* (tx) {
    yield* tx.add(id, Todo.done, done);
  });

export const deleteTodo = (db: Db<typeof Todos>, id: number) =>
  db.transact(function* (tx) {
    yield* tx.retractEntity(id);
  });
```

Card-one attributes replace themselves: setting `Todo.done` again retracts the
old value in the same transaction, so you never write the retraction yourself.

## Keys and lookups

An attribute declared `{ unique: "identity" }` is a key. Writing a value that
already exists attaches your facts to the entity that has it, instead of
creating a duplicate:

```ts title="src/users.ts"
import type { Db } from "@ripple/alchemy/db";
import { User, type Todos } from "../schema.ts";

export const upsertUser = (db: Db<typeof Todos>, email: string, name: string) =>
  db.transact(function* (tx) {
    const user = yield* tx.entity();
    yield* user.add(User.email, email); // existing email → that user
    yield* user.add(User.name, name);
  });
```

The same key addresses an entity from anywhere, with no id in hand:

```ts title="src/users.ts"
yield* tx.add([User.email, "grace@acme.dev"], User.name, "Grace H.");
```

## What you get back

`transact` resolves with a report:

```ts title="src/todos.ts"
const { t, txEid, datomCount, dbAfter } = yield* addTodo(db, "buy milk");
```

- **`t`** is the database's version number after your write.
- **`txEid`** is the transaction itself, as an entity — attach audit facts to
  it if you want to record who or why.
- **`datomCount`** is how many facts landed.
- **`dbAfter`** is the same database handle, floored at `t`. Read through it
  and you see your own write without a second round trip and without a sleep.

```ts title="src/todos.ts"
const { dbAfter } = yield* addTodo(db, "buy milk");
const rows = yield* dbAfter.q(
  Ripple.query(Todo).select({ id: Todo.id, title: Todo.title }),
);
```

:::note[No ids come back]
A new entity's id is not in the report. If you need it, query for it — usually
through a unique attribute you just wrote. The wire protocol carries the
mapping today, but the client does not expose it, so do not write code that
expects `report.tempids`.
:::

A write also moves the whole connection forward: every standing
[live query](/guides/live-queries/) on that connection re-runs against `t`, so
nothing in your UI has to announce the change.

## When a write is refused

- **A rejected transaction is `TxRejected`**, and no version number is spent —
  a schema violation, a unique conflict, or a policy denial inside the commit
  loop all land here.
- **A policy denial caught at the edge is `Unauthorized`** (HTTP 403) carrying
  a code and the attribute that failed. See
  [Permissions](/guides/permissions/#what-a-denial-looks-like) for both.
- **A transactor restart is `Unavailable`** with a retry delay; retrying the
  same transaction is safe because nothing was written.
- Writing to a database whose catalog was never installed fails `TxRejected`.
  Install it first — at deploy or with `db.install()`.

## Worth knowing

- Transactions are applied one at a time per database, so there are no write
  conflicts to retry — only refusals to handle.
- `transact` returns only after the write is on disk. An acknowledgement means
  durable.
- `db.install()` is itself an ordinary transaction, and an unchanged catalog
  costs one no-op write.
- You cannot write into the past: `db.asOf(t)` and `db.history` hand back
  read-only handles.
