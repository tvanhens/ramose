/**
 * Timed incremental-index bench (M4/M7): merge a delta of D transactions into
 * a database of N people (≈3N datoms + schema) and report run time, objects
 * written vs objects in the tree, and objects per touched tx.
 *
 *   bun run bench/indexer.bench.ts [people=300000] [deltaTxs=10000] [leafSize=3000] [fanout=1024]
 *
 * Runs in-process (Transactor over an in-memory R2 + bun:sqlite) — the numbers
 * are the merge cost itself (structural-sharing rewrite of touched paths, gzip
 * + sha256 per new object), not R2 round trips.
 */
import { Schema, type Datom, ValueTag, FIRST_USER_EID, attributeDatoms, bootstrapDatoms, buildRoots, gzipCodec, reachable, treeDepth } from "../packages/ramose/src/internal/core/index.ts";
import { R2NodeStore, dbPrefix, prefixedBucket, publishRoot, recordToRoots, rootsToRecord } from "../packages/ramose/src/internal/storage/index.ts";
import { MemoryBucket } from "../packages/ramose/src/internal/storage/memory.ts";
import { Harness } from "../packages/ramose/test/internal/transactor/harness.ts";
import { fmt } from "./lib.ts";

const people = Number(process.argv[2] ?? 300_000);
const deltaTxs = Number(process.argv[3] ?? 10_000);
const leafSize = Number(process.argv[4] ?? 3000);
const fanout = Number(process.argv[5] ?? 1024);

const NAME = FIRST_USER_EID, AGE = FIRST_USER_EID + 1, CITY = FIRST_USER_EID + 2, FRIEND = FIRST_USER_EID + 3;
const FIRST_PERSON = FIRST_USER_EID + 100;

// ---- seed
let t0 = performance.now();
const datoms: Datom[] = [
  ...attributeDatoms(NAME, { ident: ":p/name", valueType: ":db.type/string", index: true }, 2),
  ...attributeDatoms(AGE, { ident: ":p/age", valueType: ":db.type/long" }, 2),
  ...attributeDatoms(CITY, { ident: ":p/city", valueType: ":db.type/string", index: true }, 2),
  ...attributeDatoms(FRIEND, { ident: ":p/friend", valueType: ":db.type/ref", cardinality: "many" }, 2),
];
for (let i = 0; i < people; i++) {
  const e = FIRST_PERSON + i;
  datoms.push({ e, a: NAME, vt: ValueTag.Str, v: `n${i}`, t: 3, op: true });
  datoms.push({ e, a: AGE, vt: ValueTag.Long, v: i % 90, t: 3, op: true });
  datoms.push({ e, a: CITY, vt: ValueTag.Str, v: `c${i % 100}`, t: 3, op: true });
  datoms.push({ e, a: FRIEND, vt: ValueTag.Ref, v: FIRST_PERSON + ((i * 7919) % people), t: 3, op: true });
}
const raw = new MemoryBucket();
const bucket = prefixedBucket(raw, dbPrefix("bench"));
const seedStore = new R2NodeStore(bucket, { codec: gzipCodec });
const roots = await buildRoots(seedStore, Schema.bootstrap().apply(datoms), bootstrapDatoms().concat(datoms), { leafSize, fanout });
await publishRoot(bucket, rootsToRecord(roots, { log_watermark: 3, next_eid: FIRST_PERSON + people, codec: gzipCodec.name }));
const seedMs = performance.now() - t0;
const treeObjects = raw.objects.size;
console.log(`seed: ${datoms.length.toLocaleString()} datoms → ${treeObjects} objects in ${fmt(seedMs, 0)} ms (leaf ${leafSize}, fan-out ${fanout})`);

// ---- transactor over the seeded root; write the delta
const h = new Harness({ dbName: "bench", config: { indexTxThreshold: 1e9, indexIntervalMs: 1e9, indexMaxTxsPerRun: 1e9, logKeepTxs: 100 } }, raw);
const tx = h.transactor;
await tx.init();
t0 = performance.now();
const ops: Promise<unknown>[] = [];
for (let i = 0; i < deltaTxs; i++) {
  const e = FIRST_PERSON + ((i * 104729) % people); // scattered entities
  if (i % 4 === 0) ops.push(tx.transact([{ ":p/name": `new${i}`, ":p/age": 1, ":p/city": `c${i % 100}` }]));
  else if (i % 4 === 1) ops.push(tx.transact([[":db/add", e, ":p/age", 100 + (i % 50)]]));
  else if (i % 4 === 2) ops.push(tx.transact([[":db/add", e, ":p/friend", FIRST_PERSON + ((i * 31) % people)]]));
  else ops.push(tx.transact([[":db/add", e, ":p/city", `c${(i * 7) % 100}`]]));
  if (ops.length >= 512) {
    await Promise.all(ops);
    ops.length = 0;
  }
}
await Promise.all(ops);
const writeMs = performance.now() - t0;
const novelty = tx.connection.noveltyCount;
console.log(`delta: ${deltaTxs.toLocaleString()} txs (${novelty.toLocaleString()} novelty datoms) written in ${fmt(writeMs, 0)} ms → ${fmt((deltaTxs / writeMs) * 1000, 0)} tx/s`);

// ---- index run (timed)
const store = tx.nodeStore;
const oldRoots = recordToRoots(tx.currentRootRecord);
const putsBefore = store.stats.r2Puts;
const bytesBefore = store.stats.bytesWritten;
t0 = performance.now();
const res = await tx.handleRequest(new Request("https://t/admin/index", { method: "POST" })).then((r) => r.json() as Promise<any>);
const runMs = performance.now() - t0;
const puts = store.stats.r2Puts - putsBefore;
const bytes = store.stats.bytesWritten - bytesBefore;
const newRoots = recordToRoots(tx.currentRootRecord);
const depth = Math.max(...(await Promise.all([newRoots.eavt, newRoots.aevt, newRoots.avet, newRoots.vaet].map((r) => treeDepth(store, r)))));
const oldSet = new Set<string>();
for (const r of [oldRoots.eavt, oldRoots.aevt, oldRoots.avet, oldRoots.vaet]) await reachable(store, r, oldSet);
const newSet = new Set<string>();
for (const r of [newRoots.eavt, newRoots.aevt, newRoots.avet, newRoots.vaet]) await reachable(store, r, newSet);
const fresh = [...newSet].filter((x) => !oldSet.has(x)).length;

console.log(`index run: ${res.txs.toLocaleString()} txs / ${res.datoms.toLocaleString()} datoms merged in ${fmt(runMs, 0)} ms (indexer-reported ${res.ms} ms)`);
console.log(`  new objects written: ${puts} (${fmt(bytes / 1024, 0)} KB) = |reachable(new) − reachable(old)| ${fresh}; tree now ${newSet.size} objects (depth ${depth}); rewritten fraction ${fmt((100 * puts) / newSet.size, 1)}%`);
console.log(`  ${fmt(puts / deltaTxs, 2)} objects per tx, ${fmt(runMs / deltaTxs, 3)} ms per tx, ${fmt((res.datoms / runMs) * 1000, 0)} datoms/s`);
console.log(JSON.stringify({ people, datoms: datoms.length, deltaTxs, leafSize, fanout, seedMs: Math.round(seedMs), runMs: Math.round(runMs), puts, fresh, treeObjects: newSet.size, depth }));
h.db.close();
