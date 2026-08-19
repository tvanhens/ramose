import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag } from "../../../src/internal/core/datom.ts";
import { TxError } from "../../../src/internal/core/tx.ts";

const SCHEMA = [
  { ":db/ident": ":user/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/index": true },
  { ":db/ident": ":user/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  { ":db/ident": ":user/handle", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/value" },
  { ":db/ident": ":user/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":user/tags", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/friends", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":user/address", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/isComponent": true },
  { ":db/ident": ":address/city", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":user/joined", ":db/valueType": ":db.type/instant", ":db/cardinality": ":db.cardinality/one" },
  { ":db/ident": ":color/red" },
];

async function setup() {
  const conn = await Connection.create({ now: () => 1_700_000_000_000 });
  await conn.transact(SCHEMA);
  return conn;
}

describe("transact", () => {
  test("installs schema and exposes attributes", async () => {
    const conn = await setup();
    const db = conn.db();
    const name = db.attr(":user/name")!;
    expect(name.valueType).toBe(ValueTag.Str);
    expect(name.index).toBe(true);
    expect(db.attr(":user/friends")!.cardinality).toBe("many");
    expect(db.attr(":user/email")!.unique).toBe("identity");
    expect(db.schema.entid(":color/red")).toBeGreaterThanOrEqual(1000);
    expect(db.attr(":color/red")).toBeUndefined(); // plain ident, not an attribute
    expect(conn.t).toBe(2);
  });

  test("map form with tempids, refs, nested components, reverse refs", async () => {
    const conn = await setup();
    const rep = await conn.transact([
      { ":db/id": "alice", ":user/name": "Alice", ":user/email": "a@x", ":user/tags": ["a", "b"], ":user/address": { ":address/city": "Berlin" } },
      { ":db/id": "bob", ":user/name": "Bob", ":user/friends": ["alice"], ":user/joined": new Date("2020-01-01T00:00:00Z") },
      { ":db/id": "carol", ":user/name": "Carol", ":user/_friends": ["bob"] },
    ]);
    const { alice, bob, carol } = rep.tempids;
    expect(alice).toBeGreaterThanOrEqual(1000);
    const db = conn.db();
    const a = await db.entity(alice);
    expect(a![":user/name"]).toBe("Alice");
    expect((a![":user/tags"] as string[]).sort()).toEqual(["a", "b"]);
    const addr = a![":user/address"] as number;
    expect((await db.entity(addr))![":address/city"]).toBe("Berlin");
    const b = await db.entity(bob);
    expect(b![":user/friends"]).toEqual([alice, carol].sort((x, y) => x - y));
    expect((b![":user/joined"] as Date).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    // tx entity has txInstant
    const tx = await db.entity(rep.txEid);
    expect((tx![":db/txInstant"] as Date).getTime()).toBe(1_700_000_000_000);
    expect(rep.txData[0].a).toBe(50);
  });

  test("cardinality-one replaces (implicit retract), redundant asserts elided", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const r2 = await conn.transact([[":db/add", u, ":user/age", 31]]);
    const ops = r2.txData.filter((d) => d.a === conn.db().attr(":user/age")!.id).map((d) => [d.v, d.op]);
    expect(ops).toEqual([[30, false], [31, true]]);
    const r3 = await conn.transact([[":db/add", u, ":user/age", 31]]);
    expect(r3.txData.length).toBe(1); // only txInstant
    expect((await conn.db().entity(u))![":user/age"]).toBe(31);
    // history shows both values
    const hist = await conn.db().history().datomsArray(Index.EAVT, { e: u, a: conn.db().attr(":user/age")!.id });
    expect(hist.map((d) => [d.v, d.op])).toEqual([[30, true], [30, false], [31, true]]);
    // as-of sees the old value
    expect((await conn.db().asOf(r1.t).entity(u))![":user/age"]).toBe(30);
  });

  test("unique identity upserts; unique value conflicts throw", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/email": "a@x", ":user/name": "A", ":user/handle": "aa" }]);
    const u = r1.tempids.u;
    const r2 = await conn.transact([{ ":db/id": "again", ":user/email": "a@x", ":user/age": 5 }]);
    expect(r2.tempids.again).toBe(u);
    expect((await conn.db().entity(u))![":user/age"]).toBe(5);
    await expect(conn.transact([{ ":user/name": "B", ":user/handle": "aa" }])).rejects.toBeInstanceOf(TxError);
    await expect(conn.transact([{ ":user/name": "B", ":user/email": "b@x" }, { ":user/name": "C", ":user/email": "b@x", ":user/age": 1 }])).resolves.toBeDefined();
    // moving a unique value between entities within one tx via retract works
    const rb = await conn.transact([{ ":db/id": "b", ":user/email": "b@x" }]);
    const b = rb.tempids.b;
    await expect(conn.transact([[":db/add", u, ":user/handle", "aa"], [":db/add", b, ":user/handle", "aa"]])).rejects.toBeInstanceOf(TxError);
    await conn.transact([[":db/retract", u, ":user/handle", "aa"], [":db/add", b, ":user/handle", "aa"]]);
    expect((await conn.db().entity(b))![":user/handle"]).toBe("aa");
    expect((await conn.db().entity(u))![":user/handle"]).toBeUndefined();
  });

  test("lookup refs and idents as entity/value forms", async () => {
    const conn = await setup();
    const r = await conn.transact([{ ":db/id": "u", ":user/email": "a@x", ":user/name": "A" }]);
    const u = r.tempids.u;
    await conn.transact([[":db/add", [":user/email", "a@x"], ":user/age", 9]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(9);
    expect(await conn.db().entid([":user/email", "a@x"])).toBe(u);
    expect(await conn.db().entid([":user/email", "nope"])).toBeUndefined();
    await expect(conn.transact([[":db/add", [":user/email", "nope"], ":user/age", 9]])).rejects.toBeInstanceOf(TxError);
    // ref to ident entity
    await conn.transact([{ ":db/ident": ":user/favorite", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one" }]);
    await conn.transact([[":db/add", u, ":user/favorite", ":color/red"]]);
    expect((await conn.db().entity(u))![":user/favorite"]).toBe(conn.db().schema.entid(":color/red"));
  });

  test("retract, retract-all, retractEntity (with components and incoming refs)", async () => {
    const conn = await setup();
    const r = await conn.transact([
      { ":db/id": "a", ":user/name": "A", ":user/tags": ["x", "y", "z"], ":user/address": { ":db/id": "addr", ":address/city": "Oslo" } },
      { ":db/id": "b", ":user/name": "B", ":user/friends": ["a"] },
    ]);
    const { a, b, addr } = r.tempids;
    await conn.transact([[":db/retract", a, ":user/tags", "x"]]);
    expect(((await conn.db().entity(a))![":user/tags"] as string[]).sort()).toEqual(["y", "z"]);
    const rr = await conn.transact([[":db/retract", a, ":user/tags", "nope"]]);
    expect(rr.txData.length).toBe(1);
    await conn.transact([[":db/retract", a, ":user/tags"]]);
    expect((await conn.db().entity(a))![":user/tags"]).toBeUndefined();
    await conn.transact([[":db/retractEntity", a]]);
    expect(await conn.db().entity(a)).toBeUndefined();
    expect(await conn.db().entity(addr)).toBeUndefined(); // component
    expect((await conn.db().entity(b))![":user/friends"]).toBeUndefined(); // incoming ref removed
    // history still has everything
    expect((await conn.db().history().datomsArray(Index.EAVT, { e: a })).length).toBeGreaterThan(0);
  });

  test("validation errors", async () => {
    const conn = await setup();
    await expect(conn.transact([[":db/add", "x", ":nope/attr", 1]])).rejects.toThrow(/unknown attribute/);
    await expect(conn.transact([[":db/add", "x", ":user/age", "notanumber"]])).rejects.toThrow(/user\/age/);
    await expect(conn.transact([{ ":db/ident": ":bad", ":db/valueType": ":db.type/nope", ":db/cardinality": ":db.cardinality/one" }])).rejects.toThrow(/valueType/);
    await expect(conn.transact([[":db/frob", 1, 2, 3]])).rejects.toThrow(/unknown tx op/);
    await expect(conn.transact([[":db/add", "x", ":user/friends", "danglingtempid"]])).resolves.toBeDefined(); // tempid as ref allocates
  });

  test("concurrent transacts are serialized with monotonic t and no id reuse", async () => {
    const conn = await setup();
    const reps = await Promise.all(Array.from({ length: 50 }, (_, i) => conn.transact([{ ":user/name": "n" + i, ":user/age": i }])));
    const ts = reps.map((r) => r.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBe(ts[i - 1] + 1);
    const ids = new Set(reps.flatMap((r) => Object.values(r.tempids)));
    expect(ids.size).toBe(50);
    expect(conn.t).toBe(2 + 50);
  });

  test("index() merges novelty into trees; snapshots stay stable; as-of via old roots", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 1 }]);
    const u = r1.tempids.u;
    const dbBefore = conn.db();
    const roots1 = await conn.index();
    expect(conn.noveltyCount).toBe(0);
    expect(roots1.t).toBe(conn.t);
    await conn.transact([[":db/add", u, ":user/age", 2]]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(2);
    expect((await dbBefore.entity(u))![":user/age"]).toBe(1); // old snapshot unaffected
    const roots2 = await conn.index();
    expect(roots2.eavt.hash).not.toBe(roots1.eavt.hash);
    expect((await conn.db().entity(u))![":user/age"]).toBe(2);
    expect((await conn.dbAtRoot(roots1).entity(u))![":user/age"]).toBe(1);
    expect((await conn.db().asOf(roots1.t).entity(u))![":user/age"]).toBe(1);
    // schema survives restore from roots
    const restored = await Connection.restore(conn.store, roots2, [], conn.nextEntityId);
    expect(restored.db().attr(":user/friends")!.cardinality).toBe("many");
    expect((await restored.db().entity(u))![":user/age"]).toBe(2);
    const r3 = await restored.transact([{ ":user/name": "new" }]);
    expect(Object.values(r3.tempids)[0]).toBeGreaterThan(u);
  });
});
