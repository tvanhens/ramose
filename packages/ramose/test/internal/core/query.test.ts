import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { type Db } from "../../../src/internal/core/db.ts";
import { QueryError, query } from "../../../src/internal/core/query/engine.ts";
import { parseQuery } from "../../../src/internal/core/query/parse.ts";
import { readEdn } from "../../../src/internal/core/query/edn.ts";

const SCHEMA = [
  { ":db/ident": ":person/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":person/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":person/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":person/score", ":db/valueType": ":db.type/double", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":person/active", ":db/valueType": ":db.type/boolean", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":person/friends", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":person/boss", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":person/tags", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":person/joined", ":db/valueType": ":db.type/instant", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":person/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
];

let conn: Connection;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "alice", ":person/name": "Alice", ":person/email": "alice@x", ":person/age": 30, ":person/score": 1.5, ":person/active": true, ":person/tags": ["admin", "dev"], ":person/joined": new Date("2020-01-01Z"), ":person/city": "Berlin" },
    { ":db/id": "bob", ":person/name": "Bob", ":person/email": "bob@x", ":person/age": 25, ":person/score": 2.5, ":person/active": false, ":person/friends": ["alice"], ":person/boss": "alice", ":person/tags": ["dev"], ":person/city": "Berlin" },
    { ":db/id": "carol", ":person/name": "Carol", ":person/email": "carol@x", ":person/age": 35, ":person/score": 0.5, ":person/active": true, ":person/friends": ["alice", "bob"], ":person/boss": "alice", ":person/city": "Oslo" },
    { ":db/id": "dave", ":person/name": "Dave", ":person/email": "dave@x", ":person/age": 25, ":person/active": true, ":person/friends": ["carol"], ":person/boss": "carol" },
  ]);
  ids = rep.tempids;
  db = conn.db();
});

const sortRows = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

describe("datalog basics", () => {
  test("simple pattern, EDN string", async () => {
    const res = await query(db, `[:find ?n :where [?e :person/name ?n]]`);
    expect(sortRows(res)).toEqual(sortRows([["Alice"], ["Bob"], ["Carol"], ["Dave"]]));
  });

  test("JS form with inputs and predicates", async () => {
    const res = await query(db, { find: ["?n", "?a"], in: ["$", "?min"], where: [["?e", ":person/age", "?a"], [[">", "?a", "?min"]], ["?e", ":person/name", "?n"]] }, [db, 26]);
    expect(sortRows(res)).toEqual(sortRows([["Alice", 30], ["Carol", 35]]));
    // db can be implied
    const res2 = await query(db, `[:find ?n :in $ ?min :where [?e :person/age ?a] [(> ?a ?min)] [?e :person/name ?n]]`, [26]);
    expect(sortRows(res2)).toEqual(sortRows([["Alice"], ["Carol"]]));
  });

  test("join through refs (VAET/AVET/EAVT paths)", async () => {
    const res = await query(db, `[:find ?n ?fn :where [?e :person/friends ?f] [?e :person/name ?n] [?f :person/name ?fn]]`);
    expect(sortRows(res)).toEqual(sortRows([["Bob", "Alice"], ["Carol", "Alice"], ["Carol", "Bob"], ["Dave", "Carol"]]));
    // reverse direction: who has Alice as boss? (v bound, a bound → VAET)
    const res2 = await query(db, `[:find ?n :in $ ?boss :where [?e :person/boss ?boss] [?e :person/name ?n]]`, [ids.alice]);
    expect(sortRows(res2)).toEqual(sortRows([["Bob"], ["Carol"]]));
    // lookup ref / ident constants in entity position
    const res3 = await query(db, `[:find ?a . :where [[:person/email "bob@x"] :person/age ?a]]`);
    expect(res3).toBe(25);
    // constant value with indexed attribute (AVET seek)
    const res4 = await query(db, `[:find ?e . :where [?e :person/name "Carol"]]`);
    expect(res4).toBe(ids.carol);
    // constant value on unindexed attribute (AEVT + filter)
    const res5 = await query(db, `[:find [?n ...] :where [?e :person/age 25] [?e :person/name ?n]]`);
    expect(res5.sort()).toEqual(["Bob", "Dave"]);
  });

  test("find specs: scalar, coll, tuple, rel + keys", async () => {
    expect(await query(db, `[:find ?a . :where [?e :person/name "Alice"] [?e :person/age ?a]]`)).toBe(30);
    expect((await query(db, `[:find [?n ...] :where [?e :person/name ?n]]`)).sort()).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    expect(await query(db, `[:find [?n ?a] :where [?e :person/name "Bob"] [?e :person/name ?n] [?e :person/age ?a]]`)).toEqual(["Bob", 25]);
    const withKeys = await query(db, `[:find ?n ?a :keys name age :where [?e :person/name ?n] [?e :person/age ?a]]`);
    expect(withKeys.find((r: any) => r.name === "Alice")).toEqual({ name: "Alice", age: 30 });
    expect(await query(db, `[:find ?a . :where [?e :person/name "Nobody"] [?e :person/age ?a]]`)).toBeNull();
  });

  test("aggregates and :with", async () => {
    expect(await query(db, `[:find (count ?e) . :where [?e :person/name]]`)).toBe(4);
    // Datomic semantics: aggregates run over the *set* of find tuples, so duplicate ages collapse…
    expect(await query(db, `[:find (sum ?a) . :where [?e :person/age ?a]]`)).toBe(90);
    // …unless :with keeps the entity in the tuple
    expect(await query(db, `[:find (sum ?a) . :with ?e :where [?e :person/age ?a]]`)).toBe(115);
    expect(await query(db, `[:find (sum ?a) . :where [_ :person/age ?a]]`)).toBe(90); // set semantics without :with
    const byCity = await query(db, `[:find ?c (count ?e) (max ?a) :where [?e :person/city ?c] [?e :person/age ?a]]`);
    expect(sortRows(byCity)).toEqual(sortRows([["Berlin", 2, 30], ["Oslo", 1, 35]]));
    expect(await query(db, `[:find (avg ?a) . :with ?e :where [?e :person/age ?a]]`)).toBeCloseTo(28.75);
    expect(await query(db, `[:find (min ?s) (max ?s) :where [_ :person/score ?s]]`)).toEqual([[0.5, 2.5]]);
    expect(await query(db, `[:find (count-distinct ?a) . :with ?e :where [?e :person/age ?a]]`)).toBe(3);
    expect(await query(db, `[:find [(min 2 ?a) ...] :with ?e :where [?e :person/age ?a]]`)).toEqual([[25, 30]]);
  });

  test("functions and bindings", async () => {
    const res = await query(db, `[:find ?n ?next :where [?e :person/name ?n] [?e :person/age ?a] [(inc ?a) ?next] [(> ?next 30)]]`);
    expect(sortRows(res)).toEqual(sortRows([["Alice", 31], ["Carol", 36]]));
    const tup = await query(db, `[:find ?x ?y :where [(ground [1 2]) [?x ?y]]]`);
    expect(tup).toEqual([[1, 2]]);
    const coll = await query(db, `[:find [?x ...] :where [(ground [1 2 3]) [?x ...]]]`);
    expect(coll.sort()).toEqual([1, 2, 3]);
    const rel = await query(db, `[:find ?x ?y :where [(ground [[1 2] [3 4]]) [[?x ?y]]]]`);
    expect(sortRows(rel)).toEqual(sortRows([[1, 2], [3, 4]]));
    const str = await query(db, `[:find ?s . :where [?e :person/name "Bob"] [?e :person/age ?a] [(str "Bob is " ?a) ?s]]`);
    expect(str).toBe("Bob is 25");
    // get-else and missing?
    const ge = await query(db, `[:find ?n ?s :where [?e :person/name ?n] [(get-else $ ?e :person/score -1) ?s]]`);
    expect(ge.find((r: any) => r[0] === "Dave")[1]).toBe(-1);
    const missing = await query(db, `[:find [?n ...] :where [?e :person/name ?n] [(missing? $ ?e :person/score)]]`);
    expect(missing).toEqual(["Dave"]);
    // custom function
    const custom = await query(db, `[:find [?n ...] :where [?e :person/name ?n] [(shout ?n) ?u] [(= ?u "BOB")]]`, [], { functions: { shout: (s: string) => s.toUpperCase() } });
    expect(custom).toEqual(["Bob"]);
  });

  test("not, not-join, or, or-join", async () => {
    const notActive = await query(db, `[:find [?n ...] :where [?e :person/name ?n] (not [?e :person/active true])]`);
    expect(notActive).toEqual(["Bob"]);
    const noFriends = await query(db, `[:find [?n ...] :where [?e :person/name ?n] (not-join [?e] [?e :person/friends _])]`);
    expect(noFriends).toEqual(["Alice"]);
    const orQ = await query(db, `[:find [?n ...] :where [?e :person/name ?n] (or [?e :person/age 35] [?e :person/city "Berlin"])]`);
    expect(orQ.sort()).toEqual(["Alice", "Bob", "Carol"]);
    const orJoin = await query(db, `[:find [?n ...] :where [?e :person/name ?n] (or-join [?e] [?e :person/age 35] (and [?e :person/friends ?f] [?f :person/name "Bob"]))]`);
    expect(orJoin.sort()).toEqual(["Carol"]);
    await expect(query(db, `[:find ?n :where [?e :person/name ?n] (or [?e :person/age 35] [?e :person/friends ?f])]`)).rejects.toBeInstanceOf(QueryError);
  });

  test("collection / relation / tuple inputs", async () => {
    const coll = await query(db, `[:find [?n ...] :in $ [?a ...] :where [?e :person/age ?a] [?e :person/name ?n]]`, [[25, 35]]);
    expect(coll.sort()).toEqual(["Bob", "Carol", "Dave"]);
    const rel = await query(db, `[:find ?n ?x :in $ [[?n ?x]] :where [?e :person/name ?n]]`, [[["Alice", 1], ["Nobody", 2], ["Bob", 3]]]);
    expect(sortRows(rel)).toEqual(sortRows([["Alice", 1], ["Bob", 3]]));
    const tup = await query(db, `[:find ?e . :in $ [?n ?a] :where [?e :person/name ?n] [?e :person/age ?a]]`, [["Bob", 25]]);
    expect(tup).toBe(ids.bob);
  });

  test("attribute and tx variables; history db", async () => {
    const attrs = await query(db, `[:find [?a ...] :in $ ?e :where [?e ?a _]]`, [ids.dave]);
    const idents = attrs.map((a: number) => db.attr(a)!.ident).sort();
    expect(idents).toEqual([":person/active", ":person/age", ":person/boss", ":person/email", ":person/friends", ":person/name"]);
    const txq = await query(db, `[:find ?inst . :where [?e :person/name "Alice" ?tx] [?tx :db/txInstant ?inst]]`);
    expect((txq as Date).getTime()).toBe(1_700_000_000_000);
    // history: age change appears as retract + assert
    const c2 = conn; // same conn; add a tx
    await c2.transact([[":db/add", ids.bob, ":person/age", 26]]);
    const hist = await query(c2.db().history(), `[:find ?a ?op :in $ ?e :where [?e :person/age ?a _ ?op]]`, [ids.bob]);
    expect(sortRows(hist)).toEqual(sortRows([[25, true], [25, false], [26, true]]));
    expect(await query(c2.db(), `[:find ?a . :in $ ?e :where [?e :person/age ?a]]`, [ids.bob])).toBe(26);
    expect(await query(c2.db().asOf(db.basisT), `[:find ?a . :in $ ?e :where [?e :person/age ?a]]`, [ids.bob])).toBe(25);
    db = conn.db();
  });

  test("errors: unbound find var, unknown attribute, insufficient bindings", async () => {
    await expect(query(db, `[:find ?x :where [?e :person/name ?n]]`)).rejects.toBeInstanceOf(QueryError);
    await expect(query(db, `[:find ?e :where [?e :nope/attr ?n]]`)).rejects.toBeInstanceOf(QueryError);
    await expect(query(db, `[:find ?e :where [(> ?e 5)]]`)).rejects.toBeInstanceOf(QueryError);
  });

  test("parser produces AST usable directly", async () => {
    const ast = parseQuery(`[:find ?n :where [?e :person/name ?n]]`);
    expect(ast.find.kind).toBe("rel");
    const res = await query(db, ast);
    expect(res.length).toBe(4);
    expect(readEdn(`{:a [1 2] :b "x"}`)).toEqual({ ":a": [1, 2], ":b": "x" });
  });

  test("planner uses seeks (stats)", async () => {
    const stats = { clauses: [] as any[] };
    await query(db, `[:find ?fn :in $ ?e :where [?e :person/friends ?f] [?f :person/name ?fn]]`, [ids.carol], { stats });
    expect(stats.clauses.length).toBe(2);
    for (const c of stats.clauses) {
      expect(["seek-join", "hash-join"]).toContain(c.strategy);
      expect(["eavt", "aevt"]).toContain(c.index);
      expect(c.seeks).toBeGreaterThanOrEqual(1);
    }
  });
});
