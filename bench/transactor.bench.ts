import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchHarness, attribute } from "./transactor-harness.ts";
import { fmt, percentile } from "./lib.ts";

const conc = Number(process.argv[2] ?? 64);
const seconds = Number(process.argv[3] ?? 5);

const sweep = process.argv[4] ? process.argv[4].split(",").map(Number) : [conc];

const dir = mkdtempSync(join(tmpdir(), "ramose-tx-"));
const file = join(dir, "transactor.sqlite");

async function run(label: string, groupCommit: boolean, conc: number) {
  const h = new BenchHarness({ file: `${file}-${label}-${conc}`, config: { maxBatch: groupCommit ? 0 : 1, indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000 } });
  const tx = h.transactor;
  await tx.init();
  await tx.transact([attribute(":k/id", "long", { ":db/unique": ":db.unique/identity" }), attribute(":k/v", "string")]);
  const sub = h.subscribe(tx.t);

  let done = 0, errors = 0;
  const lat: number[] = [];
  const deadline = Date.now() + seconds * 1000;
  async function client(id: number) {
    let i = 0;
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        await tx.transact([{ ":k/id": id * 1_000_000 + i++, ":k/v": "x" }]);
        done++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, (_, i) => client(i)));
  const ms = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const tps = (done / ms) * 1000;
  console.log(`${label.padEnd(16)} concurrency=${conc}: ${done} tx in ${fmt(ms, 0)} ms → ${fmt(tps, 0)} tx/s, errors=${errors}`);
  console.log(`  ack latency p50 ${fmt(percentile(lat, 50))} ms  p95 ${fmt(percentile(lat, 95))} ms  p99 ${fmt(percentile(lat, 99))} ms`);
  console.log(`  storage writes=${h.writes} batches=${tx.stats.batches} maxBatch=${tx.stats.maxBatch} avgBatch=${fmt(tx.stats.txs / Math.max(1, tx.stats.batches), 1)} frames=${sub.ofKind("tx").length}`);

  const ts = h.logTs();
  for (let i = 0; i < ts.length; i++) if (ts[i] !== i + 1) throw new Error(`log gap at ${i}: ${ts[i]}`);
  if (ts.length !== tx.t) throw new Error(`log length ${ts.length} != t ${tx.t}`);
  h.db.close();
  return { tps, p50: percentile(lat, 50), p99: percentile(lat, 99), avgBatch: tx.stats.txs / Math.max(1, tx.stats.batches), maxBatch: tx.stats.maxBatch };
}

const table: Record<string, unknown>[] = [];
let grouped = 0, single = 0;
for (const c of sweep) {
  const g = await run("group-commit", true, c);
  const s1 = await run("one-tx-per-write", false, c);
  if (c === conc) {
    grouped = g.tps;
    single = s1.tps;
  }
  table.push({ concurrency: c, "group tx/s": Math.round(g.tps), "group p50 ms": +fmt(g.p50), "group p99 ms": +fmt(g.p99), "avg batch": +fmt(g.avgBatch, 1), "single tx/s": Math.round(s1.tps), "single p50 ms": +fmt(s1.p50), "single p99 ms": +fmt(s1.p99) });
}
rmSync(dir, { recursive: true, force: true });

console.log(`\nM2 gate: ≥ 500 tx/s sustained with group commit → ${grouped >= 500 ? "PASS" : "FAIL"} (${fmt(grouped, 0)} tx/s; without group commit ${fmt(single, 0)} tx/s)`);
console.log("\nwrite ceiling (in-process Transactor over an fsync'd SQLite file):");
console.table(table);
