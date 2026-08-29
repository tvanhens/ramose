/** Compile-time contract for the built-in Graph trait. */

// @effect-diagnostics floatingEffect:off

import * as EffectSchema from "effect/Schema";
import {
  Entity,
  EntityId,
  Graph,
  Ref,
  Schema,
  txBuilder,
  type CodeDefinition,
} from "../../src/db/internal.ts";

const Child = { key: "graph-types-child", schema: Schema({}) } satisfies CodeDefinition;

const Workspace = Entity("graphTypesWorkspace", {}, {
  traits: [Graph(Child)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        doc: EffectSchema.optionalKey(EffectSchema.String),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        const graph = op.create(input);
        graph.set(Graph.name, input.name);
        // @ts-expect-error the catalog key is fixed by Graph(Child)
        graph.set(Graph.catalog, "forged");
        // @ts-expect-error the catalog key is absent from create input
        op.create({ name: input.name, catalog: "forged" });
        return { id: graph };
      },
    }),
  }),
});

const Project = Entity("graphTypesProject", {}, { traits: [Graph(Child)] });
const App = Schema({
  graphTypesWorkspace: Workspace,
  graphTypesProject: Project,
});
const tx = txBuilder(App);

tx.put(Workspace, { name: "acme" });
tx.put(Project, { name: "project", doc: "Project graph" });
tx.update(Workspace, 1, { name: "renamed" });
// @ts-expect-error fixed Graph catalog is absent from create input
tx.put(Workspace, { name: "bad", catalog: "forged" });
// @ts-expect-error fixed Graph catalog is absent from update input
tx.update(Project, 1, { catalog: "forged" });

Ref(Graph);
