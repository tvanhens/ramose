import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { fmt, percentile } from "../lib.ts";
import { BENCH_DATABASE, BenchSchema } from "./catalog.ts";
import {
  CAPABILITY_HEADER,
  LANE_PATH,
  MAX_LANE_PARALLEL,
  MAX_LANE_REQUESTS,
  type LaneReport,
  type LaneRequest,
  type LaneTarget,
} from "./lane.ts";

const url = process.env.RAMOSE_URL;
const capability = process.env.RAMOSE_BENCH_CAPABILITY;
if (!url || !capability) {
  console.error("set RAMOSE_URL and RAMOSE_BENCH_CAPABILITY");
  process.exit(1);
}
const base = url.replace(/\/+$/, "");
const lanes = Math.max(1, Number(process.argv[2] ?? 32));
const parallel = Math.max(1, Math.min(MAX_LANE_PARALLEL, Number(process.argv[3] ?? 4)));
const seconds = Math.max(1, Number(process.argv[4] ?? 15));
const laneRequests = Math.max(
  parallel,
  Math.min(MAX_LANE_REQUESTS, Number(process.env.BENCH_LANE_REQUESTS ?? 500)),
);
const label = process.env.BENCH_LABEL ?? "";
const inFlight = lanes * parallel;

type Exchange = { status: number; body: any; text: string };

const call = async (path: string, init: RequestInit, token?: string): Promise<Exchange> => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (path.startsWith("/__test__/") || path.startsWith("/__bench__/")) {
    headers.set(CAPABILITY_HEADER, capability);
  }
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  return { status: res.status, body, text };
};

const admin = (db: string, rest: string, body: unknown): Promise<Exchange> =>
  call(`/__test__/db/${encodeURIComponent(db)}${rest}`, { method: "POST", body: JSON.stringify(body) });

const requireOk = (what: string, r: Exchange): any => {
  if (r.status !== 200) throw new Error(`${what} failed (${r.status}): ${r.text.slice(0, 400)}`);
  return r.body;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const run = Date.now().toString(36);
let laneCounter = 0;

const launchLane = async (
  target: LaneTarget,
  db: string,
  durationMs: number,
  requests: number,
  token?: string,
): Promise<LaneReport> => {
  const lane: LaneRequest = {
    target,
    db,
    run,
    lane: laneCounter++,
    parallel,
    maxRequests: requests,
    durationMs,
    ...(token === undefined ? {} : { token }),
  };
  const r = await call(LANE_PATH, { method: "POST", body: JSON.stringify(lane) });
  requireOk("bench lane", r);
  return r.body as LaneReport;
};

const load = async (name: string, target: LaneTarget, db: string, token?: string) => {
  const warm = await launchLane(target, db, 10_000, parallel, token);
  if (warm.ok === 0) {
    throw new Error(`${name} warm-up failed: ${JSON.stringify(warm.failures)}`);
  }
  const lat: number[] = [];
  const failures = new Map<string, number>();
  const colos = new Map<string, number>();
  let done = 0, errors = 0, invocations = 0, laneErrors = 0;
  const t0 = performance.now();
  const deadline = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining < 200) break;
      try {
        const report = await launchLane(target, db, remaining, laneRequests, token);
        invocations++;
        done += report.ok;
        errors += report.errors;
        for (const ms of report.latencies) lat.push(ms);
        for (const [error, count] of Object.entries(report.failures)) {
          failures.set(error, (failures.get(error) ?? 0) + count);
        }
        colos.set(report.colo, (colos.get(report.colo) ?? 0) + 1);
      } catch (e) {
        laneErrors++;
        const message = e instanceof Error ? e.message : String(e);
        failures.set(`lane: ${message}`, (failures.get(`lane: ${message}`) ?? 0) + 1);
        await sleep(250);
      }
    }
  }));
  const ms = performance.now() - t0;
  lat.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(12)} lanes=${lanes} parallel=${parallel} in-flight=${inFlight}: ${done} ok in ${fmt(ms, 0)} ms → ${fmt((done / ms) * 1000, 0)}/s, errors=${errors}, lane invocations=${invocations}, lane failures=${laneErrors}`,
  );
  console.log(`  latency p50 ${fmt(percentile(lat, 50))} ms  p95 ${fmt(percentile(lat, 95))} ms  p99 ${fmt(percentile(lat, 99))} ms`);
  console.log(`  driver colos ${[...colos.entries()].map(([colo, n]) => `${colo}×${n}`).join(" ")}`);
  for (const [error, count] of [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  error ×${count}: ${error}`);
  }
  return { done, errors, rate: (done / ms) * 1000, p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99) };
};

const transactorStats = async (db: string) => {
  const info = requireOk("transactor info", await admin(db, "/info", {}));
  const s = info.stats;
  return {
    txs: s.txs as number,
    batches: s.batches as number,
    avgBatch: s.batches ? s.txs / s.batches : 0,
    maxBatch: s.maxBatch as number,
    rejected: s.rejected as number,
    txPerSec: info.metrics.txPerSec as number,
    novelty: info.novelty as number,
    opts: info.opts,
  };
};

type Stats = Awaited<ReturnType<typeof transactorStats>>;

const serverSide = (before: Stats, after: Stats) => ({
  "server txs": after.txs - before.txs,
  "server tx/s": after.txPerSec,
  novelty: after.novelty,
});

const attribute = (ident: string, type: string, extra: Record<string, unknown> = {}) => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ":db/optional": true,
  ...extra,
});

const rows: Record<string, unknown>[] = [];

{
  const db = `bench-tx-${run}`;
  requireOk("transact schema", await admin(db, "/transact", {
    tx: [attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string")],
  }));
  const before = await transactorStats(db);
  const r = await load("transact", "transact", db);
  const after = await transactorStats(db);
  const batches = after.batches - before.batches;
  rows.push({ phase: "transact", label, ...summary(r), batches, "avg batch": fmt(batches ? r.done / batches : 0, 1), "max batch": after.maxBatch, ...serverSide(before, after) });
  console.log(`  transactor opts ${JSON.stringify(after.opts)} batches=${batches} maxBatch=${after.maxBatch}`);
}

{
  const db = BENCH_DATABASE;
  requireOk("operation schema", await admin(db, "/transact", { tx: schemaTx(BenchSchema) }));
  const token = await signToken(db, "writer", "bench-writer", undefined, { exp: `${seconds + 300}s` });
  const before = await transactorStats(db);
  const r = await load("operation", "operation", db, token);
  const after = await transactorStats(db);
  const batches = after.batches - before.batches;
  rows.push({ phase: "operation", label, ...summary(r), batches, "avg batch": fmt(batches ? r.done / batches : 0, 1), "max batch": after.maxBatch, ...serverSide(before, after) });
  console.log(`  transactor opts ${JSON.stringify(after.opts)} batches=${batches} maxBatch=${after.maxBatch}`);
}

function summary(r: Awaited<ReturnType<typeof load>>) {
  return { "per second": Math.round(r.rate), ok: r.done, errors: r.errors, "p50 ms": +fmt(r.p50), "p95 ms": +fmt(r.p95), "p99 ms": +fmt(r.p99) };
}

console.log(`\nCloudflare write throughput driven from Cloudflare with ${lanes} lanes × ${parallel} in flight (${inFlight} concurrent writers) over ${seconds}s per phase:`);
console.table(rows);
