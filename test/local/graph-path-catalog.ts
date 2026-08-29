/** Reachable two-level Graph catalog used by the real local path contract. */

import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import { Catalog, Policy } from "ramose";
import {
  Entity,
  EntityId,
  Graph,
  OwnedOperations,
  Schema,
  string,
} from "ramose/db";

export const GRAPH_PATH_ROOT_DATABASE = "graph-path-root";

let childCatalog!: ReturnType<typeof Catalog>;
let leafCatalog!: ReturnType<typeof Catalog>;

export const Workspace = Entity("localWorkspace", {}, {
  traits: [Graph(() => childCatalog)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Graph.name, input.name);
        return { id: op.self };
      },
    }),
  }),
});

export const Project = Entity("localProject", {}, {
  traits: [Graph(() => leafCatalog)],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ name: input.name }) };
      },
    }),
  }),
});

export const NestedNote = Entity("localNestedNote", { text: string() }, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ text: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ text: input.text }) };
      },
    }),
  }),
});

export const GraphPathRootSchema = Schema({ localWorkspace: Workspace });
export const GraphPathChildSchema = Schema({ localProject: Project });
export const GraphPathLeafSchema = Schema({ localNestedNote: NestedNote });

const member = Policy.hasClass("member");
const rootReader = Policy.hasClass("root-reader");

leafCatalog = Catalog("local-graph-leaf", {
  schema: GraphPathLeafSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathLeafSchema,
    classes: ["member", "root-reader"],
    rules: [
      Policy.read(NestedNote).when(member),
      Policy.invoke(NestedNote[OwnedOperations].create).when(member),
    ],
  })),
});

childCatalog = Catalog("local-graph-child", {
  schema: GraphPathChildSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathChildSchema,
    classes: ["member", "root-reader"],
    rules: [
      Policy.read(Project).when(member),
      Policy.read(Graph).when(member),
      Policy.read(Graph.catalog).deny(member),
      Policy.invoke(Project[OwnedOperations].create).when(member),
    ],
  })),
});

export const graphPathCatalog = Catalog("local-graph-root", {
  schema: GraphPathRootSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: GraphPathRootSchema,
    classes: ["member", "root-reader"],
    rules: [
      Policy.read(Workspace).when(Policy.any(member, rootReader)),
      Policy.read(Graph).when(Policy.any(member, rootReader)),
      Policy.read(Graph.catalog).deny(Policy.any(member, rootReader)),
      Policy.invoke(Workspace[OwnedOperations].create).when(member),
      Policy.invoke(Workspace[OwnedOperations].rename).when(member),
    ],
  })),
});

export const graphPathCatalogDeployment = Object.freeze({
  root: graphPathCatalog,
  artifactHash: "c".repeat(64),
  deployments: [{ database: GRAPH_PATH_ROOT_DATABASE }],
});
