---
title: Time travel
description: asOf and history are views, not dumps — pure functions from a Db to a ReadDb.
---

A Ripple database is immutable: a transaction adds facts (datoms), it never
overwrites them. Time travel is therefore a *view*, not an export job.

```ts
const yesterday = db.asOf(t);   // ReadDb<C> — the database as of transaction t
const everything = db.history;  // ReadDb<C> — all facts, including retracted
```

## `asOf(t)` — a pinned past

`db.asOf(t)` is `Db -> ReadDb`: pure, zero I/O at the call site. `q`, `pull`,
and `live` compose over it unchanged, and the type system removes `transact` —
you cannot write into the past.

```ts
const report = yield* db.transact(function* (tx) { /* … */ });

// later: what did the world look like just before that write?
const titles = Ripple.query(Todo).select({ title: Todo.title });
const rows = yield* db.asOf(report.t - 1).q(titles);
```

Where `dbAfter`'s floor is best-effort ("at least this fresh"), `asOf(t)` pins
an exact past view.

## Where is the basis? — `db.basis()`

`db.basis()` answers `{ t }`: for a live db, the peer's current basis (one
`GET /db/:name/info`); for `asOf(t)`, just `t`, with no request. That makes a
time-travel slider two lines — the max is the basis, the value is `asOf`:

```ts
const { t: max } = yield* db.basis();  // the slider's upper bound
const rows = yield* db.asOf(slider).q(titles); // slider ∈ [1, max]
```

## `history` — every fact, ever

`db.history` includes retracted datoms. Use it for audit trails, "who changed
this and when", and debugging state that no longer exists. Each datom is still
judged by its attribute's read rule under a policy, and a retracted
authorization datom cannot re-grant access.

## Live queries over pinned views

`live` over `asOf(t)` or `history` emits once and completes — a pinned view
has no news.

## What makes it cheap

The indexer periodically folds recent writes into fresh immutable segment
trees in R2 and flips `root/current`. Old roots are retained
(`RIPPLE_RETAIN_ROOTS`, default 20), so an `asOf` inside the retention window
is just a read against an older root — same engine, same cache.

:::caution[History is bounded, and not by time]
Retention keeps the newest 20 roots and garbage-collects everything unreachable
from them, so `asOf` at an older `t` no longer resolves — that history is
deleted, not archived. A root is published per index run, so the window is
roughly "the last 20 index runs", which depends on how much you write
(`RIPPLE_INDEX_TX_THRESHOLD`, 500 transactions) and how often the indexer runs
(`RIPPLE_INDEX_INTERVAL_MS`, 5 s). It is not a number of days. Raise it
deliberately if you are relying on an audit trail — see [Before
production](/guides/before-production/#decide-what-you-keep).
:::
