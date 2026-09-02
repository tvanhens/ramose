import { describe, expect, test } from "bun:test";
import { COMPARATORS, type Datom, Index, ValueTag, comparePrefix, datomEquals } from "../../../src/internal/core/datom.ts";
import { Novelty, SortedNovelty } from "../../../src/internal/core/novelty.ts";
import { Schema } from "../../../src/internal/core/schema.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { randDatoms, randInt, rng } from "./util.ts";

function sortDedup(index: 0 | 1 | 2 | 3, ds: readonly Datom[]): Datom[] {
  const cmp = COMPARATORS[index];
  const s = ds.slice().sort(cmp);
  return s.filter((d, i) => i === 0 || cmp(s[i - 1], d) !== 0);
}

function chunkToArray(c: { datoms: readonly Datom[]; start: number; end: number } | undefined): Datom[] {
  return c === undefined ? [] : c.datoms.slice(c.start, c.end);
}

describe("SortedNovelty sorted runs", () => {
  test("many small adds keep range and all consistent with a single sorted array", () => {
    const r = rng(7);
    for (const index of [Index.EAVT, Index.AEVT, Index.AVET, Index.VAET] as const) {
      const n = new SortedNovelty(index);
      let all: Datom[] = [];
      for (let i = 0; i < 300; i++) {
        const batch = randDatoms(r, randInt(r, 1, 6), { maxE: 40, maxA: 4, maxT: 50 });
        n.add(batch);
        all = all.concat(batch);
        if (i % 7 === 0) {
          const d = all[randInt(r, 0, all.length - 1)];
          const p = index === Index.VAET ? { vt: d.vt, v: d.v } : index === Index.EAVT ? { e: d.e } : { a: d.a };
          const got = chunkToArray(n.range(p));
          const exp = sortDedup(index, all).filter((x) => comparePrefix(index, x, p) === 0);
          expect(got.length).toBe(exp.length);
          got.forEach((x, j) => expect(datomEquals(x, exp[j])).toBe(true));
        }
      }
      const got = n.all();
      const exp = sortDedup(index, all);
      expect(got.length).toBe(exp.length);
      got.forEach((x, j) => expect(datomEquals(x, exp[j])).toBe(true));
      expect(n.size).toBe(exp.length);
      n.dropThrough(25);
      expect(n.all().every((d) => d.t > 25)).toBe(true);
      expect(n.size).toBe(exp.filter((d) => d.t > 25).length);
    }
  });

  test("a duplicate added in a later run is reported once", () => {
    const r = rng(11);
    const n = new SortedNovelty(Index.EAVT);
    const first = randDatoms(r, 5, { maxE: 3, maxA: 2, maxT: 2 });
    n.add(first);
    n.all();
    n.add([first[2]]);
    n.range({ e: first[2].e });
    n.add(first.slice(0, 2));
    const got = n.all();
    const exp = sortDedup(Index.EAVT, first);
    expect(got.length).toBe(exp.length);
    got.forEach((x, j) => expect(datomEquals(x, exp[j])).toBe(true));
  });
});

describe("Novelty overlay", () => {
  test("layered view reads like a copy of base plus the overlay datoms", () => {
    const r = rng(13);
    const schema = Schema.bootstrap();
    const isAvet = (a: number) => schema.isAvet(a) || a % 2 === 0;
    const isVaet = (a: number) => schema.isVaet(a) || a % 3 === 0;
    const base = new Novelty();
    const baseDatoms = randDatoms(r, 500, { maxE: 30, maxA: 6, maxT: 20 });
    base.add(baseDatoms, isAvet, isVaet);
    const extra = randDatoms(r, 20, { maxE: 30, maxA: 6, maxT: 25 });
    const view = base.overlay(extra, isAvet, isVaet);
    const copy = new Novelty();
    copy.add(baseDatoms, isAvet, isVaet);
    copy.add(extra, isAvet, isVaet);
    expect(view.maxT).toBe(copy.maxT);
    for (const index of [Index.EAVT, Index.AEVT, Index.AVET, Index.VAET] as const) {
      const expAll = copy.byIndex[index].all();
      const gotAll = view.byIndex[index].all();
      expect(gotAll.length).toBe(expAll.length);
      gotAll.forEach((x, j) => expect(datomEquals(x, expAll[j])).toBe(true));
      for (let k = 0; k < 40; k++) {
        const d = expAll.length === 0 ? undefined : expAll[randInt(r, 0, expAll.length - 1)];
        if (d === undefined) continue;
        const p = index === Index.VAET ? { vt: d.vt, v: d.v } : index === Index.EAVT ? { e: d.e } : k % 2 ? { a: d.a } : {};
        const got = chunkToArray(view.byIndex[index].range(p));
        const exp = chunkToArray(copy.byIndex[index].range(p));
        expect(got.length).toBe(exp.length);
        got.forEach((x, j) => expect(datomEquals(x, exp[j])).toBe(true));
      }
    }
    expect(base.byIndex[Index.EAVT].all().length).toBe(sortDedup(Index.EAVT, baseDatoms).length);
  });

  test("validators see the staged transaction without copying unindexed novelty", async () => {
    const conn = await Connection.create();
    await conn.transact([
      { ":db/ident": ":item/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
      { ":db/ident": ":item/parent", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    for (let i = 0; i < 200; i++) await conn.transact([{ ":item/name": `seed-${i}` }]);
    const seeded = conn.noveltyCount;
    const staged = await conn.transactValidated(
      [{ ":db/id": "child", ":item/name": "child", ":item/parent": [":item/name", "seed-7"] }],
      async ({ dbBefore, dbAfter, tempids }) => {
        const child = tempids.child;
        expect(await dbBefore.entid([":item/name", "child"])).toBeUndefined();
        expect(await dbAfter.entid([":item/name", "child"])).toBe(child);
        expect(await dbAfter.entid([":item/name", "seed-7"])).toBe(await dbBefore.entid([":item/name", "seed-7"]));
        const parent = await dbAfter.entid([":item/name", "seed-7"]);
        const incoming = await dbAfter.datomsArray(Index.VAET, { vt: ValueTag.Ref, v: parent! });
        expect(incoming.some((d) => d.e === child)).toBe(true);
        expect(dbAfter.novelty.count).toBe(seeded + 4);
        return child;
      },
    );
    expect(conn.noveltyCount).toBe(seeded + 4);
    expect(await conn.db().entid([":item/name", "child"])).toBe(staged.value);
  });
});
