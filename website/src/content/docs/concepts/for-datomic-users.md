---
title: For Datomic users
description: The bones are familiar — an immutable fact store, one writer, views into the past. Here is the mapping, and where Ripple deliberately differs.
---

You do not need this page to use Ripple. It exists for readers who already
know [Datomic](https://www.datomic.com), because the shapes will look
familiar and the differences are worth stating plainly.

Ripple takes Datomic's core ideas — an immutable store of facts, a single
transactor, time as a view rather than an export, pull patterns as the
projection language — and re-homes them on Cloudflare primitives: a Durable
Object as the writer, more Durable Objects as read replicas, and R2 as the
immutable storage layer. There is no JVM, no peer cache to size, and no
create-database call.

## The mapping

| Datomic | Ripple |
| --- | --- |
| datom `[e a v t]` | the same, and the same total order on `t` |
| schema transacted as data | a **catalog** of TypeScript values; `Ripple.Database` or `db.install()` upserts it |
| `d/transact` with tx-data | `db.transact(function* (tx) { … })` — a generator of `add` / `retract` / `retractEntity` |
| tempids resolved in the transactor | `tx.entity()` — but the resolved ids are **not** returned; query for them |
| `:db.unique/identity` upsert, lookup refs | `{ unique: "identity" }`, `[User.email, "…"]` |
| `:db.cardinality/many` | `{ cardinality: "many" }` |
| `d/pull` | `db.pull(eid, shape)`, same nesting, `.optional` instead of a `:default` |
| Datalog query | a typed navigational builder — `Ripple.query(Todo).where(…).orderBy(…).limit(n).select(…)`, run by `db.q` / `db.live`; there is no string-variable escape hatch today |
| `d/as-of`, `d/history` | `db.asOf(t)`, `db.history` — pure functions to a read-only handle |
| transaction entity for annotations | `report.txEid` |
| `d/filter` | a compiled **policy**, evaluated per request against JWT claims |

## Where it differs

- **A database is a name.** `ripple.db("acme", Catalog)` is a pure function
  call: no connection, no request, no provisioning. Per-tenant databases cost
  nothing to name.
- **`asOf` takes a `t`, not a date.** And its reach is bounded: the storage
  layer keeps the newest `RIPPLE_RETAIN_ROOTS` roots (20 by default) and
  garbage-collects the segments behind older ones. History is not infinite —
  see [Time travel](/concepts/time-travel/).
- **Queries are typed, and smaller.** `where`, `select`, `orderBy`, `limit`,
  `offset`. There are no aggregates, no rules, no reverse-ref navigation, and
  no `d/with`. Ordering, limit, and offset are lowered into the query and run on
  the server, so `limit(20)` really is twenty rows on the wire.
- **Live queries are first-class.** `db.live` is a stream that re-runs when the
  database advances — the feature Datomic leaves to `tx-report-queue` plus your
  own plumbing.
- **Authorization ships with the database.** A policy is data compiled at
  deploy time; reads become a filtered database and every write is checked
  inside the commit loop. See [Auth and policy](/guides/auth/).
- **One writer per database, low thousands of transactions per second.** The
  answer to more write throughput is to split the database, never to add a
  second writer — see [the runbook](/reference/runbook/#the-write-ceiling).
