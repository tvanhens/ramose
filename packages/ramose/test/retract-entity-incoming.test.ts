/**
 * Incoming-ref deletion contract (#276): declared cascade only (`owned`);
 * survivors' pointers clear when absence is schema-legal; required card-one
 * incoming refs reject unless the referrer is itself deleted in the same tx.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Connection } from "../src/internal/core/conn.ts";
import {
  Entity,
  Field,
  Ref,
  Schema as DbSchema,
  txBuilder,
  txOps,
} from "../src/db/internal.ts";
import { schemaTx } from "../src/db/ensure.ts";

const Part = Entity("part", {
  label: Field(Schema.String),
});
const Item = Entity("item", {
  name: Field.unique(Schema.String, "upsert"),
  part: Field.owned(Ref(Part), { optional: true }),
});
const Note = Entity("note", {
  title: Field(Schema.String),
  item: Field(Ref(Item), { optional: true }),
});
const Tag = Entity("tag", {
  name: Field(Schema.String),
  items: Field.many(Ref(Item)),
});
const Hold = Entity("hold", {
  title: Field(Schema.String),
  item: Field(Ref(Item)),
});
const Catalog = DbSchema({
  part: Part,
  item: Item,
  note: Note,
  tag: Tag,
  hold: Hold,
});

const setup = async () => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(Catalog) as unknown[]);
  return conn;
};

const catalogTx = () => txBuilder(Catalog);

const seedItem = (tx: ReturnType<typeof catalogTx>, name: string) => {
  const item = Effect.runSync(tx.entity());
  Effect.runSync(tx.put(Item, item, { name }));
  return item;
};

describe("retractEntity incoming-ref contract", () => {
  test("owned cascade deletes the referenced child", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "owned");
    const part = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Part, part, { label: "child" }));
    Effect.runSync(tx.update(Item, item, { part }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const itemEid = tempids["tmp-1"]!;
    const partEid = tempids["tmp-2"]!;

    await conn.transact([[":db/retractEntity", itemEid]]);
    expect(await conn.db().entity(itemEid)).toBeUndefined();
    expect(await conn.db().entity(partEid)).toBeUndefined();
  });

  test("optional incoming ref clears on the survivor", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "optional");
    const note = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Note, note, { title: "memo", item }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const itemEid = tempids["tmp-1"]!;
    const noteEid = tempids["tmp-2"]!;

    await conn.transact([[":db/retractEntity", itemEid]]);
    expect(await conn.db().entity(itemEid)).toBeUndefined();
    const row = await conn.db().entity(noteEid);
    expect(row?.[":note/title"]).toBe("memo");
    expect(row?.[":note/item"]).toBeUndefined();
  });

  test("card-many incoming ref drops the deleted member", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "many");
    const tag = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Tag, tag, { name: "watch", items: [item] }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const itemEid = tempids["tmp-1"]!;
    const tagEid = tempids["tmp-2"]!;

    await conn.transact([[":db/retractEntity", itemEid]]);
    expect(await conn.db().entity(itemEid)).toBeUndefined();
    const row = await conn.db().entity(tagEid);
    expect(row?.[":tag/name"]).toBe("watch");
    expect(row?.[":tag/items"]).toBeUndefined();
  });

  test("required card-one incoming ref rejects and names the survivor", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "required");
    const hold = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Hold, hold, { title: "lock", item }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const itemEid = tempids["tmp-1"]!;
    const holdEid = tempids["tmp-2"]!;

    await expect(conn.transact([[":db/retractEntity", itemEid]])).rejects.toMatchObject({
      code: "tx/required",
      message: `entity ${holdEid} still references the deleted entity via required :hold/item — delete or re-point it first`,
    });
    expect((await conn.db().entity(itemEid))?.[":item/name"]).toBe("required");
    expect((await conn.db().entity(holdEid))?.[":hold/item"]).toBe(itemEid);
  });

  test("same-tx referrer deletion passes", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "together");
    const hold = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Hold, hold, { title: "lock", item }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const itemEid = tempids["tmp-1"]!;
    const holdEid = tempids["tmp-2"]!;

    await conn.transact([
      [":db/retractEntity", itemEid],
      [":db/retractEntity", holdEid],
    ]);
    expect(await conn.db().entity(itemEid)).toBeUndefined();
    expect(await conn.db().entity(holdEid)).toBeUndefined();
  });

  test("an explicit retract of a required field keeps the bare message", async () => {
    const conn = await setup();
    const tx = catalogTx();
    const item = seedItem(tx, "bare");
    const hold = Effect.runSync(tx.entity());
    Effect.runSync(tx.put(Hold, hold, { title: "lock", item }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const holdEid = tempids["tmp-2"]!;

    await expect(
      conn.transact([[":db/retract", holdEid, ":hold/item"]]),
    ).rejects.toMatchObject({
      code: "tx/required",
      message: "cannot clear required field :hold/item",
    });
  });
});
