/** Permanent-key catalog definition assembly (#323). */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import {
  Catalog,
  type CatalogDefinition,
} from "../../../src/Catalog.ts";
import {
  Entity,
  Schema,
  Trait,
  creationDefault,
  resolveCreationValues,
  string,
  type AnySchema,
  type CodeDefinition,
} from "../../../src/db/internal.ts";
import {
  CatalogId,
  CatalogMismatch,
  CatalogUnitHash,
  CatalogVersionMismatch,
  DigestHex,
  InvalidIR,
  allow,
  assembleCatalogDefinitions,
  compileReadAuthorization,
  opaqueCatalogDenial,
  read,
  resolveCatalogDefinition,
} from "../../../src/internal/authorization/index.ts";

const artifactHash = DigestHex.make("a".repeat(64));

const policy = (
  schema: AnySchema,
  rules: Parameters<typeof compileReadAuthorization>[0]["rules"] = [],
) => Effect.runPromise(compileReadAuthorization({ schema, rules }));

const assemble = (root: CatalogDefinition, hash = artifactHash) =>
  Effect.runPromise(assembleCatalogDefinitions({ root, artifactHash: hash }));

const assembleFailure = (root: CatalogDefinition) =>
  Effect.runPromise(Effect.flip(assembleCatalogDefinitions({ root, artifactHash })));

describe("Catalog", () => {
  test("constructs one frozen permanently keyed runnable definition", async () => {
    const App = Schema({});
    const definition = Catalog("app", { schema: App, policy: await policy(App) });

    expect(definition).toEqual({
      _tag: "Catalog",
      key: "app",
      schema: App,
      policy: definition.policy,
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => Catalog("", { schema: App, policy: definition.policy })).toThrow(
      /permanent key must not be empty/,
    );
  });

  test("accepts the supported root Policy compiler Effect directly", async () => {
    const App = Schema({});
    const definition = Catalog("effect-policy", {
      schema: App,
      policy: compileReadAuthorization({ schema: App, rules: [] }),
    });

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

    let root!: CatalogDefinition;
    let child!: CatalogDefinition;
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
    const RootSchema = Schema({ rootNode: RootNode });
    const ChildSchema = Schema({ childNode: ChildNode });
    root = Catalog("root", { schema: RootSchema, policy: await policy(RootSchema) });
    child = Catalog("child", { schema: ChildSchema, policy: await policy(ChildSchema) });

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
    expect(installedRoot.operations.map((entry) => entry.localName)).toEqual([
      "audit",
      "inspect",
    ]);
    expect(installedRoot.operations[0]!.writes).toEqual([Audit]);
    expect(installedRoot.resolveCreationValues(
      "rootNode",
      { title: "Root" },
      { now: new Date(0) },
    )).toEqual({ title: "Root", catalog: "child" });
    expect(Object.isFrozen(installedRoot)).toBe(true);
    expect(Object.isFrozen(installedRoot.unit)).toBe(true);
  });

  test("binds the unit hash to the deployed artifact", async () => {
    const App = Schema({ item: Entity("item", { name: string() }) });
    const definition = Catalog("app", { schema: App, policy: await policy(App) });
    const first = await assemble(definition);
    const second = await assemble(
      definition,
      DigestHex.make("b".repeat(64)),
    );

    expect(Result.getOrThrow(first.require(CatalogId.make("app"))).unitHash)
      .not.toBe(Result.getOrThrow(second.require(CatalogId.make("app"))).unitHash);
  });

  test("binds the unit hash to fixed creation constraints", async () => {
    const Fixed = Trait("fixed", { value: string() }, {
      bind: (definition) => ({ values: { value: definition.key } }),
    });
    const Empty = Schema({});
    const leftValue: CodeDefinition = { key: "left", schema: Empty };
    const rightValue: CodeDefinition = { key: "right", schema: Empty };
    const LeftSchema = Schema({ item: Entity("item", {}, { traits: [Fixed(leftValue)] }) });
    const RightSchema = Schema({ item: Entity("item", {}, { traits: [Fixed(rightValue)] }) });
    const left = Catalog("app", {
      schema: LeftSchema,
      policy: await policy(LeftSchema),
    });
    const right = Catalog("app", {
      schema: RightSchema,
      policy: await policy(RightSchema),
    });

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
    const ChildSchema = Schema({});
    const child = Catalog("binding-child", {
      schema: ChildSchema,
      policy: await policy(ChildSchema),
    });
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
    const RootSchema = Schema({
      singleRoot: Entity("singleRoot", {}, { traits: [Bound(child)] }),
    });
    const root = Catalog("single-bind-root", {
      schema: RootSchema,
      policy: await policy(RootSchema),
    });

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

  test("deduplicates stable trait IDs while retaining every bound dependency", async () => {
    const Empty = Schema({});
    const left = Catalog("left-child", { schema: Empty, policy: await policy(Empty) });
    const right = Catalog("right-child", { schema: Empty, policy: await policy(Empty) });
    const Graph = Trait("multiGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: "shared" },
        dependencies: [catalog],
      }),
    });
    const Root = Entity("multiRoot", {}, {
      traits: [Graph(left), Graph(right)],
    });
    const RootSchema = Schema({ multiRoot: Root });
    const root = Catalog("multi-root", {
      schema: RootSchema,
      policy: await policy(RootSchema),
    });

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

  test("binds declared captured default inputs and rejects undeclared captures", async () => {
    const make = (value: string) =>
      creationDefault({ value }, (inputs) => inputs.value);
    const LeftSchema = Schema({ item: Entity("item", {
      value: string({ default: make("left") }),
    }) });
    const RightSchema = Schema({ item: Entity("item", {
      value: string({ default: make("right") }),
    }) });
    const left = Catalog("defaults", {
      schema: LeftSchema,
      policy: await policy(LeftSchema),
    });
    const right = Catalog("defaults", {
      schema: RightSchema,
      policy: await policy(RightSchema),
    });
    const leftUnit = Result.getOrThrow(
      (await assemble(left)).require(CatalogId.make("defaults")),
    );
    const rightUnit = Result.getOrThrow(
      (await assemble(right)).require(CatalogId.make("defaults")),
    );
    expect(rightUnit.unitHash).not.toBe(leftUnit.unitHash);

    const mutable = { value: "snapshot" };
    const SnapshotSchema = Schema({ item: Entity("item", {
      value: string({
        default: creationDefault(mutable, (inputs) => inputs.value),
      }),
    }) });
    const snapshot = Catalog("snapshot-default", {
      schema: SnapshotSchema,
      policy: await policy(SnapshotSchema),
    });
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

    const UnsafeSchema = Schema({ item: Entity("item", {
      value: string({ default: () => "captured" }),
    }) });
    const unsafe = Catalog("unsafe-default", {
      schema: UnsafeSchema,
      policy: await policy(UnsafeSchema),
    });
    expect((await assembleFailure(unsafe)).message).toMatch(
      /must declare canonical captured inputs with creationDefault/,
    );
  });

  test("preserves own __proto__ default inputs in evaluation and identity", async () => {
    type DangerousInputs = {
      readonly ["__proto__"]: { readonly value: string };
    };
    const make = (value: string) => creationDefault(
      JSON.parse(`{"__proto__":{"value":${JSON.stringify(value)}}}`) as DangerousInputs,
      (inputs) => inputs.__proto__.value,
    );
    const schemaFor = (value: string) => Schema({
      item: Entity("item", { value: string({ default: make(value) }) }),
    });
    const LeftSchema = schemaFor("left");
    const RightSchema = schemaFor("right");
    const left = Result.getOrThrow(
      (await assemble(Catalog("proto", {
        schema: LeftSchema,
        policy: await policy(LeftSchema),
      }))).require(CatalogId.make("proto")),
    );
    const right = Result.getOrThrow(
      (await assemble(Catalog("proto", {
        schema: RightSchema,
        policy: await policy(RightSchema),
      }))).require(CatalogId.make("proto")),
    );

    expect(left.resolveCreationValues("item", {}, { now: new Date(0) }))
      .toEqual({ value: "left" });
    expect(right.unitHash).not.toBe(left.unitHash);
  });

  test("rejects duplicate permanent keys with both internal reachability paths", async () => {
    const Empty = Schema({});
    const left = Catalog("duplicate", { schema: Empty, policy: await policy(Empty) });
    const right = Catalog("duplicate", { schema: Empty, policy: await policy(Empty) });
    const Graph = Trait("duplicateGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
        dependencies: [catalog],
      }),
    });
    const Left = Entity("left", {}, { traits: [Graph(left)] });
    const Right = Entity("right", {}, { traits: [Graph(right)] });
    const RootSchema = Schema({ left: Left, right: Right });
    const root = Catalog("root", {
      schema: RootSchema,
      policy: await policy(RootSchema),
    });

    const failure = await assembleFailure(root);
    expect(failure).toBeInstanceOf(InvalidIR);
    expect(failure.message).toMatch(/permanent key "duplicate" names different definitions/);
    expect(failure.message).toMatch(/entity:left.*binding:duplicate/);
    expect(failure.message).toMatch(/entity:right.*binding:duplicate/);
  });

  test("rejects reachable non-runnable definitions and ignores unreachable imports", async () => {
    const Empty = Schema({});
    const plain: CodeDefinition = { key: "plain", schema: Empty };
    const Graph = Trait("plainGraph", { catalog: string() }, {
      bind: (catalog) => ({ dependencies: [catalog] }),
    });
    const RootEntity = Entity("root", {}, { traits: [Graph(plain)] });
    const RootSchema = Schema({ root: RootEntity });
    const root = Catalog("root", {
      schema: RootSchema,
      policy: await policy(RootSchema),
    });
    const unused = Catalog("unused", { schema: Empty, policy: await policy(Empty) });

    const failure = await assembleFailure(root);
    expect(failure.message).toMatch(/key 'plain' has no runnable Catalog definition/);

    const isolated = Catalog("isolated", { schema: Empty, policy: await policy(Empty) });
    const registry = await assemble(isolated);
    expect(registry.keys().map(String)).toEqual(["isolated"]);
    expect(registry.keys().map(String)).not.toContain(unused.key);
  });

  test("admits policy identities only when an explicit operation write contributes them", async () => {
    const Outside = Entity("outside", { name: string() });
    const RootOnly = Entity("rootOnly", {});
    const RootOnlySchema = Schema({ rootOnly: RootOnly });
    const PolicySchema = Schema({ rootOnly: RootOnly, outside: Outside });
    const outsidePolicy = await policy(PolicySchema, [read(Outside).when(allow)]);
    const invalidDefinition = Catalog("invalid", {
      schema: RootOnlySchema,
      policy: outsidePolicy,
    });

    const invalidFailure = await assembleFailure(invalidDefinition);
    expect(invalidFailure.message).toMatch(/missing entity 'outside'/);

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
    const RootWithWriteSchema = Schema({ rootWithWrite: RootWithWrite });
    const FullSchema = Schema({ rootWithWrite: RootWithWrite, outside: Outside });
    const validDefinition = Catalog("valid", {
      schema: RootWithWriteSchema,
      policy: await policy(FullSchema, [read(Outside).when(allow)]),
    });
    const registry = await assemble(validDefinition);
    const installed = Result.getOrThrow(registry.require(CatalogId.make("valid")));
    expect(installed.unit.catalog.entities.map((entry) => entry.id.name)).toEqual([
      "outside",
      "rootWithWrite",
    ]);
  });

  test("missing definitions and mixed hashes fail closed at lookup", async () => {
    const App = Schema({});
    const definition = Catalog("app", { schema: App, policy: await policy(App) });
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
