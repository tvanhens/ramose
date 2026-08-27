import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import type { Db } from "../../../src/internal/core/db.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import { parsePullPattern } from "../../../src/internal/core/query/parse.ts";

const SCHEMA = [
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":user/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":user/friends", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/address", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/isComponent": true, ":db/optional": true },
  { ":db/ident": ":address/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":user/tags", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user", ":ramose/kind": ":ramose.kind/entity" },
  { ":db/ident": ":address", ":ramose/kind": ":ramose.kind/entity" },
];

let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  const conn = await Connection.create();
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "a", ":ramose/type": ":user", ":user/name": "A", ":user/age": 1, ":user/friends": ["b", "c"], ":user/address": { ":db/id": "addr", ":ramose/type": ":address", ":address/city": "Rome" }, ":user/tags": ["t1", "t2", "t3"] },
    { ":db/id": "b", ":ramose/type": ":user", ":user/name": "B", ":user/friends": ["a"] },
    { ":db/id": "c", ":ramose/type": ":user", ":user/name": "C" },
  ]);
  ids = rep.tempids;
  db = conn.db();
});

describe("pull", () => {
  test("wildcard", async () => {
    const r = await pull(db, ids.a, "[*]");
    expect(r![":db/id"]).toBe(ids.a);
    expect(r![":user/name"]).toBe("A");
    expect(r![":user/friends"]).toEqual([{ ":db/id": ids.b }, { ":db/id": ids.c }].sort((x, y) => x[":db/id"] - y[":db/id"]));
    expect(r![":user/address"]).toEqual({ ":db/id": ids.addr });
  });

  test("nested wildcard through a ref, including the already-lowered AST", async () => {
    const edn = await pull(db, ids.a, `[{:user/friends [*]}]`);
    const friends = (edn![":user/friends"] as Record<string, unknown>[]).sort(
      (x, y) => (x[":db/id"] as number) - (y[":db/id"] as number),
    );
    expect(friends.map((f) => f[":user/name"])).toEqual(["B", "C"]);
    expect(friends[0]![":db/id"]).toBe(ids.b);
    // what `ref.select(all(N))` sends: an attr spec whose `sub` is still `["*"]`
    const ast = await pull(db, ids.a, [
      { kind: "attr", attr: ":user/friends", reverse: false, as: "friends", sub: ["*"] },
    ]);
    expect(ast).toEqual({ friends: edn![":user/friends"] });
  });

  test("attribute list, nested, reverse, options", async () => {
    const r = await pull(db, ids.a, `[:user/name {:user/friends [:user/name]} {:user/address [:address/city]}]`);
    expect(r).toEqual({ ":user/name": "A", ":user/friends": [{ ":user/name": "B" }, { ":user/name": "C" }], ":user/address": { ":address/city": "Rome" } });
    const rev = await pull(db, ids.b, `[:user/name {:user/_friends [:user/name]}]`);
    expect(rev).toEqual({ ":user/name": "B", ":user/_friends": [{ ":user/name": "A" }] });
    // reverse of a component attr is single-valued
    const comp = await pull(db, ids.addr, `[:address/city {:user/_address [:user/name]}]`);
    expect(comp).toEqual({ ":address/city": "Rome", ":user/_address": { ":user/name": "A" } });
    const opts = await pull(db, ids.a, `[(:user/name :as "name") (limit :user/tags 2) (default :user/age 0) (default :user/nope 7)]`);
    expect(opts![":user/name"]).toBeUndefined();
    expect(opts!.name).toBe("A");
    expect((opts![":user/tags"] as string[]).length).toBe(2);
    expect(opts![":user/age"]).toBe(1);
    const dflt = await pull(db, ids.c, `[:user/name (default :user/age 0)]`);
    expect(dflt).toEqual({ ":user/name": "C", ":user/age": 0 });
    expect(await pull(db, 999_999, `[:user/name]`)).toBeNull();
    // JS-form pattern
    expect(await pull(db, ids.c, [":user/name"])).toEqual({ ":user/name": "C" });
    expect(parsePullPattern([":user/name", { ":user/friends": [":user/name"] }]).length).toBe(2);
  });

  test("recursion with cycles", async () => {
    const r = await pull(db, ids.a, `[:user/name {:user/friends ...}]`);
    expect(r![":user/name"]).toBe("A");
    const friends = r![":user/friends"] as any[];
    const b = friends.find((f) => f[":user/name"] === "B");
    expect(b[":user/friends"]).toEqual([{ ":db/id": ids.a }]); // cycle cut
    const limited = await pull(db, ids.a, `[:user/name {:user/friends 1}]`);
    const lb = (limited![":user/friends"] as any[]).find((f) => f[":user/name"] === "B");
    expect(lb[":user/friends"]).toEqual([{ ":db/id": ids.a }]);
  });

  test("pull inside query", async () => {
    const res = await query(db, `[:find (pull ?e [:user/name {:user/friends [:user/name]}]) :where [?e :user/name "A"]]`);
    expect(res).toEqual([[{ ":user/name": "A", ":user/friends": [{ ":user/name": "B" }, { ":user/name": "C" }] }]]);
    const scalar = await query(db, `[:find (pull ?e [*]) . :where [?e :user/name "C"]]`);
    expect(scalar[":user/name"]).toBe("C");
    const coll = await query(db, `[:find [(pull ?e [:user/name]) ...] :where [?e :user/name]]`);
    expect(coll.map((x: any) => x[":user/name"]).sort()).toEqual(["A", "B", "C"]);
  });
});
