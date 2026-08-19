/**
 * M3 acceptance, in-process: the tiered segment source over an (in-memory)
 * R2 bucket.
 *   - a cold query performs ≤ depth GETs per unique segment path it touches
 *   - a repeat query performs 0 R2 reads (memory tier); a fresh isolate with a
 *     warm Cache API tier also performs 0 R2 reads
 *   - byte-identical segments dedupe (same hash → one object, one put)
 *   - a corrupt cache-tier entry falls back to R2
 *   - per-database key namespace via prefixedBucket
 */
import { describe, expect, test } from "bun:test";
import { Connection, Db, Index, Novelty, buildRoots, Schema, bootstrapDatoms, deriveSchema, gzipCodec, treeDepth, type Datom, type NodeSource, type RootRecord, ValueTag, FIRST_USER_EID, attributeDatoms, query } from "../../../src/internal/core/index.ts";
import { R2NodeStore, type CacheTier, dbPrefix, prefixedBucket, publishRoot, readCurrentRoot, rootsToRecord, recordToRoots, listRoots } from "../../../src/internal/storage/index.ts";
import { MemoryBucket } from "../../../src/internal/storage/memory.ts";

/** Db over a root record with no novelty (what a peer builds from a basis). */
async function dbAt(store: NodeSource, rec: RootRecord): Promise<Db> {
  const roots = recordToRoots(rec);
  const schema = await deriveSchema(store, roots);
  return new Db({ store, roots, novelty: new Novelty(), basisT: rec.t, schema, nextEid: rec.next_eid });
}

/** Cache API stand-in. */
class MemCache implements CacheTier {
  readonly m = new Map<string, Uint8Array>();
  hits = 0;
  async match(key: string) {
    const b = this.m.get(key);
    if (b) this.hits++;
    return b;
  }
  async put(key: string, body: Uint8Array) {
    this.m.set(key, body);
  }
}

const NAME = FIRST_USER_EID, CITY = FIRST_USER_EID + 1;
function dataset(n: number): Datom[] {
  const out: Datom[] = [
    ...attributeDatoms(NAME, { ident: ":p/name", valueType: ":db.type/string", index: true }, 2),
    ...attributeDatoms(CITY, { ident: ":p/city", valueType: ":db.type/string", index: true }, 2),
  ];
  for (let i = 0; i < n; i++) {
    const e = FIRST_USER_EID + 100 + i;
    out.push({ e, a: NAME, vt: ValueTag.Str, v: `n${i}`, t: 3, op: true });
    out.push({ e, a: CITY, vt: ValueTag.Str, v: `c${i % 10}`, t: 3, op: true });
  }
  return out;
}

async function seed(bucket: MemoryBucket, n = 20_000) {
  const store = new R2NodeStore(bucket, { codec: gzipCodec });
  const datoms = dataset(n);
  const schema = Schema.bootstrap().apply(datoms);
  const roots = await buildRoots(store, schema, bootstrapDatoms().concat(datoms), { leafSize: 256, fanout: 16 });
  const rec = rootsToRecord(roots, { log_watermark: 3, next_eid: FIRST_USER_EID + 100 + n, codec: gzipCodec.name });
  await publishRoot(bucket, rec);
  return { store, rec, roots };
}

const Q = `[:find ?n :where [?e :p/city "c3"] [?e :p/name ?n]]`;

describe("R2NodeStore tiers (M3)", () => {
  test("cold query: ≤ depth GETs per unique segment; repeat query: 0 R2 reads; warm cache tier: 0 R2 reads", async () => {
    const bucket = new MemoryBucket();
    const { rec, roots } = await seed(bucket);
    const depth = Math.max(...(await Promise.all([Index.EAVT, Index.AEVT, Index.AVET].map((i) => treeDepth(new R2NodeStore(bucket, { codec: gzipCodec }), i === 0 ? roots.eavt : i === 1 ? roots.aevt : roots.avet)))));
    expect(depth).toBeGreaterThanOrEqual(2);

    // fresh "isolate": memory tier empty, cache tier empty
    const mark = bucket.getLog.length; // ignore reads made by seed/treeDepth above
    const cache = new MemCache();
    const peer = new R2NodeStore(bucket, { codec: gzipCodec, cache });
    const db1 = await dbAt(peer, rec);
    const r1 = (await query(db1, Q)) as unknown[][];
    expect(r1.length).toBe(2000);
    const cold = peer.stats.r2Gets;
    expect(cold).toBeGreaterThan(0);
    // ≤ depth GETs per unique segment: every object is fetched at most once
    // (dir nodes above a leaf are shared and fetched once too), so the GET
    // log has no duplicates and is bounded by (leaves touched) × depth.
    const gets = bucket.getLog.slice(mark).filter((k) => k.startsWith("seg/") || k.startsWith("n/"));
    expect(new Set(gets).size).toBe(gets.length);
    const leaves = gets.filter((k) => k.startsWith("seg/")).length;
    expect(gets.length).toBeLessThanOrEqual(leaves * depth);
    expect(peer.stats.r2Gets).toBe(gets.length);

    // repeat in the same isolate → served from memory, zero R2 reads
    const before = peer.stats.r2Gets;
    const db2 = await dbAt(peer, rec);
    expect(((await query(db2, Q)) as unknown[][]).length).toBe(2000);
    expect(peer.stats.r2Gets).toBe(before);

    // fresh isolate, warm Cache API tier → zero R2 reads
    const peer2 = new R2NodeStore(bucket, { codec: gzipCodec, cache });
    const db3 = await dbAt(peer2, rec);
    expect(((await query(db3, Q)) as unknown[][]).length).toBe(2000);
    expect(peer2.stats.r2Gets).toBe(0);
    expect(peer2.stats.cacheHits).toBeGreaterThan(0);
  });

  test("byte-identical segments dedupe: same hash → one object, one put", async () => {
    const bucket = new MemoryBucket();
    const store = new R2NodeStore(bucket, { codec: gzipCodec, headBeforePut: true });
    const a = await Connection.create({ store });
    const b = await Connection.create({ store });
    // both databases start from the same empty trees: identical hashes, written once
    expect(a.currentRoots.eavt.hash).toBe(b.currentRoots.eavt.hash);
    expect(store.stats.r2PutSkipped).toBeGreaterThan(0);
    const keys = (await bucket.list({ prefix: "seg/" })).objects.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    // second store without head-before-put: writes are idempotent (same key, same bytes)
    const store2 = new R2NodeStore(bucket, { codec: gzipCodec });
    await Connection.create({ store: store2 });
    expect((await bucket.list({ prefix: "seg/" })).objects.length).toBe(keys.length);
  });

  test("a corrupt/empty cache-tier entry is bypassed (R2 is authoritative)", async () => {
    const bucket = new MemoryBucket();
    const { rec } = await seed(bucket, 2000);
    const cache = new MemCache();
    // poison: every cache key returns an empty body
    cache.match = async () => new Uint8Array(0);
    const peer = new R2NodeStore(bucket, { codec: gzipCodec, cache });
    const db = await dbAt(peer, rec);
    expect(((await query(db, Q)) as unknown[][]).length).toBe(200);
    // truncated bodies are bypassed too
    cache.match = async (k) => (cache.m.get(k) ?? new Uint8Array(0)).subarray(0, 5);
    const peer2 = new R2NodeStore(bucket, { codec: gzipCodec, cache });
    const db2 = await dbAt(peer2, rec);
    expect(((await query(db2, Q)) as unknown[][]).length).toBe(200);
  });

  test("prefixedBucket namespaces every key and un-prefixes listings", async () => {
    const raw = new MemoryBucket();
    const a = prefixedBucket(raw, dbPrefix("a"));
    const b = prefixedBucket(raw, dbPrefix("b"));
    const { rec } = await seed(a as MemoryBucket, 100);
    expect(await readCurrentRoot(a)).toEqual(rec);
    expect(await readCurrentRoot(b)).toBeNull();
    expect([...raw.objects.keys()].every((k) => k.startsWith("db/a/"))).toBe(true);
    expect(await listRoots(a)).toEqual([rec.t]);
    expect(await listRoots(b)).toEqual([]);
    const page = await a.list({ prefix: "seg/" });
    expect(page.objects.every((o) => o.key.startsWith("seg/"))).toBe(true);
    await a.delete(page.objects.map((o) => o.key));
    expect((await raw.list({ prefix: "db/a/seg/" })).objects.length).toBe(0);
    expect(recordToRoots(rec).t).toBe(rec.t);
  });
});
