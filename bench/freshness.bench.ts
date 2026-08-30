import { attrMap, Peer } from "../test/support/ramoseHttp.ts";
import { fmt, percentile } from "./lib.ts";

const url = process.env.RAMOSE_URL;
if (!url) {
  console.error("set RAMOSE_URL");
  process.exit(1);
}
const rounds = Number(process.argv[2] ?? 10);
const readers = Number(process.argv[3] ?? 16);
const headers: Record<string, string> = {};
if (process.env.RAMOSE_REPLICA_HINT) headers["x-ramose-replica-hint"] = process.env.RAMOSE_REPLICA_HINT;
if (process.env.RAMOSE_CACHE_BASIS) headers["x-ramose-cache-basis"] = process.env.RAMOSE_CACHE_BASIS;
if (process.env.RAMOSE_CACHE_MODE) headers["x-ramose-cache-mode"] = process.env.RAMOSE_CACHE_MODE;
const fence = process.env.RAMOSE_MIN_T === "1";
console.log(`variant: hint=${process.env.RAMOSE_REPLICA_HINT ?? "(default)"} cacheBasis=${process.env.RAMOSE_CACHE_BASIS ?? "(default)"} cacheMode=${process.env.RAMOSE_CACHE_MODE ?? "(default)"} minT=${fence ? "on" : "off"} rounds=${rounds} readers=${readers}`);

const name = `fresh-${Date.now().toString(36)}`;
const writer = new Peer(url, { token: process.env.RAMOSE_TOKEN, headers }).db(name);
await writer.transact([attrMap(":k/name", "string", { unique: "upsert" }), attrMap(":k/v", "long")]);
const { tempids } = await writer.transact([{ ":db/id": "c", ":k/name": "counter", ":k/v": 0 }]);
const eid = tempids.c;

const readerClients = Array.from({ length: readers }, () => new Peer(url, { token: process.env.RAMOSE_TOKEN, headers, fetch: ((i: any, init: any) => fetch(i, { ...init, keepalive: false })) as any }).db(name));

await Promise.all(readerClients.map((r) => r.q(`[:find ?v . :in $ ?e :where [?e :k/v ?v]]`, [eid])));

let staleFirst = 0, totalFirst = 0, hitsFirst = 0;
const ttv: number[] = [];
const seenIsolates = new Set<string>();
for (let round = 1; round <= rounds; round++) {
  const ack = await writer.transact([[":db/add", eid, ":k/v", round]]);
  const t0 = performance.now();

  const first = await Promise.all(readerClients.map((r) => r.queryEnvelope<number>(`[:find ?v . :in $ ?e :where [?e :k/v ?v]]`, [eid], fence ? { minT: ack.t } : {})));
  for (const f of first) {
    totalFirst++;
    if (f.result !== round) staleFirst++;
    if (f.meta.basisHit) hitsFirst++;
    if (f.meta.basisT !== null && f.meta.basisT !== undefined) seenIsolates.add(`${f.meta.basisT}`);
  }

  await Promise.all(
    readerClients.map(async (r, i) => {
      if (first[i].result === round) return ttv.push(0);
      for (;;) {
        const v = await r.q<number>(`[:find ?v . :in $ ?e :where [?e :k/v ?v]]`, [eid], fence ? { minT: ack.t } : {});
        if (v === round) return ttv.push(performance.now() - t0);
        if (performance.now() - t0 > 10_000) return ttv.push(Infinity);
        await new Promise((res) => setTimeout(res, 100));
      }
    }),
  );
  await new Promise((res) => setTimeout(res, 300));
}
ttv.sort((a, b) => a - b);
console.log(`first-read stale: ${staleFirst}/${totalFirst} (${fmt((100 * staleFirst) / totalFirst)}%), first-read cache hits: ${hitsFirst}/${totalFirst}`);
console.log(`time-to-visible (ms) over all reads: p50 ${fmt(percentile(ttv, 50))} p95 ${fmt(percentile(ttv, 95))} max ${fmt(ttv[ttv.length - 1])}; stale-then-visible count ${ttv.filter((x) => x > 0).length}`);
