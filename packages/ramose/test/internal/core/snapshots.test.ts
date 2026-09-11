import { makeCompositionIndex } from "../../../src/internal/core/composition.ts";
import { captureRevision, restoreRevision } from "../../../src/internal/core/revision.ts";
import { fromJson, toJson } from "../../../src/internal/core/json.ts";
import { expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";
import { Index } from "../../../src/internal/core/datom.ts";

test("database values survive independent fork writes, schema changes, and indexing", async () => {
  const live = await Connection.create();
  await live.transact([{ ":db/id": "name", ":db/ident": ":item/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" }]);
  const seed = await live.transact([{ ":db/id": "item", ":item/name": "original" }]);
  const id = seed.tempids.item!;
  const snapshot = live.db();
  const history = await snapshot.history().datomsArray(Index.EAVT, { e: id });
  const left = Connection.fromSnapshot(snapshot, live.store);
  const right = Connection.fromSnapshot(snapshot, live.store);
  await Promise.all([
    left.transact([[":db/add", id, ":item/name", "left"]]),
    right.transact([[":db/add", id, ":item/name", "right"]]),
    live.transact([[":db/add", id, ":item/name", "live"]]),
  ]);
  const leftSnapshot = left.db();
  await Promise.all([live.index(), left.index(), right.index()]);
  await left.transact([[":db/add", id, ":item/name", "later"]]);
  await live.transact([{ ":db/id": "extra", ":db/ident": ":item/extra", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" }]);
  expect((await snapshot.entity(id))?.[":item/name"]).toBe("original");
  expect((await leftSnapshot.entity(id))?.[":item/name"]).toBe("left");
  expect((await right.db().entity(id))?.[":item/name"]).toBe("right");
  expect((await live.db().entity(id))?.[":item/name"]).toBe("live");
  expect(snapshot.attr(":item/extra")).toBeUndefined();
  expect(await snapshot.history().datomsArray(Index.EAVT, { e: id })).toEqual(history);
});


test("serialized revisions restore their own composition and catalog identity", async () => {
  const composition = makeCompositionIndex({ entities: ["item"], traits: ["named"], entityTraits: [["item", ["named"]]] });
  const connection = await Connection.create({ composition });
  await connection.transact([{ ":db/id": "name", ":db/ident": ":item/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one" }]);
  const revision = captureRevision(connection, { key: "catalog", unitHash: "historical" });
  const wire = JSON.stringify(toJson(revision));
  const current = await Connection.create({ store: connection.store, composition: makeCompositionIndex({ entities: ["item"], traits: ["different"], entityTraits: [["item", ["different"]]] }) });
  const restored = await restoreRevision(current.store, fromJson(JSON.parse(wire)) as typeof revision);
  expect(restored.db().composition?.transitiveTraits(":item")).toEqual([":named"]);
  expect(current.db().composition?.transitiveTraits(":item")).toEqual([":different"]);
  expect(restored.db().attr(":item/name")?.valueType).toBe(connection.db().attr(":item/name")?.valueType);
  expect(JSON.parse(wire).catalog).toEqual({ key: "catalog", unitHash: "historical" });
  expect(captureRevision(restored).composition).toEqual(revision.composition);
});
