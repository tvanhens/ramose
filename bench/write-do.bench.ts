import { attrMap, Peer } from "../test/support/ramoseHttp.ts";
import { fmt, percentile } from "./lib.ts";

const url = process.env.RAMOSE_URL;
if (!url) {
  console.error("set RAMOSE_URL");
  process.exit(1);
}
const conc = Number(process.argv[2] ?? 64);
const seconds = Number(process.argv[3] ?? 10);
const client = new Peer(url, { token: process.env.RAMOSE_TOKEN });
const db = client.db(`bench-${Date.now().toString(36)}`);
await db.transact([attrMap(":k/id", "long", { unique: "upsert" }), attrMap(":k/v", "string")]);

let done = 0, errors = 0;
const lat: number[] = [];
const deadline = Date.now() + seconds * 1000;
async function worker(id: number) {
  let i = 0;
  while (Date.now() < deadline) {
    const t0 = performance.now();
    try {
      await db.transact([{ ":k/id": id * 1_000_000 + i++, ":k/v": "x" }]);
      done++;
    } catch {
      errors++;
    }
    lat.push(performance.now() - t0);
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
const ms = performance.now() - t0;
lat.sort((a, b) => a - b);
const info = await db.info();
console.log(`concurrency=${conc}: ${done} tx in ${fmt(ms, 0)} ms → ${fmt((done / ms) * 1000, 0)} tx/s, errors=${errors}`);
console.log(`ack latency p50 ${fmt(percentile(lat, 50))} ms  p95 ${fmt(percentile(lat, 95))} ms  p99 ${fmt(percentile(lat, 99))} ms`);
console.log(`transactor batches=${info.transactor.stats.batches} maxBatch=${info.transactor.stats.maxBatch} avgBatch=${fmt(info.transactor.stats.txs / Math.max(1, info.transactor.stats.batches))}`);
