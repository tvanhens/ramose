---
title: Live queries
description: db.live keeps a query answered. Write a row and every standing query re-runs — no refetch call, no cache invalidation.
---

A live query answers itself. You hand `db.live` the same query value you would
give `db.q`, and instead of one result you get a stream of results: the rows
now, and the rows again every time the database moves. Nothing at your write
site has to announce the change, and there is no cache to invalidate.

The query is a value, and it lives with your other queries:

```ts title="src/todos.ts"
import * as Ripple from "@ripple/alchemy/db";
import { Todo } from "../schema.ts";

export const todoQuery = Ripple.query(Todo)
  .orderBy(Todo.createdAt, "asc")
  .select({
    id: Todo.id,
    title: Todo.title,
    done: Todo.done,
    createdAt: Todo.createdAt,
  });
```

The stream is built once, where the component that reads it lives:

```tsx title="src/App.tsx"
import { db } from "./db.ts";
import { todoQuery } from "./todos.ts";

// built once, outside render — see the caution below
export const todos = db.live(todoQuery);
// Stream<readonly { id: number; title: string; done: boolean; createdAt: Date }[], DbError>
```

## In React

Ripple ships no React package. A stream becomes state in about a dozen lines,
and the todos example keeps them in one file you can copy:

```ts title="src/useLive.ts"
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { useEffect, useState } from "react";

export const useLive = <A, E>(stream: Stream.Stream<A, E>) => {
  const [s, set] = useState<{ rows?: A; error?: Cause.Cause<E> }>({});
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (rows) => Effect.sync(() => set({ rows }))).pipe(
        Effect.catchCause((error) =>
          Effect.sync(() => set((p) => ({ ...p, error }))),
        ),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }, [stream]);
  return s;
};
```

```tsx title="src/App.tsx"
import { todos } from "./todos.ts";
import { useLive } from "./useLive.ts";

export const TodoList = () => {
  const { rows, error } = useLive(todos);
  if (error !== undefined) return <p>offline…</p>;
  if (rows === undefined) return <p>loading…</p>;
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.id}>{row.title}</li>
      ))}
    </ul>
  );
};
```

:::caution[Build the stream outside render]
`db.live(query)` creates a new stream every time it is called, and the hook
resubscribes whenever its dependency changes. Call it once at module scope (or
in a `useMemo` with stable inputs) — never in the body of a component.
:::

## Where live queries work

A live query needs a WebSocket, because that connection is how the database
tells the client it moved.

| environment | live queries |
| --- | --- |
| a browser, through `Ripple.connect` (or `Ripple.layer` for Effect users) | yes — this is the intended home |
| a Worker binding another Worker (`Ripple.ServerBinding`) | **no.** There is no socket on that hop; calling `db.live` fails the fiber outright rather than returning an error you can catch |
| Node or Bun | only where a global `WebSocket` exists, or one you pass to `Ripple.connect` / `Ripple.layer` |

:::note[Two tabs, locally]
On the local emulator writes do not propagate between isolates, so a second
tab picks them up on reload. Your own tab always updates, because its own write
moves its own connection forward. Against a deployed peer, every connected
client updates.
:::

## What re-runs, and when

- **A write moves the whole connection.** Your `transact` sets the connection's
  version to the report's `t`, so every standing query on that connection
  re-runs — including in the tab that wrote.
- **A re-run is a whole re-run.** There is no diffing: the query is evaluated
  again. Policies and budgets apply exactly as they do to `db.q`.
- **Only news is emitted.** A re-run whose rows are identical to the last
  emission is not emitted again, so a write the query does not see is not a
  re-render.
- **The socket carries a version number, never rows.** It is a signal that the
  database advanced, not a data channel.
- **Dropped connections recover on their own.** Network failures and 5xx
  responses retry with a backoff from 250 ms up to 5 s, and the socket
  reconnects in place, re-reading your token. Standing streams are not torn
  down.
- **Four failures are terminal**, because retrying them changes nothing:
  `InvalidRequest`, `DatabaseNotFound`, `Unauthorized`, and
  `QueryBudgetExceeded`.
- **A pinned view emits once and completes.** `db.asOf(t).live(query)` has no
  news to deliver.
- **Teardown is interruption.** Interrupt the fiber draining the stream and
  everything unwinds; there is no unsubscribe call.

## What it costs

There is no per-query subscription state on the server. A live query is a
re-run of the same read path, triggered by a version tick, served from the
replica's view plus cached immutable data. Bursts of small writes coalesce
naturally, because re-runs happen per tick rather than per write.

**Checkpoint.** Tick a box in the running app and watch the list redraw with no
refetch.

Next: [put permissions on it](/guides/permissions/) so a standing query only
ever returns rows that caller is allowed to see.
