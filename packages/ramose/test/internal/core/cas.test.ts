import { describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";
import { TxError } from "../../../src/internal/core/tx.ts";

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

  test("absent expected (null) on an existing entity without the attr", async () => {
    const conn = await setup();
    const named = await conn.transact([{ ":db/id": "v", ":user/name": "V" }]);
    const v = named.tempids.v;
    await conn.transact([[":db/cas", v, ":user/age", null, 11]]);
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

  test("lookup-ref subject must exist in db-before, not only via a same-tx add", async () => {
    const conn = await setup();
    await expect(
      conn.transact([
        { ":db/id": "u", ":user/email": "fresh@x", ":user/name": "N" },
        [":db/cas", [":user/email", "fresh@x"], ":user/age", null, 1],
      ]),
    ).rejects.toMatchObject({ code: "tx/lookup-ref" });
    expect(await conn.db().entid([":user/email", "fresh@x"])).toBeUndefined();
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

  test("ref-typed card-one: nested map replacement, ident replacement, expected vs db-before", async () => {
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

  test("same-tx retractEntity of other entity then CAS expected=old component ref", async () => {
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

  test("replacement ref may be a tempid created by an add in the same tx", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A" }]);
    const u = r1.tempids.u;
    const r2 = await conn.transact([
      { ":db/id": "addr", ":address/city": "Oslo" },
      [":db/cas", u, ":user/address", null, "addr"],
    ]);
    const addr = r2.tempids.addr;
    expect(typeof addr).toBe("number");
    expect((await conn.db().entity(u))![":user/address"]).toBe(addr);
    expect((await conn.db().entity(addr))![":address/city"]).toBe("Oslo");
  });

  test("tempid subject is tx/invalid and allocates no entity", async () => {
    const conn = await setup();
    const next = conn.nextEntityId;
    const t = conn.t;
    await expect(conn.transact([[":db/cas", "new", ":user/age", null, 10]])).rejects.toMatchObject({
      code: "tx/invalid",
    });
    expect(conn.nextEntityId).toBe(next);
    expect(conn.t).toBe(t);
    expect(await conn.db().entid([":user/email", "nobody@x"])).toBeUndefined();
  });

  test("undefined expected is tx/invalid (not the absent encoding)", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A" }]);
    const u = r1.tempids.u;
    await expect(conn.transact([[":db/cas", u, ":user/age", undefined, 11]])).rejects.toMatchObject({
      code: "tx/invalid",
    });
    expect((await conn.db().entity(u))![":user/age"]).toBeUndefined();
  });

  test("two CAS on the same (e, a) is tx/invalid and commits nothing", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    const t = conn.t;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/cas", u, ":user/age", 30, 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect(conn.t).toBe(t);
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("CAS + add / retract / update on the same (e, a) is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/add", u, ":user/age", 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    await expect(
      conn.transact([
        [":db/add", u, ":user/age", 32],
        [":db/cas", u, ":user/age", 30, 33],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/retract", u, ":user/age", 30],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/update", u, ":user/age", 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("retractEntity of the CAS subject is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/retractEntity", u],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect(await conn.db().entity(u)).toBeDefined();
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("ref CAS then retractEntity of the replacement is tx/invalid (either order)", async () => {
    const conn = await setup();
    const r1 = await conn.transact([
      { ":db/id": "u", ":user/name": "A", ":user/address": { ":db/id": "old", ":address/city": "Paris" } },
    ]);
    const u = r1.tempids.u;
    const oldAddr = r1.tempids.old;
    const created = await conn.transact([{ ":db/id": "new", ":address/city": "Oslo" }]);
    const newAddr = created.tempids.new;
    const t = conn.t;

    await expect(
      conn.transact([
        [":db/cas", u, ":user/address", oldAddr, newAddr],
        [":db/retractEntity", newAddr],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect(conn.t).toBe(t);
    expect((await conn.db().entity(u))![":user/address"]).toBe(oldAddr);
    expect(await conn.db().entity(newAddr)).toBeDefined();

    await expect(
      conn.transact([
        [":db/retractEntity", newAddr],
        [":db/cas", u, ":user/address", oldAddr, newAddr],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect(conn.t).toBe(t);
    expect((await conn.db().entity(u))![":user/address"]).toBe(oldAddr);
    expect(await conn.db().entity(newAddr)).toBeDefined();
  });

  test("same-tx tempid replacement then retractEntity of that tempid is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A" }]);
    const u = r1.tempids.u;
    const t = conn.t;
    await expect(
      conn.transact([
        { ":db/id": "addr", ":address/city": "Oslo" },
        [":db/cas", u, ":user/address", null, "addr"],
        [":db/retractEntity", "addr"],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect(conn.t).toBe(t);
    expect((await conn.db().entity(u))![":user/address"]).toBeUndefined();
  });

  test("numeric CAS subject equal to a same-tx allocation is tx/missing-entity", async () => {
    const conn = await setup();
    const allocated = conn.nextEntityId;
    const t = conn.t;
    await expect(
      conn.transact([
        { ":db/id": "x", ":user/name": "X" },
        [":db/cas", allocated, ":user/age", null, 1],
      ]),
    ).rejects.toMatchObject({ code: "tx/missing-entity" });
    expect(conn.t).toBe(t);
    expect(await conn.db().entity(allocated)).toBeUndefined();
  });

  test("unrelated CAS does not block a same-tx lookup-ref update", async () => {
    const conn = await setup();
    const existing = await conn.transact([{ ":db/id": "u", ":user/name": "U", ":user/age": 1 }]);
    const u = existing.tempids.u;
    const r = await conn.transact([
      { ":db/id": "x", ":user/email": "n@x", ":user/name": "N" },
      [":db/update", [":user/email", "n@x"], ":user/age", 5],
      [":db/cas", u, ":user/age", 1, 2],
    ]);
    expect((await conn.db().entity(u))![":user/age"]).toBe(2);
    const x = r.tempids.x;
    expect((await conn.db().entity(x))![":user/email"]).toBe("n@x");
    expect((await conn.db().entity(x))![":user/age"]).toBe(5);
  });

  test("same-pair via a db-before lookup ref is still tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([
      { ":db/id": "u", ":user/email": "a@x", ":user/name": "A", ":user/age": 30 },
    ]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/update", [":user/email", "a@x"], ":user/age", 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    expect((await conn.db().entity(u))![":user/age"]).toBe(30);
  });

  test("CAS then same-tx unique add then update of the CAS attr via the new lookup is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/add", u, ":user/email", "n2@x"],
        [":db/update", [":user/email", "n2@x"], ":user/age", 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    const row = await conn.db().entity(u);
    expect(row![":user/age"]).toBe(30);
    expect(row![":user/email"]).toBeUndefined();
  });

  test("CAS then same-tx unique add then add of the CAS attr via the new lookup is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/add", u, ":user/email", "n2@x"],
        [":db/add", [":user/email", "n2@x"], ":user/age", 32],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    const row = await conn.db().entity(u);
    expect(row![":user/age"]).toBe(30);
    expect(row![":user/email"]).toBeUndefined();
  });

  test("CAS then same-tx unique add then retract of the CAS attr via the new lookup is tx/invalid", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await expect(
      conn.transact([
        [":db/cas", u, ":user/age", 30, 31],
        [":db/add", u, ":user/email", "n2@x"],
        [":db/retract", [":user/email", "n2@x"], ":user/age"],
      ]),
    ).rejects.toMatchObject({ code: "tx/invalid" });
    const row = await conn.db().entity(u);
    expect(row![":user/age"]).toBe(30);
    expect(row![":user/email"]).toBeUndefined();
  });

  test("malformed CAS lookup subjects are TxError, not a raw Error", async () => {
    const conn = await setup();
    const t = conn.t;
    const subjects = [
      [":nope/attr", "x"],
      [":user/name", "A"],
      [":user/tags", "x"],
      [":user/email", 99],
    ] as const;
    for (const subject of subjects) {
      let err: unknown;
      try {
        await conn.transact([[":db/cas", subject, ":user/age", null, 1]]);
        throw new Error("expected transact to reject");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TxError);
      expect(typeof (err as TxError).code).toBe("string");
      expect((err as TxError).code.startsWith("tx/")).toBe(true);
    }
    expect(conn.t).toBe(t);
  });

  test("two CAS on different attrs of the same entity is OK", async () => {
    const conn = await setup();
    const r1 = await conn.transact([{ ":db/id": "u", ":user/name": "A", ":user/age": 30 }]);
    const u = r1.tempids.u;
    await conn.transact([
      [":db/cas", u, ":user/age", 30, 31],
      [":db/cas", u, ":user/name", "A", "B"],
    ]);
    const row = await conn.db().entity(u);
    expect(row![":user/age"]).toBe(31);
    expect(row![":user/name"]).toBe("B");
  });
});
