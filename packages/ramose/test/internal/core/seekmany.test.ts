/**
 * Property test: Db.seekMany (batched cursor seek, tree + novelty, current view)
 * ≡ datomsArray per prefix — including duplicate prefixes in one batch.
 */
import { expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, type Prefix } from "../../../src/internal/core/datom.ts";
import { rng, randInt, pick } from "./util.ts";
test("seekMany ≡ datomsArray per prefix (with duplicates)", async () => {
  const r = rng(7);
  const conn = await Connection.create({ build: { leafSize: 8, fanout: 4 } });
  await conn.transact([
    { ":db/ident": ":p/tag", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many", ":db/index": true },
    { ":db/ident": ":p/boss", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  ]);
  const eids: number[] = [];
  for (let i = 0; i < 60; i++) eids.push((await conn.transact([{ ":db/id": "x", ":p/tag": pick(r, ["x","y","z"]) }])).tempids.x);
  for (let i = 0; i < 200; i++) {
    const e = pick(r, eids);
    const k = r();
    if (k < 0.4) await conn.transact([[":db/add", e, ":p/boss", pick(r, eids)]]);
    else if (k < 0.8) await conn.transact([[":db/add", e, ":p/tag", pick(r, ["x","y","z"])]]);
    else await conn.transact([[":db/retract", e, ":p/tag"]]);
    if (i === 100) await conn.index();
  }
  const db = conn.db();
  const tag = db.schema.entid(":p/tag")!, boss = db.schema.entid(":p/boss")!;
  for (let round = 0; round < 50; round++) {
    const shapes: (() => Prefix)[] = [
      () => ({ e: pick(r, eids) }),
      () => ({ e: pick(r, eids), a: r() < 0.5 ? tag : boss }),
      () => ({ a: tag, vt: 1 as any, v: pick(r, ["x","y","z"]) }),
      () => ({ vt: 5 as any, v: pick(r, eids), a: boss }),
    ];
    const si = randInt(r, 0, 3);
    const index = [Index.EAVT, Index.EAVT, Index.AVET, Index.VAET][si];
    const n = randInt(r, 1, 30);
    const seen = new Set<string>(); const prefixes: Prefix[] = [];
    for (let i = 0; i < n; i++) { const p = shapes[si](); const k = JSON.stringify(p); if (seen.has(k) && r() < 0.7) continue; seen.add(k); prefixes.push(p); }
    const got = new Map<number, string>();
    (await db.seekMany(index, prefixes)).forEach((datoms, i) => got.set(i, JSON.stringify(datoms)));
    for (let i = 0; i < prefixes.length; i++) {
      const want = JSON.stringify(await db.datomsArray(index, prefixes[i]));
      if (got.get(i) !== want) throw new Error(`round ${round} idx ${index} prefix ${JSON.stringify(prefixes[i])} (${i}/${prefixes.length})\n got ${got.get(i)}\nwant ${want}`);
    }
  }
});

test("seekMany over an empty tree (all novelty) works", async () => {
  const conn = await Connection.create();
  await conn.transact([{ ":db/ident": ":p/tag", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" }]);
  const r = await conn.transact([{ ":db/id": "x", ":p/tag": "a" }]);
  const db = conn.db();
  const tag = db.schema.entid(":p/tag")!;
  const res = await db.seekMany(Index.EAVT, [{ e: r.tempids.x, a: tag }, { e: 5, a: tag }]);
  expect(res[0].length).toBe(1);
  expect(res[1].length).toBe(0);
});
