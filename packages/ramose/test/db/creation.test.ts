import { describe, expect, test } from "bun:test";
import {
  BindingConflictError,
  CreationValueError,
  Entity,
  Field,
  Query,
  Ref,
  Schema,
  Trait,
  assertNoFixedValues,
  compositionValueMetadata,
  resolveCreationValues,
  refTargetOf,
  string,
  timestamp,
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
        }),
      },
    );
    const child = Schema("child", {});
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

  test("converting a defaulted scalar to many requires an array default", () => {
    const scalar = string({ default: () => "new" });
    expect(() => Field.many(scalar as never)).toThrow(
      /requires a new array default/,
    );
    const tags = Field.many(scalar, { default: () => ["new"] });
    const Tagged = Entity("convertedTags", { tags });
    expect(resolveCreationValues(Tagged, {}, { now: fixedNow })).toEqual({
      tags: ["new"],
    });
  });

  test("resolved explicit, default, and fixed values are schema validated", () => {
    const Bound = Trait("boundValue", { catalog: string() }, {
      bind: () => ({ values: { catalog: 42 as unknown as string } }),
    });
    const child = Schema("child", {});
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
    const child = Schema("child", {});
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
      traits: [Bound(Schema("child", {}))],
    });
    compositionValueMetadata(Node);
    expect(calls).toBe(0);
  });
});

describe("trait binding values", () => {
  test("a binding keeps one stable trait and field identity", () => {
    const CatalogBinding = Trait("graph", { catalog: string(), name: string() }, {
      bind: (catalog) => ({
        values: { catalog: catalog.key },
      }),
    });
    const child = Schema("workspace", {});
    const Workspace = Entity("workspace", {}, { traits: [CatalogBinding(child)] });

    expect(Object.is(Workspace.catalog, CatalogBinding.catalog)).toBe(true);
    expect(Workspace.catalog.ident).toBe(":graph/catalog");
    expect(Workspace.traits[0]!.ns).toBe("graph");
    expect(resolveCreationValues(Workspace, { name: "acme" }, { now: fixedNow }))
      .toEqual({ catalog: "workspace", name: "acme" });
  });

  test("the bindable trait remains a query and reference root", () => {
    const CatalogBinding = Trait("composerBinding", { catalog: string() }, {
      bind: (catalog) => ({ values: { catalog: catalog.key } }),
    });

    expect(Query.from(CatalogBinding)._tag).toBe("Query");
    const target = refTargetOf(Ref(CatalogBinding).schema)?.();
    expect(target?.ns).toBe("composerBinding");
    expect(target?.fields).toBe(CatalogBinding.fields);
  });

  test("different fixed bindings on one reachable field fail with both paths", () => {
    const CatalogBinding = Trait("catalogConflict", { catalog: string() }, {
      bind: (catalog) => ({ values: { catalog: catalog.key } }),
    });
    const left = Schema("left", {});
    const right = Schema("right", {});
    const Broken = Entity("broken", {}, {
      traits: [CatalogBinding(left), CatalogBinding(right)],
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
