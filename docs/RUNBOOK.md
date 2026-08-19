# Ramose runbook

Operational notes for one Ramose deployment (one Worker, one Transactor DO per
logical database, N QueryReplica DOs per database, one R2 bucket). Numbers
quoted below come from `bench/RESULTS.md`; re-measure on your hardware.

## What to look at

Every component emits one JSON object per line (`{ ts, level, component,
event, db, … }`); read them with `wrangler tail`, Logpush, or the `alchemy dev`
console. Set `RAMOSE_LOG_LEVEL=debug` to also see per-batch / per-query events.

| question | where |
|---|---|
| where is the basis right now? | `GET /db/:name/info` → top-level `t` — every principal gets it (non-admin sees only `{ db, t }`); the client's `db.basis()` reads the same field |
| tx/s, batch size, commit latency for a db | `GET /db/:name/info` → `transactor.metrics` (`txPerSec`, `batchSize.p50/p95`, `commitMs`); events `transactor/tx.commit` |
| is the transactor rejecting or dead? | events `transactor/tx.rejected` (schema/unique errors, per tx) and `transactor/tx.aborted` (storage write failed → the DO resets and reboots from durable state; clients get 503 + `retry-after`) |
| index lag / run cost | `/info` → `transactor.txsSinceIndex`, `indexer.lastRun`; events `indexer/index.run` (`txs`, `datoms`, `ms`, `r2Puts`, `remainingTxs`) |
| replica health / novelty size | `/info` → `replica.novelty`, `replica.connected`, `replica.stats.gaps`; events `replica/replica.connect`, `replica.root` (novelty before/after a flip), `replica.gap` |
| read latency at the edge | `/info` → `peerMetrics.queryMs`; events `peer/query` (`ms`, `rows`, `r2Gets`, `cacheHits`, `peakCells`); response header `x-ramose-ms` |
| queries hitting the memory guardrail | events `peer/query.budget-exceeded` (413, `code: query/budget-exceeded`, names the clause and the cell count) |

## The write ceiling (and the answer: split the logical database)

**Every logical database has exactly one writer** — its Transactor Durable
Object — which serializes all transactions and assigns `t`. That is a design
invariant, not a tuning knob: it is what makes `t` total,
tempid/unique resolution consistent, and the log gap-free.

Measured ceiling of one database on dev hardware (`bench/RESULTS.md`):
~2.5–2.9k small tx/s with group commit in-process, ~1.7k tx/s through the
local Worker → DO path; ~600–850 tx/s with group commit disabled. Real
Cloudflare hardware and colo placement will move these numbers, but the shape
is fixed: **low thousands of tx/s per logical database, full stop.**

### Symptoms that a tenant is at the ceiling

- `transactor.metrics.txPerSec` flat while `batchSize.p95` keeps growing and
  ack latency (`peer/transact` `ms`, `commitMs.p95`) climbs — group commit is
  already coalescing everything that arrives; the DO is CPU/IO bound.
- `tx.commit` events show `queued` consistently > 0.
- `txsSinceIndex` grows faster than the indexer drains it (`index.run`
  `remainingTxs` > 0 run after run) — writes outrun indexing, novelty (and
  replica memory) grows.

### What NOT to do

- Do **not** add a second writer, shard `t`, or let two DOs accept writes for
  the same database. Multi-writer breaks the invariants above; there is no
  supported configuration for it and none is planned.
- Do not raise `RAMOSE_MAX_BATCH` hoping for more throughput — 0 (unbounded)
  already batches everything in flight; a cap only trades throughput for
  latency fairness.

### What to do: split the logical database

A tenant that needs more than one Transactor's worth of writes must be split
into several logical databases, each with its own Transactor (`/db/<name>`).
Splits are by *ownership of writes*, so that a transaction never needs to
touch two databases:

1. Pick a partition key that all writes carry (customer/account/region/
   workload). Each partition becomes a database `tenant-<key>`.
2. Create the new databases: install the schema (`POST /db/tenant-<key>/transact`
   with the attribute definitions — same as the original), then optionally
   backfill from the old database (`/query` + `/transact` in the client, or
   from `log/` chunks in R2 under `db/<old>/log/`).
3. Point writers at the partitioned names. Reads that need a union across
   partitions run one query per database and merge in the application (there
   is no cross-database join; that is the price of the split).
4. Retire the old database when its writers are gone (its history stays
   readable and `as-of`-able for as long as its roots are retained).

Rules of thumb: split *before* p95 ack latency matters to users, and split
along the same lines you would shard any single-writer system — no
distributed transactions across partitions.

## Other knobs (env, see `packages/ramose/src/internal/transactor/env.ts`)

| var | default | effect |
|---|---|---|
| `RAMOSE_MAX_BATCH` | 0 (unbounded) | cap txs per storage write; `1` disables group commit (bench/testing only) |
| `RAMOSE_INDEX_TX_THRESHOLD` / `RAMOSE_INDEX_INTERVAL_MS` | 500 / 5000 | when the indexer runs; lower both to keep novelty (and replica memory) small |
| `RAMOSE_INDEX_MAX_TXS_PER_RUN` | 5000 | bound one run (DO CPU/memory limits); the run re-arms until caught up |
| `RAMOSE_LOG_KEEP_TXS` | 20000 | SQLite log tail kept for WebSocket catch-up; older → replicas read `log/` chunks from R2 (`gap` frame) |
| `RAMOSE_QUERY_MAX_CELLS` | 1,572,864 (~48 MB) | planner memory guardrail per query; over-budget queries get 413 `query/budget-exceeded` |
| `RAMOSE_RETAIN_ROOTS` / `RAMOSE_GC_EVERY_N_INDEXES` | 20 / 50 | root retention for `as-of`; GC cadence (mark & sweep against retained roots) |
| `RAMOSE_LOG_LEVEL` | info | telemetry level |
| `RAMOSE_TOKEN` | unset (auth off) | one bearer token, checked for every database name |
| `RAMOSE_POLICY` | unset | compiled policy (`Ramose.Policy.compile`); set = enforcement is armed and fails closed |
| `RAMOSE_JWKS_URL` (or `RAMOSE_JWKS_JSON`) | unset | the issuer's public keys; required once `RAMOSE_POLICY` is set |
| `RAMOSE_JWT_ISS` / `RAMOSE_JWT_AUD` | unset | accepted issuers (comma-separated) and the audience every token must carry |
| `RAMOSE_JWT_MAX_TTL` | 900 | cap on a token's `exp - iat`, in seconds |
| `RAMOSE_ALLOWED_ORIGINS` | unset | once a policy is set, CORS narrows to this list (empty = no CORS header) |
| `RAMOSE_INTERNAL_SECRET` | unset (no gate) | Worker→DO shared secret; every internal fetch carries it, `/subscribe` included |

`principalOf()` (`packages/ramose/src/worker/auth.ts`) resolves the caller per request from
`Authorization: Bearer <token>` (or `?token=`, since a browser cannot set headers on a
WebSocket upgrade). With no `RAMOSE_POLICY` that is today's shared-token mode —
`RAMOSE_TOKEN` unset is open, set is one service principal — and a `Ramose.Server`
resource's `token` is that same peer token for every name it opens. With `RAMOSE_POLICY`
set, a JWT is the only data-plane principal: it is bound to exactly one database by
`ramose.db`, and `RAMOSE_TOKEN` reaches `/health` and an already-deployed `ensure` only.

## Recovery notes

- **Transactor `tx.aborted`**: in-memory and durable state diverged (storage
  write failed after `t` was assigned). The DO aborts itself; the next request
  reboots it from SQLite (`log`) + `root/current`. Nothing from the failed
  batch is durable; clients that got 503 must retry. `t` continues with no
  gap. This is tested (`packages/ramose/test/internal/transactor/transactor.test.ts`).
- **Replica behind / disconnected**: it reconnects on the next request
  (`resume` from its watermark, `gap` → `log/` chunks in R2). Force it with
  `POST /db/:name/admin/replica/reconnect`.
- **Indexer stuck** (`remainingTxs` never drops): lower
  `RAMOSE_INDEX_MAX_TXS_PER_RUN`, or trigger `POST /db/:name/admin/index`
  and read the `index.error` event.
- **Bucket bloat**: `POST /db/:name/admin/gc` sweeps `seg/` and `n/` objects
  unreachable from retained roots (keys are namespaced per database, so a
  sweep can never touch another database).
