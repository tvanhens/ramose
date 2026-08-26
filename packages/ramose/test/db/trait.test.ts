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
  Policy as P,
  Query,
  Ref,
  Schema,
  Trait,
  string,
  lowerQueryObject,
  schemaTx,
  txBuilder,
  txOps,
} from "../../src/db/internal.ts";
import {
  filterDb,
  parsePolicy,
  query as coreQuery,
  type Principal,
} from "../../src/internal/core/index.ts";
import { decideSessionTx } from "../../src/worker/session-sync.ts";

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

  test("Entity(traits) cannot coexist with a trait named read", () => {
    const Read = Trait("read", { flag: string() });
    const Item = Entity("item", { title: string() }, { traits: [Read] });
    const Traits = Entity("traits", { label: string() });
    expect(() => Schema({ traits: Traits, item: Item })).toThrow(
      /Entity\("traits"\) cannot coexist with Trait\("read"\)/,
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

  test("P.field on a stamped trait ident compiles", () => {
    const Task = Entity("task", { title: string() }, { traits: [Taggable] });
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Catalog = Schema({ actor: Actor, issue: Issue, task: Task });
    const head = {
      schema: Catalog,
      principal: Actor.sub,
      classes: ["member"] as const,
      schemaClasses: ["member"] as const,
    };
    const authored = P.policy(head, {
      issue: { attrs: [P.field(Issue.tag, { read: P.class("member") })] },
    });
    const compiled = JSON.parse(P.compile(authored)) as {
      attrs: Record<string, unknown>;
      ns?: Record<string, unknown>;
    };
    expect(compiled.attrs[":taggable/tag"]).toBeDefined();
    expect(compiled.attrs[":issue/tag"]).toBeUndefined();
  });

  test("selecting a trait field under policy returns the row with pushdown on", async () => {
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Catalog = Schema({ actor: Actor, issue: Issue });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    const seed = txBuilder(Catalog);
    Effect.runSync(seed.put(Actor, { sub: "a1" }));
    Effect.runSync(seed.put(Issue, { title: "an issue", tag: "urgent" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const actorEid = tempids["tmp-1"]!;

    const authored = P.policy(
      {
        schema: Catalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      {
        actor: { read: true },
        issue: { read: true, attrs: [P.field(Issue.tag, { read: true })] },
        traits: { taggable: { read: true } },
      },
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    expect(policy.ns?.taggable).toBeDefined();
    expect(policy.ns?.issue).toBeDefined();

    const listing = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ id: Issue.id, title: Issue.title, tag: Issue.tag }),
      ),
    );
    const { query } = lowerQueryObject(listing);
    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "a1",
      eid: actorEid,
      claims: { sub: "a1" },
      db: "test",
    };
    const view = filterDb(conn.db(), conn.db(), policy, principal);
    const rows = (await coreQuery(view, query)) as readonly [
      { readonly id: number; readonly title: string; readonly tag: string },
    ][];
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toMatchObject({ title: "an issue", tag: "urgent" });
    const filteredOnly = (await coreQuery(view, query, [], { pushdown: false })) as readonly [
      { readonly id: number; readonly title: string; readonly tag: string },
    ][];
    expect(filteredOnly).toEqual(rows);
  });

  test("a trait attr on an unconjoined var is filtered under both pushdown paths", async () => {
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Owned = Entity(
      "issue",
      { title: string(), owner: Field(Ref(() => Actor)) },
      { traits: [Taggable] },
    );
    const Catalog = Schema({ actor: Actor, issue: Owned });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":actor/sub": "alice" },
      { ":db/id": "bob", ":actor/sub": "bob" },
      {
        ":db/id": "mine",
        ":issue/title": "alice-issue",
        ":issue/owner": "alice",
        ":taggable/tag": "PUBLIC",
      },
      {
        ":db/id": "theirs",
        ":issue/title": "bob-issue",
        ":issue/owner": "bob",
        ":taggable/tag": "TOP-SECRET",
      },
    ]);
    const mine = tempids.mine!;
    const ownIssue = (me: P.Me<typeof Actor>) => Query.is(Owned.owner, me);
    const authored = P.policy(
      {
        schema: Catalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      {
        actor: { read: true },
        issue: { read: ownIssue },
        traits: { taggable: { read: true } },
      },
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "alice",
      eid: tempids.alice!,
      claims: { sub: "alice" },
      db: "test",
    };
    const view = filterDb(conn.db(), conn.db(), policy, principal);
    const expected: readonly [number, string][] = [[mine, "PUBLIC"]];

    const leak = {
      find: ["?b", "?g"],
      where: [
        ["?a", ":issue/title", "?t"],
        ["?b", ":taggable/tag", "?g"],
      ],
    };
    const leakOn = (await coreQuery(view, leak)) as readonly [number, string][];
    const leakOff = (await coreQuery(view, leak, [], { pushdown: false })) as readonly [
      number,
      string,
    ][];
    expect(leakOn).toEqual(expected);
    expect(leakOff).toEqual(expected);

    const sameVar = {
      find: ["?e", "?g"],
      where: [
        ["?e", ":issue/title", "?t"],
        ["?e", ":taggable/tag", "?g"],
      ],
    };
    const sameOn = (await coreQuery(view, sameVar)) as readonly [number, string][];
    const sameOff = (await coreQuery(view, sameVar, [], {
      pushdown: false,
    })) as readonly [number, string][];
    expect(sameOn).toEqual(expected);
    expect(sameOff).toEqual(expected);
  });

  test("two composers sharing a trait field keep one attr rule", () => {
    const Task = Entity("task", { title: string() }, { traits: [Taggable] });
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Catalog = Schema({ actor: Actor, issue: Issue, task: Task });
    const head = {
      schema: Catalog,
      principal: Actor.sub,
      classes: ["member"] as const,
      schemaClasses: ["member"] as const,
    };
    const same = P.policy(head, {
      issue: { attrs: [P.field(Issue.tag, { read: P.class("member") })] },
      task: { attrs: [P.field(Task.tag, { read: P.class("member") })] },
    });
    const compiled = JSON.parse(P.compile(same)) as {
      attrs: Record<string, unknown>;
    };
    expect(compiled.attrs[":taggable/tag"]).toEqual({
      read: [{ _tag: "allow", class: ["member"], rule: true }],
    });

    const conflicting = P.policy(head, {
      issue: { attrs: [P.field(Issue.tag, { read: P.class("member") })] },
      task: { attrs: [P.field(Task.tag, { read: true })] },
    });
    expect(() => P.compile(conflicting)).toThrow(
      /ns\.task\.attrs: :taggable\/tag conflicts with ns\.issue/,
    );

    const nsDifferent = P.policy(head, {
      issue: { read: true },
      task: { read: P.class("member") },
    });
    const nsCompiled = JSON.parse(P.compile(nsDifferent)) as {
      ns?: Record<string, unknown>;
    };
    expect(nsCompiled.ns?.taggable).toBeUndefined();
    expect(nsCompiled.ns?.issue).toBeDefined();
    expect(nsCompiled.ns?.task).toBeDefined();
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
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
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
      message: expect.stringContaining(
        "cannot create an entity from trait attributes alone: :taggable",
      ),
    });
  });

  test("a mixed composed+plain create still requires every born namespace", async () => {
    const Todo = Entity("todo", { title: string(), body: string() });
    const Mixed = Schema({ issue: Issue, todo: Todo });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Mixed) as unknown[]);
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
      code: "tx/required",
      message: expect.stringContaining(
        "entity issue is missing required fields: :todo/body",
      ),
    });
  });

  test("a composer with no policy does not inherit another composer's trait grant", async () => {
    const Secret = Entity("secret", { code: string() }, { traits: [Taggable] });
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Catalog = Schema({ actor: Actor, issue: Issue, secret: Secret });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    const seed = txBuilder(Catalog);
    Effect.runSync(seed.put(Actor, { sub: "a1" }));
    Effect.runSync(seed.put(Issue, { title: "public", tag: "public-tag" }));
    Effect.runSync(seed.put(Secret, { code: "s", tag: "TOP-SECRET" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const actorEid = tempids["tmp-1"]!;
    const issueEid = tempids["tmp-2"]!;
    const secretEid = tempids["tmp-3"]!;

    const authored = P.policy(
      {
        schema: Catalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      {
        actor: { read: true },
        issue: { read: true },
        traits: { taggable: { read: true } },
      },
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    expect(policy.ns?.taggable).toBeDefined();
    expect(policy.ns?.secret).toBeUndefined();

    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "a1",
      eid: actorEid,
      claims: { sub: "a1" },
      db: "test",
    };
    const view = filterDb(conn.db(), conn.db(), policy, principal);

    expect(await view.entity(secretEid)).toBeUndefined();
    const issueRow = await view.entity(issueEid);
    expect(issueRow?.[":taggable/tag"]).toBe("public-tag");
    expect(issueRow?.[":issue/title"]).toBe("public");

    const tags = { find: ["?e", "?t"], where: [["?e", ":taggable/tag", "?t"]] };
    const tagOn = (await coreQuery(view, tags)) as readonly [number, string][];
    const tagOff = (await coreQuery(view, tags, [], { pushdown: false })) as readonly [
      number,
      string,
    ][];
    expect(tagOn).toEqual([[issueEid, "public-tag"]]);
    expect(tagOff).toEqual(tagOn);

    const codes = { find: ["?e", "?c"], where: [["?e", ":secret/code", "?c"]] };
    expect(await coreQuery(view, codes)).toEqual([]);
    expect(await coreQuery(view, codes, [], { pushdown: false })).toEqual([]);

    const secretListing = Query.q(() =>
      pipe(Query.entities(Secret), Query.select({ id: Secret.id })),
    );
    const { query: secretQuery } = lowerQueryObject(secretListing);
    expect(await coreQuery(view, secretQuery)).toEqual([]);
    expect(await coreQuery(view, secretQuery, [], { pushdown: false })).toEqual([]);

    const issueListing = Query.q(() =>
      pipe(Query.entities(Issue), Query.select({ id: Issue.id, tag: Issue.tag })),
    );
    const { query: issueQuery } = lowerQueryObject(issueListing);
    const issueOn = (await coreQuery(view, issueQuery)) as readonly [
      { readonly id: number; readonly tag: string },
    ][];
    const issueOff = (await coreQuery(view, issueQuery, [], { pushdown: false })) as readonly [
      { readonly id: number; readonly tag: string },
    ][];
    expect(issueOn).toEqual([[{ id: issueEid, tag: "public-tag" }]]);
    expect(issueOff).toEqual(issueOn);
  });

  test("membership facts are judged by the named type, not as system attrs", async () => {
    const Secret = Entity("secret", { title: string() }, { traits: [Taggable] });
    const Plain = Entity("plain", { title: string() });
    const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
    const Catalog = Schema({ actor: Actor, secret: Secret, plain: Plain });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    const seed = txBuilder(Catalog);
    Effect.runSync(seed.put(Actor, { sub: "a1" }));
    Effect.runSync(seed.put(Secret, { title: "hidden", tag: "s" }));
    Effect.runSync(seed.put(Plain, { title: "p" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const actorEid = tempids["tmp-1"]!;
    const secretEid = tempids["tmp-2"]!;

    const authored = P.policy(
      {
        schema: Catalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      { actor: { read: true } },
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "a1",
      eid: actorEid,
      claims: { sub: "a1" },
      db: "test",
    };
    const view = filterDb(conn.db(), conn.db(), policy, principal);

    const types = { find: ["?e", "?t"], where: [["?e", ":ramose/type", "?t"]] };
    expect(await coreQuery(view, types)).toEqual([]);
    expect(await coreQuery(view, types, [], { pushdown: false })).toEqual([]);

    const titles = { find: ["?e", "?t"], where: [["?e", ":secret/title", "?t"]] };
    expect(await coreQuery(view, titles)).toEqual([]);
    expect(await coreQuery(view, titles, [], { pushdown: false })).toEqual([]);

    expect(await view.entity(secretEid)).toBeUndefined();

    const secretListing = Query.q(() =>
      pipe(Query.entities(Secret), Query.select({ id: Secret.id })),
    );
    const { query: secretQuery } = lowerQueryObject(secretListing);
    expect(await coreQuery(view, secretQuery)).toEqual([]);
    expect(await coreQuery(view, secretQuery, [], { pushdown: false })).toEqual([]);

    const plainListing = Query.q(() =>
      pipe(Query.entities(Plain), Query.select({ id: Plain.id })),
    );
    const { query: plainQuery } = lowerQueryObject(plainListing);
    expect(await coreQuery(view, plainQuery)).toEqual([]);
    expect(await coreQuery(view, plainQuery, [], { pushdown: false })).toEqual([]);

    const before = conn.db();
    const more = txBuilder(Catalog);
    Effect.runSync(more.put(Secret, { title: "another", tag: "x" }));
    const rep = await conn.transact([...txOps(more)]);
    const decision = await decideSessionTx({
      datoms: rep.txData,
      policy,
      principal,
      ruleDbAfter: conn.db(),
      ruleDbBefore: before,
    });
    expect(decision.kind).toBe("skip");
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
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
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
