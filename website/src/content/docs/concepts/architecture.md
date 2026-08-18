---
title: Architecture
description: How a write becomes a fact, and a fact becomes a query result — one writer, immutable storage, replicas at the edge.
---

A Ripple deployment is four parts and four invariants. The parts are one peer
Worker, one Transactor Durable Object per logical database, N QueryReplica
Durable Objects per database, and one R2 bucket. The invariants are the
product.

## The write path

Every logical database has exactly one writer: its Transactor Durable Object.
The peer Worker receives a transaction, resolves the database name to that DO
(`idFromName(name)`), and queues the transaction there.

Inside the Transactor:

1. Transactions are batched (group commit) and applied serially.
2. Tempids, lookup refs, and `:db.unique/identity` upserts resolve against the
   database value the transaction will actually apply to.
3. The batch is persisted — the log lands in the Durable Object's SQLite
   **before** any acknowledgement; segments and roots are published to R2
   afterwards by the indexer, and never rewritten.
4. Each transaction is assigned the next `t`. `t` is dense: no API mints,
   skips, or supplies one, so the log is gap-free by construction.

The client's `transact` resolves only with a `TxReport` — `{ t, txEid,
datomCount, dbAfter }`. If the ack arrived, the write is durable.

## The read path

Workers never read novelty from the Transactor. QueryReplicas are first-class:
each replica subscribes to the writer over a WebSocket, holds novelty (the
datoms newer than the last index run) in memory, and serves a *basis* — a
consistent point-in-time view — to the peer.

Queries run in the peer Worker, at the edge:

- The datalog engine is seek-driven; it reads immutable segment trees from R2
  through a cache and merges novelty from the replica's basis.
- `q`, `pull`, and `live` all read through the same basis, so a query never
  sees a half-applied transaction.
- A per-query memory guardrail (`RIPPLE_QUERY_MAX_CELLS`) rejects over-budget
  queries with a 413 rather than degrading the isolate.

## Storage layout

Everything except `root/current` is immutable, and keys are namespaced per
database (`db/<name>/…`):

| key | contents |
| --- | --- |
| `db/<name>/seg/…` | content-addressed segment-tree nodes (EAVT/AEVT/AVET/VAET) |
| `db/<name>/log/…` | transaction-log chunks for replica catch-up |
| `db/<name>/root/current` | the only mutable key: the latest root after an index run |

The indexer runs inside the Transactor on a threshold/interval
(`RIPPLE_INDEX_TX_THRESHOLD` / `RIPPLE_INDEX_INTERVAL_MS`), folding novelty
into new segment trees and flipping the root. Old roots are retained
(`RIPPLE_RETAIN_ROOTS`) so `asOf` stays cheap, and a mark-and-sweep GC reclaims
unreachable segments.

## The invariants

- **Single writer.** One Transactor per database serializes all transactions.
  Multi-writer is not a configuration; it would break `t`'s total order and
  tempid/unique resolution. Need more write throughput? [Split the logical
  database](/reference/runbook/#the-write-ceiling).
- **Dense `t`.** `t` is only ever read (`report.t`, `db.asOf(t)`).
- **Persist-before-ack.** An acknowledged transaction is durable; `dbAfter`
  carries the fence.
- **QueryReplicas first-class.** Reads take their basis from the replica
  path — the writer's queue never competes with reads.

## Failure behavior

- **Transactor storage failure** (`tx.aborted`): if in-memory and durable
  state diverge, the DO aborts itself and the next request reboots it from
  SQLite + `root/current`. Nothing from the failed batch is durable; clients
  that got a 503 retry; `t` continues with no gap.
- **Replica behind or disconnected**: it reconnects on the next request,
  resuming from its watermark; if the SQLite log tail no longer reaches back
  far enough, it reads `log/` chunks from R2.
- **Session socket drops**: the client reconnects in place with backoff;
  standing `live` streams are not torn down.
