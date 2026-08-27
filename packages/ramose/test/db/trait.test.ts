/**
 * Traits: composition, install metadata, create-time membership, and
 * required-field validation (issue #316).
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Connection } from "../../src/internal/core/conn.ts";
import { pipe } from "effect/Function";
import {
  Entity,
  Field,
  Query,
  Schema,
  Trait,
  string,
  lowerQueryObject,
  schemaTx,
  txBuilder,
  txOps,
} from "../../src/db/internal.ts";
import { query as coreQuery } from "../../src/internal/core/index.ts";

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
  test("entity-only catalogs still emit type identity", () => {
    const Todo = Entity("todo", { title: string() });
    expect(schemaTx(Schema({ todo: Todo }))).toEqual([
      {
        ":db/ident": ":todo/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
      { ":db/ident": ":todo", ":ramose/kind": ":ramose.kind/entity" },
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
  test("put writes composer attrs and asserts the entity type", () => {
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
        ":ramose/type": ":issue",
        ":issue/title": "Fix login",
        ":taggable/tag": "urgent",
      },
      {
        ":db/id": "tmp-2",
        ":ramose/type": ":diamond",
        ":diamond/title": "D",
        ":taggable/tag": "t",
        ":timestamped/createdAt": "now",
      },
    ]);
  });

  test("optional and card-many trait fields are omitted on create", () => {
    const tx = txBuilder(Board);
    Effect.runSync(tx.put(Note, { title: "n" }));
    expect(txOps(tx)).toEqual([
      {
        ":db/id": "tmp-1",
        ":ramose/type": ":note",
        ":note/title": "n",
      },
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
      message: expect.stringContaining(
        "entity issue is missing required fields: :taggable/tag",
      ),
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

  test("forged membership facts are rejected without a prior type", async () => {
    const Todo = Entity("todo", { title: string() });
    const Mixed = Schema({
      issue: Issue,
      note: Note,
      diamond: Diamond,
      todo: Todo,
    });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Mixed) as unknown[]);

    await expect(
      conn.transact([[":db/add", "tmp-x", ":ramose/trait", ":taggable"]]),
    ).rejects.toMatchObject({ code: "tx/system" });

    const created = txBuilder(Mixed);
    Effect.runSync(created.put(Todo, { title: "x" }));
    const { tempids } = await conn.transact([...txOps(created)]);
    const todo = tempids["tmp-1"]!;
    await expect(
      conn.transact([[":db/add", todo, ":ramose/trait", ":taggable"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", todo, ":ramose/type", ":todo"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("Query.entities membership is the type fact, not a shared trait field", async () => {
    const Task = Entity("task", { title: string() }, { traits: [Taggable] });
    const Mixed = Schema({
      issue: Issue,
      note: Note,
      diamond: Diamond,
      task: Task,
    });
    const listing = Query.q(() =>
      pipe(Query.entities(Issue), Query.select({ id: Issue.id })),
    );
    const { query } = lowerQueryObject(listing);
    expect(query.where).toEqual([["isIssue", "?q0"]]);
    expect(query.rules).toEqual([
      [["isIssue", "?qm0"], ["?qm0", ":ramose/type", ":issue"]],
    ]);

    const conn = await Connection.create();
    await conn.transact(schemaTx(Mixed) as unknown[]);
    const tx = txBuilder(Mixed);
    Effect.runSync(tx.put(Issue, { title: "an issue", tag: "urgent" }));
    Effect.runSync(tx.put(Task, { title: "a task", tag: "urgent" }));
    await conn.transact([...txOps(tx)]);
    const tuples = (await coreQuery(conn.db(), query)) as readonly [
      { readonly id: number },
    ][];
    expect(tuples).toHaveLength(1);
    const issueRow = await conn.db().entity(tuples[0]![0]!.id);
    expect(issueRow?.[":issue/title"]).toBe("an issue");
    expect(issueRow?.[":task/title"]).toBeUndefined();
  });

  test("two composed entity namespaces on one id are tx/wrong-entity", async () => {
    const Task = Entity("task", { title: string() }, { traits: [Taggable] });
    const Mixed = Schema({ issue: Issue, task: Task });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Mixed) as unknown[]);

    await expect(
      conn.transact([
        { ":db/id": "tmp-1", ":issue/title": "a", ":task/title": "b" },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("cannot create an entity without a type"),
    });

    await expect(
      conn.transact([
        {
          ":db/id": "tmp-2",
          ":issue/title": "a",
          ":task/title": "b",
          ":taggable/tag": "urgent",
        },
      ]),
    ).rejects.toMatchObject({ code: "tx/wrong-entity" });
  });

  test("a write of only trait attributes is tx/wrong-entity", async () => {
    const Two = Trait("two", { a: string(), b: string() });
    const Doc = Entity("doc", { title: string() }, { traits: [Two] });
    const Catalog = Schema({ doc: Doc });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    await expect(
      conn.transact([{ ":db/id": "tmp-1", ":two/a": "x" }]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("cannot create an entity without a type"),
    });
  });

  test("typed put creates a composer that has no required own-namespace field", async () => {
    const SoftIssue = Entity(
      "issue",
      { title: string({ optional: true }) },
      { traits: [Taggable] },
    );
    const Bare = Entity("bare", {}, { traits: [Taggable] });
    const Catalog = Schema({ issue: SoftIssue, bare: Bare });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);

    const viaPut = txBuilder(Catalog);
    Effect.runSync(viaPut.put(SoftIssue, { tag: "t" }));
    Effect.runSync(viaPut.put(Bare, { tag: "u" }));
    expect(txOps(viaPut)).toEqual([
      { ":db/id": "tmp-1", ":ramose/type": ":issue", ":taggable/tag": "t" },
      { ":db/id": "tmp-2", ":ramose/type": ":bare", ":taggable/tag": "u" },
    ]);
    const { tempids } = await conn.transact([...txOps(viaPut)]);
    const issue = await conn.db().entity(tempids["tmp-1"]!);
    const bare = await conn.db().entity(tempids["tmp-2"]!);
    expect(issue).toMatchObject({
      ":ramose/type": ":issue",
      ":ramose/trait": [":taggable"],
      ":taggable/tag": "t",
    });
    expect(bare).toMatchObject({
      ":ramose/type": ":bare",
      ":ramose/trait": [":taggable"],
      ":taggable/tag": "u",
    });

    await expect(
      conn.transact([{ ":db/id": "tmp-raw", ":taggable/tag": "z" }]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("cannot create an entity without a type"),
    });
  });

  test("a foreign entity field on a typed create is tx/wrong-entity", async () => {
    const Todo = Entity("todo", { title: string(), body: string() });
    const Mixed = Schema({ issue: Issue, todo: Todo });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Mixed) as unknown[]);
    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
          ":ramose/type": ":issue",
          ":issue/title": "a",
          ":taggable/tag": "t",
          ":todo/title": "b",
        },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("is not a todo"),
    });
  });

  test("a foreign required trait attribute is tx/wrong-entity at create", async () => {
    const Two = Trait("two", { a: string(), b: string() });
    const Doc = Entity("doc", { title: string() }, { traits: [Two] });
    const Other = Entity("other", { title: string() }, { traits: [Taggable] });
    const Catalog = Schema({ doc: Doc, other: Other });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);

    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
          ":ramose/type": ":other",
          ":other/title": "x",
          ":taggable/tag": "t",
          ":two/a": "1",
        },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("is not a two"),
    });

    const created = await conn.transact([
      { ":db/id": "tmp-ok", ":ramose/type": ":other", ":other/title": "ok", ":taggable/tag": "t" },
    ]);
    const e = created.tempids["tmp-ok"]!;
    await expect(
      conn.transact([{ ":db/id": e, ":two/a": "1" }]),
    ).rejects.toMatchObject({ code: "tx/wrong-entity" });
    await expect(
      conn.transact([[":db/add", e, ":two/b", "2"]]),
    ).rejects.toMatchObject({ code: "tx/wrong-entity" });

    await expect(
      conn.transact([
        {
          ":db/id": "tmp-plain",
          ":ramose/type": ":other",
          ":other/title": "x",
          ":taggable/tag": "t",
          ":doc/title": "y",
        },
      ]),
    ).rejects.toMatchObject({ code: "tx/wrong-entity" });
  });

  test("a foreign optional-only trait attribute is tx/wrong-entity at create", async () => {
    const Solo = Trait("solo", { note: string({ optional: true }) });
    const Other = Entity("other", { title: string() }, { traits: [Taggable] });
    const Holder = Entity("holder", { title: string() }, { traits: [Solo] });
    const Catalog = Schema({ other: Other, holder: Holder });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
          ":ramose/type": ":other",
          ":other/title": "x",
          ":taggable/tag": "t",
          ":solo/note": "n",
        },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("is not a solo"),
    });
  });

  test("entity-only creates still stamp the engine-owned type", async () => {
    const Todo = Entity("todo", { title: string() });
    const Todos = Schema({ todo: Todo });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Todos) as unknown[]);
    const tx = txBuilder(Todos);
    Effect.runSync(tx.put(Todo, { title: "x" }));
    expect(txOps(tx)).toEqual([
      { ":db/id": "tmp-1", ":ramose/type": ":todo", ":todo/title": "x" },
    ]);
    const rep = await conn.transact([...txOps(tx)]);
    const row = await conn.db().entity(rep.tempids["tmp-1"]!);
    expect(row?.[":todo/title"]).toBe("x");
    expect(row?.[":ramose/type"]).toBe(":todo");
    expect(row?.[":ramose/trait"]).toBeUndefined();
  });

  test("occupied type composition cannot change", async () => {
    const conn = await setup();
    const created = txBuilder(Board);
    Effect.runSync(created.put(Issue, { title: "Fix", tag: "a" }));
    await conn.transact([...txOps(created)]);
    await expect(
      conn.transact([
        { ":db/ident": ":issue", ":ramose/composes": ":soft" },
      ]),
    ).rejects.toMatchObject({
      code: "tx/occupied",
      message: expect.stringContaining("cannot change trait composition of occupied type :issue"),
    });
  });
});
