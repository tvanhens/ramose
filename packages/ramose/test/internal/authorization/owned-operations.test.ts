/** Entity/trait operation authoring and inert deterministic lowering (#317). */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  Operation,
  Schema as CatalogSchema,
  Trait,
  string,
} from "../../../src/db/internal.ts";
import { Ref as RefSchema } from "../../../src/db/valueTypes.ts";
import {
  lowerOperationSchema,
  lowerOwnedOperations,
} from "../../../src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
  EntityId,
} from "../../../src/internal/authorization/identities.ts";

const catalog = CatalogId.make("app");
const artifactHash = DigestHex.make("a".repeat(64));

const fixture = () => {
  const Slugged = Trait(
    "slugged",
    { slug: string() },
    {
      operations: (Operation) => ({
        refresh: Operation({
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          run() {
            return { ok: true };
          },
        }),
      }),
    },
  );
  const Taggable = Trait(
    "taggable",
    { tags: Field.many(string()) },
    {
      traits: [Slugged],
      operations: (Operation) => ({
        addTag: Operation({
          input: Schema.Struct({ tag: Schema.String }),
          output: Schema.Struct({}),
          doc: "Add one tag",
          run(op, { tag }) {
            op.self.set(Taggable.tags, tag);
            return {};
          },
        }),
        rebuild: Operation({
          self: false,
          input: Schema.Struct({ force: Schema.Boolean }),
          output: Schema.Struct({}),
          run() {
            return {};
          },
        }),
      }),
    },
  );
  const User = Entity("user", { name: string() });
  const Issue = Entity(
    "issue",
    { title: string() },
    {
      traits: [Taggable],
      operations: (Operation) => ({
        create: Operation({
          self: false,
          input: Schema.Struct({ title: Schema.String, slug: Schema.String }),
          output: Schema.Struct({ id: OperationEntityId }),
          doc: "Create an issue",
          run(op, input) {
            return { id: op.create({ title: input.title, slug: input.slug }) };
          },
        }),
        assign: Operation({
          input: Schema.Struct({ assignee: RefSchema(User) }),
          output: Schema.Struct({}),
          run() {
            return {};
          },
        }),
      }),
    },
  );
  const Doc = Entity("doc", { body: string() }, { traits: [Slugged] });
  const App = CatalogSchema({ user: User, issue: Issue, doc: Doc });
  return { Slugged, Taggable, User, Issue, Doc, App };
};

describe("owned operation authoring", () => {
  test("binds owner and local key without copying trait operations", () => {
    const { Taggable, Issue } = fixture();
    expect(Issue.operations.create.owner).toBe(Issue);
    expect(Issue.operations.create.localName).toBe("create");
    expect(Issue.operations.create.self).toBe(false);
    expect(Issue.operations.assign.self).toBe(true);
    expect(Taggable.operations.addTag.owner).toBe(Taggable);
    expect((Issue.operations as { addTag?: unknown }).addTag).toBeUndefined();
    expect(Object.keys(Issue.operations)).toEqual(["create", "assign"]);
  });

  test("rejects invalid operation map keys and values", () => {
    const spec = Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    });
    expect(() =>
      Entity("bad-key", {}, { operations: { "not/valid": spec } } as never)
    ).toThrow(/invalid operation name/);
    expect(() =>
      Entity("bad-value", {}, { operations: { run: {} } } as never)
    ).toThrow(/must be Ramose\.Operation/);
  });
});

describe("owned operation lowering", () => {
  test("produces deterministic catalog-local identities and inert descriptors", async () => {
    const { App, Issue } = fixture();
    const first = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const second = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const otherArtifact = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, DigestHex.make("b".repeat(64))),
    );

    expect(second.descriptors).toEqual(first.descriptors);
    expect(otherArtifact.descriptors.map((entry) => entry.bodyHash)).not.toEqual(
      first.descriptors.map((entry) => entry.bodyHash),
    );
    expect(
      otherArtifact.descriptors.map((entry) => entry.inputSchemaHash),
    ).not.toEqual(first.descriptors.map((entry) => entry.inputSchemaHash));
    expect(first.descriptors.map((entry) =>
      `${entry.id.owner.kind}:${entry.id.owner.name}.${entry.id.localName}:${entry.id.target}`
    )).toEqual([
      "entity:issue.assign:required",
      "entity:issue.create:none",
      "trait:slugged.refresh:required",
      "trait:taggable.addTag:required",
      "trait:taggable.rebuild:none",
    ]);

    const create = first.descriptors.find((entry) => entry.id.localName === "create")!;
    expect(create.id.catalog).toBe(catalog);
    expect("database" in create.id).toBe(false);
    expect(create.doc).toBe("Create an issue");
    expect(create.composers).toEqual([]);
    expect(create.inputSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.outputSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first.descriptors)).not.toContain("function");

    const definition = first.definitions.find((entry) => entry.localName === "create")!;
    expect(definition.owner).toBe(Issue);
    expect(definition.input).toBe(Issue.operations.create.input);
    expect(definition.output).toBe(Issue.operations.create.output);
    expect(definition.run as unknown).toBe(Issue.operations.create.run);
    expect(Object.isFrozen(first.descriptors)).toBe(true);
    expect(Object.isFrozen(first.definitions)).toBe(true);
  });

  test("keeps trait ownership once and derives direct plus transitive composers", async () => {
    const { App } = fixture();
    const lowered = await Effect.runPromise(
      lowerOwnedOperations(catalog, App, artifactHash),
    );
    const refresh = lowered.descriptors.find((entry) => entry.id.localName === "refresh")!;
    const addTag = lowered.descriptors.find((entry) => entry.id.localName === "addTag")!;
    const rebuild = lowered.descriptors.find((entry) => entry.id.localName === "rebuild")!;

    expect(refresh.id.owner).toEqual({ kind: "trait", name: "slugged" });
    expect(refresh.composers.map((entry) => entry.name)).toEqual(["doc", "issue"]);
    expect(addTag.id.owner).toEqual({ kind: "trait", name: "taggable" });
    expect(addTag.composers.map((entry) => entry.name)).toEqual(["issue"]);
    expect(rebuild.id.target).toBe("none");
    expect(rebuild.composers).toEqual([]);
  });

  test("lowers nested schemas, optional keys, arrays, and typed refs", () => {
    const { User } = fixture();
    const shape = lowerOperationSchema(
      catalog,
      Schema.Struct({
        assignee: RefSchema(User),
        labels: Schema.Array(Schema.String),
        note: Schema.optionalKey(Schema.String),
      }),
    );
    expect(shape).toEqual({
      _tag: "struct",
      fields: [
        {
          key: "assignee",
          optional: false,
          shape: {
            _tag: "ref",
            refTarget: {
              _tag: "entity",
              entity: EntityId.make({ catalog, name: "user" }),
            },
          },
        },
        {
          key: "labels",
          optional: false,
          shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
        },
        {
          key: "note",
          optional: true,
          shape: { _tag: "scalar", valueType: "string" },
        },
      ],
    });
  });

  test("is idempotent across repeated schema components and rejects conflicts", async () => {
    const { App } = fixture();
    const repeated = await Effect.runPromise(
      lowerOwnedOperations(catalog, [App, App], artifactHash),
    );
    expect(repeated.descriptors).toHaveLength(5);

    const OtherIssue = Entity(
      "issue",
      {},
      {
        operations: (Operation) => ({
          create: Operation({
            self: false,
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const conflicting = CatalogSchema({ issue: OtherIssue });
    const failure = await Effect.runPromise(
      Effect.flip(lowerOwnedOperations(catalog, [App, conflicting], artifactHash)),
    );
    expect(failure.message).toBe("duplicate entity definition 'issue'");
  });

  test("rejects target-resource schema inputs on targetless definitions", async () => {
    const Invalid = Entity(
      "invalid",
      {},
      {
        operations: (Operation) => ({
          inspect: Operation({
            self: false,
            input: Schema.Struct({ nested: Schema.Array(RefSchema.self) }),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          CatalogSchema({ invalid: Invalid }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "targetless operation 'invalid.inspect' cannot reference self",
    );
  });
});
