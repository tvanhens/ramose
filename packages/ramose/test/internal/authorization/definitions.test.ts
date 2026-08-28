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
    expect(resolveCreationValues(
      installedRoot.schema.entities.rootNode!,
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
