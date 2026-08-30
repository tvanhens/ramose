import { describe, expect, test } from "bun:test";
import {
  ALL_INDEXES,
  COMPARATORS,
  type Datom,
  Index,
  type IndexId,
  type Prefix,
  ValueTag,
  comparePrefix,
  datomEquals,
} from "../../../src/internal/core/datom.ts";
import { MemStore, gzipCodec } from "../../../src/internal/core/store.ts";
import {
  buildTree,
  collect,
  estimateCount,
  mergeTree,
  reachable,
  seekOne,
  sortedUnion,
  treeDepth,
} from "../../../src/internal/core/tree.ts";
import { randDatoms, randInt, rng } from "./util.ts";

function sortDedup(index: IndexId, ds: readonly Datom[]): Datom[] {
  const cmp = COMPARATORS[index];
  const s = ds.slice().sort(cmp);
  return s.filter((d, i) => i === 0 || cmp(s[i - 1], d) !== 0);
}

function randomPrefix(r: () => number, index: IndexId, ds: readonly Datom[]): Prefix {
  const d = ds[randInt(r, 0, ds.length - 1)];
  const depth = randInt(r, 0, 4);
  const order = { 0: ["e", "a", "v", "t"], 1: ["a", "e", "v", "t"], 2: ["a", "v", "e", "t"], 3: ["v", "a", "e", "t"] }[index];
  const p: any = {};
  for (let i = 0; i < depth; i++) {
    const k = order[i];
    if (k === "v") {
      p.vt = d.vt;
      p.v = d.v;
    } else p[k] = (d as any)[k];
  }

  if (r() < 0.2 && depth > 0) {
    if (p.e !== undefined) p.e = 10_000 + randInt(r, 0, 10);
    else if (p.a !== undefined) p.a = 999;
    else if (p.vt !== undefined) p.v = p.vt === ValueTag.Str ? "zzzz-none" : p.v;
  }
  return p;
}

const SMALL = { leafSize: 16, fanout: 4 };

describe("tree build + scan", () => {
  test("seek/scan over built trees ≡ filter over the raw datom list (all indexes, small nodes)", async () => {
    const r = rng(100);
    for (const index of ALL_INDEXES) {
      const raw = randDatoms(r, 3000, { maxE: 120, maxA: 6, maxT: 30 });
      const sorted = sortDedup(index, raw);
      const store = new MemStore();
      const root = await buildTree(store, index, sorted, SMALL);
      expect(root.count).toBe(sorted.length);
      expect(await treeDepth(store, root)).toBeGreaterThan(2);
      for (let k = 0; k < 300; k++) {
        const p = randomPrefix(r, index, sorted);
        const expected = sorted.filter((d) => comparePrefix(index, d, p) === 0);
        const got = await collect(store, index, root, p);
        if (got.length !== expected.length) throw new Error(`count mismatch for ${JSON.stringify(p)} in index ${index}: got ${got.length} want ${expected.length}`);
        for (let i = 0; i < got.length; i++) expect(datomEquals(got[i], expected[i])).toBe(true);
        const first = await seekOne(store, index, root, p);
        if (expected.length) expect(datomEquals(first!, expected[0])).toBe(true);
        else expect(first).toBeUndefined();
        const est = await estimateCount(store, index, root, p);
        expect(est).toBe(expected.length);
      }
    }
  });

  test("full scan with empty prefix returns everything in order", async () => {
    const r = rng(101);
    const sorted = sortDedup(Index.AEVT, randDatoms(r, 1000));
    const store = new MemStore();
    const root = await buildTree(store, Index.AEVT, sorted, SMALL);
    const all = await collect(store, Index.AEVT, root, {});
    expect(all.length).toBe(sorted.length);
    for (let i = 0; i < all.length; i++) expect(datomEquals(all[i], sorted[i])).toBe(true);
  });

  test("empty tree", async () => {
    const store = new MemStore();
    const root = await buildTree(store, Index.EAVT, []);
    expect(root.count).toBe(0);
    expect(await collect(store, Index.EAVT, root, {})).toEqual([]);
    expect(await collect(store, Index.EAVT, root, { e: 5 })).toEqual([]);
    expect(await seekOne(store, Index.EAVT, root, { e: 5 })).toBeUndefined();
    expect(await estimateCount(store, Index.EAVT, root, { e: 5 })).toBe(0);
  });

  test("cold path: nodes are decoded from bodies (gzip codec) and results are identical", async () => {
    const r = rng(102);
    const sorted = sortDedup(Index.EAVT, randDatoms(r, 2000));
    const store = new MemStore(gzipCodec);
    const root = await buildTree(store, Index.EAVT, sorted, { leafSize: 100, fanout: 8 });
    store.evictDecoded();
    const before = store.stats.loads;
    const got = await collect(store, Index.EAVT, root, { e: sorted[500].e });
    expect(store.stats.loads).toBeGreaterThan(before);
    const expected = sorted.filter((d) => d.e === sorted[500].e);
    expect(got.length).toBe(expected.length);
    got.forEach((d, i) => expect(datomEquals(d, expected[i])).toBe(true));

    const depth = await treeDepth(store, root);
    expect(store.stats.loads - before).toBeLessThanOrEqual(depth + Math.ceil(expected.length / 100) + depth);
  });
});

describe("tree merge (structural sharing)", () => {
  test("merge ≡ rebuild from union; only touched paths are rewritten", async () => {
    const r = rng(200);
    for (const index of ALL_INDEXES) {
      const base = sortDedup(index, randDatoms(r, 4000, { maxE: 300, maxA: 6, maxT: 20 }));
      const store = new MemStore();
      const root = await buildTree(store, index, base, { leafSize: 32, fanout: 8 });
      const objectsBefore = store.stats.objects;

      const nov = sortDedup(index, randDatoms(r, 20, { maxE: 300, maxA: 6, maxT: 20 }).map((d) => ({ ...d, t: 21 + randInt(r, 0, 5) })));
      const newRoot = await mergeTree(store, index, root, nov, { leafSize: 32, fanout: 8 });
      const expected = sortDedup(index, base.concat(nov));
      const got = await collect(store, index, newRoot, {});
      expect(got.length).toBe(expected.length);
      got.forEach((d, i) => {
        if (!datomEquals(d, expected[i])) throw new Error(`mismatch at ${i} in index ${index}`);
      });
      expect(newRoot.count).toBe(expected.length);

      const old = await collect(store, index, root, {});
      expect(old.length).toBe(base.length);

      const written = store.stats.objects - objectsBefore;
      const depth = await treeDepth(store, newRoot);
      expect(written).toBeLessThanOrEqual(nov.length * depth + depth);
      const total = (await reachable(store, newRoot)).size;
      expect(written).toBeLessThan(total / 2);

      const shared = [...(await reachable(store, root))].filter((h) => (store.peek(h) !== undefined)).length;
      expect(shared).toBeGreaterThan(0);
    }
  });

  test("merging duplicates is a no-op (same root)", async () => {
    const r = rng(201);
    const base = sortDedup(Index.EAVT, randDatoms(r, 500));
    const store = new MemStore();
    const root = await buildTree(store, Index.EAVT, base, SMALL);
    const same = await mergeTree(store, Index.EAVT, root, base.slice(10, 40), SMALL);
    expect(same.hash).toBe(root.hash);
    const before = store.stats.objects;
    await mergeTree(store, Index.EAVT, root, [], SMALL);
    expect(store.stats.objects).toBe(before);
  });

  test("repeated merges grow the tree correctly (leaf and dir splits)", async () => {
    const r = rng(202);
    const store = new MemStore();
    let root = await buildTree(store, Index.EAVT, [], SMALL);
    let all: Datom[] = [];
    for (let round = 0; round < 25; round++) {
      const nov = sortDedup(Index.EAVT, randDatoms(r, 60, { maxE: 500, maxA: 5, maxT: 40 }));
      root = await mergeTree(store, Index.EAVT, root, nov, SMALL);
      all = sortDedup(Index.EAVT, all.concat(nov));
      expect(root.count).toBe(all.length);
    }
    const got = await collect(store, Index.EAVT, root, {});
    expect(got.length).toBe(all.length);
    got.forEach((d, i) => expect(datomEquals(d, all[i])).toBe(true));
    expect(await treeDepth(store, root)).toBeGreaterThanOrEqual(3);

    for (let k = 0; k < 100; k++) {
      const d = all[randInt(r, 0, all.length - 1)];
      const got = await collect(store, Index.EAVT, root, { e: d.e, a: d.a });
      const exp = all.filter((x) => x.e === d.e && x.a === d.a);
      expect(got.length).toBe(exp.length);
    }
  });

  test("merge into a large tree with a small delta writes O(touched · depth) objects", async () => {
    const r = rng(203);
    const base = sortDedup(Index.EAVT, randDatoms(r, 40_000, { maxE: 5000, maxA: 10, maxT: 100 }));
    const store = new MemStore();
    const root = await buildTree(store, Index.EAVT, base, { leafSize: 200, fanout: 16 });
    const before = store.stats.objects;

    const e = base[20_000].e;
    const nov = sortDedup(Index.EAVT, [1, 2, 3, 4, 5].map((i) => ({ e, a: 20 + i, vt: ValueTag.Long, v: i, t: 101, op: true } as Datom)));
    const newRoot = await mergeTree(store, Index.EAVT, root, nov, { leafSize: 200, fanout: 16 });
    const depth = await treeDepth(store, newRoot);
    const written = store.stats.objects - before;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(2 * depth);
    expect(newRoot.count).toBe(base.length + 5);
  });

  test("sortedUnion dedups", () => {
    const cmp = COMPARATORS[Index.EAVT];
    const a: Datom[] = [{ e: 1, a: 1, vt: ValueTag.Long, v: 1, t: 1, op: true }];
    const b: Datom[] = [{ e: 1, a: 1, vt: ValueTag.Long, v: 1, t: 1, op: true }, { e: 2, a: 1, vt: ValueTag.Long, v: 1, t: 1, op: true }];
    expect(sortedUnion(cmp, a, b).length).toBe(2);
  });
});
