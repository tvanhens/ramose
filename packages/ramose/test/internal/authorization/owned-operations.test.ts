/** Entity/trait operation authoring and inert deterministic lowering (#317). */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Entity,
  EntityId as OperationEntityId,
  Field,
  Operation,
  OwnedOperations,
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
    expect(Issue[OwnedOperations].create.owner).toBe(Issue);
    expect(Issue[OwnedOperations].create.localName).toBe("create");
    expect(Issue[OwnedOperations].create.self).toBe(false);
    expect(Issue[OwnedOperations].assign.self).toBe(true);
    expect(Taggable[OwnedOperations].addTag.owner).toBe(Taggable);
    expect((Issue[OwnedOperations] as { addTag?: unknown }).addTag).toBeUndefined();
    expect(Object.keys(Issue[OwnedOperations])).toEqual(["create", "assign"]);
  });

  test("preserves symbol-keyed operations on bindable trait callables", () => {
    const Bound = Trait(
      "bound",
      { catalog: string() },
      {
        bind: (definition) => ({ values: { catalog: definition.key } }),
        operations: (Operation) => ({
          inspect: Operation({
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    expect(Bound[OwnedOperations].inspect.owner.ns).toBe("bound");
    expect(Bound[OwnedOperations].inspect.localName).toBe("inspect");
    expect(
      Bound({ key: "child", schema: CatalogSchema({}) })[OwnedOperations]
        .inspect,
    ).toBe(Bound[OwnedOperations].inspect);
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
    expect(() =>
      Entity(
        "bad-symbol",
        {},
        { operations: { [Symbol("run")]: spec } } as never,
      )
    ).toThrow(/operation map keys must be strings/);
    expect(() =>
      Entity(
        "bad-author",
        {},
        { operations: () => ({ run: spec }) } as never,
      )
    ).toThrow(/must use the Operation author supplied/);
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
    expect(definition.input).toBe(Issue[OwnedOperations].create.input);
    expect(definition.output).toBe(Issue[OwnedOperations].create.output);
    expect(definition.run as unknown).toBe(Issue[OwnedOperations].create.run);
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
        optionalAssignee: Schema.optionalKey(RefSchema(User)),
        optionalSelf: Schema.optionalKey(RefSchema.self),
        self: RefSchema.self,
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
        {
          key: "optionalAssignee",
          optional: true,
          shape: {
            _tag: "ref",
            refTarget: {
              _tag: "entity",
              entity: EntityId.make({ catalog, name: "user" }),
            },
          },
        },
        {
          key: "optionalSelf",
          optional: true,
          shape: { _tag: "ref", refTarget: { _tag: "self" } },
        },
        {
          key: "self",
          optional: false,
          shape: { _tag: "ref", refTarget: { _tag: "self" } },
        },
      ],
    });
  });

  test("rejects refs hidden in unsupported union, tuple, and refinement schemas", () => {
    const Missing = Entity("missing", {});
    const schemas = [
      Schema.Union([RefSchema.self, Schema.String]),
      Schema.Tuple([RefSchema(Missing), Schema.String]),
      RefSchema.self.pipe(Schema.check(Schema.isGreaterThan(0))),
    ];
    for (const schema of schemas) {
      expect(() => lowerOperationSchema(catalog, schema)).toThrow(
        /refs (nested inside|wrapped by) an unsupported .* operation schema cannot be lowered/,
      );
    }
  });

  test("fails operation lowering before fingerprinting a nested opaque ref", async () => {
    const Invalid = Entity(
      "invalidNestedRef",
      {},
      {
        operations: (Operation) => ({
          inspect: Operation({
            input: Schema.Union([RefSchema.self, Schema.String]),
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
          CatalogSchema({ invalidNestedRef: Invalid }),
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      "operation schema lowering failed: refs nested inside an unsupported Union operation schema cannot be lowered",
    );
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
            input: Schema.Struct({ nested: Schema.optionalKey(RefSchema.self) }),
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

  test("rejects entity-trait namespace clashes across schema components", async () => {
    const FooEntity = Entity("foo", {});
    const FooTrait = Trait("foo", {});
    const BarEntity = Entity("bar", {}, { traits: [FooTrait] });
    const failure = await Effect.runPromise(
      Effect.flip(
        lowerOwnedOperations(
          catalog,
          [CatalogSchema({ foo: FooEntity }), CatalogSchema({ bar: BarEntity })],
          artifactHash,
        ),
      ),
    );
    expect(failure.message).toBe(
      'ramose/schema: "foo" is both an entity and a trait',
    );
  });
});
