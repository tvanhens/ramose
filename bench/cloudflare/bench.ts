import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { fmt, percentile } from "../lib.ts";
import { BENCH_DATABASE, BenchSchema } from "./catalog.ts";

const url = process.env.RAMOSE_URL;
const capability = process.env.RAMOSE_BENCH_CAPABILITY;
if (!url || !capability) {
  console.error("set RAMOSE_URL and RAMOSE_BENCH_CAPABILITY");
  process.exit(1);
}
const base = url.replace(/\/+$/, "");
const conc = Number(process.argv[2] ?? 32);
const seconds = Number(process.argv[3] ?? 10);
const label = process.env.BENCH_LABEL ?? "";

type Exchange = { status: number; body: any; text: string };

const call = async (path: string, init: RequestInit, token?: string): Promise<Exchange> => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (path.startsWith("/__test__/")) headers.set("x-ramose-test-capability", capability);
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

type Sample = { ok: boolean; ms: number; error?: string };

const load = async (name: string, request: (worker: number, i: number) => Promise<Exchange>) => {
  const lat: number[] = [];
  const failures = new Map<string, number>();
  let done = 0, errors = 0;
  const deadline = Date.now() + seconds * 1000;
  const one = async (worker: number, i: number): Promise<Sample> => {
    const t0 = performance.now();
    try {
      const r = await request(worker, i);
      const ms = performance.now() - t0;
      if (r.status === 200) return { ok: true, ms };
      return { ok: false, ms, error: `${r.status} ${r.text.slice(0, 160)}` };
    } catch (e) {
      return { ok: false, ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) };
    }
  };
  await one(0, -1);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async (_, worker) => {
    let i = 0;
    while (Date.now() < deadline) {
      const s = await one(worker, i++);
      lat.push(s.ms);
      if (s.ok) done++;
      else {
        errors++;
        failures.set(s.error!, (failures.get(s.error!) ?? 0) + 1);
      }
    }
  }));
  const ms = performance.now() - t0;
  lat.sort((a, b) => a - b);
  console.log(`${name.padEnd(12)} concurrency=${conc}: ${done} ok in ${fmt(ms, 0)} ms → ${fmt((done / ms) * 1000, 0)}/s, errors=${errors}`);
  console.log(`  latency p50 ${fmt(percentile(lat, 50))} ms  p95 ${fmt(percentile(lat, 95))} ms  p99 ${fmt(percentile(lat, 99))} ms`);
  for (const [error, count] of [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  error ×${count}: ${error}`);
  }
  return { done, errors, rate: (done / ms) * 1000, p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99) };
};

const transactorStats = async (db: string) => {
  const info = requireOk("transactor info", await admin(db, "/info", {}));
  const s = info.stats;
  return {
    batches: s.batches as number,
    avgBatch: s.batches ? s.txs / s.batches : 0,
    maxBatch: s.maxBatch as number,
    rejected: s.rejected as number,
    opts: info.opts,
  };
};

const attribute = (ident: string, type: string, extra: Record<string, unknown> = {}) => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ":db/optional": true,
  ...extra,
});

const run = Date.now().toString(36);
const rows: Record<string, unknown>[] = [];

{
  const db = `bench-tx-${run}`;
  requireOk("transact schema", await admin(db, "/transact", {
    tx: [attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string")],
  }));
  const before = await transactorStats(db);
  const r = await load("transact", (worker, i) =>
    admin(db, "/transact", {
      tx: [{ ":k/id": worker * 1_000_000 + i, ":k/v": "x" }],
      clientTxId: `${run}-${worker}-${i}`,
    }));
  const after = await transactorStats(db);
  const batches = after.batches - before.batches;
  rows.push({ phase: "transact", label, ...summary(r), batches, "avg batch": fmt(batches ? r.done / batches : 0, 1), "max batch": after.maxBatch });
  console.log(`  transactor opts ${JSON.stringify(after.opts)} batches=${batches} maxBatch=${after.maxBatch}`);
}

{
  const db = BENCH_DATABASE;
  requireOk("operation schema", await admin(db, "/transact", { tx: schemaTx(BenchSchema) }));
  const token = await signToken(db, "writer", "bench-writer", undefined, { exp: `${seconds + 300}s` });
  const before = await transactorStats(db);
  const r = await load("operation", (worker, i) =>
    call(`/db/${encodeURIComponent(db)}/op`, {
      method: "POST",
      body: JSON.stringify({
        invocationId: crypto.randomUUID(),
        operation: { owner: { kind: "entity", name: "benchItem" }, localName: "create" },
        input: { key: `${run}-${worker}-${i}`, value: "x" },
      }),
    }, token));
  const after = await transactorStats(db);
  const batches = after.batches - before.batches;
  rows.push({ phase: "operation", label, ...summary(r), batches, "avg batch": fmt(batches ? r.done / batches : 0, 1), "max batch": after.maxBatch });
  console.log(`  transactor opts ${JSON.stringify(after.opts)} batches=${batches} maxBatch=${after.maxBatch}`);
}

function summary(r: Awaited<ReturnType<typeof load>>) {
  return { "per second": Math.round(r.rate), ok: r.done, errors: r.errors, "p50 ms": +fmt(r.p50), "p95 ms": +fmt(r.p95), "p99 ms": +fmt(r.p99) };
}

console.log(`\nCloudflare write throughput at concurrency ${conc} over ${seconds}s per phase:`);
console.table(rows);
