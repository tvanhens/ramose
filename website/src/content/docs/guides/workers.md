---
title: Workers and tenants
description: Bind the database to your own Worker as a capability, and give every customer their own database with a function call.
---

Your own Worker talks to a Ripple database through a capability, not a URL and
a token. You declare what the Worker may do — read and write, or read only —
and separately how the call travels. The body of the Worker is identical either
way, and a Worker that only declared reads cannot write, by type.

```ts title="app.ts"
import * as Ripple from "@ripple/alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Server } from "./resources.ts";
import { Todo, Todos } from "./schema.ts";

export const App = Cloudflare.Worker(
  "App",
  { main: import.meta.url },
  Effect.gen(function* () {
    // the binding is the client: one of these, bound once at startup
    const ripple = yield* Ripple.ReadWriteDatabases(Server);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const tenant = request.url.split("?")[0]?.split("/")[2] ?? "acme";

        // pure: no request, no socket, no provisioning
        const db = ripple.db(tenant, Todos);

        const { dbAfter } = yield* db.transact(function* (tx) {
          const todo = yield* tx.entity();
          yield* todo.add(Todo.title, "ship it");
          yield* todo.add(Todo.done, false);
          yield* todo.add(Todo.createdAt, new Date());
        });

        const rows = yield* dbAfter.q(
          Ripple.query(Todo).select({ id: Todo.id, title: Todo.title }),
        );
        return yield* HttpServerResponse.json(rows);
      }),
    };
  }).pipe(Effect.provide(Ripple.ServerBinding)),
);

export default App;
```

`ripple.db(name, catalog)` costs nothing: no network, no handshake, no
provisioning step. Resolving the customer from the request and naming their
database *is* the whole multi-tenancy story — see [A database is a
name](/concepts/databases-are-names/).

## Capabilities

| capability | your Worker gets |
| --- | --- |
| `Ripple.ReadWriteDatabases(Server)` | `q`, `pull`, `asOf`, `history`, `transact`, `install` |
| `Ripple.ReadDatabases(Server)` | the same client with the writes removed |

There is no write-only twin, deliberately: a writer that cannot read cannot
resolve a lookup or check an invariant.

:::caution[Live queries need a browser]
`db.live` is in the type of both capabilities, but it needs a WebSocket to the
peer, and a Worker-to-Worker binding has none. Calling it there fails the fiber
outright with `ripple: db.live needs the session socket` rather than returning
an error you can catch. Stand live queries up in the browser through
`Ripple.layer`, and let your Worker do request-shaped reads and writes.
:::

## Transports

| layer | how the call travels |
| --- | --- |
| `Ripple.ServerBinding` | a Worker service binding: same colo, no public hop, no TLS handshake |
| `Ripple.ServerHttp` | the peer's public URL over ordinary `fetch` — also what `alchemy dev` and deploy-time actions use |

Provide one of them at the edge of the program; nothing inside changes when you
swap.

## Handling failures

The client's errors are tagged, so the HTTP mapping is a total match rather
than status sniffing:

```ts title="app.ts"
// … the fetch handler above, wrapped with `.pipe(…)`:
Effect.catchTags({
  TxRejected: (e) =>
    HttpServerResponse.json({ error: e.message, code: e.code }, { status: 409 }),
  Unavailable: (e) =>
    HttpServerResponse.json(
      { error: e.message },
      {
        status: 503,
        headers: { "retry-after": String(Math.ceil(e.retryAfterMs / 1000)) },
      },
    ),
  QueryBudgetExceeded: (e) =>
    HttpServerResponse.json({ error: e.message, clause: e.clause }, { status: 413 }),
  InvalidRequest: (e) => HttpServerResponse.json({ error: e.message }, { status: 400 }),
  Unauthorized: (e) => HttpServerResponse.json({ error: e.message }, { status: 401 }),
  DatabaseNotFound: (e) => HttpServerResponse.json({ error: e.message }, { status: 404 }),
  InternalError: (e) => HttpServerResponse.json({ error: e.message }, { status: 500 }),
  NetworkError: (e) => HttpServerResponse.json({ error: e.message }, { status: 502 }),
});
```

Configuration mistakes are not in that list on purpose. A missing binding or a
malformed URL kills the fiber at startup instead of surfacing as a retryable
error on some unlucky request.

## Onboarding a new customer

Name the database, install the catalog once, then use it like any other:

```ts title="app.ts"
const onboard = (key: string) =>
  Effect.gen(function* () {
    const db = ripple.db(`tenant-${key}`, Todos);
    const report = yield* db.install(); // at signup, never per request
    return yield* HttpServerResponse.json({ tenant: key, t: report.t });
  });
```

Names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`. An invalid name fails the
first operation with `InvalidRequest` on the client, so it never reaches the
peer.

Each database has its own writer and its own storage prefix, which is what
makes the isolation real — and also the limit: one database sustains low
thousands of writes per second, and there are no joins across databases. See
[the runbook](/reference/runbook/#the-write-ceiling).

The runnable version of everything above is
[`examples/kv-style`](https://github.com/tvanhens/ripple/tree/master/examples/kv-style)
in the repository.
