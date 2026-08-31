import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import {
  appliedPolicyOf,
  Entity,
  Field,
  OwnedOperations,
  Ref,
  Schema,
  Trait,
  bytes,
  compileCreationPlan,
  compositionValueMetadata,
  creationDefault,
  float,
  pairDeployedCreationDefaults,
  resolveCreationValues,
  stored,
  string,
  timestamp,
  type AnySchemaDefinition,
  type CodeDefinition,
} from "../../../src/db/internal.ts";
import { DOCUMENTATION } from "../../../src/db/documentation.ts";
import {
  CatalogId,
  CatalogMismatch,
  CatalogUnitHash,
  CatalogVersionMismatch,
  DigestHex,
  InvalidIR,
  assembleCatalogDefinitions,
  eq,
  opaqueCatalogDenial,
  resolveCatalogDefinition,
} from "../../../src/internal/authorization/index.ts";

const artifactHash = DigestHex.make("a".repeat(64));

const runnable = <S extends AnySchemaDefinition>(schema: S): S => {
  schema.applyPolicy(() => {});
  return schema;
};

const assemble = (root: AnySchemaDefinition, hash = artifactHash) =>
  Effect.runPromise(assembleCatalogDefinitions({ root, artifactHash: hash }));

const assembleFailure = (root: AnySchemaDefinition) =>
  Effect.runPromise(Effect.flip(assembleCatalogDefinitions({ root, artifactHash })));

describe("Schema", () => {
  test("constructs one frozen permanently keyed runnable definition", async () => {
    const definition = runnable(Schema("app", {}));

    expect(definition).toEqual({
      _tag: "Schema",
      key: "app",
      schema: definition,
      entities: {},
      applyPolicy: definition.applyPolicy,
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => Schema("", {})).toThrow(
      /permanent key must not be empty/,
    );
  });

  test("accepts an applied root policy directly", async () => {
    const definition = runnable(Schema("effect-policy", {}));

    const registry = await assemble(definition);
    expect(registry.keys().map(String)).toEqual(["effect-policy"]);
  });
});

describe("catalog definition assembly", () => {
  test("terminates recursive graphs, folds operation writes, and seals each reachable unit once", async () => {
    const Audit = Entity("audit", { message: string() });
    const Graph = Trait(
      "graph",
      { catalog: string() },
      {
        bind: (catalog) => ({
          values: { catalog: catalog.key },
          dependencies: [catalog],
        }),
        operations: (Operation) => ({
          inspect: Operation({
            input: EffectSchema.Struct({}),
            output: EffectSchema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );

    let root!: AnySchemaDefinition;
    let child!: AnySchemaDefinition;
    const RootNode = Entity(
      "rootNode",
      { title: string() },
      {
        traits: [Graph(() => child)],
        operations: (Operation) => ({
          audit: Operation({
            self: false,
            writes: [Audit],
            input: EffectSchema.Struct({}),
            output: EffectSchema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const ChildNode = Entity("childNode", {}, {
      traits: [Graph(() => root)],
    });
    root = Schema("root", { rootNode: RootNode });
    child = Schema("child", { childNode: ChildNode });
    root.applyPolicy(() => {});
    child.applyPolicy(() => {});

    const first = await assemble(root);
    const second = await assemble(root);
    expect(first.keys().map(String)).toEqual(["child", "root"]);
    expect(second.keys()).toEqual(first.keys());

    const installedRoot = Result.getOrThrow(first.require(CatalogId.make("root")));
    const installedChild = Result.getOrThrow(first.require(CatalogId.make("child")));
    expect(installedRoot.unitHash).toBe(
      Result.getOrThrow(second.require(CatalogId.make("root"))).unitHash,
    );
    expect(installedRoot.unit.catalog.entities.map((entry) => entry.id.name)).toEqual([
      "audit",
      "rootNode",
    ]);
    expect(installedChild.unit.catalog.entities.map((entry) => entry.id.name)).toEqual([
      "childNode",
    ]);
    expect(installedRoot.unit.catalog.operations.map((entry) =>
      `${entry.id.owner.kind}:${entry.id.owner.name}.${entry.id.localName}`
    )).toEqual([
      "entity:rootNode.audit",
      "trait:graph.inspect",
    ]);
    expect(installedRoot.operations.map((entry) =>
      entry.descriptor.id.localName
    )).toEqual(["audit", "inspect"]);
    expect(installedRoot.operations[0]!.descriptor.writes.map((entry) =>
      entry.name
    ))
      .toEqual(["audit"]);
    expect(installedRoot.resolveCreationValues(
      "rootNode",
      { title: "Root" },
      { now: new Date(0) },
    )).toEqual({ title: "Root", catalog: "child" });
    expect(Object.isFrozen(installedRoot)).toBe(true);
    expect(Object.isFrozen(installedRoot.unit)).toBe(true);
  });

  test("binds native default implementation identity to the deployed artifact", async () => {
    const definition = runnable(Schema("app", { item: Entity("item", {
      name: string({ default: () => "native" }),
    }) }));
    const first = await assemble(definition);
    const second = await assemble(
      definition,
      DigestHex.make("b".repeat(64)),
    );

    expect(Result.getOrThrow(first.require(CatalogId.make("app"))).unitHash)
      .not.toBe(Result.getOrThrow(second.require(CatalogId.make("app"))).unitHash);
    expect(Result.getOrThrow(first.require(CatalogId.make("app"))).resolveCreationValues(
      "item",
      {},
      { now: new Date(0) },
    )).toEqual({ name: "native" });
  });

  test("preserves documentation in deployed discovery metadata without changing identities", async () => {
    const schemaWithDocs = (docs: {
      readonly entity?: string;
      readonly trait?: string;
      readonly directField?: string;
      readonly refField?: string;
      readonly composedField?: string;
      readonly operation?: string;
    }) => {
      const Author = Entity("docAuthor", { name: string() });
      const Taggable = Trait(
        "docTaggable",
        {
          tags: Field.many(string(
            docs.composedField === undefined ? {} : { doc: docs.composedField },
          )),
        },
        {
          ...(docs.trait === undefined ? {} : { doc: docs.trait }),
          operations: (Operation) => ({
            addTag: Operation({
              input: EffectSchema.Struct({ tag: EffectSchema.String }),
              output: EffectSchema.Struct({}),
              ...(docs.operation === undefined ? {} : { doc: docs.operation }),
              run(op, { tag }) {
                op.self.set(Taggable.tags, tag);
                return {};
              },
            }),
          }),
        },
      );
      const Article = Entity(
        "docArticle",
        {
          doc: string(),
          title: string(
            docs.directField === undefined ? {} : { doc: docs.directField },
          ),
          author: Ref(
            Author,
            docs.refField === undefined ? {} : { doc: docs.refField },
          ),
        },
        {
          traits: [Taggable],
          ...(docs.entity === undefined ? {} : { doc: docs.entity }),
        },
      );
      return runnable(Schema("documented", {
        docAuthor: Author,
        docArticle: Article,
      }));
    };
    const assembleDocs = async (docs: Parameters<typeof schemaWithDocs>[0]) => {
      const schema = schemaWithDocs(docs);
      return Result.getOrThrow(
        (await assemble(schema)).require(CatalogId.make("documented")),
      );
    };
    const original = await assembleDocs({
      entity: "A documented article.",
      trait: "Supports tags.",
      directField: "Article title.",
      refField: "Article author.",
      composedField: "User-managed tags.",
      operation: "Add a tag.",
    });
    const replacement = await assembleDocs({
      entity: "Replacement entity docs.",
      trait: "Replacement trait docs.",
      directField: "Replacement title docs.",
      refField: "Replacement author docs.",
      composedField: "Replacement tag docs.",
      operation: "Replacement operation docs.",
    });
    const removed = await assembleDocs({});
    const catalog = original.unit.catalog;

    expect(catalog.entities.find((entry) => entry.id.name === "docArticle")?.doc)
      .toBe("A documented article.");
    expect(catalog.traits.find((entry) => entry.id.name === "docTaggable")?.doc)
      .toBe("Supports tags.");
    expect(catalog.fields.find((entry) => entry.id.localName === "title")?.doc)
      .toBe("Article title.");
    expect(catalog.fields.find((entry) => entry.id.localName === "author")?.doc)
      .toBe("Article author.");
    expect(catalog.fields.find((entry) => entry.id.localName === "tags")?.doc)
      .toBe("User-managed tags.");
    expect(catalog.operations.find((entry) => entry.id.localName === "addTag")?.doc)
      .toBe("Add a tag.");

    const identities = (installed: typeof original) => ({
      entities: installed.unit.catalog.entities.map((entry) => entry.id),
      traits: installed.unit.catalog.traits.map((entry) => entry.id),
      fields: installed.unit.catalog.fields.map((entry) => entry.id),
      operations: installed.unit.catalog.operations.map((entry) => entry.id),
    });
    expect(identities(replacement)).toEqual(identities(original));
    expect(identities(removed)).toEqual(identities(original));
    expect(replacement.unit.catalog.version).toBe(original.unit.catalog.version);
    expect(removed.unit.catalog.version).toBe(original.unit.catalog.version);
    expect(replacement.unitHash).not.toBe(original.unitHash);
    expect(removed.unitHash).not.toBe(original.unitHash);

    const serializedRemoved = JSON.parse(
      JSON.stringify(removed.unit.catalog),
    ) as typeof removed.unit.catalog;
    expect(serializedRemoved.entities.every((entry) => !("doc" in entry))).toBe(true);
    expect(serializedRemoved.traits.every((entry) => !("doc" in entry))).toBe(true);
    expect(serializedRemoved.fields.every((entry) => !("doc" in entry))).toBe(true);
    expect(serializedRemoved.operations.every((entry) => !("doc" in entry))).toBe(true);
  });

  test("binds the unit hash to fixed creation constraints", async () => {
    const Fixed = Trait("fixed", { value: string() }, {
      bind: (definition) => ({ values: { value: definition.key } }),
    });
    const Empty = Schema("fixed-constraint-value", {});
    const leftValue: CodeDefinition = { key: "left", schema: Empty };
    const rightValue: CodeDefinition = { key: "right", schema: Empty };
    const left = runnable(Schema("app", {
      item: Entity("item", {}, { traits: [Fixed(leftValue)] }),
    }));
    const right = runnable(Schema("app", {
      item: Entity("item", {}, { traits: [Fixed(rightValue)] }),
    }));

    const leftUnit = Result.getOrThrow(
      (await assemble(left)).require(CatalogId.make("app")),
    );
    const rightUnit = Result.getOrThrow(
      (await assemble(right)).require(CatalogId.make("app")),
    );
    expect(rightUnit.unit.catalog.fingerprint).toBe(leftUnit.unit.catalog.fingerprint);
    expect(rightUnit.unitHash).not.toBe(leftUnit.unitHash);
  });

  test("resolves every binding once and retains it for authoritative creation", async () => {
    const child = runnable(Schema("binding-child", {}));
    let calls = 0;
    const Bound = Trait("singleBind", { value: string() }, {
      bind: (definition) => {
        calls += 1;
        return {
          values: { value: `${definition.key}:${calls}` },
          dependencies: [definition],
        };
      },
    });
    const root = runnable(Schema("single-bind-root", {
      singleRoot: Entity("singleRoot", {}, { traits: [Bound(child)] }),
    }));

    const installed = Result.getOrThrow(
      (await assemble(root)).require(CatalogId.make("single-bind-root")),
    );
    expect(calls).toBe(1);
    expect(installed.resolveCreationValues(
      "singleRoot",
      {},
      { now: new Date(0) },
    )).toEqual({ value: "binding-child:1" });
    expect(calls).toBe(1);
  });

  test("isolates mutable fixed binding values from authors and callers", async () => {
    const originalDate = new Date("2025-01-02T03:04:05.000Z");
    const originalBytes = new Uint8Array([1, 2, 3]);
    const Fixed = Trait("mutableFixed", {
      at: timestamp(),
      data: bytes(),
    }, {
      bind: () => ({
        values: { at: originalDate, data: originalBytes },
      }),
    });
    const App = runnable(Schema("fixed-snapshot", {
      item: Entity("item", {}, {
        traits: [Fixed({ key: "fixed", schema: Schema("fixed-value-schema", {}) })],
      }),
    }));
    const installed = Result.getOrThrow(
      (await assemble(App)).require(CatalogId.make("fixed-snapshot")),
    );

    originalDate.setUTCFullYear(2030);
    originalBytes[0] = 9;
    const first = installed.resolveCreationValues("item", {}, { now: new Date(0) });
    expect(first).toEqual({
      at: new Date("2025-01-02T03:04:05.000Z"),
      data: new Uint8Array([1, 2, 3]),
    });
    (first.at as Date).setUTCFullYear(2040);
    (first.data as Uint8Array)[1] = 8;
    expect(installed.resolveCreationValues("item", {}, { now: new Date(0) }))
      .toEqual({
        at: new Date("2025-01-02T03:04:05.000Z"),
        data: new Uint8Array([1, 2, 3]),
      });
  });

  test("does not retain mutable entity and field authoring state", async () => {
    const Item = Entity("item", {
      value: string({
        default: creationDefault({ value: "sealed" }, (inputs) => inputs.value),
      }),
    });
    const App = runnable(Schema("frozen-authoring", { item: Item }));
    const installed = Result.getOrThrow(
      (await assemble(App)).require(CatalogId.make("frozen-authoring")),
    );

    expect(Object.isFrozen(Item)).toBe(false);
    expect(Object.isFrozen(Item.value)).toBe(false);
    expect(Reflect.set(
      Item.value,
      "default",
      creationDefault({ value: "mutated" }, (inputs) => inputs.value),
    )).toBe(true);
    expect(installed.resolveCreationValues("item", {}, { now: new Date(0) }))
      .toEqual({ value: "sealed" });
  });

  test("retains compiled field codecs instead of mutable schema objects", async () => {
    const MutableString = EffectSchema.String.annotate({
      identifier: "mutable-string",
    });
    const Item = Entity("item", { value: Field(MutableString) });
    const App = runnable(Schema("codec-snapshot", { item: Item }));
    const installed = Result.getOrThrow(
      (await assemble(App)).require(CatalogId.make("codec-snapshot")),
    );

    expect(Reflect.set(
      MutableString,
      "ast",
      EffectSchema.Finite.ast,
    )).toBe(true);
    expect(installed.resolveCreationValues(
      "item",
      { value: "still-a-string" },
      { now: new Date(0) },
    )).toEqual({ value: "still-a-string" });
    expect(() => installed.resolveCreationValues(
      "item",
      { value: 42 },
      { now: new Date(0) },
    )).toThrow(/invalid explicit value/);
  });

  test("binds inert field schema projections into the unit hash", async () => {
    const schemaFor = (values: readonly [string, ...string[]]) =>
      runnable(Schema("configured-codec", {
        item: Entity("item", {
          value: Field(stored(EffectSchema.Literals(values), "string")),
        }),
      }));
    const LeftSchema = schemaFor(["left"]);
    const RightSchema = schemaFor(["right"]);
    const left = Result.getOrThrow(
      (await assemble(LeftSchema)).require(CatalogId.make("configured-codec")),
    );
    const right = Result.getOrThrow(
      (await assemble(RightSchema)).require(CatalogId.make("configured-codec")),
    );

    expect(left.unitHash).not.toBe(right.unitHash);
    expect(left.resolveCreationValues(
      "item",
      { value: "left" },
      { now: new Date(0) },
    )).toEqual({ value: "left" });
    expect(() => left.resolveCreationValues(
      "item",
      { value: "right" },
      { now: new Date(0) },
    )).toThrow(/invalid explicit value/);
    expect(right.resolveCreationValues(
      "item",
      { value: "right" },
      { now: new Date(0) },
    )).toEqual({ value: "right" });
  });

  test("executes trusted deployed field refinements without reviving metadata", async () => {
    const trustedPrefix = "trusted:";
    const Captured = EffectSchema.String.check(EffectSchema.makeFilter((value) =>
      value.startsWith(trustedPrefix) ? true : "blocked"
    ));
    const definition = runnable(Schema("callback-field", {
      item: Entity("item", { value: Field(Captured) }),
    }));

    const installed = Result.getOrThrow(
      (await assemble(definition)).require(CatalogId.make("callback-field")),
    );
    expect(Reflect.set(Captured, "ast", EffectSchema.Finite.ast)).toBe(true);
    expect(installed.resolveCreationValues(
      "item",
      { value: "trusted:value" },
      { now: new Date(0) },
    )).toEqual({ value: "trusted:value" });
    expect(() => installed.resolveCreationValues(
      "item",
      { value: "blocked" },
      { now: new Date(0) },
    )).toThrow(/invalid explicit value/);
    expect(JSON.stringify(installed.unit)).not.toContain(trustedPrefix);
  });

  test("assembly isolates inert state and retains the original live operation callback", async () => {
    const fieldInputs = { value: "field-original" };
    const bindingInputs = { value: "binding-original" };
    const typedInputs = {
      at: new Date("2024-02-03T04:05:06.000Z"),
      data: new Uint8Array([4, 5, 6]),
    };
    const fixedDate = new Date("2025-01-02T03:04:05.000Z");
    const fixedBytes = new Uint8Array([1, 2, 3]);
    const fixedTags = ["one", "two"];
    const MutableFieldSchema = EffectSchema.String.annotate({
      identifier: "boundary-field",
    });
    const Input = EffectSchema.Struct({ value: EffectSchema.String });
    const Output = EffectSchema.Struct({ ok: EffectSchema.Boolean });
    const child = runnable(Schema("boundary-child", {}));
    const dependencyRefs: CodeDefinition[] = [child];
    const bindingValues = {
      at: fixedDate,
      data: fixedBytes,
      sign: -0,
      tags: fixedTags,
    };
    const bindingDefaults = {
      label: creationDefault(bindingInputs, (inputs) => inputs.value),
    };
    const bindingResult = {
      values: bindingValues,
      defaults: bindingDefaults,
      dependencies: dependencyRefs,
    };
    let bindingCalls = 0;
    const Bound = Trait("boundaryTrait", {
      at: timestamp(),
      data: bytes(),
      sign: float(),
      tags: Field.many(string()),
      label: string(),
    }, {
      doc: "original trait",
      bind: () => {
        bindingCalls++;
        return bindingResult;
      },
    });
    const Audit = Entity("boundaryAudit", { message: string() });
    let bodyCapture = "body-original";
    const Item = Entity("boundaryItem", {
      title: string({
        doc: "original field",
        default: creationDefault(fieldInputs, (inputs) => inputs.value),
      }),
      createdAt: timestamp({
        default: creationDefault({}, (_inputs, context) => context.now),
      }),
      capturedAt: timestamp({
        default: creationDefault(typedInputs, (inputs) => inputs.at),
      }),
      capturedData: bytes({
        default: creationDefault(typedInputs, (inputs) => inputs.data),
      }),
      checked: Field(MutableFieldSchema),
    }, {
      traits: [Bound(child)],
      doc: "original entity",
      operations: (Operation) => ({
        check: Operation({
          self: false,
          writes: [Audit],
          input: Input,
          output: Output,
          doc: "original operation",
          run: () => ({ ok: bodyCapture === "body-original" }),
        }),
      }),
    });
    const App = runnable(Schema("boundary-root", { boundaryItem: Item }));
    const authoredPolicy = appliedPolicyOf(App)!;
    const definition = App;
    const registry = await assemble(definition);
    const installed = Result.getOrThrow(
      registry.require(CatalogId.make("boundary-root")),
    );
    const sealedHash = installed.unitHash;
    const sealedUnit = JSON.stringify(installed.unit);
    const operation = Item[OwnedOperations].check;
    const installedOperation = installed.operations[0]!;
    const capturedDescriptor = installedOperation.descriptor;
    const capturedRun = installedOperation.run;

    fieldInputs.value = "field-mutated";
    bindingInputs.value = "binding-mutated";
    typedInputs.at.setUTCFullYear(2040);
    typedInputs.data[0] = 8;
    Item.capturedAt.default!({ now: new Date(0) })!.setUTCFullYear(2050);
    Item.capturedData.default!({ now: new Date(0) })![0] = 7;
    fixedDate.setUTCFullYear(2035);
    fixedBytes[0] = 9;
    fixedTags[0] = "mutated";
    bindingValues.sign = 42;
    bindingDefaults.label = creationDefault(
      { value: "replacement" },
      (inputs) => inputs.value,
    );
    dependencyRefs.length = 0;
    bodyCapture = "body-mutated";
    expect(Reflect.set(bindingResult, "values", {})).toBe(true);
    expect(Reflect.set(Item.title, "default", creationDefault(
      { value: "replacement" },
      (inputs) => inputs.value,
    ))).toBe(true);
    expect(Reflect.set(Item, "ns", "mutatedItem")).toBe(true);
    expect(Reflect.set(Item, DOCUMENTATION, "mutated entity")).toBe(true);
    expect(Reflect.set(Item.title, "doc", "mutated field")).toBe(true);
    expect(Reflect.set(Bound, DOCUMENTATION, "mutated trait")).toBe(true);
    expect(Reflect.set(Audit, "ns", "mutatedAudit")).toBe(true);
    expect(Reflect.set(operation, "doc", "mutated operation")).toBe(true);
    expect(Reflect.set(operation, "run", () => ({ ok: false }))).toBe(true);
    expect(Reflect.set(MutableFieldSchema, "ast", EffectSchema.Finite.ast)).toBe(true);
    expect(Reflect.set(
      Input,
      "ast",
      EffectSchema.Struct({ value: EffectSchema.Finite }).ast,
    )).toBe(true);
    expect(Reflect.set(
      Output,
      "ast",
      EffectSchema.Struct({ ok: EffectSchema.String }).ast,
    )).toBe(true);
    expect(Reflect.set(App.entities, "boundaryItem", Audit)).toBe(true);
    expect(Object.isFrozen(authoredPolicy)).toBe(true);

    expect(bindingCalls).toBe(1);
    expect(installed.unitHash).toBe(sealedHash);
    expect(JSON.stringify(installed.unit)).toBe(sealedUnit);
    expect("schema" in installed).toBe(false);
    expect("definition" in installed).toBe(false);
    expect(installedOperation.descriptor).toBe(
      installed.unit.catalog.operations[0]!,
    );
    expect(installedOperation.descriptor).toBe(capturedDescriptor);
    expect(installedOperation.run).toBe(capturedRun);
    expect(installedOperation.run).not.toBe(operation.run);
    expect(await installedOperation.run({}, {})).toEqual({ ok: false });
    expect("run" in installedOperation.descriptor).toBe(false);
    expect(installedOperation.descriptor.id.owner).toEqual({
      kind: "entity",
      name: "boundaryItem",
    });
    expect(installedOperation.descriptor.writes.map((entry) => entry.name))
      .toEqual(["boundaryAudit"]);
    expect(installedOperation.input.decode({ value: "stable" }))
      .toEqual({ value: "stable" });
    expect(() => installedOperation.input.decode({ value: 1 })).toThrow();
    expect(installedOperation.output.encode({ ok: true }))
      .toEqual({ ok: true });
    expect(installed.resolveCreationValues(
      "boundaryItem",
      { checked: "still-a-string" },
      { now: new Date(0) },
    )).toEqual({
      title: "field-original",
      createdAt: new Date(0),
      capturedAt: new Date("2024-02-03T04:05:06.000Z"),
      capturedData: new Uint8Array([4, 5, 6]),
      checked: "still-a-string",
      at: new Date("2025-01-02T03:04:05.000Z"),
      data: new Uint8Array([1, 2, 3]),
      sign: 0,
      tags: ["one", "two"],
      label: "binding-original",
    });
    expect(registry.keys().map(String)).toEqual([
      "boundary-child",
      "boundary-root",
    ]);
  });

  test("deduplicates stable trait IDs while retaining every bound dependency", async () => {
    const left = runnable(Schema("left-child", {}));
    const right = runnable(Schema("right-child", {}));
    const Graph = Trait("multiGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: "shared" },
        dependencies: [catalog],
      }),
    });
    const Root = Entity("multiRoot", {}, {
      traits: [Graph(left), Graph(right)],
    });
    const root = runnable(Schema("multi-root", { multiRoot: Root }));

    const registry = await assemble(root);
    expect(registry.keys().map(String)).toEqual([
      "left-child",
      "multi-root",
      "right-child",
    ]);
    const installed = Result.getOrThrow(
      registry.require(CatalogId.make("multi-root")),
    );
    expect(installed.unit.catalog.entities[0]!.traits).toHaveLength(1);
  });

  test("executes declared inputs and bare deployed callbacks natively", async () => {
    const make = (value: string) =>
      creationDefault({ value }, (inputs) => {
        const decoded = EffectSchema.decodeSync(EffectSchema.String)(inputs.value);
        return decoded.toUpperCase().toLowerCase();
      });
    const left = runnable(Schema("defaults", { item: Entity("item", {
      value: string({ default: make("left") }),
    }) }));
    const right = runnable(Schema("defaults", { item: Entity("item", {
      value: string({ default: make("right") }),
    }) }));
    const leftUnit = Result.getOrThrow(
      (await assemble(left)).require(CatalogId.make("defaults")),
    );
    const rightUnit = Result.getOrThrow(
      (await assemble(right)).require(CatalogId.make("defaults")),
    );
    expect(rightUnit.unitHash).not.toBe(leftUnit.unitHash);

    const mutable = { value: "snapshot" };
    const SnapshotSchema = runnable(Schema("snapshot-default", { item: Entity("item", {
      value: string({
        default: creationDefault(mutable, (inputs) => inputs.value),
      }),
    }) }));
    const snapshot = SnapshotSchema;
    const installedSnapshot = Result.getOrThrow(
      (await assemble(snapshot)).require(CatalogId.make("snapshot-default")),
    );
    mutable.value = "mutated";
    expect(resolveCreationValues(
      SnapshotSchema.entities.item!,
      {},
      { now: new Date(0) },
    )).toEqual({ value: "snapshot" });
    expect(Result.getOrThrow(
      (await assemble(snapshot)).require(CatalogId.make("snapshot-default")),
    ).unitHash).toBe(installedSnapshot.unitHash);

    const trustedPrefix = "native-default-capture";
    const Bound = Trait("nativeBound", {
      composedAt: timestamp(),
    }, {
      bind: () => ({
        defaults: {
          composedAt: ({ now }) => new Date(now.getTime()),
        },
      }),
    });
    const NativeSchema = runnable(Schema("native-default", { nativeItem: Entity("nativeItem", {
      label: string({ default: ({ now }) => {
        const imported = EffectSchema.decodeSync(EffectSchema.String)(trustedPrefix);
        return [imported, now.toISOString()].join(":");
      } }),
      createdAt: timestamp({
        default: ({ now }) => new Date(now.getTime()),
      }),
      data: bytes({
        default: () => Uint8Array.from([1, 2, 3].map((value) => value * 2)),
      }),
    }, {
      traits: [Bound({ key: "native", schema: Schema("native-bound-schema", {}) })],
    }) }));
    const native = Result.getOrThrow(
      (await assemble(NativeSchema)).require(CatalogId.make("native-default")),
    );
    const now = new Date("2026-08-28T12:34:56.000Z");
    expect(native.resolveCreationValues("nativeItem", {}, { now })).toEqual({
      label: `${trustedPrefix}:${now.toISOString()}`,
      createdAt: now,
      data: new Uint8Array([2, 4, 6]),
      composedAt: now,
    });
    expect(JSON.stringify(native.unit)).not.toContain(trustedPrefix);
  });

  test("fails closed when default descriptors and native callbacks do not pair exactly", () => {
    const evaluate = () => "native";
    const Item = Entity("pairedDefault", {
      value: string({ default: evaluate }),
    });
    const snapshot = compileCreationPlan(
      Item,
      compositionValueMetadata(Item),
      artifactHash,
    );
    const binding = snapshot.defaults[0]!;
    const descriptor = snapshot.plan.fields[0]!.fieldDefault!;

    expect(binding.evaluate).toBe(evaluate);
    expect(pairDeployedCreationDefaults(
      [snapshot.plan],
      [binding],
    ).require(descriptor)).toBe(evaluate);

    expect(() => pairDeployedCreationDefaults([snapshot.plan], []))
      .toThrow(/missing deployed binding/);
    expect(() => pairDeployedCreationDefaults(
      [snapshot.plan],
      [binding, binding],
    )).toThrow(/duplicate deployed binding/);
    expect(() => pairDeployedCreationDefaults([{
      ...snapshot.plan,
      fields: Object.freeze([
        ...snapshot.plan.fields,
        snapshot.plan.fields[0]!,
      ]),
    }], [binding])).toThrow(/duplicate descriptor/);
    expect(() => pairDeployedCreationDefaults([snapshot.plan], [{
      ...binding,
      artifactHash: "different-build",
    }])).toThrow(/mismatched deployed binding/);
  });

  test("preserves own __proto__ default inputs in evaluation and identity", async () => {
    type DangerousInputs = {
      readonly ["__proto__"]: { readonly value: string };
    };
    const make = (value: string) => creationDefault(
      JSON.parse(`{"__proto__":{"value":${JSON.stringify(value)}}}`) as DangerousInputs,
      (inputs) => inputs.__proto__.value,
    );
    const schemaFor = (value: string) => runnable(Schema("proto", {
      item: Entity("item", { value: string({ default: make(value) }) }),
    }));
    const LeftSchema = schemaFor("left");
    const RightSchema = schemaFor("right");
    const left = Result.getOrThrow(
      (await assemble(LeftSchema)).require(CatalogId.make("proto")),
    );
    const right = Result.getOrThrow(
      (await assemble(RightSchema)).require(CatalogId.make("proto")),
    );

    expect(left.resolveCreationValues("item", {}, { now: new Date(0) }))
      .toEqual({ value: "left" });
    expect(right.unitHash).not.toBe(left.unitHash);
  });

  test("gives typed default inputs unambiguous canonical identities", async () => {
    const make = (
      value: Date | { readonly _tag: string; readonly value: string },
    ) => creationDefault({ value }, () => "same");
    const schemaFor = (
      value: Date | { readonly _tag: string; readonly value: string },
    ) => runnable(Schema("typed-input", {
      item: Entity("item", { value: string({ default: make(value) }) }),
    }));
    const instant = new Date("2024-01-02T03:04:05.000Z");
    const lookalike = {
      _tag: "instant",
      value: "2024-01-02T03:04:05.000Z",
    };
    const TypedSchema = schemaFor(instant);
    const JsonSchema = schemaFor(lookalike);
    const typed = Result.getOrThrow(
      (await assemble(TypedSchema)).require(CatalogId.make("typed-input")),
    );
    const json = Result.getOrThrow(
      (await assemble(JsonSchema)).require(CatalogId.make("typed-input")),
    );

    expect(typed.unitHash).not.toBe(json.unitHash);
  });

  test("normalizes negative zero in defaults and fixed bindings", async () => {
    const defaultSchema = (value: number) => runnable(Schema("zero", {
      item: Entity("item", {
        sign: string({
          default: creationDefault(
            { value },
            (inputs) => inputs.value === 0 ? "positive" : "negative",
          ),
        }),
      }),
    }));
    const NegativeSchema = defaultSchema(-0);
    const PositiveSchema = defaultSchema(0);
    const negative = Result.getOrThrow(
      (await assemble(NegativeSchema)).require(CatalogId.make("zero")),
    );
    const positive = Result.getOrThrow(
      (await assemble(PositiveSchema)).require(CatalogId.make("zero")),
    );
    expect(negative.unitHash).toBe(positive.unitHash);
    expect(negative.resolveCreationValues("item", {}, { now: new Date(0) }))
      .toEqual({ sign: "positive" });

    const Fixed = Trait("zeroFixed", { value: float() }, {
      bind: () => ({ values: { value: -0 } }),
    });
    const FixedSchema = runnable(Schema("fixed-zero", {
      fixed: Entity("fixed", {}, {
        traits: [Fixed({ key: "zero-fixed", schema: Schema("zero-fixed-schema", {}) })],
      }),
    }));
    const fixed = Result.getOrThrow(
      (await assemble(FixedSchema)).require(CatalogId.make("fixed-zero")),
    );
    expect(fixed.resolveCreationValues("fixed", {}, { now: new Date(0) }))
      .toEqual({ value: 0 });
    expect(Object.is(
      fixed.resolveCreationValues("fixed", {}, { now: new Date(0) }).value,
      -0,
    )).toBe(false);
  });

  test("rejects duplicate permanent keys with both internal reachability paths", async () => {
    const left = runnable(Schema("duplicate", {}));
    const right = runnable(Schema("duplicate", {}));
    const Graph = Trait("duplicateGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
        dependencies: [catalog],
      }),
    });
    const Left = Entity("left", {}, { traits: [Graph(left)] });
    const Right = Entity("right", {}, { traits: [Graph(right)] });
    const root = runnable(Schema("root", { left: Left, right: Right }));

    const failure = await assembleFailure(root);
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/permanent key "duplicate" names different definitions/);
    expect(failure.message).toMatch(/entity:left.*binding:duplicate/);
    expect(failure.message).toMatch(/entity:right.*binding:duplicate/);
  });

  test("rejects reachable non-runnable definitions and ignores unreachable imports", async () => {
    const PlainSchema = Schema("plain-schema", {});
    const plain: CodeDefinition = { key: "plain", schema: PlainSchema };
    const Graph = Trait("plainGraph", { catalog: string() }, {
      bind: (catalog) => ({ dependencies: [catalog] }),
    });
    const RootEntity = Entity("root", {}, { traits: [Graph(plain)] });
    const root = runnable(Schema("root", { root: RootEntity }));
    const unused = runnable(Schema("unused", {}));

    const failure = await assembleFailure(root);
    expect(failure.message).toMatch(/key 'plain' has no runnable Schema definition/);

    const isolated = runnable(Schema("isolated", {}));
    const registry = await assemble(isolated);
    expect(registry.keys().map(String)).toEqual(["isolated"]);
    expect(registry.keys().map(String)).not.toContain(unused.key);
  });

  test("rejects out-of-schema policy identities and retains explicit operation writes", async () => {
    const Outside = Entity("outside", { name: string() });
    const RootOnly = Entity("rootOnly", {});
    const invalidDefinition = Schema("invalid", { rootOnly: RootOnly });
    expect(() =>
      invalidDefinition.applyPolicy(({ policy }) => {
        policy.rootOnly.read.where(eq(Outside.name, "outside"));
      })
    ).toThrow(/'outside' is not in this catalog/);

    const RootWithWrite = Entity("rootWithWrite", {}, {
      operations: (Operation) => ({
        touchOutside: Operation({
          self: false,
          writes: [Outside],
          input: EffectSchema.Struct({}),
          output: EffectSchema.Struct({}),
          run() {
            return {};
          },
        }),
      }),
    });
    const validDefinition = runnable(Schema("valid", {
      rootWithWrite: RootWithWrite,
    }));
    const registry = await assemble(validDefinition);
    const installed = Result.getOrThrow(registry.require(CatalogId.make("valid")));
    expect(installed.unit.catalog.entities.map((entry) => entry.id.name)).toEqual([
      "outside",
      "rootWithWrite",
    ]);
  });

  test("missing definitions and mixed hashes fail closed at lookup", async () => {
    const definition = runnable(Schema("app", {}));
    const registry = await assemble(definition);

    const missing = registry.require(CatalogId.make("missing"));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(missing.failure).toBeInstanceOf(CatalogMismatch);
      expect(opaqueCatalogDenial(missing.failure)._tag).toBe("Unauthorized");
    }

    const mismatch = resolveCatalogDefinition(registry, {
      catalogKey: CatalogId.make("app"),
      unitHash: CatalogUnitHash.make("f".repeat(64)),
    });
    expect(Result.isFailure(mismatch)).toBe(true);
    if (Result.isFailure(mismatch)) {
      expect(mismatch.failure).toBeInstanceOf(CatalogVersionMismatch);
      expect(opaqueCatalogDenial(mismatch.failure)._tag).toBe("Unauthorized");
    }
  });
});
