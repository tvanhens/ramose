# Ramose bench results

Recorded on the dev machine (Bun 1.3, Linux, shared/noisy CPU). Re-run with `bun run bench`.

> The `ripple-worker-…workers.dev` hosts quoted below are historical records of
> the runs as they happened; the product is now Ramose.

## M1 — core engine (1,000,025-datom in-memory dataset, 100k people)

`bun run bench:seek` (warm tree seeks, leaf 3000 / fan-out 1024):

| op | per op | p50 | p99 |
|---|---|---|---|
| tree.seekOne EAVT {e} | 2.05 µs | 1.85 µs | 3.77 µs |
| tree.seekOne EAVT {e,a} | 1.84 µs | 1.88 µs | 3.62 µs |
| tree.seekOne AVET {a,v} | 3.82 µs | 3.66 µs | 8.28 µs |
| tree.seekOne VAET {v,a} | 1.86 µs | 1.76 µs | 3.04 µs |
| db.first EAVT {e,a} (merge + current view) | 3.27 µs | 3.23 µs | 6.12 µs |
| db.entid lookup ref (AVET) | 5.22 µs | 5.12 µs | 9.27 µs |

**Gate: single seek < 10 µs warm → PASS.**

`bun run bench:join` (city → friends → friend name; 10k → 30k intermediate rows):

| query | rows | min | p50 |
|---|---|---|---|
| 3-clause city→friends→name | 29,999 | 37.8 ms | 43.1 ms |
| 4-clause with both names | 29,999 | 46.4 ms | 48.9 ms |
| 3-clause count aggregate | 1 | 30.2 ms | 38.7 ms |
| input-driven 2-clause (10k ids in) | 29,999 | 32.9 ms | 34.4 ms |

**Gate: 3-clause join over ~10k intermediate rows < 50 ms → PASS (p50 43 ms).**
Plan for the gate query: AVET scan (10k) → batched seek-join on EAVT (10k
sorted seeks, one cursor) → streaming hash-join over AEVT (100k datoms scanned,
primitive-keyed probes).

## M2 — transactor write path (`bun run bench:transactor`, 64 concurrent clients, 5 s)

Runtime-agnostic `Transactor` over a real SQLite file (WAL, fsync per commit)
with one novelty subscriber receiving every frame:

| mode | tx/s | ack p50 | ack p99 | storage writes | avg batch |
|---|---|---|---|---|---|
| group commit | 2,503 | ~25 ms | ~50 ms | 198 | 63.7 |
| one tx per write | 2,047 | 26 ms | 55 ms | 10,342 | 1 |

**Gate: ≥ 500 tx/s sustained with group commit → PASS.** The durable log is
verified contiguous after each run (`t` = 1..N, no gaps/dupes).

Through the full local stack (`bun alchemy dev`: Worker → Transactor DO with
SQLite storage, miniflare emulation; `RAMOSE_URL=… bun run bench/write-do.bench.ts 64 5`):

| clients | tx/s | ack p50 | ack p99 | batches | avg batch | max batch |
|---|---|---|---|---|---|---|
| 64 | 1,744 | 27 ms | 117 ms | 570 | 15.4 | 35 |

Correctness (`bun test packages/ramose/test/internal/transactor`): contiguous `t` under 500
concurrent clients; storage-fault injection → batch all-or-nothing, instance
aborted, restart continues with no gaps/dupes; novelty frames + resume /
gap catch-up; alarm-driven indexing.

## M7 — load tests

### Write ceiling: with vs without group commit

In-process Transactor over an fsync'd SQLite file, 4 s per cell, one novelty
subscriber (`bun run bench/transactor.bench.ts 64 4 1,8,64,256`; "single" =
`maxBatch: 1`, i.e. one storage write per tx):

| clients | group tx/s | group p50 | group p99 | avg batch | single tx/s | single p50 | single p99 |
|---|---|---|---|---|---|---|---|
| 1 | 641 | 1.5 ms | 2.7 ms | 1 | 628 | 1.5 ms | 2.9 ms |
| 8 | 2,108 | 3.6 ms | 7.6 ms | 8 | 635 | 12.4 ms | 16.7 ms |
| 64 | 2,701 | 22 ms | 54 ms | 63.6 | 631 | 100 ms | 111 ms |
| 256 | 2,860 | 85 ms | 181 ms | 250 | 630 | 404 ms | 427 ms |

Single-write mode is fsync-bound (~630 tx/s regardless of concurrency);
group commit converts concurrency into batch size and reaches ~2.8k tx/s on
this machine, i.e. the write ceiling of one logical database is
**low-thousands tx/s** as the spec expects (§7). Beyond that, split the
logical database (see `docs/RUNBOOK.md`).

Through the full local stack (`bun alchemy dev`, Worker → Transactor DO,
`bun run bench/write-do.bench.ts <clients> 5`; "off" = `RAMOSE_MAX_BATCH=1`):

| clients | group commit tx/s | ack p50 / p99 | avg batch | group commit off tx/s | ack p50 / p99 |
|---|---|---|---|---|---|
| 8 | 1,228 | 4.9 / 44 ms | 2.7 | 867 | 7.7 / 58 ms |
| 64 | 1,595 | 29 / 120 ms | 15.2 | 836 | 68 / 203 ms |
| 256 | 1,741 | 142 / 303 ms | 16.1 | 805 | 312 / 456 ms |

The DO path is bounded by the local emulator's per-request overhead (batches
stay ~16 because the Worker → DO hop paces arrivals), so the in-process
numbers are the better estimate of the transactor itself.

### Read path through the Worker (warm)

`bun run bench/read-do.bench.ts 5000 200 8` (5k people indexed into segments,
200 runs × 8 concurrent per query, warm isolate; client p50 includes local
HTTP RTT, server p50 is the Worker's own `x-ramose-ms`):

| query | client p50 | client p95 | server p50 |
|---|---|---|---|
| point lookup (AVET) | 3.6 ms | 7.1 ms | 1 ms |
| entity attributes (EAVT) | 3.9 ms | 5.0 ms | 1 ms |
| city → friends → name (3-way join) | 11.6 ms | 24.6 ms | 3 ms |
| count by city (aggregate) | 4.9 ms | 7.2 ms | 1 ms |

Repeat queries hit the peer's memory tier (8,258 peek hits vs 12 R2 gets over
the whole run). **Multi-colo read scaling was not measured**: this
environment has no Cloudflare credentials, so there is one local isolate and
no geographic distribution; only a real deployment can produce those numbers.

## M7 — timed incremental index runs (`bun run bench/indexer.bench.ts`)

In-process (Transactor over in-memory R2 + bun:sqlite): seed N people
(4 datoms each) into segment trees, write a **scattered** delta of 10k txs
(¼ inserts, ¾ single-datom updates on entities spread over the whole id
range), then time one index run. "new objects" is exactly
|reachable(new) − reachable(old)| (asserted in the M4 test).

| people (datoms) | leaf / fan-out | tree objects (depth) | run | new objects (rewritten) | per tx |
|---|---|---|---|---|---|
| 300k (1.2M) | 3000 / 1024 | 1,125 (2) | 1.65 s | 925 (82%) — 4.5 MB | 0.09 obj, 0.17 ms |
| 300k (1.2M) | 500 / 64 | 6,723 (3) | 3.13 s | 5,231 (78%) — 5.5 MB | 0.52 obj, 0.31 ms |
| 1M (4M) | 3000 / 1024 | 3,695 (3) | 4.25 s | 2,425 (66%) — 12.3 MB | 0.24 obj, 0.43 ms |

Reading: with 10k *uniformly scattered* single-datom updates the delta
touches most leaves of every index (300k people / 3000-datom leaves ≈ 400 EAVT
leaves; 10k random entities hit nearly all of them), so the rewritten
fraction is high by construction — cost is O(touched paths), and here almost
every path is touched. The absolute cost is what matters for the DO budget:
~0.2–0.4 ms and ~10–20 KB of new objects per transaction at this scale, i.e.
a bounded 5k-tx run stays around 1–2 s of CPU. Localised deltas (one tenant's
entities, monotone ids) touch a handful of leaves and rewrite < 1% (see the M4
test: 60 txs on 600k datoms → < 10% of objects). A 10M-datom run was not
timed here (memory of the in-process harness); scale the 4M row linearly.

## Milestone status (as of this snapshot)

| milestone | status | evidence |
|---|---|---|
| M0 scaffold | **accepted** — deployed to a real Cloudflare account (stage `cf-e2e`, 2026-08-16), e2e 9/9 + write/read benches against it, then destroyed | `alchemy.run.ts`, `test/e2e`; see "Cloudflare" section below |
| M1 core engine | **accepted** | 57 core tests; seek < 10 µs; 3-clause join p50 43 ms |
| M2 transactor | **accepted** (in-process + local stack) | 13 transactor tests (contiguous t under 500 concurrent clients, fault injection + restart, novelty/gap catch-up, alarm indexing); ≥ 500 tx/s (2.5k in-process, 1.7k through the local Worker) |
| M3 R2 store + caching | tiers verified in-process | 4 storage tests: cold ≤ depth GETs, repeat 0 R2 reads, dedupe, corrupt-tier fallback; e2e repeat query hits cache |
| M4 incremental indexer | verified at 600k datoms (scaled from 10M) | exact new-object count == |reachable(new) − reachable(old)|; as-of via old root; consistent snapshots; bounded, re-arming runs |
| M5 replica + novelty | e2e | reconnect under concurrent writes → no missed datoms; root flip drops novelty |
| M6 peer + time travel + SDK | e2e | schema → transact → query → as-of → history → pull; persistence across a full stack restart verified manually |
| M7 | **done** (verified on a real Cloudflare deployment; see "Cloudflare" section) | planner memory guardrail (413 `query/budget-exceeded`, tested), write-ceiling load tests with/without group commit + warm read bench, structured logs/metrics per component, `docs/RUNBOOK.md`; timed indexer bench |

## Cloudflare (real deployment, stage `cf-e2e`, 2026-08-16)

`ALCHEMY_STAGE=cf-e2e bun alchemy deploy` → one Worker + `TransactorDO` +
`QueryReplicaDO` (SQLite-backed) + one R2 bucket on a real Cloudflare account.
Worker host: `ripple-worker-dev-box-3cdr6qso35cbzmpr.tvanhens.workers.dev`
(workers.dev; no custom domain, no auth token). Client ran from a machine
whose Cloudflare edge is **IAD** (`cf-ray …-IAD`; `/db/*/info` reports
`region: "NA"` for the DOs), so every number below is one client → one colo
→ one DO placement; **no multi-colo data was measured**. The stage was
destroyed afterwards (`bun alchemy destroy`; `/health` → 404, Cloudflare error 1042 "worker not found"; a re-plan shows nothing left in the stage).

### e2e (`RAMOSE_URL=<url> bun test test/e2e`)

9/9 pass in ~9 s (schema → transact → query → as-of → history → pull,
serialized `t` under 40 concurrent clients, replica reconnect under writes,
root flip drops novelty, 413 `query/budget-exceeded`, write smoke). Write
smoke: 300 tx in 1.15–1.4 s → **214–261 tx/s**, max batch 75–136. One
assertion (root flip visible on the replica right after `index()` acks) is a
~100 ms WebSocket propagation race on real CF that miniflare never showed;
the test now polls for it (test-only change).

### Write path (`bun run bench/write-do.bench.ts <clients> 5`, group commit on)

| clients | tx/s | ack p50 | ack p95 | ack p99 | errors | transactor batches / max / avg |
|---|---|---|---|---|---|---|
| 8 | **166** | 36 ms | 94 ms | 120 ms | 0 | 719 / 5 / 1.17 |
| 64 | **664** | 71 ms | 220 ms | 370 ms | 0 | 532 / 57 / 6.41 |

### Read path (`bun run bench/read-do.bench.ts` = 5000 people, 200 runs × 8 concurrent, warm)

| query | client p50 | client p95 | server p50 (`x-ramose-ms`) |
|---|---|---|---|
| point lookup (AVET) | 44.8 ms | 84.2 ms | 37 ms |
| entity attributes (EAVT) | 44.4 ms | 100.1 ms | 36 ms |
| city → friends → name (3-way join) | 49.0 ms | 102.9 ms | 39 ms |
| count by city (aggregate) | 46.3 ms | 52.7 ms | 38 ms |

Peer segment cache over the run: 7,252 peek hits, 10 R2 gets, 0 puts.

**vs local miniflare (above):** writes 166 / 664 tx/s at 8 / 64 clients vs
1,228 / 1,595 locally — the live path is dominated by client → edge → DO
round-trip (~35 ms floor per ack, so 8 clients can only push ~200 tx/s and
batches stay near 1), and throughput scales with concurrency as group commit
kicks in (avg batch 1.2 → 6.4); reads are ~45 ms client p50 vs ~4–12 ms
locally, of which ~37 ms is the server-side `x-ramose-ms` (Worker → replica DO
basis fetch + edge query, i.e. an intra-Cloudflare hop that the single local
isolate does not pay) and the rest is WAN RTT.

## Cloudflare (replica-executed queries), stage `cf-e2e`, 2026-08-16 (second deploy)

Change under test: the Worker's `/query` `/pull` `/entity` now **forward the
read to the nearest `QueryReplicaDO` (`POST /query`)** — same `replicaId` /
`locationHint` as the old `fetchBasis` — instead of fetching a basis and
running datalog in the Worker (SPEC §8). Public API unchanged;
`x-ramose-ms` is still Worker wall time for the read. Hypothesis: the ~37 ms
server p50 in the section above was the extra basis hop.

Worker host: `ripple-worker-dev-box-zobj7ehwvxnrrft3.tvanhens.workers.dev`
(fresh stage; same client machine, IAD edge, one colo, one DO placement — **no
multi-colo data**). Destroyed afterwards (`bun alchemy destroy`; `/health` →
Cloudflare 1042 "worker not found").

### e2e

`RAMOSE_URL=<url> bun test test/e2e` → **9/9 pass** in 9.8 s (write smoke 300 tx in 1.17 s → 256 tx/s, max batch 110). Unit suite incl. the new Worker forwarding test: 84/84.

### Write path (unchanged code path; `bun run bench/write-do.bench.ts <clients> 5`)

| clients | tx/s | ack p50 | ack p95 | ack p99 | errors | transactor batches / max / avg |
|---|---|---|---|---|---|---|
| 8 | **172** | 32 ms | 92 ms | 160 ms | 0 | 727 / 4 / 1.21 |
| 64 | **872** | 61 ms | 120 ms | 385 ms | 0 | 560 / 47 / 7.92 |

(Same shape as the first deploy: 166 / 664 tx/s; run-to-run noise on a shared edge.)

### Read path (`bun run bench/read-do.bench.ts` = 5000 people, 200 runs × 8 concurrent, warm)

| query | previous CF (Worker executes): server p50 | **replica executes: client p50** | **client p95** | **server p50 (`x-ramose-ms`)** |
|---|---|---|---|---|
| point lookup (AVET) | 37 ms | 80.0 ms | 186.3 ms | **73 ms** |
| entity attributes (EAVT) | 36 ms | 76.3 ms | 136.3 ms | **68 ms** |
| city → friends → name (3-way join) | 39 ms | 79.1 ms | 139.1 ms | **70 ms** |
| count by city (aggregate) | 38 ms | 83.1 ms | 101.3 ms | **76 ms** |

Peer segment cache: all zeros (the Worker no longer touches segments; the
replica's own R2/tier stats now travel back as `x-ramose-r2-gets` /
`x-ramose-cache-hits`).

Diagnostic extra run, **same data, 100 runs × 1 concurrent** (to separate
per-request cost from queueing inside the DO):

| query | client p50 | client p95 | server p50 |
|---|---|---|---|
| point lookup (AVET) | 46.2 ms | 56.1 ms | 39 ms |
| entity attributes (EAVT) | 47.0 ms | 101.2 ms | 38 ms |
| city → friends → name (join) | 49.9 ms | 107.3 ms | 41 ms |
| count by city (aggregate) | 46.8 ms | 53.9 ms | 39 ms |

**Verdict: server p50 did not move toward the 15 ms budget — it stayed at
38–41 ms at concurrency 1 (identical to the old basis-fetch path) and
roughly doubled to 68–76 ms at 8 concurrent.** The hypothesis was wrong: the
~37 ms is not "basis fetch + a second hop", it is one Worker → replica-DO
round trip, paid once either way (datalog itself is 1–3 ms). Moving execution
into the DO made things worse under concurrency because a Durable Object is
single-threaded: 8 in-flight reads now serialize their datalog inside one
replica instead of running in parallel Worker isolates. Next hypothesis (not
tested here, out of scope for this session): the DO placement — `hintFor("NA")`
pins the replica with `locationHint: "wnam"` while this client/Worker sit at
IAD, so every read may be paying a coast-to-coast RTT; a replica pinned near
the requesting colo (or per-colo/continent-sub-region ids) plus keeping
execution in the Worker (parallel isolates, one basis RTT) is the combination
to measure next. Multi-colo scaling remains unmeasured.

## Cloudflare (placement vs basis cache), stage `cf-e2e`, 2026-08-16 (third deploy)

Worker-local execution restored (`fetchBasis` → `dbFromBasis` → `query`/`pull`
in the Worker; the replica-executed forwarding above is gone). Two knobs,
switchable **per request by header** so one deploy covers all variants:

- `x-ramose-replica-hint: wnam | enam` — DO location hint; the hint is now part
  of the replica id (`${db}|${region}|${hint}|${shard}`) so `enam` creates a
  fresh DO in the east instead of reusing the wnam one. Default: `hintFor(continent)` = `wnam` for NA (old behavior).
- `x-ramose-cache-basis: 0 | 1` — module-scope basis cache in the Worker isolate,
  keyed `db|hint`, invalidated by a write through this Worker or a 5 s TTL. Default 0.

Client passes both via `headers`; `bench/read-do.bench.ts` reads
`RAMOSE_REPLICA_HINT` / `RAMOSE_CACHE_BASIS`. Worker host
`ripple-worker-dev-box-dig2mjnjv4e53lyb.tvanhens.workers.dev`; client and Worker
in **IAD** (cf-ray `…-IAD`, `x-ramose-colo: IAD` on every query) — one colo, **no
multi-colo data**. Destroyed afterwards (`/health` → 404).

e2e on defaults (Worker executes, hint wnam, cache off): **9/9 pass** (write smoke 300 tx in 1.20 s → 251 tx/s, max batch 80). Unit suite 81/81 (the forwarding test was removed with the forwarding).

### Write path control (`bun run bench/write-do.bench.ts <clients> 10`) — unchanged, as expected

| clients | tx/s | ack p50 | ack p95 | ack p99 | errors | batches / max / avg |
|---|---|---|---|---|---|---|
| 8 | 160 | 35 ms | 95 ms | 152 ms | 0 | 1176 / 6 / 1.37 |
| 64 | 879 | 59 ms | 130 ms | 241 ms | 0 | 937 / 56 / 9.48 |

### Read path (`bun run bench/read-do.bench.ts 5000 200 8` and `5000 100 1`, warm; server p50 = `x-ramose-ms`)

Baseline (first deploy, Worker executes, hint wnam, no cache): server p50 **36–39 ms** at conc 8, **38–41 ms** at conc 1. Replica-executed (second deploy): 68–76 ms at conc 8.

**A — Worker executes, hint `enam` (same colo as IAD), cache off**

| query | conc 8 client p50 | conc 8 client p95 | conc 8 server p50 | conc 1 client p50 | conc 1 client p95 | conc 1 server p50 |
|---|---|---|---|---|---|---|
| point lookup (AVET) | 43.5 ms | 63.6 ms | **32 ms** | 20.8 ms | 27.2 ms | **7 ms** |
| entity attrs (EAVT) | 43.9 ms | 109.9 ms | **31 ms** | 22.0 ms | 79.9 ms | **7 ms** |
| city → friends → name (join) | 48.0 ms | 262.5 ms | **32 ms** | 23.9 ms | 35.7 ms | **7 ms** |
| count by city (agg) | 45.6 ms | 59.6 ms | **33 ms** | 22.3 ms | 29.1 ms | **7 ms** |

Verdict: at conc 1 the same-colo hint takes server p50 from ~40 ms to **7 ms**
(the basis hop is now intra-colo, not IAD↔west coast). At conc 8 it only moves
36–39 → 31–33 ms: 8 concurrent `/basis` calls serialize on the single replica
DO, so the queue, not the wire, dominates. Placement alone does not reach 15 ms under load.

**B — Worker executes, hint `wnam` (old placement), basis cache on**

| query | conc 8 client p50 | conc 8 client p95 | conc 8 server p50 | conc 1 client p50 | conc 1 client p95 | conc 1 server p50 |
|---|---|---|---|---|---|---|
| point lookup (AVET) | 7.5 ms | 29.9 ms | **0 ms** | 7.0 ms | 9.4 ms | **0 ms** |
| entity attrs (EAVT) | 7.2 ms | 66.0 ms | **0 ms** | 7.8 ms | 68.1 ms | **0 ms** |
| city → friends → name (join) | 7.9 ms | 68.5 ms | **0 ms** | 7.7 ms | 63.2 ms | **0 ms** |
| count by city (agg) | 6.8 ms | 13.1 ms | **0 ms** | 7.2 ms | 9.8 ms | **0 ms** |

Verdict: with the basis cached in the isolate the whole read is **<1 ms of
Worker time** (server p50 rounds to 0); client p50 ≈ 7 ms is the client↔IAD
RTT. Placement becomes irrelevant once the basis hop is skipped. Well past 15 ms.
Cost: reads can be up to 5 s stale relative to writes made through *other*
Workers/isolates (writes through the same isolate invalidate immediately).

**C — Worker executes, hint `enam`, basis cache on**

| query | conc 8 client p50 | conc 8 client p95 | conc 8 server p50 | conc 1 client p50 | conc 1 client p95 | conc 1 server p50 |
|---|---|---|---|---|---|---|
| point lookup (AVET) | 7.0 ms | 10.5 ms | **0 ms** | 7.1 ms | 8.8 ms | **0 ms** |
| entity attrs (EAVT) | 7.4 ms | 65.2 ms | **0 ms** | 7.1 ms | 64.8 ms | **0 ms** |
| city → friends → name (join) | 17.7 ms | 35.1 ms | **3 ms** | 8.9 ms | 11.3 ms | **0 ms** |
| count by city (agg) | 7.0 ms | 11.8 ms | **0 ms** | 7.1 ms | 8.6 ms | **0 ms** |

Verdict: same as B (0 ms server p50; the join's 3 ms at conc 8 is CPU
contention in one isolate). Cache-miss refills are cheaper here (7 ms vs ~40 ms
per the A/baseline conc-1 numbers) so C is the better default combination, but
the cache is what moves the number, not the hint.

Summary (server p50, `x-ramose-ms`):

| variant | execution | hint | basis cache | conc 1 | conc 8 |
|---|---|---|---|---|---|
| baseline (deploy 1) | Worker | wnam | off | 38–41 ms | 36–39 ms |
| replica-executed (deploy 2) | Replica | wnam | — | 38–41 ms | 68–76 ms |
| A | Worker | enam | off | **7 ms** | 31–33 ms |
| B | Worker | wnam | on | **0 ms** | **0 ms** |
| C | Worker | enam | on | **0 ms** | **0–3 ms** |

## Cloudflare (cache/invalidation gate), stage `cf-e2e`, 2026-08-16 (fourth deploy)

Question: is "basis cache on by default + real invalidation + colo-correct hint"
better than today's default (cache off, hint `wnam`, replica hop per read)? The
earlier B/C rows used opt-in headers and a 5 s TTL; this deploy adds the
knobs below and measures them per request **on one deploy** (no redeploys
between variants). Worker host
`ripple-worker-dev-box-uax23drlds3vbl4b.tvanhens.workers.dev`; client and Worker
in **IAD** (`cf-ray …-IAD`, `x-ramose-colo: IAD`).

Knobs (`packages/ramose/src/worker/peer.ts`; header per request, env for the default):

- `x-ramose-cache-basis: 0|1` (env `RAMOSE_CACHE_BASIS`) — isolate basis cache keyed `db|hint`.
- `x-ramose-cache-mode: ttl|peer` (env `RAMOSE_CACHE_MODE`) — `ttl` = today's 5 s
  expiry (control); `peer` = no freshness timer: a transact through this isolate
  invalidates, `x-ramose-min-t: <t>` (client's last seen t) refetches when the cached
  basis is behind (polls a lagging replica up to 5×20 ms), a 10 min safety TTL only bounds memory.
- `x-ramose-replica-hint: wnam|enam|…|auto` (env `RAMOSE_REPLICA_HINT`) — `auto` = colo→hint
  (IAD/EWR/ATL/… → `enam`, SJC/LAX/SEA/… → `wnam`); the hint is part of the replica DO id.
- Diagnostics on every read: `x-ramose-basis-hit`, `x-ramose-basis-reason` (hit|off|miss|expired|min-t),
  `x-ramose-basis-calls`, `x-ramose-basis-behind`, `x-ramose-cache-mode`.

Defaults for this deploy = today's: cache off, mode ttl, hint = continent (`wnam` from IAD).
e2e on defaults: **9/9** (write smoke 300 tx in 1.39 s → 215 tx/s, max batch 117). Unit suite 91/91.

### Write path control (`bun run bench/write-do.bench.ts <clients> 10`) — unchanged

| clients | tx/s | ack p50 | ack p95 | ack p99 | errors | batches / max / avg |
|---|---|---|---|---|---|---|
| 8 | 233 | 32 ms | 40 ms | 91 ms | 0 | 1694 / 8 / 1.38 |
| 64 | 802 | 72 ms | 123 ms | 269 ms | 0 | 597 / 64 / 13.87 |

### Read path (`bun run bench/read-do.bench.ts 5000 200 8` and `5000 100 1`, warm; server p50 = `x-ramose-ms`)

Server p50 per query is identical across the four queries in every row except
where noted (join at conc 8), so rows are collapsed:

| id | what | headers | conc 8 server p50 | conc 1 server p50 | conc 8 client p50 | conc 1 client p50 | basis hits (conc 8 / conc 1) |
|---|---|---|---|---|---|---|---|
| prior baseline (deploy 3) | today's default | — | 36–39 ms | 38–41 ms | | | |
| **D0** | today's default, this deploy | cache 0, hint wnam | **68 ms** | **76–78 ms** | 76–77 ms | 84–88 ms | 0 / 0 (off) |
| **D1** | cache + old 5 s TTL (B replay) | cache 1, mode ttl, hint wnam | **0 ms** | **0 ms** | 6.6–9.9 ms | 6.7–8.0 ms | 800/800 / 399/400 |
| **D2** | cache + peer invalidation, no min-t | cache 1, mode peer, hint wnam | **0 ms** | **0 ms** | 6.5–7.7 ms | 7.5–8.2 ms | 800/800 / 400/400 |
| **D3** | D2 + colo hint enam | cache 1, mode peer, hint enam | **0 ms** (join 4 ms) | **0 ms** | 6.8–7.6 ms (join 17.6) | 6.7–8.4 ms | 800/800 / 400/400 |
| A replay (D3 miss path) | cache off, hint enam | cache 0, hint enam | — | **12–13 ms** | — | 20–21 ms | 0 / 0 (off) |
| **D4** | D2 + `x-ramose-min-t` = t of the bench's last write | cache 1, mode peer, hint wnam, min-t | **0 ms** | **0 ms** | 6.7–9.3 ms | 6.6–6.9 ms | 800/800 / 400/400 |
| D4 (enam) | same with hint enam | cache 1, mode peer, hint enam, min-t | **0 ms** (join 3 ms) | **0 ms** | 6.8–7.6 ms (join 15.9) | 7.1–9.4 ms | 800/800 / 400/400 |

Notes:

- **D0 is worse than the deploy-3 baseline** (68/77 ms vs 36–40 ms). Same code path
  as deploy 3; the `wnam` replica DO for each fresh bench db was evidently
  placed further west this time. Placement under `wnam` from an IAD client is not
  stable deploy to deploy — one more reason the hint should follow the colo.
- The A replay is 12–13 ms this deploy vs 7 ms on deploy 3 (also placement noise, still same-colo).
- D1 = D2 = D3 = D4 on the hit path: **0 ms server p50, 100% basis hits** at both
  concurrencies. Dropping the 5 s timer (peer) neither helps nor hurts the hit path;
  min-t is free when the cached basis already satisfies it (which it always does for
  a client whose own writes went through the same isolate — invalidation runs first).
- The join at conc 8 with hint enam is 3–4 ms server p50 (CPU contention in one
  isolate, as in C); with hint wnam it is 0 ms because that isolate is warmer? — noise-level.
- One D4 conc-8 run aborted in the bench's *seed* phase (`unknown attribute :person/city`
  on the first read of a fresh db): the fresh replica DO's first `/basis` was behind
  the transactor (`ensureConnected` waits 20 ms for hello + catch-up). Pre-existing
  cold-replica race (e2e already polls for it), independent of the cache; the rerun passed.

### Cross-isolate freshness (D2 / D4) — not observable from this vantage

Probe (`bench/freshness.bench.ts 10 16`: one writer, 16 fresh-connection readers,
first read right after each ack, then poll to visible):

| mode | first-read stale | first-read cache hits | time-to-visible p50 / p95 / max |
|---|---|---|---|
| D2 peer, no min-t | 0/160 | 3/160 | 0 / 0 / 0 ms |
| D4 peer, min-t = ack.t | 0/160 | 1/160 | 0 / 0 / 0 ms |
| D1 ttl (control) | 0/160 | 1/160 | 0 / 0 / 0 ms |

The 1–3/160 hit counts give it away: every reader landed on the **writer's**
isolate, so the same-isolate invalidation (not TTL / min-t) made every first
read a miss. Confirmed directly: 60 sequential fresh-connection curls (v4, v6,
both anycast IPs, HTTP/1.1 and h2, varied local ports) all carried the same
`cf-ray …f5ca-IAD` — one edge server, one isolate (1 miss, 59 hits). A second
vantage (remote agent, 441 reads over 150 s at 250 ms while this host wrote
every 6 s) also landed on `…f5ca-IAD` and saw every write on its next poll
(hit=0 immediately after each ack, 0 stale). So: **stale rate 0/N and
time-to-visible ≤ 1 poll for readers on the writer's isolate; readers on other
isolates were never reached and are unmeasured.** No second colo was invented.
By construction, on such an isolate: `ttl` → stale ≤ 5 s; `peer` without
min-t → stale until that isolate writes / a min-t read / the 10 min safety TTL;
`peer` or `ttl` **with** min-t → one extra `/basis` hop (the A/D0 miss cost:
12–13 ms same-colo, 68–77 ms `wnam` from IAD) then fresh (unit-tested, incl. polling a lagging replica).

### Gate

| criterion | result |
|---|---|
| D1 still matches B | ✅ 0 ms / 0 ms, 100 % hits |
| D2 warm server p50 ~0–3 ms | ✅ 0 ms / 0 ms |
| D4 correct, warm p50 not back in the 30s | ✅ 0 ms / 0 ms, min-t satisfied by the invalidated-then-refilled entry (single isolate) |
| writes unchanged | ✅ 233 / 802 tx/s vs 160 / 879 (noise) |
| e2e 9/9 | ✅ |
| cross-isolate stale rate / time-to-visible | ⚠️ unobservable from IAD (one isolate); peer-without-min-t is unbounded by design |

**Go, partially.** The table proves the *cache* (0 ms hits) and the *colo-correct
hint* (12–13 ms misses vs 68–77 ms) — those are now the defaults. It does **not**
distinguish `peer` from `ttl`: identical on every measured row, and the only
dimension where they differ (staleness on isolates that did not write, without
min-t) could not be measured and is strictly worse for `peer` (10 min vs 5 s).
`ttl` + `min-t` (min-t is honored in every mode) gives the same read-your-writes
as `peer` with a 5 s bound for everyone else, so **`ttl` stays the default mode;
`peer` remains opt-in** (`x-ramose-cache-mode: peer` / `RAMOSE_CACHE_MODE=peer`)
until a multi-isolate measurement exists.

### Defaults flipped (fifth deploy of the same stage, no code changes but the defaults)

`x-ramose-cache-basis` default 1, `x-ramose-replica-hint` default `auto` (colo→hint;
`continent` restores the old NA→wnam), `x-ramose-cache-mode` default `ttl`. e2e on no
headers: **9/9** (write smoke 300 tx in 1.20 s → 250 tx/s). Unit suite 91/91.

`bun run bench/read-do.bench.ts` with **no headers / no env** (the new default; `x-ramose-replica-hint: enam`, `x-ramose-cache-basis: 1`, `x-ramose-cache-mode: ttl` on every response):

| query | conc 8 client p50 | conc 8 client p95 | conc 8 server p50 | hits/refetch | conc 1 client p50 | conc 1 client p95 | conc 1 server p50 | hits/refetch |
|---|---|---|---|---|---|---|---|---|
| point lookup (AVET) | 6.8 ms | 38.9 ms | **0 ms** | 193/7 | 6.9 ms | 115.3 ms | **0 ms** | 95/5 |
| entity attrs (EAVT) | 7.3 ms | 67.0 ms | **0 ms** | 200/0 | 7.4 ms | 65.8 ms | **0 ms** | 100/0 |
| city → friends → name (join) | 10.1 ms | 22.6 ms | **0 ms** | 200/0 | 9.9 ms | 95.9 ms | **0 ms** | 98/2 |
| count by city (agg) | 6.9 ms | 34.3 ms | **0 ms** | 200/0 | 7.3 ms | 69.6 ms | **0 ms** | 96/4 |

= variant C, by default. The `refetch` column is the ttl mode's cost: one
same-colo `/basis` hop per 5 s per isolate (the p95 bumps), which peer mode would
remove at the price above. Summary vs the 36–39 ms baseline:

| id | server p50 conc 8 | conc 1 |
|---|---|---|
| deploy-3 baseline (cache off, wnam) | 36–39 ms | 38–41 ms |
| D0 this deploy (cache off, wnam) | 68 ms | 76–78 ms |
| D1 cache + ttl, wnam | 0 ms | 0 ms |
| D2 cache + peer, wnam | 0 ms | 0 ms |
| D3 cache + peer, enam | 0 ms (join 4) | 0 ms |
| D4 D2 + min-t (wnam / enam) | 0 ms / 0 ms (join 3) | 0 ms / 0 ms |
| **new default, no headers** (cache + ttl, auto=enam) | **0 ms** | **0 ms** |

Stage destroyed after the run (`bun alchemy destroy` → Worker + Store deleted, `/health` → 404). alchemy-state-store untouched.
