/**
 * Traits: composition, install metadata, create-time membership, and
 * required-field validation (issue #316).
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Connection } from "../../src/internal/core/conn.ts";
import {
  Entity,
  Field,
  Schema,
  Trait,
  string,
  schemaTx,
  txBuilder,
  txOps,
} from "../../src/db/internal.ts";

const Taggable = Trait("taggable", {
  tag: string(),
});

const Soft = Trait("soft", {
  note: string({ optional: true }),
  tags: Field.many(string()),
});

const Timestamped = Trait("timestamped", {
  createdAt: string(),
});

const Annotated = Trait("annotated", {}, { traits: [Taggable, Timestamped] });

const Issue = Entity(
  "issue",
  { title: string() },
  { traits: [Taggable] },
);

const Note = Entity("note", { title: string() }, { traits: [Soft] });

const Diamond = Entity(
  "diamond",
  { title: string() },
  { traits: [Taggable, Annotated] },
);

const Board = Schema({ issue: Issue, note: Note, diamond: Diamond });

describe("Trait() / Entity() composition", () => {
  test("flattened fields keep the trait ident and the same object", () => {
    expect(Issue.tag).toBe(Taggable.tag);
    expect(Issue.tag.ident).toBe(":taggable/tag");
    expect(Issue.title.ident).toBe(":issue/title");
    expect(Issue.fields.tag).toBe(Taggable.tag);
    expect(Issue.traits).toEqual([Taggable]);
  });

  test("diamonds are idempotent", () => {
    expect(Diamond.tag).toBe(Taggable.tag);
    expect(Diamond.createdAt).toBe(Timestamped.createdAt);
    expect(Diamond.tag.ident).toBe(":taggable/tag");
    expect(new Set(Object.keys(Diamond.fields))).toEqual(
      new Set(["title", "tag", "createdAt"]),
    );
  });

  test("conflicting flattened names throw a named diagnostic", () => {
    const Other = Trait("labeled", { tag: string() });
    expect(() =>
      Entity("clash", { title: string() }, {
        // @ts-expect-error conflicting flattened field names
        traits: [Taggable, Other],
      }),
    ).toThrow(/conflicting field "tag" — :taggable\/tag vs :labeled\/tag/);
  });

  test("a trait cycle throws a named diagnostic", () => {
    const A = Trait("cycleA", { a: string() });
    const B = Trait("cycleB", { b: string() }, { traits: [A] });
    Object.assign(A, { traits: [B] });
    expect(() => Entity("loop", { title: string() }, { traits: [A] })).toThrow(
      /trait cycle: cycleA → cycleB → cycleA/,
    );
  });

  test("entity and trait names cannot collide in a schema", () => {
    const Ghost = Entity("taggable", { title: string() });
    expect(() => Schema({ taggable: Ghost, issue: Issue })).toThrow(
      /"taggable" is both an entity and a trait/,
    );
  });
});

describe("schemaTx composition metadata", () => {
  test("entity-only catalogs still emit only attribute maps", () => {
    const Todo = Entity("todo", { title: string() });
    expect(schemaTx(Schema({ todo: Todo }))).toEqual([
      {
        ":db/ident": ":todo/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
    ]);
  });

  test("installs trait fields once and records composition", () => {
    const tx = schemaTx(Board);
    expect(tx.filter((op) => ":db/valueType" in op)).toEqual([
      {
        ":db/ident": ":issue/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":taggable/tag",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":note/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":soft/note",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
        ":db/optional": true,
      },
      {
        ":db/ident": ":soft/tags",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/many",
      },
      {
        ":db/ident": ":diamond/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      {
        ":db/ident": ":timestamped/createdAt",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
    ]);
    expect(tx.filter((op) => ":ramose/kind" in op || ":ramose/composes" in op)).toEqual([
      { ":db/ident": ":annotated", ":ramose/kind": ":ramose.kind/trait" },
      { ":db/ident": ":annotated", ":ramose/composes": ":taggable" },
      { ":db/ident": ":annotated", ":ramose/composes": ":timestamped" },
      { ":db/ident": ":soft", ":ramose/kind": ":ramose.kind/trait" },
      { ":db/ident": ":taggable", ":ramose/kind": ":ramose.kind/trait" },
      { ":db/ident": ":timestamped", ":ramose/kind": ":ramose.kind/trait" },
      { ":db/ident": ":diamond", ":ramose/kind": ":ramose.kind/entity" },
      { ":db/ident": ":diamond", ":ramose/composes": ":annotated" },
      { ":db/ident": ":diamond", ":ramose/composes": ":taggable" },
      { ":db/ident": ":issue", ":ramose/kind": ":ramose.kind/entity" },
      { ":db/ident": ":issue", ":ramose/composes": ":taggable" },
      { ":db/ident": ":note", ":ramose/kind": ":ramose.kind/entity" },
      { ":db/ident": ":note", ":ramose/composes": ":soft" },
    ]);
  });
});

describe("typed create", () => {
  test("put stamps type and each transitive trait exactly once", () => {
    const tx = txBuilder(Board);
    Effect.runSync(
      tx.put(Issue, { title: "Fix login", tag: "urgent" }),
    );
    Effect.runSync(
      tx.put(Diamond, {
        title: "D",
        tag: "t",
        createdAt: "now",
      }),
    );
    expect(txOps(tx)).toEqual([
      {
        ":db/id": "tmp-1",
        ":issue/title": "Fix login",
        ":taggable/tag": "urgent",
        ":ramose/type": ":issue",
      },
      [":db/add", "tmp-1", ":ramose/trait", ":taggable"],
      {
        ":db/id": "tmp-2",
        ":diamond/title": "D",
        ":taggable/tag": "t",
        ":timestamped/createdAt": "now",
        ":ramose/type": ":diamond",
      },
      [":db/add", "tmp-2", ":ramose/trait", ":taggable"],
      [":db/add", "tmp-2", ":ramose/trait", ":timestamped"],
      [":db/add", "tmp-2", ":ramose/trait", ":annotated"],
    ]);
  });

  test("optional and card-many trait fields are omitted on create", () => {
    const tx = txBuilder(Board);
    Effect.runSync(tx.put(Note, { title: "n" }));
    expect(txOps(tx)).toEqual([
      {
        ":db/id": "tmp-1",
        ":note/title": "n",
        ":ramose/type": ":note",
      },
      [":db/add", "tmp-1", ":ramose/trait", ":soft"],
    ]);
  });
});

describe("processTx membership and required trait fields", () => {
  const setup = async () => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(Board) as unknown[]);
    return conn;
  };

  test("missing required trait field is tx/required", async () => {
    const conn = await setup();
    const tx = txBuilder(Board);
    Effect.runSync(tx.put(Issue, { title: "Fix login" } as never));
    await expect(conn.transact([...txOps(tx)])).rejects.toMatchObject({
      code: "tx/required",
    });
  });

  test("create stamps type and transitive traits once", async () => {
    const conn = await setup();
    const tx = txBuilder(Board);
    Effect.runSync(
      tx.put(Diamond, { title: "D", tag: "t", createdAt: "now" }),
    );
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":diamond/title"]).toBe("D");
    expect(row?.[":taggable/tag"]).toBe("t");
    expect(row?.[":timestamped/createdAt"]).toBe("now");
    expect(row?.[":ramose/type"]).toBe(":diamond");
    expect([...(row?.[":ramose/trait"] as string[])].sort()).toEqual([
      ":annotated",
      ":taggable",
      ":timestamped",
    ]);
  });

  test("a later write may set an optional trait field on the composer", async () => {
    const conn = await setup();
    const created = txBuilder(Board);
    Effect.runSync(created.put(Note, { title: "n" }));
    const { tempids } = await conn.transact([...txOps(created)]);
    const e = tempids["tmp-1"]!;
    await conn.transact([[":db/add", e, ":soft/note", "aside"]]);
    const row = await conn.db().entity(e);
    expect(row?.[":soft/note"]).toBe("aside");
  });

  test("optional and card-many trait fields may be omitted", async () => {
    const conn = await setup();
    const tx = txBuilder(Board);
    Effect.runSync(tx.put(Note, { title: "n" }));
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":note/title"]).toBe("n");
    expect(row?.[":ramose/type"]).toBe(":note");
    expect(row?.[":ramose/trait"]).toEqual([":soft"]);
    expect(row?.[":soft/note"]).toBeUndefined();
    expect(row?.[":soft/tags"]).toBeUndefined();
  });

  test("ordinary writes and retracts of membership facts are rejected", async () => {
    const conn = await setup();
    const created = txBuilder(Board);
    Effect.runSync(created.put(Issue, { title: "Fix", tag: "a" }));
    const { tempids } = await conn.transact([...txOps(created)]);
    const e = tempids["tmp-1"]!;

    await expect(
      conn.transact([[":db/add", e, ":ramose/trait", ":soft"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/retract", e, ":ramose/type", ":issue"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", e, ":ramose/type", ":note"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("existing entity-only schemas still create without membership facts", async () => {
    const Todo = Entity("todo", { title: string() });
    const Todos = Schema({ todo: Todo });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Todos) as unknown[]);
    const tx = txBuilder(Todos);
    Effect.runSync(tx.put(Todo, { title: "x" }));
    expect(txOps(tx)).toEqual([{ ":db/id": "tmp-1", ":todo/title": "x" }]);
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":todo/title"]).toBe("x");
    expect(row?.[":ramose/type"]).toBeUndefined();
    expect(row?.[":ramose/trait"]).toBeUndefined();
  });
});
