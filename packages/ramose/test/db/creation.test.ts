import { describe, expect, test } from "bun:test";
import {
  BindingConflictError,
  CreationValueError,
  Entity,
  Field,
  ReachabilityConflictError,
  Schema,
  Trait,
  assertNoFixedValues,
  collectCodeReachability,
  compositionValueMetadata,
  resolveCreationValues,
  string,
  timestamp,
  type CodeDefinition,
} from "../../src/db/internal.ts";

const fixedNow = new Date("2026-08-27T12:34:56.000Z");

describe("creation defaults", () => {
  test("explicit, composition, and field defaults have exact precedence", () => {
    const Bound = Trait(
      "bound",
      {
        catalog: string(),
        label: string({ default: () => "field" }),
        fallback: string({ default: () => "field-fallback" }),
      },
      {
        bind: (catalog) => ({
          values: { catalog: catalog.key },
          defaults: {
            label: () => "composition",
            fallback: () => undefined,
          },
          dependencies: [catalog],
        }),
      },
    );
    const child = { key: "child", schema: Schema({}) };
    const Node = Entity("node", { title: string() }, { traits: [Bound(child)] });

    expect(
      resolveCreationValues(
        Node,
        { title: "t", label: "explicit" },
        { now: fixedNow },
      ),
    ).toEqual({
      title: "t",
      catalog: "child",
      label: "explicit",
      fallback: "field-fallback",
    });
    expect(
      resolveCreationValues(
        Node,
        { title: "t", label: undefined },
        { now: fixedNow },
      ).label,
    ).toBe("composition");
  });

  test("all defaults observe one authoritative now and cannot observe each other", () => {
    const observed: Date[] = [];
    const Event = Entity("event", {
      first: timestamp({ default: ({ now }) => {
        observed.push(now);
        return now;
      } }),
      second: timestamp({ default: ({ now }) => {
        observed.push(now);
        return now;
      } }),
    });

    const row = resolveCreationValues(Event, {}, { now: fixedNow });
    expect(row).toEqual({ first: fixedNow, second: fixedNow });
    expect(observed.map((now) => now.getTime())).toEqual([
      fixedNow.getTime(),
      fixedNow.getTime(),
    ]);
    expect(observed[0]).not.toBe(observed[1]);
  });

  test("undefined defaults remain missing and required fields fail", () => {
    const Required = Entity("required", {
      value: string({ default: () => undefined }),
    });
    expect(() => resolveCreationValues(Required, {}, { now: fixedNow })).toThrow(
      /missing required field :required\/value/,
    );
  });

  test("cardinality-many defaults validate and resolve as arrays", () => {
    const Tagged = Entity("tagged", {
      tags: Field.many(string(), { default: () => ["new"] }),
    });
    expect(resolveCreationValues(Tagged, {}, { now: fixedNow })).toEqual({
      tags: ["new"],
    });
  });

  test("resolved explicit, default, and fixed values are schema validated", () => {
    const Bound = Trait("boundValue", { catalog: string() }, {
      bind: () => ({ values: { catalog: 42 as unknown as string } }),
    });
    const child = { key: "child", schema: Schema({}) };
    const Item = Entity("item", { title: string() }, { traits: [Bound(child)] });
    expect(() =>
      resolveCreationValues(Item, { title: "ok" }, { now: fixedNow }),
    ).toThrow(/invalid fixed value for :boundValue\/catalog/);

    const Plain = Entity("plain", { title: string() });
    expect(() =>
      resolveCreationValues(Plain, { title: 42 }, { now: fixedNow }),
    ).toThrow(CreationValueError);
  });

  test("callers cannot supply fixed values, even as undefined", () => {
    const Bound = Trait("protected", { catalog: string() }, {
      bind: (catalog) => ({ values: { catalog: catalog.key } }),
    });
    const child = { key: "child", schema: Schema({}) };
    const Node = Entity("protectedNode", {}, { traits: [Bound(child)] });

    expect(() =>
      resolveCreationValues(Node, { catalog: undefined }, { now: fixedNow }),
    ).toThrow(/engine-owned/);
    expect(() => assertNoFixedValues(Node, { catalog: "forged" })).toThrow(
      /engine-owned/,
    );
  });

  test("metadata resolution does not execute any default", () => {
    let calls = 0;
    const Bound = Trait("lazyDefault", {
      value: string({ default: () => {
        calls++;
        return "field";
      } }),
    }, {
      bind: () => ({ defaults: { value: () => {
        calls++;
        return "binding";
      } } }),
    });
    const Node = Entity("lazyNode", {}, {
      traits: [Bound({ key: "child", schema: Schema({}) })],
    });
    compositionValueMetadata(Node);
    expect(calls).toBe(0);
  });
});

describe("trait binding values", () => {
  test("a binding keeps one stable trait and field identity", () => {
    const Graph = Trait("graph", { catalog: string(), name: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
        dependencies: [catalog],
      }),
    });
    const child = { key: "workspace", schema: Schema({}) };
    const Workspace = Entity("workspace", {}, { traits: [Graph(child)] });

    expect(Object.is(Workspace.catalog, Graph.catalog)).toBe(true);
    expect(Workspace.catalog.ident).toBe(":graph/catalog");
    expect(Workspace.traits[0]!.ns).toBe("graph");
    expect(resolveCreationValues(Workspace, { name: "acme" }, { now: fixedNow }))
      .toEqual({ catalog: "workspace", name: "acme" });
  });

  test("different fixed bindings on one reachable field fail with both paths", () => {
    const Graph = Trait("graphConflict", { catalog: string() }, {
      bind: (catalog) => ({ values: { catalog: catalog.key } }),
    });
    const left = { key: "left", schema: Schema({}) };
    const right = { key: "right", schema: Schema({}) };
    const Broken = Entity("broken", {}, {
      traits: [Graph(left), Graph(right)],
    });
    expect(() => compositionValueMetadata(Broken)).toThrow(BindingConflictError);
    expect(() => compositionValueMetadata(Broken)).toThrow(
      /paths: .*binding:left.*binding:right/,
    );
  });

  test("bindable traits must be bound before composition", () => {
    const Bound = Trait("mustBind", { key: string() }, {
      bind: (definition) => ({ values: { key: definition.key } }),
    });
    expect(() => Entity("badBinding", {}, { traits: [Bound] })).toThrow(
      /must be called with a code definition/,
    );
  });
});

describe("code reachability", () => {
  test("recursive graphs terminate and equivalent diamonds deduplicate by key", () => {
    const Graph = Trait("reachableGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
        dependencies: [catalog],
      }),
    });

    let root!: CodeDefinition;
    let child!: CodeDefinition;
    const RootNode = Entity("rootNode", {}, { traits: [Graph(() => child)] });
    const SecondRootNode = Entity("secondRootNode", {}, {
      traits: [Graph(() => child)],
    });
    const ChildNode = Entity("childNode", {}, { traits: [Graph(() => root)] });
    root = {
      key: "root",
      schema: Schema({ rootNode: RootNode, secondRootNode: SecondRootNode }),
    };
    child = { key: "child", schema: Schema({ childNode: ChildNode }) };

    const reachable = collectCodeReachability(root);
    expect(reachable.definitions.map((item) => item.key)).toEqual(["root", "child"]);
    expect(reachable.bindings).toHaveLength(3);
  });

  test("duplicate permanent keys on different definitions name both paths", () => {
    const Graph = Trait("duplicateGraph", { catalog: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
        dependencies: [catalog],
      }),
    });
    const first = { key: "duplicate", schema: Schema({}) };
    const second = { key: "duplicate", schema: Schema({}) };
    const Left = Entity("leftNode", {}, { traits: [Graph(first)] });
    const Right = Entity("rightNode", {}, { traits: [Graph(second)] });
    const root = {
      key: "root",
      schema: Schema({ leftNode: Left, rightNode: Right }),
    };

    expect(() => collectCodeReachability(root)).toThrow(ReachabilityConflictError);
    expect(() => collectCodeReachability(root)).toThrow(
      /permanent key "duplicate" names different definitions \(paths: .*leftNode.*rightNode/,
    );
  });
});
