import { describe, expect, test } from "bun:test";
import { COMPARATORS, type Datom, Index, ValueTag, comparePrefix, datomEquals, valueKey } from "../../../src/internal/core/datom.ts";
import { Novelty, SortedNovelty, currentView, mergeChunks } from "../../../src/internal/core/novelty.ts";
import { MemStore } from "../../../src/internal/core/store.ts";
import { buildTree, scan } from "../../../src/internal/core/tree.ts";
import { randDatoms, randInt, rng } from "./util.ts";

function sortDedup(index: 0 | 1 | 2 | 3, ds: readonly Datom[]): Datom[] {
  const cmp = COMPARATORS[index];
  const s = ds.slice().sort(cmp);
  return s.filter((d, i) => i === 0 || cmp(s[i - 1], d) !== 0);
}

/** Reference current view: for each (e,a,v) keep the datom with max (t, op) if t <= asOf; emit if op. */
function refCurrent(index: 0 | 1 | 2 | 3, ds: readonly Datom[], asOf?: number): Datom[] {
  const latest = new Map<string, Datom>();
  for (const d of ds) {
    if (asOf !== undefined && d.t > asOf) continue;
    const k = `${d.e}|${d.a}|${valueKey(d.vt, d.v)}`;
    const cur = latest.get(k);
    if (!cur || cur.t < d.t || (cur.t === d.t && !cur.op && d.op)) latest.set(k, d);
  }
  return sortDedup(index, [...latest.values()].filter((d) => d.op));
}

describe("SortedNovelty", () => {
  test("keeps datoms sorted and deduped across adds", () => {
    const r = rng(1);
    const n = new SortedNovelty(Index.EAVT);
    let all: Datom[] = [];
    for (let i = 0; i < 20; i++) {
      const batch = randDatoms(r, 30, { maxE: 20, maxA: 3, maxT: 5 });
      n.add(batch);
      all = all.concat(batch);
      const got = n.all();
      const exp = sortDedup(Index.EAVT, all);
      expect(got.length).toBe(exp.length);
      got.forEach((d, j) => expect(datomEquals(d, exp[j])).toBe(true));
    }
    const p = { e: 5 };
    const rg = n.range(p);
    const exp = n.all().filter((d) => comparePrefix(Index.EAVT, d, p) === 0);
    expect(rg ? rg.end - rg.start : 0).toBe(exp.length);
    n.dropThrough(3);
    expect(n.all().every((d) => d.t > 3)).toBe(true);
  });
});

describe("mergeChunks + currentView", () => {
  test("tree ∪ novelty in order, then collapsed to current view ≡ reference", async () => {
    const r = rng(2);
    for (const index of [Index.EAVT, Index.AEVT, Index.AVET, Index.VAET] as const) {
      const base = sortDedup(index, randDatoms(r, 2000, { maxE: 60, maxA: 4, maxT: 20 }));
      const store = new MemStore();
      const root = await buildTree(store, index, base, { leafSize: 20, fanout: 4 });
      const novRaw = randDatoms(r, 400, { maxE: 60, maxA: 4, maxT: 40 });
      const nov = new SortedNovelty(index);
      nov.add(novRaw);
      const union = sortDedup(index, base.concat(novRaw));
      for (let k = 0; k < 60; k++) {
        const d = union[randInt(r, 0, union.length - 1)];
        const p = index === Index.VAET ? { vt: d.vt, v: d.v } : index === Index.EAVT ? { e: d.e } : k % 2 ? { a: d.a } : {};
        // merged history
        const merged: Datom[] = [];
        for await (const c of mergeChunks(COMPARATORS[index], scan(store, index, root, p), nov.range(p))) {
          for (let i = c.start; i < c.end; i++) merged.push(c.datoms[i]);
        }
        const expM = union.filter((x) => comparePrefix(index, x, p) === 0);
        expect(merged.length).toBe(expM.length);
        merged.forEach((x, i) => {
          if (!datomEquals(x, expM[i])) throw new Error(`merge mismatch index ${index} prefix ${JSON.stringify(p)} at ${i}`);
        });
        // current view (with and without asOf)
        for (const asOf of [undefined, 10, 25, 40]) {
          const cur: Datom[] = [];
          for await (const arr of currentView(mergeChunks(COMPARATORS[index], scan(store, index, root, p), nov.range(p)), asOf)) cur.push(...arr);
          const expC = refCurrent(index, expM, asOf);
          expect(cur.length).toBe(expC.length);
          cur.forEach((x, i) => {
            if (!datomEquals(x, expC[i])) throw new Error(`current mismatch index ${index} asOf ${asOf} at ${i}`);
          });
        }
      }
    }
  });

  test("Novelty routes AVET/VAET by predicate", () => {
    const n = new Novelty();
    const ds: Datom[] = [
      { e: 1, a: 1, vt: ValueTag.Str, v: "x", t: 1, op: true },
      { e: 1, a: 2, vt: ValueTag.Ref, v: 3, t: 1, op: true },
    ];
    n.add(ds, (a) => a === 1, (a) => a === 2);
    expect(n.byIndex[Index.EAVT].size).toBe(2);
    expect(n.byIndex[Index.AVET].size).toBe(1);
    expect(n.byIndex[Index.VAET].size).toBe(1);
    expect(n.maxT).toBe(1);
  });
});
