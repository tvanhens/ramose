---
title: HTTP API
description: The peer Worker's wire surface — per-database routes, the session socket, admin routes, and response headers.
---

The typed client is the supported surface; the HTTP API is what it rides on.
Routes are prefixed per database: `/db/<name>/…`. In transaction maps every
key must be a fully-qualified ident (e.g. `:todo/title`) — a bare key like
`done` is rejected as `tx/invalid`.

## Top level

| route | method | purpose |
| --- | --- | --- |
| `/health` | GET | liveness; reachable with `RIPPLE_TOKEN` under a policy |
| `/` | GET | a small demo console (disabled once a policy is configured) |

## Per database — `/db/:name`

| route | method | purpose |
| --- | --- | --- |
| `/db/:name/transact` | POST | the only write; body is the wire transaction, response is the `TxReport` |
| `/db/:name/query` | POST | run a datalog query at the current basis |
| `/db/:name/pull` | POST | pull a pattern for one entity or lookup ref |
| `/db/:name/info` | GET | database status: top-level `t` (the current basis, for every principal); admins also get `transactor.metrics`, `replica.*`, `indexer.*`, `peerMetrics` |
| `/db/:name/session` | GET | WebSocket upgrade — the session socket behind `Ripple.layer` and `db.live` |

Auth is `Authorization: Bearer <token>`, or `?token=` on the socket upgrade
(a browser cannot set headers there). Under a policy, the token must be a JWT
whose `ripple.db` claim equals `:name`; `/info` reduces to `{ db, t }` for
non-admin principals.

## Admin — `/db/:name/admin`

Admin routes require the `admin` class under a policy (or the shared token
otherwise). See the [runbook](/reference/runbook/) for when to reach for them.

| route | method | purpose |
| --- | --- | --- |
| `/db/:name/admin/index` | POST | trigger an index run now |
| `/db/:name/admin/gc` | POST | mark-and-sweep unreachable segments for this database |
| `/db/:name/admin/replica/reconnect` | POST | force the replica to re-subscribe to the writer |

## Response headers

Every read carries its cost:

| header | meaning |
| --- | --- |
| `x-ripple-ms` | server-side time for the request |
| `x-ripple-r2-gets` | R2 object reads this query performed |
| `x-ripple-cache-hits` | segment-cache hits |

All three are listed in `access-control-expose-headers`, so a browser can read
them.

## Errors on the wire

Errors are JSON bodies with a stable `code` (e.g. `tx/invalid`,
`query/budget-exceeded`) and map onto the typed errors of the client — see
[Errors](/reference/errors/). Over-budget queries return 413; a rebooting
transactor returns 503 with `retry-after`.

:::note
The Durable Objects are not on this surface at all: Transactor and Replica
DOs are reachable only from the Worker, and every internal hop carries a
deploy-minted secret header (`RIPPLE_INTERNAL_SECRET`), `/subscribe`
included. Browser sockets terminate in the Worker isolate.
:::
