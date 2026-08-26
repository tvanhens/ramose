/**
 * M4 acceptance, in-process (scaled): the alarm-driven incremental indexer.
 *   - a small tx delta on a large tree writes exactly the objects that are new
 *     in the merged trees (structural sharing is maximal: r2Puts ==
 *     |reachable(new) − reachable(old)|), and that number is O(touched·depth)
 *   - old roots keep answering as-of queries after the flip
 *   - snapshots taken before / during / after a reindex are each internally
 *     consistent (immutable Db values), and reads never observe a torn state
 *   - the run is bounded (maxTxsPerRun) and re-arms itself until caught up
 */
import { describe, expect, test } from "bun:test";
import {
  Db,
  Novelty,
  Schema,
  type Datom,
  ValueTag,
  FIRST_USER_EID,
  attributeDatoms,
  bootstrapDatoms,
  buildRoots,
  deriveSchema,
  gzipCodec,
  query,
  reachable,
  treeDepth,
} from "../../../src/internal/core/index.ts";
import { R2NodeStore, dbPrefix, prefixedBucket, publishRoot, readRootAt, recordToRoots, rootsToRecord } from "../../../src/internal/storage/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";
import { Harness } from "./harness.ts";

const NAME = FIRST_USER_EID, AGE = FIRST_USER_EID + 1, CITY = FIRST_USER_EID + 2;
const FIRST_PERSON = FIRST_USER_EID + 100;

function people(n: number): Datom[] {
  const out: Datom[] = [
    ...attributeDatoms(NAME, { ident: ":p/name", valueType: ":db.type/string", index: true }, 2),
    ...attributeDatoms(AGE, { ident: ":p/age", valueType: ":db.type/long" }, 2),
    ...attributeDatoms(CITY, { ident: ":p/city", valueType: ":db.type/string", index: true }, 2),
  ];
  for (let i = 0; i < n; i++) {
    const e = FIRST_PERSON + i;
    out.push({ e, a: NAME, vt: ValueTag.Str, v: `n${i}`, t: 3, op: true });
    out.push({ e, a: AGE, vt: ValueTag.Long, v: i % 90, t: 3, op: true });
    out.push({ e, a: CITY, vt: ValueTag.Str, v: `c${i % 50}`, t: 3, op: true });
  }
  return out;
}

/** Seed a database in the bucket from a datom set (bootstrap-from-seed path). */
async function seed(raw: MemoryBucket, dbName: string, n: number) {
  const bucket = prefixedBucket(raw, dbPrefix(dbName));
  const store = new R2NodeStore(bucket, { codec: gzipCodec });
  const datoms = people(n);
  const schema = Schema.bootstrap().apply(datoms);
  const roots = await buildRoots(store, schema, bootstrapDatoms().concat(datoms), { leafSize: 400, fanout: 16 });
  const rec = rootsToRecord(roots, { log_watermark: 3, next_eid: FIRST_PERSON + n, codec: gzipCodec.name });
  await publishRoot(bucket, rec);
  return { bucket, rec, roots, n };
}

async function allReachable(store: R2NodeStore, roots: ReturnType<typeof recordToRoots>): Promise<Set<string>> {
  const s = new Set<string>();
  for (const r of [roots.eavt, roots.aevt, roots.avet, roots.vaet]) await reachable(store, r, s);
  return s;
}

describe("indexer (M4)", () => {
  test("small delta on a large tree: exactly the new tree objects are written; O(touched·depth); as-of via old root", async () => {
    const raw = new MemoryBucket();
    const { rec: seedRec, n } = await seed(raw, "test", 200_000); // 600k datoms + schema, ~1.5k leaves per index
    let clock = 5_000_000;
    const h = new Harness({ config: { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000, logKeepTxs: 5 }, now: () => clock }, raw);
    const tx = h.transactor;
    await tx.init();
    expect(tx.currentRootRecord.t).toBe(seedRec.t); // booted from the seeded root
    expect(tx.t).toBe(seedRec.t);

    // delta: 60 txs — 40 age updates on scattered entities + 20 new people
    const touchedE = new Set<number>();
    const acks = await Promise.all([
      ...Array.from({ length: 40 }, (_, i) => {
        const e = FIRST_PERSON + ((i * 7919) % n);
        touchedE.add(e);
        return tx.transact([[":db/add", e, ":p/age", 200 + i]]);
      }),
      ...Array.from({ length: 20 }, (_, i) => tx.transact([{ ":p/name": `new${i}`, ":p/age": 1, ":p/city": "c0" }])),
    ]);
    const tBefore = tx.t;
    expect(acks.length).toBe(60);
    const oldRoots = recordToRoots(tx.currentRootRecord);
    const store = tx.nodeStore;
    const oldSet = await allReachable(store, oldRoots);
    const putsBefore = store.stats.r2Puts;

    // run the indexer (alarm path)
    h.alarm = clock;
    expect(await h.fireAlarm()).toBe(true);
    const newRec = tx.currentRootRecord;
    expect(newRec.t).toBe(tBefore);
    const newRoots = recordToRoots(newRec);
    const newSet = await allReachable(store, newRoots);
    const fresh = [...newSet].filter((hsh) => !oldSet.has(hsh));
    const puts = store.stats.r2Puts - putsBefore;
    // exact: the run wrote precisely the objects that are new in the merged trees
    expect(puts).toBe(fresh.length);
    // O(touched · depth): touched leaves ≤ (touched entities + new entities) per index (+ possible splits),
    // each leaf drags ≤ depth-1 ancestors — and it is a tiny fraction of the tree
    const depth = Math.max(...(await Promise.all([newRoots.eavt, newRoots.aevt, newRoots.avet, newRoots.vaet].map((r) => treeDepth(store, r)))));
    const touched = touchedE.size + 20;
    expect(fresh.length).toBeLessThanOrEqual(4 * 2 * touched * depth);
    expect(fresh.length).toBeLessThan(newSet.size / 10);
    // the log was pruned to the catch-up tail and log/ chunk + roots/<t> + root/current were published
    expect(tx.earliestLogT()).toBeGreaterThan(tBefore - 10);
    expect(await readRootAt(h.bucket, newRec.t)).toEqual(newRec);
    expect(await readRootAt(h.bucket, seedRec.t)).toEqual(seedRec);
    expect((await h.bucket.list({ prefix: "log/" })).objects.length).toBe(1);

    // as-of: the old root still answers with the old values; the new root with the new ones
    const e0 = FIRST_PERSON; // i=0 → age updated to 200
    const asOfOld = new Db({ store, roots: oldRoots, novelty: new Novelty(), basisT: oldRoots.t, schema: await deriveSchema(store, oldRoots), nextEid: 0 });
    const asOfNew = new Db({ store, roots: newRoots, novelty: new Novelty(), basisT: newRoots.t, schema: await deriveSchema(store, newRoots), nextEid: 0 });
    expect(await query(asOfOld, `[:find ?a . :in $ ?e :where [?e :p/age ?a]]`, [e0])).toBe(0);
    expect(await query(asOfNew, `[:find ?a . :in $ ?e :where [?e :p/age ?a]]`, [e0])).toBe(200);
    // through the connection: as-of by t uses the log/novelty semantics
    const live = tx.connection.db();
    expect(await query(live, `[:find ?a . :in $ ?e :where [?e :p/age ?a]]`, [e0])).toBe(200);
    expect(await query(live.asOf(seedRec.t), `[:find ?a . :in $ ?e :where [?e :p/age ?a]]`, [e0])).toBe(0);
    expect(await query(live, `[:find (count ?e) . :where [?e :p/name]]`)).toBe(n + 20);
  }, 60_000);

  test("snapshots before / during / after a reindex are consistent; runs are bounded and re-arm", async () => {
    const raw = new MemoryBucket();
    await seed(raw, "test", 2_000);
    let clock = 1_000;
    const h = new Harness({ config: { indexTxThreshold: 1_000_000, indexIntervalMs: 1_000_000, indexMaxTxsPerRun: 40, logKeepTxs: 1000 }, now: () => clock }, raw);
    const tx = h.transactor;
    await tx.init();
    await Promise.all(Array.from({ length: 100 }, (_, i) => tx.transact([{ ":p/name": `x${i}`, ":p/age": i, ":p/city": "z" }])));
    const t1 = tx.t;
    const before = tx.connection.db();
    const countQ = `[:find (count ?e) . :where [?e :p/city "z"]]`;
    expect(await query(before, countQ)).toBe(100);

    // bounded run: only 40 txs merged, then it re-arms an alarm for the rest
    h.alarm = clock;
    const run = h.fireAlarm();
    // concurrent reads while the merge is in flight: a snapshot taken now is complete and stable
    const during = tx.connection.db();
    const dCount = await query(during, countQ);
    expect(dCount).toBe(100);
    // and writes keep flowing during the run
    await tx.transact([{ ":p/name": "late", ":p/age": 1, ":p/city": "z" }]);
    await run;
    expect(tx.currentRootRecord.t).toBeLessThan(t1);
    expect(h.alarm).not.toBeNull(); // remaining txs → re-armed
    expect(await query(before, countQ)).toBe(100); // old snapshot unchanged
    expect(await query(tx.connection.db(), countQ)).toBe(101);
    // drain
    let guard = 0;
    while (h.alarm !== null && guard++ < 10) {
      clock += 100;
      await h.fireAlarm();
    }
    expect(tx.currentRootRecord.t).toBe(tx.t);
    expect(tx.connection.noveltyCount).toBe(0);
    expect(await query(tx.connection.db(), countQ)).toBe(101);
    expect(await query(before, countQ)).toBe(100);
  }, 60_000);
});
