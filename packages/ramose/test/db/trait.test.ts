/**
 * Traits: descriptor composition, deployed type-to-trait membership, and
 * required-field validation (issue #460).
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Connection } from "../../src/internal/core/conn.ts";
import { pipe } from "effect/Function";
import {
  Entity,
  Field,
  Query,
  Schema,
  Trait,
  type AnySchema,
  compositionFromSchema,
  string,
  lowerQueryObject,
  schemaTx,
  txBuilder,
  txOps,
} from "../../src/db/internal.ts";
import { documentationOf } from "../../src/db/documentation.ts";
import { query as coreQuery } from "../../src/internal/core/index.ts";
import { Index } from "../../src/internal/core/datom.ts";
import { restoreEngineTypeAssertions } from "../../src/internal/core/tx-provenance.ts";
import { compositionFromDescriptor } from "../../src/internal/authorization/index.ts";
import {
  App,
  catalogDescriptor,
} from "../internal/authorization/semantic-fixtures.ts";

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
  test("entity, trait, and defining field docs remain distinct through composition", () => {
    const Documented = Trait(
      "documented",
      { label: string({ doc: "The defining trait field." }) },
      { doc: "Reusable documented behavior." },
    );
    const Article = Entity(
      "article",
      { title: string({ doc: "The direct entity field." }) },
      { traits: [Documented], doc: "A publishable article." },
    );
    const UndocumentedArticle = Entity(
      "undocumentedArticle",
      { title: string() },
      { traits: [Documented] },
    );

    expect(documentationOf(Article)).toBe("A publishable article.");
    expect(documentationOf(Documented)).toBe("Reusable documented behavior.");
    expect(documentationOf(UndocumentedArticle)).toBeUndefined();
    expect(Article.label).toBe(Documented.label);
    expect(Article.label.doc).toBe("The defining trait field.");
    expect(Article.title.doc).toBe("The direct entity field.");
    expect(() =>
      Entity(
        "documentedOverride",
        { label: string({ doc: "Entity override." }) },
        {
          // @ts-expect-error composed fields cannot be overridden by an entity
          traits: [Documented],
        },
      )
    ).toThrow(/conflicting field "label"/);
    expect(documentationOf(Entity("blankDoc", {}, { doc: " \n\t" })))
      .toBeUndefined();
    expect(documentationOf(Trait("blankTraitDoc", {}, { doc: "" }))).toBeUndefined();

    const HasDocField = Trait(
      "hasDocField",
      { doc: string({ doc: "The application document body." }) },
      { doc: "Defines an application doc field." },
    );
    const Page = Entity(
      "page",
      {},
      { traits: [HasDocField], doc: "A documented page." },
    );
    expect(Page.doc).toBe(HasDocField.doc);
    expect(Page.doc.doc).toBe("The application document body.");
    expect(documentationOf(Page)).toBe("A documented page.");
    expect(documentationOf(HasDocField))
      .toBe("Defines an application doc field.");
  });

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

describe("schemaTx", () => {
  test("entity-only catalogs emit only attribute maps", () => {
    const Todo = Entity("todo", { title: string() }, { doc: "A todo entity." });
    expect(schemaTx(Schema({ todo: Todo }))).toEqual([
      {
        ":db/ident": ":todo/title",
        ":db/valueType": ":db.type/string",
        ":db/cardinality": ":db.cardinality/one",
      },
    ]);
  });

  test("installs trait fields once and does not emit kind, composes, or trait facts", () => {
    const tx = schemaTx(Board);
    expect(tx).toEqual([
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
    expect(tx.some((op) => ":ramose/kind" in op || ":ramose/composes" in op || ":ramose/trait" in op)).toBe(
      false,
    );
  });
});

describe("deployed type-to-trait lookup", () => {
  test("schema and catalog descriptor agree on direct, transitive, and diamond membership", () => {
    const fromSchema = compositionFromSchema(Board);
    expect(fromSchema.isEntityIdent(":issue")).toBe(true);
    expect(fromSchema.isEntityIdent(":diamond")).toBe(true);
    expect(fromSchema.isTraitIdent(":taggable")).toBe(true);
    expect(fromSchema.isTraitIdent(":annotated")).toBe(true);
    expect(fromSchema.transitiveTraits(":issue")).toEqual([":taggable"]);
    expect(fromSchema.transitiveTraits(":note")).toEqual([":soft"]);
    expect(fromSchema.transitiveTraits(":diamond")).toEqual([
      ":annotated",
      ":taggable",
      ":timestamped",
    ]);
    expect(fromSchema.transitiveTraits(":todo")).toEqual([]);

    const fromCatalog = Result.getOrThrow(compositionFromDescriptor(catalogDescriptor()));
    const fromApp = compositionFromSchema(App);
    expect(fromCatalog.transitiveTraits(":issue")).toEqual(fromApp.transitiveTraits(":issue"));
    expect(fromCatalog.isEntityIdent(":user")).toBe(true);
    expect(fromCatalog.isTraitIdent(":taggable")).toBe(true);
    expect(fromApp.transitiveTraits(":user")).toEqual([]);
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

  test("put stamps type on a traitless entity", () => {
    const Todo = Entity("todo", { title: string() });
    const Todos = Schema({ todo: Todo });
    const tx = txBuilder(Todos);
    Effect.runSync(tx.put(Todo, { title: "x" }));
    expect(txOps(tx)).toEqual([
      { ":db/id": "tmp-1", ":ramose/type": ":todo", ":todo/title": "x" },
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
  const setup = async (schema: AnySchema = Board) => {
    const conn = await Connection.create({
      composition: compositionFromSchema(schema),
    });
    await conn.transact(schemaTx(schema) as unknown[]);
    return conn;
  };

  const membershipOf = (type: string, schema: AnySchema = Board) =>
    compositionFromSchema(schema).transitiveTraits(type);

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

  test("create stamps exactly one protected concrete type and no trait facts", async () => {
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
    expect(row?.[":ramose/trait"]).toBeUndefined();
    expect(row?.[":ramose/kind"]).toBeUndefined();
    expect(row?.[":ramose/composes"]).toBeUndefined();
    expect(membershipOf(":diamond")).toEqual([
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
    expect(row?.[":ramose/trait"]).toBeUndefined();
    expect(membershipOf(":note")).toEqual([":soft"]);
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
    ).rejects.toMatchObject({ code: "tx/unknown-attribute" });
    await expect(
      conn.transact([[":db/retract", e, ":ramose/type", ":issue"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", e, ":ramose/type", ":note"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("forged or conflicting type evidence fails closed", async () => {
    const Todo = Entity("todo", { title: string() });
    const Mixed = Schema({
      issue: Issue,
      note: Note,
      diamond: Diamond,
      todo: Todo,
    });
    const conn = await setup(Mixed);

    await expect(
      conn.transact([[":db/add", "tmp-x", ":ramose/trait", ":taggable"]]),
    ).rejects.toMatchObject({ code: "tx/unknown-attribute" });
    await expect(
      conn.transact([{ ":db/id": "tmp-ghost", ":ramose/type": ":missing" }]),
    ).rejects.toMatchObject({ code: "tx/system" });

    const created = txBuilder(Mixed);
    Effect.runSync(created.put(Todo, { title: "x" }));
    const { tempids } = await conn.transact([...txOps(created)]);
    const todo = tempids["tmp-1"]!;
    await expect(
      conn.transact([[":db/add", todo, ":ramose/trait", ":taggable"]]),
    ).rejects.toMatchObject({ code: "tx/unknown-attribute" });
    await expect(
      conn.transact([[":db/add", todo, ":ramose/type", ":todo"]]),
    ).rejects.toMatchObject({ code: "tx/system" });
    await expect(
      conn.transact([[":db/add", todo, ":ramose/type", ":note"]]),
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

    const conn = await setup(Mixed);
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

  test("Query.from(Trait) derives every composer from protected type and deployed composition", async () => {
    const Marker = Trait("marker", {
      notes: Field.many(string()),
    });
    const Marked = Entity("marked", { title: string() }, { traits: [Marker] });
    const AlsoMarked = Entity("alsoMarked", { title: string() }, { traits: [Marker] });
    const Plain = Entity("plain", { title: string() });
    const Mixed = Schema({ marked: Marked, alsoMarked: AlsoMarked, plain: Plain });
    const conn = await setup(Mixed);
    const tx = txBuilder(Mixed);
    Effect.runSync(tx.put(Marked, { title: "empty many" }));
    Effect.runSync(tx.put(AlsoMarked, { title: "populated", notes: ["one"] }));
    Effect.runSync(tx.put(Plain, { title: "not a composer" }));
    await conn.transact([...txOps(tx)]);

    const listing = Query.from(Marker).select({ id: Marker.id, notes: Marker.notes });
    const lowered = lowerQueryObject(listing);
    expect(lowered.query.rules).toEqual([
      [
        ["isMarker", "?qm0"],
        ["?qm0", ":ramose/type", "?qtype1"],
        [["ramose-trait?", "?qm0", "?qtype1", ":marker"]],
      ],
    ]);
    const rows = lowered.finalize(await coreQuery(conn.db(), lowered.query)) as readonly {
      readonly id: number;
      readonly notes: readonly string[];
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.notes).sort((a, b) => a.length - b.length)).toEqual([
      [],
      ["one"],
    ]);
  });

  test("two composed entity namespaces on one id are tx/wrong-entity", async () => {
    const Task = Entity("task", { title: string() }, { traits: [Taggable] });
    const Mixed = Schema({ issue: Issue, task: Task });
    const conn = await setup(Mixed);

    await expect(
      conn.transact([
        { ":db/id": "tmp-1", ":issue/title": "a", ":task/title": "b" },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining(
        "cannot create an entity in multiple composed types: :issue, :task",
      ),
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
    const conn = await setup(Catalog);
    await expect(
      conn.transact([{ ":db/id": "tmp-1", ":two/a": "x" }]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining(
        "cannot create an entity from trait attributes alone: :two",
      ),
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
    const conn = await setup(Catalog);

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
      ":taggable/tag": "t",
    });
    expect(bare).toMatchObject({
      ":ramose/type": ":bare",
      ":taggable/tag": "u",
    });
    expect(issue?.[":ramose/trait"]).toBeUndefined();
    expect(bare?.[":ramose/trait"]).toBeUndefined();
    expect(membershipOf(":issue", Catalog)).toEqual([":taggable"]);
    expect(membershipOf(":bare", Catalog)).toEqual([":taggable"]);

    await expect(
      conn.transact([{ ":db/id": "tmp-raw", ":taggable/tag": "z" }]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining(
        "cannot create an entity from trait attributes alone: :taggable",
      ),
    });
  });

  test("two concrete entity types on one id fail closed", async () => {
    const Todo = Entity("todo", { title: string(), body: string() });
    const Mixed = Schema({ issue: Issue, todo: Todo });
    const conn = await setup(Mixed);
    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
          ":issue/title": "a",
          ":taggable/tag": "t",
          ":todo/title": "b",
        },
      ]),
    ).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining(
        "cannot create an entity in multiple composed types: :issue, :todo",
      ),
    });
  });

  test("a foreign required trait attribute is tx/wrong-entity at create", async () => {
    const Two = Trait("two", { a: string(), b: string() });
    const Doc = Entity("doc", { title: string() }, { traits: [Two] });
    const Other = Entity("other", { title: string() }, { traits: [Taggable] });
    const Catalog = Schema({ doc: Doc, other: Other });
    const conn = await setup(Catalog);

    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
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
      { ":db/id": "tmp-ok", ":other/title": "ok", ":taggable/tag": "t" },
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
    const conn = await setup(Catalog);
    await expect(
      conn.transact([
        {
          ":db/id": "tmp-1",
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

  test("a traitless entity receives exactly one protected concrete type fact", async () => {
    const Todo = Entity("todo", { title: string() });
    const Todos = Schema({ todo: Todo });
    const conn = await setup(Todos);
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
    expect(membershipOf(":todo", Todos)).toEqual([]);
  });

  test("typed put preserves same-type upsert while raw type reassertion stays protected", async () => {
    const Contact = Entity("contact", {
      email: Field.unique(string(), "upsert"),
      name: string(),
    });
    const Contacts = Schema({ contact: Contact });
    const conn = await setup(Contacts);

    const first = txBuilder(Contacts);
    Effect.runSync(first.put(Contact, { email: "a@example.com", name: "A" }));
    const firstWire = JSON.parse(JSON.stringify(txOps(first))) as unknown[];
    restoreEngineTypeAssertions(firstWire);
    const created = await conn.transact(firstWire);
    const e = created.tempids["tmp-1"]!;

    const again = txBuilder(Contacts);
    Effect.runSync(
      again.put(Contact, { email: "a@example.com", name: "A2" }),
    );
    const againWire = JSON.parse(JSON.stringify(txOps(again))) as unknown[];
    restoreEngineTypeAssertions(againWire);
    const updated = await conn.transact(againWire);
    expect(updated.tempids["tmp-1"]).toBe(e);
    expect(await conn.db().entity(e)).toMatchObject({
      ":ramose/type": ":contact",
      ":contact/email": "a@example.com",
      ":contact/name": "A2",
    });

    await expect(
      conn.transact([
        { ":db/id": e, ":ramose/type": ":contact" },
      ]),
    ).rejects.toMatchObject({ code: "tx/system" });
  });

  test("current, as-of, and history derive membership from the row type and current composition", async () => {
    const conn = await setup();
    const created = txBuilder(Board);
    Effect.runSync(created.put(Diamond, { title: "D", tag: "t", createdAt: "now" }));
    const { tempids, t } = await conn.transact([...txOps(created)]);
    const e = tempids["tmp-1"]!;
    const later = await conn.transact([[":db/add", e, ":diamond/title", "D2"]]);
    const composition = compositionFromSchema(Board);
    const typeOf = async (db: ReturnType<typeof conn.db>) => {
      const attr = db.requireAttr(":ramose/type");
      const datoms = await db.datomsArray(Index.EAVT, { e, a: attr.id });
      const asserted = datoms
        .filter((datom) => datom.op && typeof datom.v === "string")
        .map((datom) => datom.v as string);
      return asserted[0];
    };
    expect(await typeOf(conn.db())).toBe(":diamond");
    expect(await typeOf(conn.db().asOf(t))).toBe(":diamond");
    expect(await typeOf(conn.db().history())).toBe(":diamond");
    expect(composition.transitiveTraits((await typeOf(conn.db()))!)).toEqual([
      ":annotated",
      ":taggable",
      ":timestamped",
    ]);
    expect(composition.transitiveTraits((await typeOf(conn.db().asOf(t)))!)).toEqual([
      ":annotated",
      ":taggable",
      ":timestamped",
    ]);
    expect(later.t).toBeGreaterThan(t);
  });
});
