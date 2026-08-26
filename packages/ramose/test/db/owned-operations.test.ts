/**
 * Entity- and trait-owned operations: identity, harvest, cards, create
 * shape, and duplicate wire identities (issue #317).
 */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Connection } from "../../src/internal/core/conn.ts";
import {
  Entity,
  EntityId,
  Field,
  Operation,
  Operations,
  Policy as P,
  Query,
  Schema as DbSchema,
  Trait,
  assembleOperations,
  defineOperations,
  harvestOwnedOperations,
  schemaTx,
  string,
} from "../../src/db/internal.ts";
import { asPromiseOp, buildOp, runBody } from "../../src/db/op-handle.ts";
import { checkOperationTarget } from "../../src/db/operation-target.ts";
import * as Effect from "effect/Effect";

const Taggable = Trait(
  "taggable",
  { tags: Field.many(string()) },
  {
    operations: {
      addTag: Operation({
        input: Schema.Struct({ tag: Schema.String }),
        output: Schema.Struct({}),
        doc: "Add a tag",
        run(op, { tag }) {
          op.self.set(Taggable.tags, tag);
          return {};
        },
      }),
    },
  },
);

const Issue = Entity(
  "issue",
  { title: string() },
  {
    traits: [Taggable],
    operations: {
      create: Operation({
        self: false,
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({ id: EntityId }),
        run(op, input) {
          return { id: op.create({ title: input.title }) };
        },
      }),
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          op.self.set(Issue.title, title);
          return {};
        },
      }),
    },
  },
);

const Doc = Entity("doc", { body: string() }, { traits: [Taggable] });
const App = DbSchema({ issue: Issue, doc: Doc });

const principal = {
  eid: null,
  class: "admin",
  claims: {},
};

describe("owned operation identity", () => {
  test("map key plus owner is the permanent wire identity", () => {
    expect(Taggable.operations.addTag.name).toBe("taggable/addTag");
    expect(Issue.operations.create.name).toBe("issue/create");
    expect(Issue.operations.rename.name).toBe("issue/rename");
    expect(Issue.operations.create.on).toBeUndefined();
    expect(Issue.operations.rename.on).toBe(Issue);
    expect(Taggable.operations.addTag.on).toBe(Taggable);
    expect(Issue.operations.create.owner).toBe(Issue);
    expect(Issue.operations.create.localName).toBe("create");
    expect(Issue.operations.create.createEntity).toBe(Issue);
    expect(Issue.operations.rename.createEntity).toBeUndefined();
  });

  test("trait operations stay on the trait and are not copied onto composers", () => {
    expect(Taggable.operations.addTag).toBeDefined();
    expect(
      (Issue.operations as { addTag?: unknown }).addTag,
    ).toBeUndefined();
    expect((Doc.operations as { addTag?: unknown }).addTag).toBeUndefined();
    expect(Object.keys(Issue.operations).sort()).toEqual(["create", "rename"]);
    expect(Object.keys(Doc.operations)).toEqual([]);
  });
});

describe("harvest and cards", () => {
  test("schema reachability harvests each owned operation once", () => {
    const harvested = harvestOwnedOperations(App);
    expect(Object.keys(harvested).sort()).toEqual([
      "issue/create",
      "issue/rename",
      "taggable/addTag",
    ]);
    expect(harvested["taggable/addTag"]).toBe(Taggable.operations.addTag);
    expect(harvested["issue/create"]).toBe(Issue.operations.create);
  });

  test("defineOperations harvests owned operations from the schema", () => {
    const ops = defineOperations(App);
    expect(ops.names()).toEqual([
      "issue/create",
      "issue/rename",
      "taggable/addTag",
    ]);
    expect(ops.cards()).toEqual([
      {
        name: "issue/create",
        owner: "issue",
        local: "create",
        self: false,
      },
      {
        name: "issue/rename",
        on: "issue",
        owner: "issue",
        local: "rename",
        self: true,
      },
      {
        name: "taggable/addTag",
        doc: "Add a tag",
        on: "taggable",
        owner: "taggable",
        local: "addTag",
        self: true,
        composers: ["doc", "issue"],
      },
    ]);
  });

  test("one trait operation produces one card with every composer", () => {
    const cards = defineOperations(App).cards();
    const addTag = cards.filter((c) => c.name === "taggable/addTag");
    expect(addTag).toHaveLength(1);
    expect(addTag[0]?.composers).toEqual(["doc", "issue"]);
  });

  test("duplicate derived identities bound to different definitions throw", () => {
    const Other = Entity("issue", { title: string() }, {
      operations: {
        create: Operation({
          self: false,
          input: Schema.Struct({ title: Schema.String }),
          output: Schema.Struct({}),
          run: () => ({}),
        }),
      },
    });
    expect(() =>
      assembleOperations(App, { extra: Other.operations.create }),
    ).toThrow(/duplicate operation identity "issue\/create"/);
  });

  test("the same definition reached twice is idempotent", () => {
    const once = assembleOperations(App);
    const twice = assembleOperations([App, App]);
    expect(Object.keys(once).sort()).toEqual(Object.keys(twice).sort());
    expect(twice["taggable/addTag"]).toBe(Taggable.operations.addTag);
  });
});

describe("runtime target check", () => {
  test("entity membership uses :ramose/type and rejects a foreign type", () => {
    expect(
      checkOperationTarget(
        { ":db/id": 1, ":ramose/type": ":issue", ":issue/title": "Fix" },
        Issue,
      ),
    ).toBe("ok");
    expect(
      checkOperationTarget(
        { ":db/id": 2, ":ramose/type": ":doc", ":doc/body": "hi" },
        Issue,
      ),
    ).toBe("foreign");
    expect(checkOperationTarget(undefined, Issue)).toBe("dangling");
  });

  test("trait membership uses :ramose/trait and rejects a non-composer", () => {
    expect(
      checkOperationTarget(
        {
          ":db/id": 1,
          ":ramose/type": ":issue",
          ":ramose/trait": [":taggable"],
          ":issue/title": "Fix",
        },
        Taggable,
      ),
    ).toBe("ok");
    expect(
      checkOperationTarget(
        { ":db/id": 3, ":user/name": "Ada" },
        Taggable,
      ),
    ).toBe("foreign");
  });

  test("entity-only rows without :ramose/type fall back to the namespace prefix", () => {
    expect(
      checkOperationTarget({ ":db/id": 1, ":issue/title": "Fix" }, Issue),
    ).toBe("ok");
    expect(
      checkOperationTarget({ ":db/id": 2, ":doc/body": "hi" }, Issue),
    ).toBe("foreign");
  });
});

describe("op.create and self", () => {
  test("entity-owned self:false create enforces required entity and trait fields", async () => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(App) as unknown[]);
    const built = buildOp({
      schema: App,
      db: "app",
      principal,
      createEntity: Issue,
      effects: "halt",
      q: () => Effect.succeed([]),
      pull: () => Effect.succeed(null),
    });
    const result = await Effect.runPromise(
      runBody(Issue.operations.create, built.op, { title: "Fix login" }),
    );
    expect(result.halted).toBe(false);
    expect(built.ops()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ":issue/title": "Fix login",
          ":ramose/type": ":issue",
        }),
      ]),
    );
  });

  test("instance operations expose self and do not expose create", () => {
    const built = buildOp({
      schema: App,
      db: "app",
      principal,
      self: 1001,
      effects: "halt",
      q: () => Effect.succeed([]),
      pull: () => Effect.succeed(null),
    });
    const op = asPromiseOp(built.op);
    expect(op.self).toBeDefined();
    expect(op.create).toBeUndefined();
  });
});

describe("owned operation policy keys", () => {
  test("entity and trait operation keys compile under their owner", () => {
    const User = Entity("user", { sub: Field.unique(Schema.String, "upsert") });
    const Board = DbSchema({ user: User, issue: Issue, doc: Doc });
    const ops = defineOperations(Board);
    const policy = P.policy(
      {
        schema: Board,
        principal: User.sub,
        classes: ["member"],
        schemaClasses: ["member"],
        operations: ops,
      },
      {
        issue: {
          read: true,
          operations: {
            create: P.class("member"),
            rename: P.class("member"),
          },
        },
        traits: {
          taggable: {
            operations: {
              addTag: P.class("member"),
            },
          },
        },
      },
    );
    const json = JSON.parse(P.compile(policy, { operations: ops })) as {
      operations?: Record<string, unknown>;
    };
    expect(Object.keys(json.operations ?? {}).sort()).toEqual([
      "issue/create",
      "issue/rename",
      "taggable/addTag",
    ]);
  });

  test("a self:false operation policy rejects a target-bound rule", () => {
    const User = Entity("user", { sub: Field.unique(Schema.String, "upsert") });
    const Board = DbSchema({ user: User, issue: Issue, doc: Doc });
    expect(() =>
      P.policy(
        {
          schema: Board,
          principal: User.sub,
          classes: ["member"],
          schemaClasses: ["member"],
        },
        {
          issue: {
            operations: {
              create: {
                class: "member",
                rule: (me: P.Me<typeof User>) => Query.has(User.sub)(me as never),
              } as never,
            },
          },
        },
      ),
    ).toThrow(/targetless operation takes a class gate only/);
  });
});

describe("Operations() still registers standalone ops", () => {
  test("standalone and owned identities coexist when names differ", () => {
    const extra = Operation(
      "misc/ping",
      { input: Schema.Struct({}), output: Schema.Struct({}) },
      () => ({}),
    );
    const ops = defineOperations(App, { extra });
    expect(ops.names()).toEqual([
      "issue/create",
      "issue/rename",
      "misc/ping",
      "taggable/addTag",
    ]);
    expect(Operations({ extra }).get("misc/ping")).toBe(extra);
  });
});
