import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { type Db } from "../../../src/internal/core/db.ts";
import { QueryBudgetError, query } from "../../../src/internal/core/query/engine.ts";
import { QueryParseError, parseQuery } from "../../../src/internal/core/query/parse.ts";

const SCHEMA = [
  { ":db/ident": ":person/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":person/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person/boss", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":group/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":group/parent", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":group/member", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
];

let conn: Connection;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "alice", ":person/name": "Alice", ":person/age": 30, ":person/city": "Berlin" },
    { ":db/id": "bob", ":person/name": "Bob", ":person/age": 25, ":person/boss": "alice", ":person/city": "Berlin" },
    { ":db/id": "carol", ":person/name": "Carol", ":person/age": 35, ":person/boss": "alice", ":person/city": "Oslo" },
    { ":db/id": "dave", ":person/name": "Dave", ":person/age": 25, ":person/boss": "carol" },

    { ":db/id": "root", ":group/name": "root" },
    { ":db/id": "eng", ":group/name": "eng", ":group/parent": "root" },
    { ":db/id": "platform", ":group/name": "platform", ":group/parent": "eng" },
  ]);
  ids = rep.tempids;
  await conn.transact([
    [":db/add", ids.root, ":group/member", ids.alice],
    [":db/add", ids.eng, ":group/member", ids.carol],
    [":db/add", ids.platform, ":group/member", ids.bob],
  ]);
  db = conn.db();
});

const sortRows = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

describe("non-recursive rules", () => {
  test("membership as an or over attrs (the wire form entities(ns) emits)", async () => {
    const res = await query(db, {
      find: ["?e"],
      where: [["isPerson", "?e"]],
      rules: [
        [["isPerson", "?e"], ["or", ["?e", ":person/name", "_"], ["?e", ":person/age", "_"]]],
      ],
    });
    expect(sortRows(res)).toEqual(sortRows([[ids.alice], [ids.bob], [ids.carol], [ids.dave]]));
  });

  test("moded invocation: bound argument seeks, free argument binds", async () => {
    const res = await query(db, {
      find: ["?n"],
      where: [["bossOf", "?e", "?b"], ["?e", ":person/name", "Dave"], ["?b", ":person/name", "?n"]],
      rules: [[["bossOf", "?x", "?y"], ["?x", ":person/boss", "?y"]]],
    });
    expect(res).toEqual([["Carol"]]);
  });

  test("constant argument constrains the head position", async () => {
    const res = await query(db, {
      find: ["?n"],
      in: ["$", "?city"],
      where: [["livesIn", "?e", "?city"], ["?e", ":person/name", "?n"]],
      rules: [[["livesIn", "?p", "?c"], ["?p", ":person/city", "?c"]]],
    }, [db, "Berlin"]);
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Bob"]]));
  });

  test("multiple definitions of one name are disjunctive branches", async () => {
    const res = await query(db, {
      find: ["?n"],
      where: [["senior", "?e"], ["?e", ":person/name", "?n"]],
      rules: [
        [["senior", "?e"], ["?e", ":person/age", "?a"], [[">=", "?a", 35]]],
        [["senior", "?e"], ["?e", ":person/name", "Alice"]],
      ],
    });
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Carol"]]));
  });

  test("rules invoking rules; blank argument leaves the position free", async () => {
    const res = await query(db, {
      find: ["?n"],
      where: [["isBoss", "?e"], ["?e", ":person/name", "?n"]],
      rules: [
        [["bossOf", "?x", "?y"], ["?x", ":person/boss", "?y"]],
        [["isBoss", "?b"], ["bossOf", "_", "?b"]],
      ],
    });
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Carol"]]));
  });

  test("rule call inside not", async () => {
    const res = await query(db, {
      find: ["?n"],
      where: [["?e", ":person/name", "?n"], ["not", ["isBoss", "?e"]]],
      rules: [
        [["isBoss", "?b"], ["_", ":person/boss", "?b"]],
      ],
    });
    expect(sortRows(res)).toEqual(sortRows([["Bob"], ["Dave"]]));
  });

  test("EDN spelling", async () => {
    const res = await query(
      db,
      `[:find ?n
        :where (isBoss ?e) [?e :person/name ?n]
        :rules [[(isBoss ?b) [_ :person/boss ?b]]]]`,
    );
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Carol"]]));
  });
});

describe("recursive rules", () => {
  const reports = [
    [["reportsTo", "?e", "?m"], ["?e", ":person/boss", "?m"]],
    [["reportsTo", "?e", "?m"], ["?e", ":person/boss", "?b"], ["reportsTo", "?b", "?m"]],
  ];

  test("transitive closure over a ref", async () => {
    const res = await query(db, {
      find: ["?n"],
      in: ["$", "?e"],
      where: [["reportsTo", "?e", "?m"], ["?m", ":person/name", "?n"]],
      rules: reports,
    }, [db, ids.dave]);
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Carol"]]));
  });

  test("transitive closure runs backwards too (free first arg)", async () => {
    const res = await query(db, {
      find: ["?n"],
      in: ["$", "?m"],
      where: [["reportsTo", "?e", "?m"], ["?e", ":person/name", "?n"]],
      rules: reports,
    }, [db, ids.alice]);
    expect(sortRows(res)).toEqual(sortRows([["Bob"], ["Carol"], ["Dave"]]));
  });

  test("nested group membership (or of direct and parent-transitive)", async () => {
    const rules = [
      [["inGroup", "?p", "?g"], ["?g", ":group/member", "?p"]],
      [["inGroup", "?p", "?g"], ["?sub", ":group/parent", "?g"], ["inGroup", "?p", "?sub"]],
    ];
    const res = await query(db, {
      find: ["?n"],
      in: ["$", "?g"],
      where: [["inGroup", "?p", "?g"], ["?p", ":person/name", "?n"]],
      rules,
    }, [db, ids.root]);
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Bob"], ["Carol"]]));
    const eng = await query(db, {
      find: ["?n"],
      in: ["$", "?g"],
      where: [["inGroup", "?p", "?g"], ["?p", ":person/name", "?n"]],
      rules,
    }, [db, ids.eng]);
    expect(sortRows(eng)).toEqual(sortRows([["Bob"], ["Carol"]]));
  });

  test("mutual recursion", async () => {

    const rules = [
      [["evenChain", "?e"], ["?e", ":person/name", "_"], ["not", ["?e", ":person/boss", "_"]]],
      [["evenChain", "?e"], ["?e", ":person/boss", "?b"], ["oddChain", "?b"]],
      [["oddChain", "?e"], ["?e", ":person/boss", "?b"], ["evenChain", "?b"]],
    ];
    const res = await query(db, {
      find: ["?n"],
      where: [["oddChain", "?e"], ["?e", ":person/name", "?n"]],
      rules,
    });

    expect(sortRows(res)).toEqual(sortRows([["Bob"], ["Carol"]]));
  });

  test("runaway recursion aborts on the query budget", async () => {
    const p = query(db, {
      find: ["?x"],
      where: [["counts", "?x"]],
      rules: [
        [["counts", "?x"], [["ground", 0], "?x"]],
        [["counts", "?x"], ["counts", "?y"], [["+", "?y", 1], "?x"]],
      ],
    }, [db], { maxCells: 10_000 });
    await expect(p).rejects.toThrow(QueryBudgetError);
  });
});

describe("rule validation", () => {
  test("an unknown head is still an error", () => {
    expect(() => parseQuery({ find: ["?e"], where: [["isPerson", "?e"]] })).toThrow(QueryParseError);
    expect(() => parseQuery({ find: ["?e"], where: [["isPerson", "?e"]] })).toThrow(/unknown clause form 'isPerson'/);
  });

  test("arity is checked at parse", () => {
    expect(() =>
      parseQuery({
        find: ["?e"],
        where: [["bossOf", "?e"]],
        rules: [[["bossOf", "?x", "?y"], ["?x", ":person/boss", "?y"]]],
      }),
    ).toThrow(/takes 2 arguments/);
  });

  test("branches must share the head arity", () => {
    expect(() =>
      parseQuery({
        find: ["?e"],
        where: [["r", "?e"]],
        rules: [
          [["r", "?x"], ["?x", ":person/name", "_"]],
          [["r", "?x", "?y"], ["?x", ":person/boss", "?y"]],
        ],
      }),
    ).toThrow(QueryParseError);
  });

  test("a rule head takes distinct variables", () => {
    expect(() =>
      parseQuery({
        find: ["?e"],
        where: [["r", "?e", "?e"]],
        rules: [[["r", "?x", "?x"], ["?x", ":person/name", "_"]]],
      }),
    ).toThrow(QueryParseError);
  });
});
