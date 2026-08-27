import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { schemaTx } from "../../../src/db/ensure.ts";
import { txBuilder, txOps } from "../../../src/db/Tx.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { TxError } from "../../../src/internal/core/tx.ts";
import { Movies, User } from "../../db/fixture.ts";

const SCHEMA = [
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true, ":db/optional": true },
  { ":db/ident": ":user/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
  { ":db/ident": ":user/handle", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/value", ":db/optional": true },
  { ":db/ident": ":user/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":user/tags", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/friends", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/address", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/isComponent": true, ":db/optional": true },
  { ":db/ident": ":address/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":user/joined", ":db/valueType": ":db.type/instant", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":color/red" },
];

async function setup() {
  const conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  return conn;
}

const ageOps = (conn: Connection, datoms: { a: number; v: unknown; op: boolean }[]) => {
  const age = conn.db().attr(":user/age")!.id;
  return datoms.filter((d) => d.a === age).map((d) => [d.v, d.op]);
};

describe("db/cas", () => {
  test("match: retracts the old card-one value and adds the replacement", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const r2 = await conn.transact([[":db/cas", u, ":user/age", 30, 31]]);
    expect(ageOps(conn, r2.txData)).toEqual([[30, false], [31, true]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(31);
  });

  test("absent expected when absent: tempid and existing entity without the attr", async () => {
    const conn = await setup();
    const created = await conn.transact([[":db/cas", "u", ":user/age", null, 10]]);
    const u = created.tempids.u;
    expect((await conn.db().entity(u))![":user/age"]).toBe(10);

    const named = await conn.transact([{ ":db/id": "v", ":user/name": "V" }]);
    const v = named.tempids.v;
    await conn.transact([[":db/cas", v, ":user/age", undefined, 11]]);
    expect((await conn.db().entity(v))![":user/age"]).toBe(11);
  });

  test("absent expected when present is tx/cas-conflict and leaves the entity unchanged", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(conn.transact([[":db/cas", u, ":user/age", null, 10]])).rejects.toMatchObject({
      code: "tx/cas-conflict",
    });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("mismatch aborts the whole tx: neither CAS nor a sibling add is visible", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 31 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 99],
        [":db/add", u, ":user/name", "B"],
      ]),
    ).rejects.toMatchObject({ code: "tx/cas-conflict" });
    const row = await conn.db().entity(u);
    expect(row![":user/age"]).toBe(31);
    expect(row![":user/name"]).toBe("A");
  });

  test("lookup-ref entity form", async () => {
    const conn = await setup();
    const r1 = await conn.transact([
      { ":db/id": "u", ":user/email": "a@x", ":user/name": "A", ":user/age": 30 },
    ]);
    const u = r1.tempids.u;
    await conn.transact([[":db/cas", [":user/email", "a@x"], ":user/age", 30, 31]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(31);
  });

  test("unique conflict on replacement leaves original values unchanged", async () => {
    const conn = await setup();
    const r1 = await conn.transact([
      { ":db/id": "a", ":user/name": "A", ":user/handle": "aa" },
      { ":db/id": "b", ":user/name": "B", ":user/handle": "bb" },
    ]);
    const a = r1.tempids.a;
    const b = r1.tempids.b;
    await expect(conn.transact([[":db/cas", b, ":user/handle", "bb", "aa"]])).rejects.toMatchObject({
      code: "tx/unique-conflict",
    });
    expect((await conn.db().entity(a))![":user/handle"]).toBe("aa");
    expect((await conn.db().entity(b))![":user/handle"]).toBe("bb");
  });

  test("CAS is not upsert: tempid + taken unique replacement is tx/unique-conflict", async () => {
    const conn = await setup();
    await conn.transact([{ ":db/id": "a", ":user/name": "A", ":user/handle": "aa" }]);
    await expect(conn.transact([[":db/cas", "new", ":user/handle", null, "aa"]])).rejects.toMatchObject({
      code: "tx/unique-conflict",
    });
    expect(await conn.db().entid([":user/handle", "aa"])).toBeDefined();
  });

  test("card-many is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/tags": ["x"] }]);
    await expect(conn.transact([[":db/cas", r1.tempids.u, ":user/tags", null, "y"]])).rejects.toMatchObject({
      code: "tx/invalid",
    });
    expect(((await conn.db().entity(r1.tempids.u))![":user/tags"] as string[])).toEqual(["x"]);
  });

  test("malformed: arity, unknown attr, nil replacement, type mismatch", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(conn.transact([[":db/cas", u, ":user/age", 30]])).rejects.toMatchObject({
      code: "tx/invalid",
    });
    await expect(conn.transact([[":db/cas", u, ":user/age", 30, 31, "extra"]])).rejects.toMatchObject({
      code: "tx/invalid",
    });
    await expect(conn.transact([[":db/cas", u, ":nope/attr", null, 1]])).rejects.toMatchObject({
      code: "tx/unknown-attribute",
    });
    await expect(conn.transact([[":db/cas", u, ":user/age", 30, null]])).rejects.toThrow(/nil value/);
    await expect(conn.transact([[":db/cas", u, ":user/age", "nope", 31]])).rejects.toMatchObject({
      code: "tx/type-mismatch",
    });
    await expect(conn.transact([[":db/cas", u, ":user/age", 30, "nope"]])).rejects.toMatchObject({
      code: "tx/type-mismatch",
    });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("numeric eid that does not exist is tx/missing-entity", async () => {
    const conn = await setup();
    await expect(conn.transact([[":db/cas", 99_999, ":user/age", null, 10]])).rejects.toMatchObject({
      code: "tx/missing-entity",
    });
  });

  test("same-tx two matching CAS with different replacements: last wins", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const age = conn.db().attr(":user/age")!.id;
    const r2 = await conn.transact([
      [":db/cas", u, ":user/age", 30, 31],
      [":db/cas", u, ":user/age", 30, 32],
    ]);
    expect(ageOps(conn, r2.txData)).toEqual([[30, false], [32, true]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(32);
    const eavt = await conn.db().datomsArray(Index.EAVT, { e: u, a: age });
    expect(eavt.map((d) => [d.v, d.op])).toEqual([[32, true]]);
    const hist = await conn.db().history().datomsArray(Index.EAVT, { e: u, a: age });
    expect(hist.map((d) => [d.v, d.op])).toEqual([
      [30, true],
      [30, false],
      [32, true],
    ]);
    expect((await conn.db().asOf(r1.t).entity(u))![":user/age"]).toBe(30);
    expect((await conn.db().asOf(r2.t).entity(u))![":user/age"]).toBe(32);
  });

  test("same-tx two matching CAS: query and subsequent CAS see one value", async () => {
    const conn = await setup();
    const { query } = await import("../../../src/internal/core/query/engine.ts");
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await conn.transact([
      [":db/cas", u, ":user/age", 30, 31],
      [":db/cas", u, ":user/age", 30, 32],
    ]);
    expect(await query(conn.db(), `[:find ?a . :where [${u} :user/age ?a]]`)).toBe(32);
    await conn.transact([[":db/cas", u, ":user/age", 32, 33]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(33);
  });

  test("same-tx CAS then ordinary add: last wins without contradictory datoms", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const age = conn.db().attr(":user/age")!.id;
    await conn.transact([
      [":db/cas", u, ":user/age", 30, 31],
      [":db/add", u, ":user/age", 32],
    ]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(32);
    const eavt = await conn.db().datomsArray(Index.EAVT, { e: u, a: age });
    expect(eavt.map((d) => [d.v, d.op])).toEqual([[32, true]]);
  });

  test("same-tx ordinary add then CAS: last wins without contradictory datoms", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const age = conn.db().attr(":user/age")!.id;
    await conn.transact([
      [":db/add", u, ":user/age", 31],
      [":db/cas", u, ":user/age", 30, 32],
    ]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(32);
    const eavt = await conn.db().datomsArray(Index.EAVT, { e: u, a: age });
    expect(eavt.map((d) => [d.v, d.op])).toEqual([[32, true]]);
  });

  test("same-tx two CAS with different expecteds: tx/cas-conflict", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/cas", u, ":user/age", 99, 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/cas-conflict" });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("same-tx second CAS expected=first replacement fails (db-before compare)", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/cas", u, ":user/age", 31, 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/cas-conflict" });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("history / as-of / current after a successful CAS", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await conn.transact([[":db/cas", u, ":user/age", 30, 31]]);
    const age = conn.db().attr(":user/age")!.id;
    expect((await conn.db().entity(u))![":user/age"]).toBe(31);
    expect((await conn.db().asOf(r1.t).entity(u))![":user/age"]).toBe(30);
    const hist = await conn.db().history().datomsArray(Index.EAVT, { e: u, a: age });
    expect(hist.map((d) => [d.v, d.op])).toEqual([
      [30, true],
      [30, false],
      [31, true],
    ]);
  });

  test("concurrent Connection.transact: exactly one CAS wins", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const settled = await Promise.allSettled([
      conn.transact([[":db/cas", u, ":user/age", 30, 1]]),
      conn.transact([[":db/cas", u, ":user/age", 30, 2]]),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({ code: "tx/cas-conflict" });
    const age = (await conn.db().entity(u))![":user/age"];
    expect(age === 1 || age === 2).toBe(true);
  });

  test("redundant CAS elides user datoms (only txInstant)", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const r2 = await conn.transact([[":db/cas", u, ":user/age", 30, 30]]);
    expect(r2.txData.length).toBe(1);
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("ref-typed card-one: nested map replacement and ident replacement", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A" }]);
    const u = r1.tempids.u;
    await conn.transact([[":db/cas", u, ":user/address", null, { ":address/city": "Paris" }]]);
    const addr = (await conn.db().entity(u))![":user/address"] as number;
    expect((await conn.db().entity(addr))![":address/city"]).toBe("Paris");

    const other = await conn.transact([{ ":db/id": "a2", ":address/city": "Oslo" }]);
    const a2 = other.tempids.a2;
    await conn.transact([[":db/cas", u, ":user/address", addr, a2]]);
    expect((await conn.db().entity(u))![":user/address"]).toBe(a2);

    await conn.transact([
      {
        ":db/ident": ":user/favorite",
        ":db/valueType": ":db.type/ref",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
    ]);
    await conn.transact([[":db/cas", u, ":user/favorite", null, ":color/red"]]);
    expect((await conn.db().entity(u))![":user/favorite"]).toBe(conn.db().schema.entid(":color/red"));
  });

  test("tx.cas lowers to :db/cas and commits through Connection", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact(schemaTx(Movies) as unknown[]);
    const create = txBuilder(Movies);
    Effect.runSync(create.put(User, { name: "Ada", age: 36 }));
    const created = await conn.transact([...txOps(create)]);
    const eid = created.tempids["tmp-1"]!;
    expect(typeof eid).toBe("number");
    const cas = txBuilder(Movies);
    Effect.runSync(cas.cas(eid, User.age, 36, 37));
    expect(txOps(cas)).toEqual([[":db/cas", eid, ":user/age", 36, 37]]);
    const handle = txBuilder(Movies);
    const h = Effect.runSync(handle.entity(eid));
    Effect.runSync(h.cas(User.age, null, 1));
    expect(txOps(handle)).toEqual([[":db/cas", eid, ":user/age", null, 1]]);
    await conn.transact([...txOps(cas)]);
    expect((await conn.db().entity(eid))![":user/age"]).toBe(37);
  });

  test("same-tx retractEntity then CAS expected=old component ref succeeds", async () => {
    const conn = await setup();
    const r1 = await conn.transact([
      { ":db/id": "u", ":user/name": "A", ":user/address": { ":db/id": "old", ":address/city": "Paris" } },
    ]);
    const u = r1.tempids.u;
    const oldAddr = r1.tempids.old;
    const created = await conn.transact([{ ":db/id": "new", ":address/city": "Oslo" }]);
    const newAddr = created.tempids.new;

    await expect(
      conn.transact([[":db/cas", u, ":user/address", newAddr, newAddr]]),
    ).rejects.toMatchObject({ code: "tx/cas-conflict" });
    expect((await conn.db().entity(u))![":user/address"]).toBe(oldAddr);

    await conn.transact([
      [":db/retractEntity", oldAddr],
      [":db/cas", u, ":user/address", oldAddr, newAddr],
    ]);
    expect((await conn.db().entity(u))![":user/address"]).toBe(newAddr);
    expect(await conn.db().entity(oldAddr)).toBeUndefined();
  });

  test("TxError from CAS is still a TxError", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/age": 1 }]);
    await expect(conn.transact([[":db/cas", r1.tempids.u, ":user/age", 9, 2]])).rejects.toBeInstanceOf(
      TxError,
    );
  });
});
