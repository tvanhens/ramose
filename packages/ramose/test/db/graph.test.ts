import { describe, expect, test } from "bun:test";
import {
  Entity,
  Graph,
  Query,
  Ref,
  Schema,
  collectCodeReachability,
  compositionFromSchema,
  compositionValueMetadata,
  refTargetOf,
  resolveCreationValues,
  type CodeDefinition,
} from "../../src/db/internal.ts";

describe("Graph", () => {
  const Child = Schema("workspace", {}) satisfies CodeDefinition;
  const Workspace = Entity("workspace", {}, { traits: [Graph(Child)] });
  const Project = Entity("project", {}, { traits: [Graph(Child)] });
  const App = Schema("graph-app", { workspace: Workspace, project: Project });

  test("is one stable bindable trait with canonical fields", () => {
    expect(Graph._tag).toBe("Trait");
    expect(Graph.ns).toBe("graph");
    expect(Graph.catalog.ident).toBe(":graph/catalog");
    expect(Graph.name.ident).toBe(":graph/name");
    expect(Graph.name.unique).toBe("strict");
    expect(Graph.name.index).toBe(true);
    expect(Graph.doc.ident).toBe(":graph/doc");
    expect(Graph.doc.isOptional).toBe(true);

    expect(Object.is(Workspace.catalog, Graph.catalog)).toBe(true);
    expect(Object.is(Project.catalog, Graph.catalog)).toBe(true);
    expect(Object.is(Workspace.name, Project.name)).toBe(true);
    expect(Workspace.traits[0]!.ns).toBe("graph");
    expect(Project.traits[0]!.ns).toBe("graph");
    expect(compositionFromSchema(App).transitiveTraits(":workspace"))
      .toEqual([":graph"]);
    expect(compositionFromSchema(App).transitiveTraits(":project"))
      .toEqual([":graph"]);
  });

  test("fixes and retains the runnable catalog definition", () => {
    const created = resolveCreationValues(
      Workspace,
      { name: "acme", doc: "Acme workspace" },
      { now: new Date(0) },
    );
    expect(created).toEqual({
      catalog: "workspace",
      name: "acme",
      doc: "Acme workspace",
    });
    expect(() =>
      resolveCreationValues(
        Workspace,
        { name: "forged", catalog: "other" },
        { now: new Date(0) },
      )
    ).toThrow(/:graph\/catalog is engine-owned/);

    const metadata = compositionValueMetadata(Workspace);
    expect(metadata.fixed.get(":graph/catalog")?.value).toBe("workspace");
    expect(metadata.bindings[0]!.binding.dependencies).toEqual([Child]);

    const reachable = collectCodeReachability(App);
    expect(reachable.definitions.map(({ key }) => key)).toEqual([
      "graph-app",
      "workspace",
    ]);
    expect(reachable.bindings).toHaveLength(2);
    expect(reachable.bindings.every(({ binding }) =>
      binding.trait.ns === "graph" && binding.trait.fields === Graph.fields
    )).toBe(true);
  });

  test("uses ordinary trait query and ref surfaces", () => {
    expect(Query.from(Graph)._tag).toBe("Query");
    const target = refTargetOf(Ref(Graph).schema)?.();
    expect(target?.ns).toBe("graph");
    expect(target?.fields).toBe(Graph.fields);
  });
});
