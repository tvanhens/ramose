import { fromJson, toJson } from "../../../src/internal/core/json.ts";
import { expect, test } from "bun:test";
import { Entity, Schema, ref, string, float, timestamp, bytes } from "../../../src/db/index.ts";
import { schemaTx } from "../../../src/db/internal.ts";
import { lowerQueryObject } from "../../../src/db/query/index.ts";
import { Connection } from "../../../src/internal/core/conn.ts";
import { restoreEngineTypeAssertions } from "../../../src/internal/core/tx-provenance.ts";
import { readQueryView } from "../../../src/internal/authorization/query-view.ts";
import { clientQueryFrom } from "../../../src/client/query.ts";
import { compositionFromSchema } from "../../../src/db/composition.ts";

const Person = Entity("viewPerson", { name: string() });
const Item = Entity("viewItem", { title: string(), rank: float(), at: timestamp(), payload: bytes(), owner: ref(Person) });
const App = Schema("query-view", { viewPerson: Person, viewItem: Item });

test("the normal query compiler reads a snapshot with opaque identities, nested references, ordering and cursors", async () => {
  const connection = await Connection.create({ composition: compositionFromSchema(App) });
  await connection.transact(schemaTx(App));
  const seed = [
    { ":db/id": "person", ":ramose/type": ":viewPerson", ":viewPerson/name": "Ada" },
    { ":db/id": "one", ":ramose/type": ":viewItem", ":viewItem/title": "One", ":viewItem/rank": -1, ":viewItem/at": new Date(1000), ":viewItem/payload": new Uint8Array([1, 2]), ":viewItem/owner": "person" },
    { ":db/id": "two", ":ramose/type": ":viewItem", ":viewItem/title": "Two", ":viewItem/rank": 2, ":viewItem/at": new Date(2000), ":viewItem/payload": new Uint8Array([3, 4]), ":viewItem/owner": "person" },
  ];
  restoreEngineTypeAssertions(seed);
  const report = await connection.transact(seed);
  const snapshot = connection.db();
  const handles = new Map([[report.tempids.person!, "person-handle"], [report.tempids.one!, "one-handle"], [report.tempids.two!, "two-handle"]]);
  const run = async (input: Parameters<typeof lowerQueryObject>[0]) => {
    let identities: readonly number[] = [];
    const lowered = lowerQueryObject(input, { entity: (id) => handles.get(identities[id - 1]!) });
    const response = await readQueryView(snapshot, lowered.query, 100_000);
    identities = response.entities;
    return lowered.finalize(fromJson(JSON.parse(JSON.stringify(toJson(response.result)))));
  };
  const all = await run(clientQueryFrom(Item).orderBy(Item.rank)) as any[];
  expect(all.map((row) => row.id)).toEqual(["one-handle", "two-handle"]);
  expect(all[0].rank).toBe(-1);
  expect(all[0].at).toEqual(new Date(1000));
  expect(all[0].payload).toEqual(new Uint8Array([1, 2]));
  expect(all[0].owner.id).toBe("person-handle");
  const page = await run(clientQueryFrom(Item).orderBy(Item.rank).limit(1).after(null)) as any;
  expect(page.rows).toHaveLength(1);
  expect(page.cursor.keys).toContain("one-handle");
  const ids = await run(clientQueryFrom(Item).orderBy(Item.rank).ids());
  expect(ids).toEqual([{ id: "one-handle" }, { id: "two-handle" }]);
});

test("query execution preserves references through bindings, dynamic attributes, functions, rules and aggregates", async () => {
  const connection = await Connection.create();
  await connection.transact([
    { ":db/id": "label", ":db/ident": ":thing/label", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/id": "ref", ":db/ident": ":thing/ref", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    { ":db/id": "number", ":db/ident": ":thing/number", ":db/valueType": ":db.type/long", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
  ]);
  const tx = await connection.transact([
    { ":db/id": "a", ":thing/label": "A", ":thing/number": 7 },
    { ":db/id": "b", ":thing/label": "B", ":thing/ref": "a" },
  ]);
  const a = tx.tempids.a!;
  const run = (raw: Record<string, unknown>) => readQueryView(connection.db(), raw, 100_000);
  const dynamic = await run({ find: ["?v"], where: [["?e", "?attr", "?v"], ["?attr", ":db/ident", ":thing/ref"]] });
  expect(dynamic.entities).toEqual([a]);
  expect(dynamic.result).toEqual([[1]]);
  const identity = await run({ find: ["?copy", "?number"], where: [["?e", ":thing/label", "A"], [["identity", "?e"], "?copy"], [["+", "?e", 1], "?number"]] });
  expect(identity.entities).toEqual([a]);
  expect(identity.result).toEqual([[1, a + 1]]);
  const bound = await run({ find: ["?e"], where: [[["ground", a], "?e"], ["?e", ":thing/label", "A"]] });
  expect(bound.entities).toEqual([a]);
  const getElse = await run({ find: ["?target"], where: [["?e", ":thing/label", "B"], [["get-else", "$", "?e", ":thing/ref", null], "?target"]] });
  expect(getElse.entities).toEqual([a]);
  const aggregate = await run({ find: [["min", "?e"], ["count", "?e"]], where: [["?e", ":thing/label", "?label"]] });
  expect(aggregate.result).toEqual([[1, 2]]);
  expect(aggregate.entities).toEqual([a]);
  const mixed = await run({ find: ["?v"], where: [["or-join", ["?v"], ["?e", ":thing/ref", "?v"], ["?e", ":thing/number", "?v"]]] });
  expect(mixed.entities).toEqual([a]);
  expect(mixed.result).toEqual([[1], [7]]);
  const ruled = await run({ find: ["?v"], where: [["target", "?v"]], rules: [[["target", "?v"], ["?e", ":thing/ref", "?v"]]] });
  expect(ruled.entities).toEqual([a]);
  const nested = await run({ find: ["?v"], where: [[["q", { find: ["?e", "."], where: [["?e", ":thing/label", "A"]] }, "$"], "?v"]] });
  expect(nested.entities).toEqual([a]);
  const keys = await run({ find: ["?e"], keys: ["entity"], where: [["?e", ":thing/label", "A"]] });
  expect(keys.result).toEqual([{ entity: 1 }]);
});
