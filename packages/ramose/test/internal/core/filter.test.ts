import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index, ValueTag } from "../../../src/internal/core/datom.ts";
import { type DatomPredicate, Db } from "../../../src/internal/core/db.ts";
import { query } from "../../../src/internal/core/query/engine.ts";
import { pull } from "../../../src/internal/core/query/pull.ts";
import { DB_IDENT } from "../../../src/internal/core/schema.ts";

const SCHEMA = [
  { ":db/ident": ":person/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
  { ":db/ident": ":person/email", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
  { ":db/ident": ":person/age", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  { ":db/ident": ":person/friend", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
  { ":db/ident": ":person/secret", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
];

let conn: Connection;
let db: Db;
let ids: Record<string, number>;
let nameA: number;
let emailA: number;
let friendA: number;
let secretA: number;
let hiddenEid: number;
let visibleEid: number;

const sortRows = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

const hideEid =
  (eid: number): DatomPredicate =>
  (_u, d) =>
    d.e !== eid && !(d.vt === ValueTag.Ref && d.v === eid);

const hideAttr =
  (attrId: number): DatomPredicate =>
  (_u, d) =>
    d.a !== attrId;

beforeAll(async () => {
  conn = await Connection.create();
  await conn.transact(SCHEMA);
  const rep = await conn.transact([
    { ":db/id": "alice", ":person/name": "Alice", ":person/email": "alice@x", ":person/age": 30, ":person/friend": ["bob", "carol"], ":person/secret": "alice-secret" },
    { ":db/id": "bob", ":person/name": "Bob", ":person/email": "bob@x", ":person/age": 25, ":person/friend": ["alice"] },
    { ":db/id": "carol", ":person/name": "Carol", ":person/email": "carol@x", ":person/age": 35, ":person/friend": ["alice"], ":person/secret": "carol-secret" },
    { ":db/id": "dave", ":person/name": "Dave", ":person/email": "dave@x", ":person/age": 40 },
    { ":db/id": "eve", ":person/name": "Eve", ":person/email": "eve@x", ":person/age": 20 },
  ]);
  ids = rep.tempids;
  await conn.transact([
    { ":db/ident": ":x/hidden" },
    { ":db/ident": ":x/visible" },
  ]);
  db = conn.db();
  nameA = db.requireAttr(":person/name").id;
  emailA = db.requireAttr(":person/email").id;
  friendA = db.requireAttr(":person/friend").id;
  secretA = db.requireAttr(":person/secret").id;
  hiddenEid = (await db.entid(":x/hidden"))!;
  visibleEid = (await db.entid(":x/visible"))!;
});

describe("visibility", () => {
  test("query contains only accepted datoms", async () => {
    const filtered = db.filter(hideEid(ids.carol));
    const names = await query(filtered, `[:find [?n ...] :where [?e :person/name ?n]]`);
    expect((names as string[]).sort()).toEqual(["Alice", "Bob", "Dave", "Eve"]);
  });

  test("pull omits hidden attributes and hidden entities", async () => {
    const noSecret = db.filter(hideAttr(secretA));
    const alice = await pull(noSecret, ids.alice, `[:person/name :person/secret]`);
    expect(alice).toEqual({ ":person/name": "Alice" });

    const noCarol = db.filter(hideEid(ids.carol));
    expect(await pull(noCarol, ids.carol, `[*]`)).toBeNull();
  });

  test("nested and reverse refs omit hidden targets", async () => {
    const noCarol = db.filter(hideEid(ids.carol));
    const forward = await pull(noCarol, ids.alice, `[:person/name {:person/friend [:person/name]}]`);
    expect(forward).toEqual({
      ":person/name": "Alice",
      ":person/friend": [{ ":person/name": "Bob" }],
    });
    const reverse = await pull(noCarol, ids.alice, `[:person/name {:person/_friend [:person/name]}]`);
    expect(reverse).toEqual({
      ":person/name": "Alice",
      ":person/_friend": [{ ":person/name": "Bob" }],
    });
  });

  test("entity() omits hidden attributes; missing if all datoms hidden", async () => {
    const noSecret = db.filter(hideAttr(secretA));
    const alice = await noSecret.entity(ids.alice);
    expect(alice![":person/name"]).toBe("Alice");
    expect(alice![":person/secret"]).toBeUndefined();

    const noCarol = db.filter(hideEid(ids.carol));
    expect(await noCarol.entity(ids.carol)).toBeUndefined();
    expect(await noCarol.exists(ids.carol)).toBe(false);
  });

  test("lookup refs do not resolve a hidden unique datom", async () => {
    const hideCarolEmail: DatomPredicate = (_u, d) => !(d.a === emailA && d.v === "carol@x");
    const filtered = db.filter(hideCarolEmail);
    expect(await filtered.entid([":person/email", "carol@x"])).toBeUndefined();
    expect(await filtered.entid([":person/email", "alice@x"])).toBe(ids.alice);
    expect(await db.entid([":person/email", "carol@x"])).toBe(ids.carol);
  });
});

describe("hidden datoms cannot influence", () => {
  test("joins: hidden friendship edge does not produce a join row", async () => {
    const hideAliceBob: DatomPredicate = (_u, d) =>
      !(d.e === ids.alice && d.a === friendA && d.v === ids.bob);
    const filtered = db.filter(hideAliceBob);
    const rows = await query(
      filtered,
      `[:find ?n ?fn :where [?e :person/friend ?f] [?e :person/name ?n] [?f :person/name ?fn]]`,
    );
    expect(sortRows(rows)).toEqual(
      sortRows([
        ["Alice", "Carol"],
        ["Bob", "Alice"],
        ["Carol", "Alice"],
      ]),
    );
  });

  test("aggregation: (count ?e) does not count hidden entities", async () => {
    const filtered = db.filter((_u, d) => d.e !== ids.carol && d.e !== ids.dave);
    expect(await query(filtered, `[:find (count ?e) . :where [?e :person/name]]`)).toBe(3);
    expect(await query(db, `[:find (count ?e) . :where [?e :person/name]]`)).toBe(5);
  });

  test("negation: a hidden :person/secret does not make (not …) fail", async () => {
    const noSecret = db.filter(hideAttr(secretA));
    const names = await query(
      noSecret,
      `[:find [?n ...] :where [?e :person/name ?n] (not [?e :person/secret _])]`,
    );
    expect((names as string[]).sort()).toEqual(["Alice", "Bob", "Carol", "Dave", "Eve"]);
    const visible = await query(
      db,
      `[:find [?n ...] :where [?e :person/name ?n] (not [?e :person/secret _])]`,
    );
    expect((visible as string[]).sort()).toEqual(["Bob", "Dave", "Eve"]);
  });

  test("ordering / limiting counts visible entities only", async () => {
    const filtered = db.filter((_u, d) => d.e !== ids.carol && d.e !== ids.dave);
    const names = await query(filtered, {
      find: [["?n", "..."]],
      where: [["?e", ":person/name", "?n"]],
      order: [["?n"]],
      limit: 3,
    });
    expect(names).toEqual(["Alice", "Bob", "Eve"]);
  });

  test("nested pull reverse-ref collection omits hidden children", async () => {
    const noCarol = db.filter(hideEid(ids.carol));
    const r = await pull(noCarol, ids.alice, `[{:person/_friend [:person/name]}]`);
    expect(r).toEqual({ ":person/_friend": [{ ":person/name": "Bob" }] });
  });
});

describe("composition", () => {
  test("chained .filter(p1).filter(p2) is AND", async () => {
    const p1: DatomPredicate = (_u, d) => d.e === ids.alice || d.e === ids.bob;
    const p2: DatomPredicate = (_u, d) => d.e === ids.bob || d.e === ids.carol;
    const both = db.filter(p1).filter(p2);
    expect(await query(both, `[:find [?n ...] :where [?e :person/name ?n]]`)).toEqual(["Bob"]);
    expect(((await query(db.filter(p1), `[:find [?n ...] :where [?e :person/name ?n]]`)) as string[]).sort()).toEqual(["Alice", "Bob"]);
    expect(((await query(db.filter(p2), `[:find [?n ...] :where [?e :person/name ?n]]`)) as string[]).sort()).toEqual(["Bob", "Carol"]);
  });

  test("filter then asOf ≡ asOf then filter", async () => {
    const isolated = await Connection.create();
    await isolated.transact(SCHEMA);
    const seed = await isolated.transact([
      { ":db/id": "bob", ":person/name": "Bob", ":person/age": 25 },
    ]);
    const bob = seed.tempids.bob;
    const t0 = isolated.db().basisT;
    await isolated.transact([[":db/add", bob, ":person/age", 26]]);
    const live = isolated.db();
    const hideName: DatomPredicate = (_u, d) => d.a !== live.requireAttr(":person/name").id;
    const q = (view: Db) => query(view, `[:find ?a . :in $ ?e :where [?e :person/age ?a]]`, [bob]);
    const datomsOf = (view: Db) => view.datomsArray(Index.EAVT, { e: bob });
    const a = live.filter(hideName).asOf(t0);
    const b = live.asOf(t0).filter(hideName);
    expect(await q(a)).toBe(25);
    expect(await q(b)).toBe(25);
    expect(await datomsOf(a)).toEqual(await datomsOf(b));
    expect(await q(live)).toBe(26);
  });

  test("filter then history applies the predicate to history datoms", async () => {
    const isolated = await Connection.create();
    await isolated.transact(SCHEMA);
    const seed = await isolated.transact([
      { ":db/id": "bob", ":person/name": "Bob", ":person/age": 25 },
    ]);
    const bob = seed.tempids.bob;
    await isolated.transact([[":db/add", bob, ":person/age", 26]]);
    const hide25: DatomPredicate = (_u, d) => d.v !== 25;
    const live = isolated.db();
    const hist = live.filter(hide25).history();
    const also = live.history().filter(hide25);
    const q = (view: Db) => query(view, `[:find ?a ?op :in $ ?e :where [?e :person/age ?a _ ?op]]`, [bob]);
    expect(sortRows(await q(hist))).toEqual(sortRows([[26, true]]));
    expect(sortRows(await q(also))).toEqual(sortRows([[26, true]]));
    expect(sortRows(await q(live.history()))).toEqual(sortRows([[25, true], [25, false], [26, true]]));
  });

  test("predicate unfiltered argument has temporal coords and sees hidden datoms", async () => {
    const t = db.basisT;
    const asOfSeen: Db[] = [];
    await db
      .asOf(t)
      .filter((unfiltered, d) => {
        asOfSeen.push(unfiltered);
        return true;
      })
      .datomsArray(Index.EAVT, { e: ids.alice });
    expect(asOfSeen.length).toBeGreaterThan(0);
    expect(asOfSeen[0]!.asOfT).toBe(t);
    expect(asOfSeen[0]!.isHistory).toBe(false);
    expect(asOfSeen[0]!.filters).toEqual([]);
    expect(asOfSeen[0]!.basisT).toBe(db.basisT);

    const histSeen: Db[] = [];
    await db
      .history()
      .filter((unfiltered) => {
        histSeen.push(unfiltered);
        return true;
      })
      .datomsArray(Index.EAVT, { e: ids.alice });
    expect(histSeen[0]!.isHistory).toBe(true);
    expect(histSeen[0]!.filters).toEqual([]);

    let sawHidden = false;
    const hideCarol: DatomPredicate = async (unfiltered, d) => {
      if (d.e === ids.carol) {
        const raw = await unfiltered.entity(ids.carol);
        expect(raw![":person/name"]).toBe("Carol");
        sawHidden = true;
        return false;
      }
      return true;
    };
    expect(await db.filter(hideCarol).entity(ids.carol)).toBeUndefined();
    expect(sawHidden).toBe(true);
  });

  test("chained filters both receive an unfiltered db with the same coords", async () => {
    const seen: Db[] = [];
    const p1: DatomPredicate = (u) => {
      seen[0] = u;
      return true;
    };
    const p2: DatomPredicate = (u) => {
      seen[1] = u;
      return true;
    };
    const asOf = db.asOf(db.basisT);
    await asOf.filter(p1).filter(p2).datomsArray(Index.EAVT, { e: ids.alice });
    expect(seen[0]!.filters).toEqual([]);
    expect(seen[1]!.filters).toEqual([]);
    expect(seen[0]!.asOfT).toBe(db.basisT);
    expect(seen[1]!.asOfT).toBe(db.basisT);
    expect(seen[0]!.isHistory).toBe(false);
    expect(seen[1]!.isHistory).toBe(false);
    expect(seen[0]!.store).toBe(seen[1]!.store);
  });

  test("original db is unchanged after .filter()", async () => {
    const before = db.filters;
    const asOfT = db.asOfT;
    const filtered = db.filter(hideEid(ids.carol));
    expect(filtered).not.toBe(db);
    expect(db.filters).toBe(before);
    expect(db.filters).toEqual([]);
    expect(db.asOfT).toBe(asOfT);
    expect((await query(db, `[:find [?n ...] :where [?e :person/name ?n]]`) as string[]).sort()).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Dave",
      "Eve",
    ]);
  });
});

describe("index candidates, seekMany, estimate, async, immutability, schema", () => {
  test("counting predicate sees only index-selected candidates", async () => {
    const isolated = await Connection.create();
    await isolated.transact(SCHEMA);
    const seed = Array.from({ length: 50 }, (_, i) => ({
      ":db/id": `x${i}`,
      ":person/name": `n${i}`,
      ":person/email": `e${i}@x`,
      ":person/age": i,
    }));
    const seeded = await isolated.transact(seed);
    const eids = seed.map((_, i) => seeded.tempids[`x${i}`]!);
    const live = isolated.db();
    const total = (await live.datomsArray(Index.EAVT, {})).length;
    let seen = 0;
    const counting: DatomPredicate = (_u, _d) => {
      seen += 1;
      return true;
    };
    const one = eids[7]!;
    const got = await live.filter(counting).datomsArray(Index.EAVT, { e: one });
    expect(got.length).toBeGreaterThan(0);
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(total);
    expect(seen).toBe(got.length);
  });

  test("seekMany with a filter ≡ per-prefix datomsArray", async () => {
    const filtered = db.filter(hideEid(ids.carol));
    const prefixes = [
      { e: ids.alice },
      { e: ids.carol },
      { e: ids.bob, a: friendA },
      { e: ids.dave },
    ];
    const batched = await filtered.seekMany(Index.EAVT, prefixes);
    for (let i = 0; i < prefixes.length; i++) {
      expect(batched[i]).toEqual(await filtered.datomsArray(Index.EAVT, prefixes[i]!));
    }
    expect(batched[1]).toEqual([]);
  });

  test("estimate returns filtered count, not unfiltered size", async () => {
    const prefix = { a: nameA };
    const all = await db.datomsArray(Index.AEVT, prefix);
    expect(all.length).toBe(5);
    const filtered = db.filter((_u, d) => d.e !== ids.carol && d.e !== ids.dave);
    const visible = await filtered.datomsArray(Index.AEVT, prefix);
    expect(visible.length).toBe(3);
    expect(await filtered.estimate(Index.AEVT, prefix)).toBe(3);
    expect(await db.estimate(Index.AEVT, prefix)).toBeGreaterThanOrEqual(5);
  });

  test("async predicate works", async () => {
    const filtered = db.filter(async (_u, d) => {
      await Promise.resolve();
      return d.e !== ids.carol;
    });
    const names = await query(filtered, `[:find [?n ...] :where [?e :person/name ?n]]`);
    expect((names as string[]).sort()).toEqual(["Alice", "Bob", "Dave", "Eve"]);
  });

  test("filter is a new immutable Db sharing the store", async () => {
    const p: DatomPredicate = (_u, _d) => true;
    const filtered = db.filter(p);
    expect(filtered).not.toBe(db);
    expect(filtered.store).toBe(db.store);
    expect(filtered.filters).toHaveLength(1);
    expect(db.filters).toEqual([]);
    expect(db.asOfT).toBeUndefined();
    expect(filtered.asOfT).toBeUndefined();
    expect(filtered.basisT).toBe(db.basisT);
    expect(filtered.roots).toBe(db.roots);
    expect(filtered.novelty).toBe(db.novelty);
  });

  test("schema lookups still work on a filtered Db", async () => {
    const filtered = db.filter(hideEid(ids.carol));
    expect(filtered.attr(":person/name")?.ident).toBe(":person/name");
    expect(filtered.requireAttr(":person/friend").valueType).toBe(5);
    const names = await query(filtered, `[:find [?n ...] :where [?e :person/name ?n]]`);
    expect((names as string[]).sort()).toEqual(["Alice", "Bob", "Dave", "Eve"]);
  });

  test("constructor copies filters so later mutation of the input array is ignored", async () => {
    const hideCarol: DatomPredicate = (_u, d) => d.e !== ids.carol;
    const mutable: DatomPredicate[] = [hideCarol];
    const constructed = new Db({
      store: db.store,
      roots: db.roots,
      novelty: db.novelty,
      basisT: db.basisT,
      schema: db.schema,
      nextEid: db.nextEid,
      filters: mutable,
    });
    const namesOf = (view: Db) =>
      query(view, `[:find [?n ...] :where [?e :person/name ?n]]`) as Promise<string[]>;
    expect((await namesOf(constructed)).sort()).toEqual(["Alice", "Bob", "Dave", "Eve"]);
    mutable.push((_u, d) => d.e !== ids.alice);
    mutable.length = 0;
    expect(constructed.filters).not.toBe(mutable);
    expect(constructed.filters).toHaveLength(1);
    expect((await namesOf(constructed)).sort()).toEqual(["Alice", "Bob", "Dave", "Eve"]);
  });
});

describe("plain entity-ident resolution honors the filtered view", () => {
  test("unfiltered entid / identOf resolve a plain ident", async () => {
    expect(hiddenEid).toBeDefined();
    expect(await db.entid(":x/hidden")).toBe(hiddenEid);
    expect(await db.identOf(hiddenEid)).toBe(":x/hidden");
    expect(await db.entid(":x/visible")).toBe(visibleEid);
  });

  test("filter hiding :x/hidden ident datom hides entid and identOf", async () => {
    const filtered = db.filter((_u, d) => !(d.a === DB_IDENT && d.v === ":x/hidden"));
    expect(await filtered.entid(":x/hidden")).toBeUndefined();
    expect(await filtered.identOf(hiddenEid)).toBeUndefined();
    expect(await filtered.entid(":x/visible")).toBe(visibleEid);
    expect(filtered.attr(":person/name")?.ident).toBe(":person/name");
    expect(filtered.requireAttr(":person/friend").valueType).toBe(5);
    expect(db.schema.entid(":x/hidden")).toBe(hiddenEid);
  });

  test("query entity-ident constant is empty on the filtered db", async () => {
    const q = `[:find ?i :where [:x/hidden :db/ident ?i]]`;
    const filtered = db.filter((_u, d) => !(d.a === DB_IDENT && d.v === ":x/hidden"));
    expect(await query(db, q)).toEqual([[":x/hidden"]]);
    expect(await query(filtered, q)).toEqual([]);
  });

  test("hidden ident in attribute position is unknown, not an empty scan", async () => {
    const filtered = db.filter((_u, d) => !(d.a === DB_IDENT && d.v === ":x/hidden"));
    const qHidden = `[:find ?e :where [?e :x/hidden ?v]]`;
    const qMissing = `[:find ?e :where [?e :x/does-not-exist ?v]]`;
    expect(await query(db, qHidden)).toEqual([]);
    await expect(query(filtered, qHidden)).rejects.toThrow(/unknown attribute/);
    await expect(query(filtered, qMissing)).rejects.toThrow(/unknown attribute/);
    await expect(query(db, qMissing)).rejects.toThrow(/unknown attribute/);

    expect((await query(filtered, `[:find [?n ...] :where [?e :person/name ?n]]`) as string[]).sort()).toEqual([
      "Alice", "Bob", "Carol", "Dave", "Eve",
    ]);
  });
});
