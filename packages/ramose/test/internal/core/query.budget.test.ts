import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { DEFAULT_QUERY_MAX_CELLS, QueryBudgetError, QueryError, query, type QueryStats } from "../../../src/internal/core/query/engine.ts";

async function setup(n = 2000) {
  const conn = await Connection.create();
  await conn.transact([
    { ":db/ident": ":p/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
    { ":db/ident": ":p/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
    { ":db/ident": ":p/friend", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  ]);
  const tx: unknown[] = [];
  for (let i = 0; i < n; i++) tx.push({ ":db/id": `p${i}`, ":p/name": `n${i}`, ":p/city": `c${i % 10}`, ":p/friend": [`p${(i + 1) % n}`, `p${(i + 2) % n}`] });
  await conn.transact(tx);
  return conn.db();
}

describe("query memory budget (M7)", () => {
  test("a query that would blow the budget fails cleanly with a tagged error, before allocating the relation", async () => {
    const db = await setup(2000);

    const t0 = performance.now();
    let err: unknown;
    try {
      await query(db, `[:find ?n ?c :where [?e :p/name ?n] [?f :p/city ?c]]`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryBudgetError);
    expect(err).toBeInstanceOf(QueryError);
    const be = err as QueryBudgetError;
    expect(be.code).toBe("query/budget-exceeded");
    expect(be.limit).toBe(DEFAULT_QUERY_MAX_CELLS);
    expect(be.cells).toBeGreaterThan(be.limit);
    expect(be.message).toMatch(/memory budget/);

    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("the budget is a seam: a tiny limit aborts an ordinary join; the abort names the clause", async () => {
    const db = await setup(500);
    const q = `[:find ?n ?fn :where [?e :p/city "c3"] [?e :p/friend ?f] [?f :p/name ?fn] [?e :p/name ?n]]`;
    const ok = (await query(db, q)) as unknown[][];
    expect(ok.length).toBe(100);
    let err: unknown;
    try {
      await query(db, q, [], { maxCells: 120 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QueryBudgetError);
    expect((err as QueryBudgetError).clause).toMatch(/\[\?e :p\/friend \?f\]|\[\?f :p\/name \?fn\]|\[\?e :p\/city/);
    expect((err as QueryBudgetError).limit).toBe(120);

    await expect(query(db, `[:find ?e ?f :in $ [?e ...] :where [?e :p/friend ?f]]`, [Array.from({ length: 200 }, (_, i) => 1000 + i)], { maxCells: 50 })).rejects.toBeInstanceOf(QueryBudgetError);

    await expect(query(db, `[:find ?e ?x :where [?e :p/city "c3"] [(range 0 100) [?x ...]]]`, [], { maxCells: 200, functions: { range: (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i) } })).rejects.toBeInstanceOf(QueryBudgetError);
  });

  test("a normal query is unchanged and reports its peak usage", async () => {
    const db = await setup(1000);
    const q = `[:find ?n ?fn :where [?e :p/city "c3"] [?e :p/friend ?f] [?f :p/name ?fn] [?e :p/name ?n]]`;
    const stats: QueryStats = { clauses: [] };
    const a = (await query(db, q, [], { stats })) as unknown[][];
    const b = (await query(db, q, [], { maxCells: DEFAULT_QUERY_MAX_CELLS })) as unknown[][];
    const c = (await query(db, q, [], { maxCells: 100_000 })) as unknown[][];
    expect(a.length).toBe(200);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(stats.budget).toBeDefined();
    expect(stats.budget!.maxCells).toBe(DEFAULT_QUERY_MAX_CELLS);
    expect(stats.budget!.peakCells).toBeGreaterThan(0);
    expect(stats.budget!.peakCells).toBeLessThan(10_000);

    expect(await query(db, `[:find (count ?e) . :where [?e :p/city "c3"]]`, [], { maxCells: 1000 })).toBe(100);
  });
});
