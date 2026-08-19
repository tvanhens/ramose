# Transaction / write-path performance — where the time goes and what can move

Scope: the **write path** of one logical database — HTTP `POST /transact` →
Worker → Transactor DO → ack — under the current guarantees (one writer, dense
per-tx `t`, one log in `t` order, transactor-resolved uniques incl. upsert,
serializable against db-before + earlier txs in the batch, persist-before-ack,
replicas first-class). Not reads, not multi-writer, not splitting the database
(that is the product scale lever, RUNBOOK). Analysis + local micro-benches
only; no engine change, no deploy.

Numbers quoted from `bench/RESULTS.md` are marked *RESULTS*; numbers marked
*local* were measured for this doc on the dev box (Bun 1.3.14, 8 vCPU, shared)
with two throw-away scripts that drive `packages/ramose/test/internal/transactor/harness.ts`
and `Connection` directly (not committed). Re-run before trusting them on other
hardware.

**Thesis in one paragraph.** The write path has three different ceilings and
they are not the ones RESULTS labels. (1) In-process, the ceiling is *resolve
CPU*, not fsync: `stats.resolveMs` is 78–96 % of wall at 64–256 clients and
`commitMs` (the SQLite write incl. fsync) is 2–8 %. Most of that resolve time
is a single hot loop we had not named — `SortedNovelty.flush()` re-merges the
whole novelty array on the first read after every write, once per index per
tx, ≈ 9 µs per 1,000 novelty datoms per index — so per-tx cost is O(novelty),
and the recorded 2.5–2.8k tx/s is what you get with the bench's indexer
*disabled* (novelty grows to ~30k datoms); with the default indexer the same
harness does ~4.9–5.3k tx/s (*local*). (2) The "one write per tx ≈ 630 tx/s =
fsync" row is the Bun `setTimeout(0)` ≥ 1.08 ms clamp on the batching window,
not fsync (commit is 0.3–1 ms per *batch*). (3) On real Cloudflare the ceiling
is DO requests/s: 700–900 tx/s at 64 clients with batches of 6–14 means the DO
spends most of its wall time admitting requests, not resolving or writing
(inference; the split is exposed on `/info` and was never recorded — that is
experiment #1). Under every guarantee, the only lever that raises **remote
tx/s** is more txs per DO request (multi-tx POST, optionally coalesced in the
Worker); the O(novelty) fix and moving `mergeSlice` off the writer thread raise
**in-process** tx/s and remove a degradation mode but do not touch the remote
number unless the DO turns out to be CPU-bound; fatter txs raise **datoms/s**
only.

---

## 1. Current write path (HTTP POST → ack)

One small tx (`[{":k/id": n, ":k/v": "x"}]`, 3 datoms incl. `:db/txInstant`),
default config (`RAMOSE_MAX_BATCH=0`, index every 500 txs / 5 s).

| step | where | on the ack path? |
|---|---|---|
| 1. Client `db.transact(tx)` → `POST /db/:name/transact {tx}` (JSON, `toJson`) | `packages/ramose/src/db/http.ts` | yes (WAN RTT) |
| 2. Worker: auth, `request.text()`, **one DO `fetch` per POST** to `TRANSACTOR.idFromName(db)`; response body streamed back; `invalidateBasis(db)` | `packages/ramose/src/worker/index.ts:99-113` | yes (Worker→DO hop, ~one intra-CF RTT) |
| 3. DO shell: `assign(db)`, `await core.init()`, route to `Transactor.handleRequest` | `packages/ramose/src/internal/transactor/transactor-do.ts:98-122` | yes |
| 4. `handleRequest`: `fromJson(await request.json())`, `this.transact(body.tx)` | `packages/ramose/src/internal/transactor/transactor.ts:443-447` | yes |
| 5. `transact()`: push `{tx, resolve, reject}` onto `queue`; start `commitLoop` if idle | `transactor.ts:259-268` | yes |
| 6. `commitLoop`: **batch window** = one `setTimeout(0)` yield (`yieldToEventLoop`, `:86`), then `takeBatch()` = everything queued (unbounded when `maxBatch=0`) | `transactor.ts:281-287` | yes |
| 7. **Resolve**, serially per tx in arrival order: `conn.transact(p.tx)` → `processTx(dbBefore, tx, t=basisT+1, nextEid, now)`; on success `nextEid`, `schema = schema.clone().apply(datoms)`, `novelty.add(datoms)`, `basisT = t`; on `TxError` the tx is rejected here and **does not consume `t`** (guarantee 2) | `transactor.ts:291-303`, `packages/ramose/src/internal/core/conn.ts:216-230`, `packages/ramose/src/internal/core/tx.ts:155-425` | yes — `stats.resolveMs` |
| 7a. inside `processTx`: `flatten` map forms → **upsert pass** (one `db.first(AVET, {a,v})` per unique-identity add, `tx.ts:233-271`) → main pass: `resolveEntity` (tempid alloc), `valueFor`/`coerce`, `emitAdd` = `current(e,a)` (one `db.datomsArray(EAVT,{e,a})` per (e,a) touched, `:276-284`) + **unique check** (`db.first(AVET,…)` again, `:298`) + card-one implicit retract; `retractEntity` reads EAVT `{e}` + VAET `{v:e}` and scans the whole in-tx overlay (`:336-364`) | `tx.ts` | yes |
| 7b. every `Db` read = `scan()` over the tree (`R2NodeStore`, LRU of 4096 nodes, **no SQLite tier on the transactor**, miss = R2 GET, `transactor.ts:135`) merged with `novelty.byIndex[i].range(prefix)` through three async generators (`db.ts:116-121`); `range()` calls `flush()` which sorts `pending` and does `sortedUnion(base, pending)` — a full copy of the novelty array — `packages/ramose/src/internal/core/novelty.ts:38-51`, `:59-67`, `tree.ts:655-670` | core | yes |
| 8. **Persist**: one `host.transactionSync` for the batch: `INSERT INTO log` per tx (`encodeLogChunk([e])`, `:182-187`) + `meta.next_eid`; failure → `die()` (503, DO abort, reboot from SQLite; no `t` burned) | `transactor.ts:305-317` | yes — `stats.commitMs` (on workerd this is the *synchronous* SQLite work; the durability wait is paid by the DO output gate on the response, so it is on the client's ack latency but not on the loop) |
| 9. Stats, then `p.resolve(ack)` for every tx in the batch | `transactor.ts:318-328` | ack |
| 10. `broadcast(txFrame(e))` per tx: `JSON.stringify` once, `ws.send` per subscriber (replica WS) | `transactor.ts:329`, `:358-368` | after ack, same thread, same loop iteration |
| 11. `indexer.maybeSchedule()`: `getAlarm()` (+ `setAlarm(now)` when `txsSinceIndex ≥ 500`) — a DO storage call per batch | `transactor.ts:330`, `indexer.ts:62-72` | after ack, but before the next batch starts |
| 12. Alarm → `Indexer.runOnce`: `readLogEntries` slice (≤ 5,000 txs) → `putLogChunk` (R2) → `conn.index(toT)` = `mergeRoots` (CPU: `mergeTree` ×4, gzip+sha256 per node, R2 puts) → `publishRoot` → `adoptRoot` (root frame to replicas) → `pruneLog` | `indexer.ts:84-147`, `conn.ts:236-251` | **off the ack path, on the writer thread** — every synchronous slice of the merge blocks the commit loop, and every `await` inside it lets a batch through |
| 13. Replica: WS `tx` frame → SQLite `novelty` row + in-memory entries; Workers read basis from the replica | `packages/ramose/src/internal/replica/replica-do.ts` | off path (guarantee 7 intact) |

What is *not* on the path: R2 (except node-cache misses in 7b), the replica,
the indexer's CPU (except by thread contention, step 12), and any Worker-side
work beyond one DO fetch.

Serialization points that make the guarantees hold, and which are therefore
fixed cost per tx: the queue (guarantee 3), `processTx` against `dbBefore` =
db after the previous tx in the batch (guarantees 4, 5), `transactionSync`
before `resolve` (6), `basisT + 1` only on success (2).

---

## 2. Where the time goes

### 2.1 In-process (Bun harness over an fsync'd SQLite file, one WS subscriber)

*RESULTS* (M7 table): 641 / 2,108 / 2,701 / 2,860 tx/s at 1 / 8 / 64 / 256
clients, avg batch 1 / 8 / 64 / 250; `maxBatch: 1` ≈ 630 tx/s at every
concurrency. That bench (`bench/transactor.bench.ts:24`) sets
`indexTxThreshold: 1_000_000` — **the indexer never runs, so novelty grows for
the whole run** (≈ 3 datoms/tx → ~30k datoms after 4 s at 64 clients).

*Local* split of the same harness (`stats.resolveMs` / `commitMs` are already
counted by the transactor, `transactor.ts:303,319`; the bench just never
prints them):

| config | clients | tx/s | avg batch | ack p50 | resolve % wall | commit % wall | µs resolve / tx | ms commit / batch | novelty at end |
|---|---|---|---|---|---|---|---|---|---|
| bench config (index off), file | 64 | 2,641–2,998 | 64 | 20–21 ms | **85–87 %** | 4–5 % | 283–329 | 1.05–1.12 | 27–32k |
| bench config, `:memory:` SQLite (no fsync) | 64 | 3,111 | 64 | 18 ms | 88 % | 2 % | 283 | 0.39 | 28k |
| bench config, novelty pre-loaded 5k txs | 64 | 1,878 | 64 | 35 ms | 90 % | 3 % | 480 | 1.12 | 32k |
| bench config, novelty pre-loaded 20k txs | 64 | **718** | 64 | 88 ms | **96 %** | 1 % | **1,342** | 1.2 | 67k |
| **default config (index every 500 / 5 s)**, file | 64 | **4,925–5,335** | 64 | 12–13 ms | 78–79 % | 7–8 % | 146–160 | 0.86–0.91 | 0.6–6k |
| default config, 4 WS subscribers | 64 | 4,745 | 64 | 13 ms | 77 % | 7 % | 163 | 0.94 | 1.2k |
| default config | 256 | 2,996 | 256 | 79 ms | 94 % | 2 % | 313 | 2.1 | 12.6k (indexer starved: 3 runs) |
| default config, 10-entity txs (`fat10`) | 64 | 1,198 (= 12k entities/s) | 64 | 56 ms | 91 % | 3 % | 758 | 1.5 | 25k |
| bench config | 8 | 2,320 | 8 | 3.3 ms | 48 % | 14 % | 209 | 0.49 | 21k |
| bench config | 1 | 612 | 1 | 1.5 ms | 8 % | 21 % | 133 | 0.34 | 5.5k |

Reading:

- **Resolve CPU is the in-process ceiling.** fsync (`file` vs `:memory:`) is
  worth ~0.6 ms per *batch*, i.e. 2–5 % of wall at 64 clients. "Storage group
  commit is spent" is true, but the reason is that the write is already only a
  few % of the loop, not that the disk is saturated.
- **Per-tx resolve cost is O(novelty).** `Connection`-only micro-bench (no
  SQLite, no sockets): unbounded novelty → 208 µs/tx (6,000 txs, novelty 18k);
  index every 500 → **35 µs/tx**; index every 100 → 19 µs/tx; no unique attr →
  16 µs/tx. `SortedNovelty.flush()` alone (one add of 3 datoms then one
  `range()`): 13 / 39 / 82 / 121 / 257 / 553 µs at base 0 / 1.5k / 6k / 15k /
  30k / 60k datoms — linear, ≈ 9 µs per 1,000 datoms per index. Every tx pays
  it twice (EAVT for `current(e,a)`, AVET for the unique/upsert seek; AEVT and
  VAET only when read). The fixed part of resolve is small: a warm
  `db.first`/`datomsArray` is 1–2 µs, `schema.clone().apply` 2.5 µs (10 attrs).
- **The 630 tx/s "single write / fsync" number is the timer clamp.**
  `setTimeout(0)` in Bun ≈ 1.08 ms (`setImmediate` 1 µs, microtask 0.5 µs);
  at 1 client or `maxBatch: 1` every loop iteration pays 1.08 ms yield + 0.13
  ms resolve + 0.34 ms commit ≈ 1.55 ms → ~645 tx/s. That is exactly the
  measured 612–641. Whether workerd clamps a 0 ms timer is **unmeasured**.
- **The default indexer halves per-tx cost and doubles throughput vs the
  bench config, but it runs on the writer thread.** In the 4 s / 64-client
  default-config run, 13 index runs (`index.run` events) reported 43 → 707 ms
  wall each (growing with the tree; 3–25 R2 puts per run through the
  in-memory bucket), 3.7 s of the 4.0 s wall overlapped with commits. At 256
  clients the alarm fired only 3 times in 4 s (80 ms batches starve it),
  novelty reached 12.6k and throughput fell to 3k. RESULTS' "1–2 s CPU per 5k-tx
  merge" is for scattered updates on 1.2–4M-datom trees; localized inserts are
  cheaper per tx but the coupling is the same: **more novelty → slower
  resolve → longer batches → fewer alarms → more novelty**.
- Broadcast is not a lever: 4 subscribers vs 1 costs ~4 %.

### 2.2 Local Worker → DO (miniflare)

*RESULTS*: 1,228 / 1,595 / 1,741 tx/s at 8 / 64 / 256 clients, avg batch
2.7 / 15 / 16, ack p50 5 / 29 / 142 ms. Batches stay ~16 at 256 clients while
the in-process harness reaches 250: the emulator's per-request cost (Worker
isolate → DO stub → JSON parse → response) paces arrivals into the queue. The
ceiling here is **emulator request overhead**, not the transactor; the number
is not predictive of Cloudflare.

### 2.3 Real Cloudflare (stage `cf-e2e`, one colo IAD, 4 deploys)

*RESULTS*: 8 clients → 160–233 tx/s, avg batch 1.2–1.4, ack p50 32–36 ms;
64 clients → 664–879 tx/s, avg batch 6.4–13.9, ack p50 59–72 ms, p99 241–385
ms; 0 errors. Write smoke: 300 tx in 1.15–1.4 s.

Which ceiling: at 8 clients the client→edge→DO→client round trip (~32–36 ms)
is the whole story — 8 / 0.034 s ≈ 235 tx/s, batches ≈ 1. At 64 clients
Little's law gives 64 / 0.07 s ≈ 900 tx/s: the ~35 ms above RTT is queueing
somewhere between Worker and DO. If it were resolve+commit CPU, an 8–14-tx
batch would cost ~1–3 ms in the loop, not 10–12 ms per batch (~75 batches/s
observed). So the DO is spending its wall time **admitting and answering
requests** — one `fetch` event per tx — which is consistent with the known
single-DO band of 500–1k simple req/s. This is an inference: `/info` returns
`stats.resolveMs` and `stats.commitMs` for the DO and the CF runs never
recorded them (see §5, experiment 1). Note the DO also pays per batch a
`getAlarm()`/`setAlarm()` storage call (`indexer.ts:62-72`) and per request
`fromJson`/`toJson`; and every index run does its R2 puts and CPU on the same
thread.

Summary of ceilings:

| environment | measured tx/s (64 clients) | ceiling | evidence |
|---|---|---|---|
| in-process, bench config | 2.5–3.0k | resolve CPU, dominated by O(novelty) flush | 85–96 % resolve, novelty 30–67k |
| in-process, default indexer | 4.9–5.3k | resolve CPU (~150 µs/tx) + indexer sharing the thread | 78 % resolve; 13 runs / 4 s |
| in-process, 1 client or `maxBatch: 1` | ~630 | `setTimeout(0)` 1 ms clamp | 1.08 ms/yield measured; commit 0.34 ms |
| local Worker → DO | 1.6–1.7k | miniflare per-request overhead | batches capped ~16 |
| real CF | 0.7–0.9k | DO requests/s (inferred) | ack ≈ RTT + 35 ms queueing at 64 clients; batch 6–14 |

---

## 3. Options that keep every guarantee (ranked)

Ranking is by effect on **remote tx/s** first (the product number), then
in-process. "Remote" = real CF at 64 clients, 700–900 tx/s today.

### 3.1 Multi-tx HTTP: N independent `TxData` per POST, N acks (+ optional Worker-side coalescing)

**This is the only option below that moves the remote 700–900 number.**

What: `POST /transact { txs: [TxData, …] }` → `[ {t,…} | {error, code}, … ]`
(keep `{tx}` as the 1-element form). In the DO handler this is
`Promise.allSettled(body.txs.map((tx) => this.transact(tx)))`
(`transactor.ts:443-447`): the pushes are synchronous, so the N txs land in
the queue in array order, get consecutive `t`, are resolved serially against
db-before-each (guarantees 3, 4, 5 hold exactly as for N separate POSTs that
happen to arrive back-to-back), persist in one `transactionSync` (6), and a
rejected element does not consume `t` (2) while its neighbours commit — the
same per-tx independence the batch loop already implements
(`transactor.ts:291-302`). Client: `db.transactMany(txs)`. Worker: pass
through. Optional second step: a module-scope coalescer in the Worker that
holds concurrent `/transact` calls for the same `db` for one macrotask and
issues **one** DO fetch with the array, fanning acks/errors back to each
caller — no client change; ordering across concurrent HTTP requests is
undefined today, so packing them in the isolate's arrival order does not
weaken guarantee 3 (t order == arrival order at the transactor, where the
array is one arrival). The `invalidateBasis(db)` call stays.

Expected: **remote tx/s ≈ DO req/s × txs per request** until the DO becomes
CPU-bound. Bound from measurement: with default indexing the DO's own cost is
~150 µs/tx resolve + ~1 ms/batch write on the dev box (§2.1), i.e. a CPU
ceiling near 5k tx/s *if* CF's DO CPU is comparable — unmeasured on CF; the
first data point comes from experiment 1/2. In-process tx/s: unchanged (the
harness already calls `transact()` directly). Datoms/s: scales with tx/s.
Ack latency: a coalesced request waits ≤ 1 macrotask in the Worker + the
DO's batch; per-tx acks are unchanged in shape.

Cost / risk: ~30 lines DO+client for the array form, ~80 lines for the
Worker coalescer; new failure surface = partial-success responses (already
the semantics of independent POSTs) and 503 `TransactorDeadError` fanning to
all elements (already the semantics of `die()`). Body-size limits (Worker/DO
request bodies) cap N; pick N ≤ 64 or a byte cap. Not a drop of anything:
each element is still one tx, one `t`, one serial turn.

Looks like a drop but isn't: "one POST = one t" is a wire convenience, not
SPEC §1; the log, `t` density and unique semantics are per element.

### 3.2 Bound `SortedNovelty.flush()` — make novelty inserts incremental instead of a full re-merge

**Does not move remote 700–900 unless the DO is CPU-bound** (experiment 1
decides). It is the largest in-process lever and it removes the degradation
mode of §2.1.

What: `packages/ramose/src/internal/core/novelty.ts:38-51` rebuilds `base` with
`sortedUnion(base, pending)` on the first read after any add — O(|base|) per
index per tx. Options that keep `all()`/`range()` semantics: (a) two-level:
keep `pending` sorted+deduped separately, let `range()` return the union of two
binary-searched slices (small; `mergeChunks`/`seekMany` take one `Chunk`, so
either union the two slices into a fresh small array — cost O(matches), not
O(N) — or accept two chunks), and fold `pending` into `base` only when
`|pending| > sqrt(|base|)` or on `dropThrough`; (b) a proper sorted
structure (B-tree / skip list) — bigger change, same effect. `all()` (used by
the indexer and `Connection.index`) can still materialize once per run.

Expected, from the local numbers: per-tx resolve at bench config 283–329 µs →
~20–40 µs (the fixed part measured with tiny novelty), so **in-process
2.6–3.0k → plausibly 8k+ tx/s** at 64 clients (upper bound from 64 × 35 µs +
1 ms commit + 1 ms yield ≈ 15k; other per-tx costs — promise chains, JSON
broadcast, log encode — will show up next; unmeasured beyond the bound). It
also makes throughput flat in novelty size (today: 3.0k → 0.7k when 20k txs
are un-indexed), which is what protects the writer when a big scattered merge
lags. Datoms/s: same factor. Remote: DO CPU per tx drops by the same amount;
converts to tx/s only if experiment 1 shows the DO is CPU-bound.

Cost / risk: core data structure, medium (~150 lines + tests: `range()`
correctness across the two levels, `dropThrough`, `mergeChunks` fast path,
`seekMany`). Also benefits the replica/peer read path (same class, same
pattern: every read after a WS frame re-merges) — out of scope here but a
free rider. No guarantee touched: novelty is an in-memory view of the log.

### 3.3 Move `mergeSlice` (the index merge) off the writer thread — second DO / Workflow

**Does not move remote 700–900 unless the DO is CPU-bound.** In-process it
removes the thread sharing shown in §2.1 (13 runs / 4 s, growing per run,
alarm starvation at 256 clients).

What: the seam is documented (`indexer.ts:11-13`): hand `(roots, log range)`
to another isolate — an `IndexerDO` per db or a Workflow — which reads the
slice from `log/` chunks (already flushed first, `indexer.ts:99`) or from the
transactor's `/log`, runs `mergeRoots` against R2, publishes `roots/<t>`, and
calls back; the transactor then needs an `adoptRoots(roots, maxT)` on
`Connection` that swaps roots and rebuilds `remaining` novelty (today
`Connection.index()` does merge+swap in one, `conn.ts:236-251`; the swap half
is `Novelty.dropThrough`). Guarantees untouched: the index is derived data;
`t`, log, uniques, durability are all in the transactor.

Expected: in-process — the merge's CPU and its per-run R2 puts leave the
writer thread; resolve stays at ~35 µs/tx + flush cost (so combine with 3.2:
without 3.2, novelty grows while the remote merge runs and 3.2's problem
returns). Bound: unmeasured; the prior "15–25 % stall tax" figure came from
scattered-update merges; the local default-config run suggests the coupling
is worse under sustained load (see §2.1) but the two are hard to separate
because `index.run` `ms` is wall time overlapping commits. Remote: only via DO
CPU. Datoms/s: same as tx/s.

Cost / risk: medium-large (new DO/Workflow, callback protocol, node cache is
cold on the other isolate so more R2 GETs per merge, root-flip ordering with
`adoptRoot`/replicas). Not a new ceiling; a stall remover.

### 3.4 Fatter single tx (already the API)

**Does not move remote tx/s at all; it moves datoms/s.** In-process (*local*,
default config): 1-entity txs 4.9k tx/s ≈ 15k datoms/s; 10-entity txs 1.2k
tx/s ≈ 12k entities/s ≈ 36k datoms/s; `Connection`-only 50-entity txs 1,096
µs/tx ≈ 46k entities/s. So per-entity cost is ~20 µs flat and a fat tx buys
2–3× datoms/s in-process; remotely it buys N× datoms/s at the same req/s
until DO CPU. Cost: none (API exists). Keep as the bulk-load answer; it is
not a tx/s answer.

### 3.5 Less work per tx (trims; none moves remote, each is small in-process)

Ordered by measured or bounded size:

- **Hot (e,a) history growth** — found, not a trim: `current(e,a)` reads the
  *entire* EAVT `{e,a}` history and collapses it (`tx.ts:276-284`,
  `db.ts:116-121`). Updating the same card-one attribute repeatedly costs
  O(prior updates): *local* 6,000 updates of one `(e, :k/v)` → **200 µs/tx**
  with the default indexer (vs 35 µs for inserts) and it keeps growing —
  counters/status fields will hit this. Every mitigation is an index-design
  question (a current-only tree next to the history tree, or a reverse seek
  that stops at the newest datom per value), not a write-path tweak; the read
  path pays the same. Flagged; no option here.
- **Duplicate AVET seek for unique-identity adds**: upsert pass (`tx.ts:250`)
  and `emitAdd` (`:298`) seek the same `(a,v)`; ~2 µs when warm, negligible —
  *except* when the node is not in the 4096-node LRU (then it is an R2 GET
  either way; the second is deduped by `inflight`). Skip.
- **`schema.clone().apply()` per tx** (`conn.ts:222`): 2.5 µs (10 attrs); grows
  with schema size (5 maps copied). Skip when no datom has `a ≤ DB_DOC`
  (`schema.ts:160` already has the fast reject inside `apply`). ~1–2 % at
  today's per-tx cost; more after 3.2. Trivial.
- **`getAlarm()`/`setAlarm()` per batch** (`indexer.ts:62-72`): a DO storage
  call per batch, and while `txsSinceIndex ≥ threshold` a `setAlarm(now)`
  write per batch until the alarm runs. Memoize in memory. Cost on CF
  unmeasured (sub-ms per batch, i.e. ≤ 10 % of a 10 ms batch); free to fix.
- **WS broadcast per tx** (`transactor.ts:329,358`): one `JSON.stringify` +
  send per tx per subscriber; ~10 µs/tx locally, 4 % for 4 subscribers. One
  frame per batch would need a wire-format bump. Not worth it now.
- **`retractEntity` overlay scan** (`tx.ts:352-363`): iterates the whole in-tx
  overlay with `k.split(":")` per key → O(ops²) for txs that retract many
  entities. Edge case; keep a ref-only side index if it shows up.
- **Log row per tx** (`transactor.ts:182-187`, one `encodeLogChunk([e])` +
  `INSERT` each): commit is 2–8 % of wall; not a lever.
- **JSON**: `fromJson`/`toJson` walk the tx and the ack (`transactor.ts:444,
  447`); µs for small txs; scales with fat txs. Not a lever.
- **`Connection.transact` promise chain** (`conn.ts:227-229`): redundant under
  the commit loop's own serialization; 2 promises/tx. Micro.

### 3.6 SQLite segment tier on the transactor's `R2NodeStore`

**Does not move remote tx/s.** It moves ack p99 / cold-start on large trees.
The transactor's node store has `maxNodes: 4096` and **no tier**
(`transactor.ts:135`); every `current(e,a)` / unique seek that misses the LRU
is an R2 GET on the ack path (tens of ms; deploy 3/4 measured 12–13 ms
same-colo for a basis hop, R2 is more). Fresh-db benches never miss, so this
is unobserved. The replica already has a SQLite `segcache`
(`replica-do.ts:46-56`); reusing it for the transactor is small. Effect:
bounded latency for updates to existing entities on multi-million-datom dbs
and after DO eviction; throughput unchanged.

### 3.7 Batch window: shorter, not longer

**Does not move remote at all** (each POST is still one DO event, and remote
batches are 6–14 because arrivals are RTT-paced, not because the window
closes early). Longer windows only add latency (RUNBOOK is right). *Shorter*
matters in-process at low concurrency: the `setTimeout(0)` yield is 1.08 ms in
Bun (`transactor.ts:86`), so 1 client / `maxBatch: 1` caps at ~640 tx/s
regardless of storage; a `setImmediate`-class yield (or "yield only after a
write, not before every batch") would put the single-client bound near 1/(0.13
+ 0.34 ms) ≈ 2k tx/s in-process — inferred from the split, unmeasured; on
workerd the clamp is unknown. Cost trivial; do it only after checking the
timer behaviour there, and keep *a* macrotask yield so in-flight DO events
can join the batch (guarantee 3 is unaffected either way).

### 3.8 Index knob tuning

**Does not move remote.** In-process, lower `RAMOSE_INDEX_TX_THRESHOLD`
(500 → 100) shrinks steady-state novelty and with it the flush cost (35 → 19
µs/tx in the `Connection` bench) at the price of 5× more runs (each with a
`putLogChunk`, `publishRoot`, root frame to replicas, and its own R2 puts —
run count is what hurt at 64 clients in §2.1); lower `RAMOSE_INDEX_MAX_TXS_PER_RUN`
shortens each stall. Both are second-order to 3.2/3.3 and trade R2 traffic
for CPU. Worth a sweep only after 3.2.

---

## 4. Rejected / out of scope

- **Multi-writer / sharded `t` for one database** — breaks guarantees 1–5;
  RUNBOOK says never.
- **Gossip / distributed unique reservation** — moves unique/upsert
  resolution out of the serial turn (guarantee 4).
- **One `t` per group-commit batch (FDB/Calvin style)** — drops dense per-tx
  `t` (guarantee 2) and the per-tx tx entity.
- **DSQL / TrueTime / hybrid clocks** — solve multi-writer ordering, which we
  do not have and do not want.
- **CRDT / client-merged writes** — no transactor-resolved uniqueness, no
  serializable txs.
- **Skipping or deferring persistence before ack** — guarantee 6.
- **Compacting retracted history out of the current tree** — would fix the
  hot-(e,a) cost (§3.5) but changes as-of/history semantics; an index-design
  decision, not a write-path tweak.
- **Splitting the logical database** — the product scale lever (RUNBOOK); it
  multiplies transactors, it does not make one faster.

---

## 5. Recommended next experiments (ordered; no implementation this session)

1. **Record the DO's own split on real CF (no engine change).** Re-run
   `bench/write-do.bench.ts` at 8 / 64 / 256 clients and print
   `info.transactor.stats.{resolveMs, commitMs, txs, batches}` and
   `metrics.commitMs` deltas over the run (`/info` already returns them,
   `transactor.ts:416-436`). Falsifiable: if `(resolveMs + commitMs) / wall <
   0.25` at 64 clients, the DO is request-bound and only 3.1 raises remote tx/s
   (3.2/3.3 will not); if `> 0.6`, the DO is CPU-bound and 3.2 then 3.3 come
   first. Also print `resolveMs / txs` to see whether CF's per-tx cost is
   near the dev box's ~150 µs.
2. **Multi-tx POST prototype (3.1) on one deploy, header-gated.** Same bench,
   64 clients, k = 1 / 8 / 32 txs per request. Falsifiable: at k = 8, tx/s ≥
   3× the k = 1 number at ≤ 1.5× ack p50 and equal DO req/s (`batches`,
   `metrics.txPerSec`); if tx/s does not scale with k the ceiling is DO CPU or
   body handling, not req/s, and experiment 1's split says which.
3. **Incremental novelty (3.2) locally.** Falsifiable: `bench/transactor.bench.ts
   64 4` (bench config, index off) goes from ~2.6–3.0k to ≥ 5k tx/s, and per-tx
   resolve with 20k txs pre-loaded is within 20 % of the 0-preload number
   (today 1,342 vs 283 µs). Then re-run with the default indexer to see how far
   the in-process ceiling moves once the flush is O(log N) — that number is the
   new bound for 3.3 and for CPU-bound DOs.

Two corrections to `bench/RESULTS.md` fall out of this and should be applied
when it is next touched: the in-process M2/M7 tables were measured with the
indexer disabled (unbounded novelty; the default configuration is ~2× faster on
the same harness), and the "single write ≈ 630 tx/s = fsync-bound" reading is
the Bun `setTimeout(0)` clamp (commit is 0.3–1 ms per batch).
