/**
 * M7 read-path bench against a running Ramose deployment: warm query latency
 * through the Worker (replica basis + edge datalog over cached segments).
 *
 *   RAMOSE_URL=http://localhost:1337 bun run bench/read-do.bench.ts [people=5000] [runs=200] [concurrency=8]
 *
 * Reports client-observed p50/p95 (includes local HTTP RTT) and the server-side
 * `x-ramose-ms` p50 (query execution only). Multi-colo scaling cannot be
 * measured against a local emulator; see bench/RESULTS.md.
 */
import { attrMap, Peer } from "../test/support/ramoseHttp.ts";
import { fmt, percentile } from "./lib.ts";

const url = process.env.RAMOSE_URL;
if (!url) {
  console.error("set RAMOSE_URL");
  process.exit(1);
}
const people = Number(process.argv[2] ?? 5000);
const runs = Number(process.argv[3] ?? 200);
const conc = Number(process.argv[4] ?? 8);
const headers: Record<string, string> = {};
if (process.env.RAMOSE_REPLICA_HINT) headers["x-ramose-replica-hint"] = process.env.RAMOSE_REPLICA_HINT;
if (process.env.RAMOSE_CACHE_BASIS) headers["x-ramose-cache-basis"] = process.env.RAMOSE_CACHE_BASIS;
if (process.env.RAMOSE_CACHE_MODE) headers["x-ramose-cache-mode"] = process.env.RAMOSE_CACHE_MODE;
// RAMOSE_MIN_T=1: every read carries x-ramose-min-t = t of the last write this bench made (read fence)
const fence = process.env.RAMOSE_MIN_T === "1";
const client = new Peer(url, { token: process.env.RAMOSE_TOKEN, headers });
console.log(`variant: hint=${process.env.RAMOSE_REPLICA_HINT ?? "(default)"} cacheBasis=${process.env.RAMOSE_CACHE_BASIS ?? "(default)"} cacheMode=${process.env.RAMOSE_CACHE_MODE ?? "(default)"} minT=${fence ? "on" : "off"}`);
const db = client.db(`readbench-${Date.now().toString(36)}`);

await db.transact([
  attrMap(":person/name", "string", { index: true }),
  attrMap(":person/city", "string", { index: true }),
  attrMap(":person/age", "long"),
  attrMap(":person/friends", "ref", { cardinality: "many" }),
]);
// seed in batches of 200 entities per tx
for (let i = 0; i < people; i += 200) {
  const tx: unknown[] = [];
  for (let j = i; j < Math.min(people, i + 200); j++) {
    tx.push({ ":db/id": `p${j}`, ":person/name": `person-${j}`, ":person/city": `city-${j % 10}`, ":person/age": j % 90 });
  }
  await db.transact(tx);
}
// friends (refs to existing entities) + index so most data lives in segments
const ids = (await db.q<number[]>(`[:find [?e ...] :where [?e :person/city "city-3"]]`)).slice(0, 500);
await db.transact(ids.map((e, i) => [":db/add", e, ":person/friends", ids[(i + 1) % ids.length]]));
await db.index();
// D4-style fence: one more write, then every read demands >= its t
const lastT = fence ? (await db.transact([{ ":person/name": "fence", ":person/city": "city-0", ":person/age": 1 }])).t : undefined;
const qopts = lastT !== undefined ? { minT: lastT } : {};

const QUERIES: Record<string, { q: string; inputs?: unknown[] }> = {
  "point lookup (AVET)": { q: `[:find ?e . :where [?e :person/name "person-42"]]` },
  "entity attrs (EAVT)": { q: `[:find ?a ?v :in $ ?e :where [?e ?a ?v]]`, inputs: [ids[0]] },
  "city → friends → name (join)": { q: `[:find ?n ?fn :where [?e :person/city "city-3"] [?e :person/friends ?f] [?f :person/name ?fn] [?e :person/name ?n]]` },
  "count by city (agg)": { q: `[:find (count ?e) . :where [?e :person/city "city-7"]]` },
};

const results: Record<string, unknown> = {};
for (const [name, { q, inputs }] of Object.entries(QUERIES)) {
  const warm = await db.queryEnvelope(q, inputs, qopts); // warm
  if (warm.meta?.colo || warm.meta?.replicaHint) console.log(`  ${name}: worker colo=${warm.meta?.colo ?? "?"} replicaHint=${warm.meta?.replicaHint ?? "?"}`);
  const client_ms: number[] = [], server_ms: number[] = [];
  let hits = 0, refetches = 0, behind = 0;
  let i = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (i++ < runs) {
        const t0 = performance.now();
        const r = await db.queryEnvelope(q, inputs, qopts);
        client_ms.push(performance.now() - t0);
        if (r.meta?.ms !== null && r.meta?.ms !== undefined) server_ms.push(r.meta.ms);
        if (r.meta?.basisHit) hits++;
        else if (r.meta?.basisReason && r.meta.basisReason !== "off") refetches++;
        if (r.meta?.basisBehind) behind++;
      }
    }),
  );
  client_ms.sort((a, b) => a - b);
  server_ms.sort((a, b) => a - b);
  results[name] = { "client p50 ms": +fmt(percentile(client_ms, 50)), "client p95 ms": +fmt(percentile(client_ms, 95)), "server p50 ms": server_ms.length ? +fmt(percentile(server_ms, 50)) : null, "basis hits": hits, "refetches": refetches, "behind": behind };
}
console.log(`read bench: ${people} people, ${runs} runs × ${conc} concurrent per query, warm`);
console.table(results);
const info = await db.info();
console.log(`peer segment cache: ${JSON.stringify(info.peer)}`);
