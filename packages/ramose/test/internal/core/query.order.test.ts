import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { type Db } from "../../../src/internal/core/db.ts";
import { QueryError, query } from "../../../src/internal/core/query/engine.ts";
import { QueryParseError, parseQuery } from "../../../src/internal/core/query/parse.ts";

const SCHEMA = [
  { ":db/ident": ":person/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":person/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person/score", ":db/valueType": ":db.type/double", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person", ":ramose/kind": ":ramose.kind/entity" },
];

let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  const conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "alice", ":ramose/type": ":person", ":person/name": "Alice", ":person/age": 30, ":person/score": 1.5, ":person/city": "Berlin" },
    { ":db/id": "bob", ":ramose/type": ":person", ":person/name": "Bob", ":person/age": 25, ":person/score": 2.5, ":person/city": "Berlin" },
    { ":db/id": "carol", ":ramose/type": ":person", ":person/name": "Carol", ":person/age": 35, ":person/score": 0.5, ":person/city": "Oslo" },
    { ":db/id": "dave", ":ramose/type": ":person", ":person/name": "Dave", ":person/age": 25, ":person/city": "Oslo" },
  ]);
  ids = rep.tempids;
  db = conn.db();
});

/** Wraps a Db so per-entity pull reads (`datomsArray`) can be counted. */
function countingDb(target: Db): { db: Db; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(target, {
    get(t, p) {
      const val = Reflect.get(t, p, t);
      if (typeof val !== "function") return val;
      const f = val.bind(t);
      return p === "datomsArray" ? (...args: unknown[]) => (n++, f(...args)) : f;
    },
  });
  return { db: proxy as Db, reads: () => n };
}

describe("order / limit / offset", () => {
  test("asc and desc on a find var", async () => {
    const asc = await query(db, `[:find [?n ...] :where [?e :person/name ?n] [?e :person/age ?a] :order [?a :asc] [?n :asc]]`);
    expect(asc).toEqual(["Bob", "Dave", "Alice", "Carol"]);
    const desc = await query(db, `[:find [?n ...] :where [?e :person/name ?n] [?e :person/age ?a] :order [?a :desc] [?n :desc]]`);
    expect(desc).toEqual(["Carol", "Alice", "Dave", "Bob"]);
    // a bare variable defaults to :asc
    expect(await query(db, `[:find [?n ...] :where [?e :person/name ?n] :order ?n]`)).toEqual(["Alice", "Bob", "Carol", "Dave"]);
  });

  test("multi-key order", async () => {
    const rows = await query(db, {
      find: ["?c", "?n"],
      where: [["?e", ":person/city", "?c"], ["?e", ":person/name", "?n"], ["?e", ":person/age", "?a"]],
      order: [{ var: "?c", dir: "asc" }, { var: "?a", dir: "desc" }],
    });
    expect(rows).toEqual([["Berlin", "Alice"], ["Berlin", "Bob"], ["Oslo", "Carol"], ["Oslo", "Dave"]]);
  });

  test("order by a variable that is not in :find", async () => {
    const rows = await query(db, {
      find: ["?n"],
      where: [["?e", ":person/name", "?n"], ["?e", ":person/age", "?a"]],
      order: [["?a", "desc"], ["?n", "asc"]],
    });
    expect(rows).toEqual([["Carol"], ["Alice"], ["Bob"], ["Dave"]]);
  });

  test("offset, limit, and both together", async () => {
    const q = (extra: object) =>
      query(db, { find: [["?n", "..."]], where: [["?e", ":person/name", "?n"]], order: [["?n"]], ...extra });
    expect(await q({ limit: 2 })).toEqual(["Alice", "Bob"]);
    expect(await q({ offset: 2 })).toEqual(["Carol", "Dave"]);
    expect(await q({ offset: 1, limit: 2 })).toEqual(["Bob", "Carol"]);
    expect(await q({ offset: 10 })).toEqual([]);
    expect(await q({ limit: 0 })).toEqual([]);
    expect(await q({ offset: 3, limit: 99 })).toEqual(["Dave"]);
  });

  test("order over an optional attribute via get-else keeps every row", async () => {
    const rows = await query(
      db,
      `[:find ?n ?s :where [?e :person/name ?n] [(get-else $ ?e :person/score -1) ?s] :order [?s :asc]]`,
    );
    expect(rows).toEqual([["Dave", -1], ["Carol", 0.5], ["Alice", 1.5], ["Bob", 2.5]]);
    const desc = await query(
      db,
      `[:find ?n ?s :where [?e :person/name ?n] [(get-else $ ?e :person/score -1) ?s] :order [?s :desc]]`,
    );
    expect(desc.map((r: unknown[]) => r[0])).toEqual(["Bob", "Alice", "Carol", "Dave"]);
  });

  test("null/undefined placement follows :empty in both directions", async () => {
    const data = [["a", 2], ["b", null], ["c", 1]];
    const run = (order: unknown[]) =>
      query(db, { find: [["?k", "..."]], where: [[["ground", data], [["?k", "?v"]]]], order });
    expect(await run([["?v", "asc"]])).toEqual(["c", "a", "b"]);
    expect(await run([["?v", "desc"]])).toEqual(["a", "c", "b"]);
    expect(await run([["?v", "asc", "first"]])).toEqual(["b", "c", "a"]);
    expect(await run([["?v", "desc", "first"]])).toEqual(["b", "a", "c"]);
  });

  test("mixed types get a deterministic total order", async () => {
    const when = new Date("2020-01-01Z");
    const data = [["date", when], ["bool", true], ["str", "x"], ["num", 7], ["nil", null]];
    const rows = await query(db, {
      find: [["?k", "..."]],
      where: [[["ground", data], [["?k", "?v"]]]],
      order: [["?v", "asc"]],
    });
    expect(rows).toEqual(["num", "str", "bool", "date", "nil"]);
    const rev = await query(db, {
      find: [["?k", "..."]],
      where: [[["ground", data], [["?k", "?v"]]]],
      order: [["?v", "desc"]],
    });
    expect(rev).toEqual(["date", "bool", "str", "num", "nil"]);
  });

  test("aggregates order on the aggregated tuple", async () => {
    const rows = await query(db, `[:find ?c (count ?e) :with ?e :where [?e :person/city ?c] :order [?c :desc]]`);
    expect(rows).toEqual([["Oslo", 2], ["Berlin", 2]]);
    const byCity = await query(db, `[:find ?c (max ?a) :where [?e :person/city ?c] [?e :person/age ?a] :order [?a :desc] :limit 1]`);
    expect(byCity).toEqual([["Oslo", 35]]);
    // a var that survives neither the grouping nor the aggregation
    await expect(
      query(db, `[:find ?c (count ?e) :where [?e :person/city ?c] [?e :person/age ?a] :order [?a :asc]]`),
    ).rejects.toBeInstanceOf(QueryError);
  });

  test("limit only pulls the rows that survive it", async () => {
    const pattern = `(pull ?e [:person/name])`;
    const q = (extra: string) => `[:find ${pattern} :where [?e :person/name ?n] [?e :person/age ?a] :order [?a :asc] [?n :asc] ${extra}]`;
    const all = countingDb(db);
    const rowsAll = await query(all.db, q(""));
    const capped = countingDb(db);
    const rowsCapped = await query(capped.db, q(":limit 2"));
    expect(rowsAll.length).toBe(4);
    expect(rowsCapped).toEqual([[{ ":person/name": "Bob" }], [{ ":person/name": "Dave" }]]);
    expect(all.reads() - capped.reads()).toBe(2);
  });

  test("scalar and tuple find specs tolerate order/offset/limit", async () => {
    expect(await query(db, `[:find ?n . :where [?e :person/name ?n] :order [?n :desc] :limit 1]`)).toBe("Dave");
    expect(await query(db, `[:find ?n . :where [?e :person/name ?n] :order ?n :offset 2]`)).toBe("Carol");
    expect(await query(db, `[:find [?n ?a] :where [?e :person/name ?n] [?e :person/age ?a] :order [?a :desc] :limit 1]`)).toEqual(["Carol", 35]);
    expect(await query(db, `[:find ?n . :where [?e :person/name ?n] :offset 99]`)).toBeNull();
  });

  test(":keys rows survive order + offset + limit", async () => {
    const rows = await query(db, {
      find: ["?n", "?a"],
      keys: ["name", "age"],
      where: [["?e", ":person/name", "?n"], ["?e", ":person/age", "?a"]],
      order: [["?a", "desc"], ["?n", "asc"]],
      offset: 1,
      limit: 2,
    });
    expect(rows).toEqual([{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]);
  });

  test("order variables must be bound", async () => {
    await expect(query(db, `[:find [?n ...] :where [?e :person/name ?n] :order ?nope]`)).rejects.toBeInstanceOf(QueryError);
  });

  test("queries without order/limit are unchanged", async () => {
    const ast = parseQuery(`[:find ?n :where [?e :person/name ?n]]`);
    expect(ast.order).toBeUndefined();
    expect(ast.limit).toBeUndefined();
    expect(ast.offset).toBeUndefined();
    const rows = await query(db, ast);
    expect(rows.map((r: unknown[]) => r[0]).sort()).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    expect(await query(db, `[:find ?a . :in $ ?e :where [?e :person/age ?a]]`, [ids.dave])).toBe(25);
  });
});

describe("order / limit / offset parsing", () => {
  test("map, vector and EDN forms agree", () => {
    const expected = [{ var: "?a", dir: "desc", empty: "first" }, { var: "?n", dir: "asc" }];
    expect(parseQuery({ find: ["?n"], where: [], order: [["?a", "desc", "first"], "?n"], limit: 5, offset: 2 })).toMatchObject({
      order: expected,
      limit: 5,
      offset: 2,
    });
    expect(
      parseQuery({ find: ["?n"], where: [], order: [{ var: "?a", dir: "desc", empty: "first" }, { var: "?n" }], limit: 5, offset: 2 }),
    ).toMatchObject({ order: expected, limit: 5, offset: 2 });
    expect(parseQuery(`[:find ?n :where [?e :a/b ?n] :order [?a :desc :first] ?n :limit 5 :offset 2]`)).toMatchObject({
      order: expected,
      limit: 5,
      offset: 2,
    });
    expect(parseQuery(`{:find [?n] :order [[?a :desc :first] ?n] :limit 5 :offset 2}`)).toMatchObject({
      order: expected,
      limit: 5,
      offset: 2,
    });
    expect(parseQuery({ find: ["?n"], where: [], order: [] }).order).toBeUndefined();
  });

  test("bad order/limit/offset forms are rejected", () => {
    const bad = (q: object) => expect(() => parseQuery(q)).toThrow(QueryParseError);
    bad({ find: ["?n"], order: "?n" });
    bad({ find: ["?n"], order: ["n"] });
    bad({ find: ["?n"], order: [["?n", "sideways"]] });
    bad({ find: ["?n"], order: [["?n", "asc", "middle"]] });
    bad({ find: ["?n"], order: [{ var: "?n", direction: "asc" }] });
    bad({ find: ["?n"], limit: -1 });
    bad({ find: ["?n"], limit: 1.5 });
    bad({ find: ["?n"], limit: "3" });
    bad({ find: ["?n"], offset: -2 });
    bad({ find: ["?n"], offset: true });
    expect(() => parseQuery(`[:find ?n :limit 1 2]`)).toThrow(QueryParseError);
  });

  test("unknown top-level keys are rejected", () => {
    expect(() => parseQuery({ find: ["?n"], where: [], limitt: 5 })).toThrow(QueryParseError);
    expect(() => parseQuery({ find: ["?n"], where: [], "order-by": [["?n"]] })).toThrow(QueryParseError);
    expect(parseQuery({ ":find": ["?n"], ":where": [], ":limit": 3 }).limit).toBe(3);
  });
});

describe(":after keyset cursor", () => {
  const byAgeName = (extra: object) =>
    query(db, {
      find: ["?n"],
      where: [["?e", ":person/name", "?n"], ["?e", ":person/age", "?a"]],
      order: [["?a", "asc"], ["?n", "asc"]],
      ...extra,
    });

  test("keeps only the rows strictly after the cursor position", async () => {
    // sorted: Bob(25) Dave(25) Alice(30) Carol(35)
    expect(await byAgeName({ after: [25, "Bob"] })).toEqual([["Dave"], ["Alice"], ["Carol"]]);
    expect(await byAgeName({ after: [25, "Dave"] })).toEqual([["Alice"], ["Carol"]]);
    expect(await byAgeName({ after: [35, "Carol"] })).toEqual([]);
    // a cursor before every row keeps them all
    expect((await byAgeName({ after: [0, ""] })).length).toBe(4);
  });

  test(":limit counts rows past the cursor", async () => {
    expect(await byAgeName({ after: [25, "Bob"], limit: 2 })).toEqual([["Dave"], ["Alice"]]);
  });

  test("a null cursor value sits where :empty put the missing rows", async () => {
    // Dave has no :person/score; get-else-style or-join binding grounds null.
    const q = (after: unknown[]) =>
      query(db, {
        find: ["?n"],
        where: [
          ["?e", ":person/name", "?n"],
          ["or-join", ["?e", "?s"],
            ["and", ["?e", ":person/score", "?s"]],
            ["and", ["not", ["?e", ":person/score", "_"]], [["ground", [null]], ["?s", "..."]]]],
        ],
        order: [{ var: "?s", dir: "asc", empty: "last" }, { var: "?n", dir: "asc" }],
        after,
      });
    // sorted: Carol(0.5) Alice(1.5) Bob(2.5) Dave(null last)
    expect(await q([2.5, "Bob"])).toEqual([["Dave"]]);
    expect(await q([null, "Dave"])).toEqual([]);
  });

  test(":after needs :order, matching arity, and no aggregates", () => {
    const bad = (q: object) => expect(() => parseQuery(q)).toThrow(QueryParseError);
    bad({ find: ["?n"], where: [], after: [1] });
    bad({ find: ["?n"], where: [], order: [["?n"]], after: [1, 2] });
    bad({ find: ["?n"], where: [], order: [["?n"]], after: "x" });
    bad({ find: [["count", "?e"], "?c"], where: [], order: [["?c"]], after: [1] });
    expect(parseQuery({ find: ["?n"], where: [], order: [["?n"]], after: ["Bob"] })).toMatchObject({
      after: ["Bob"],
    });
    expect(parseQuery(`[:find ?n :where [?e :a/b ?n] :order ?n :after ["Bob"]]`)).toMatchObject({
      after: ["Bob"],
    });
  });
});
