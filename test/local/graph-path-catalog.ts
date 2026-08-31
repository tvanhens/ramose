import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import * as Result from "effect/Result";
import {
  bytes,
  type CodeDefinition,
  Entity,
  EntityId,
  Field,
  Graph,
  Ref,
  Schema,
  Trait,
  string,
} from "ramose/db";
import {
  CatalogId,
  DigestHex,
  assembleCatalogDefinitions,
  hashReadCompatibility,
} from "../../packages/ramose/src/internal/authorization/index.ts";

export const GRAPH_PATH_ROOT_DATABASE = "graph-path-root";

let childSchema!: CodeDefinition;
let leafSchema!: CodeDefinition;

export const GateTagged = Trait("localGateTagged", {
  label: string({ optional: true }),
  tags: Field.many(string()),
}, {
  operations: (Operation) => ({
    retag: Operation({
      input: EffectSchema.Struct({ label: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId, label: EffectSchema.String }),
      run(op, input) {
        op.self.set(GateTagged.label, input.label);
        return { id: op.self, label: input.label };
      },
    }),
  }),
});

const GateLeft = Trait("localGateLeft", {}, { traits: [GateTagged] });
const GateRight = Trait("localGateRight", {}, { traits: [GateTagged] });
const GateDiamond = Trait("localGateDiamond", {}, {
  traits: [GateLeft, GateRight],
});

export const GateVisible = Entity("localGateVisible", {
  title: string(),
}, {
  traits: [GateDiamond],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        label: EffectSchema.optionalKey(EffectSchema.String),
        tags: EffectSchema.optionalKey(EffectSchema.Array(EffectSchema.String)),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            title: input.title,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
          }),
        };
      },
    }),
  }),
});

export const GateHidden = Entity("localGateHidden", {
  title: string(),
}, {
  traits: [GateDiamond],
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        label: EffectSchema.optionalKey(EffectSchema.String),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            title: input.title,
            ...(input.label === undefined ? {} : { label: input.label }),
          }),
        };
      },
    }),
  }),
});

export const GatePlain = Entity("localGatePlain", {
  title: string(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return { id: op.create({ title: input.title }) };
      },
    }),
  }),
});

export const GateLink = Entity("localGateLink", {
  name: Field.unique(string(), "strict"),
  target: Ref(GateTagged, { optional: true }),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        target: EffectSchema.optionalKey(EntityId),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        return {
          id: op.create({
            name: input.name,
            ...(input.target === undefined ? {} : { target: input.target as never }),
          }),
        };
      },
    }),
    deleteThenLink: Operation({
      self: false,
      writes: [GateVisible],
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        target: EntityId,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.entity(GateVisible, input.target).delete();
        return { id: op.create({ name: input.name, target: input.target as never }) };
      },
    }),
  }),
});

export const Workspace = Entity("localWorkspace", {}, {
  traits: [Graph(() => childSchema)],
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
    recatalog: Operation({
      input: EffectSchema.Struct({
        action: EffectSchema.Literals(["set", "remove"]),
      }),
      output: EffectSchema.Struct({}),
      run(op, input) {
        if (input.action === "set") {
          (op.self as any).set(Graph.catalog, "caller-selected-catalog");
        } else {
          (op.self as any).remove(Graph.catalog);
        }
        return {};
      },
    }),
    remove: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        op.self.delete();
        return {};
      },
    }),
  }),
});

export const PrivateWorkspace = Entity("localPrivateWorkspace", {}, {
  traits: [Graph(() => childSchema)],
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

export const Project = Entity("localProject", {}, {
  traits: [Graph(() => leafSchema)],
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

export const BulkValue = Entity("localBulkValue", {
  label: Field.unique(string(), "strict"),
  body: string(),
  blob: bytes(),
}, {
  operations: (Operation) => ({
    create: Operation({
      self: false,
      input: EffectSchema.Struct({
        label: EffectSchema.String,
        body: EffectSchema.String,
        blob: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        const binary = atob(input.blob);
        const blob = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          blob[index] = binary.charCodeAt(index);
        }
        return {
          id: op.create({ label: input.label, body: input.body, blob }),
        };
      },
    }),
  }),
});

export const GraphPathRootSchema = Schema("local-graph-root", {
  localWorkspace: Workspace,
  localPrivateWorkspace: PrivateWorkspace,
  localGateVisible: GateVisible,
  localGateHidden: GateHidden,
  localGatePlain: GatePlain,
  localGateLink: GateLink,
});
export const GraphPathChildSchema = Schema("local-graph-child", {
  localProject: Project,
});
export const GraphPathLeafSchema = Schema("local-graph-leaf", {
  localNestedNote: NestedNote,
  localBulkValue: BulkValue,
});
childSchema = GraphPathChildSchema;
leafSchema = GraphPathLeafSchema;

GraphPathLeafSchema.applyPolicy(
  { roles: ["member", "root-reader"] as const },
  ({ policy, session }) => {
    const member = session.roles.member;
    policy.localNestedNote.read.where(member);
    policy.localBulkValue.read.where(member);
    policy.localNestedNote.operations.create.where(member);
    policy.localBulkValue.operations.create.where(member);
  },
);

GraphPathChildSchema.applyPolicy(
  { roles: ["member", "root-reader"] as const },
  ({ policy, session }) => {
    const member = session.roles.member;
    policy.localProject.read.where(member);
    policy.graph.read.where(member);
    policy.graph.fields.catalog.read.denyWhere(member);
    policy.localProject.operations.create.where(member);
  },
);

GraphPathRootSchema.applyPolicy(
  {
    roles: ["member", "root-reader", "admin", "row-only", "field-only"] as const,
  },
  ({ policy, session }) => {
    const member = session.roles.member;
    const rootReader = session.roles["root-reader"];
    const admin = session.roles.admin;
    const rowOnly = session.roles["row-only"];
    const fieldOnly = session.roles["field-only"];

    policy.localWorkspace.read.where(member);
    policy.localWorkspace.read.where(rootReader);
    policy.localPrivateWorkspace.read.where(admin);
    policy.graph.read.where(member);
    policy.graph.read.where(rootReader);
    policy.graph.read.where(admin);
    policy.graph.fields.catalog.read.denyWhere(member);
    policy.graph.fields.catalog.read.denyWhere(rootReader);
    policy.graph.fields.catalog.read.denyWhere(admin);

    policy.localWorkspace.operations.create.where(member);
    policy.localWorkspace.operations.rename.where(member);
    policy.localWorkspace.operations.recatalog.where(member);
    policy.localWorkspace.operations.remove.where(member);
    policy.localPrivateWorkspace.operations.create.where(admin);

    policy.localGateVisible.read.where(member);
    policy.localGateVisible.read.where(rowOnly);
    policy.localGateVisible.read.where(fieldOnly);
    policy.localGateHidden.read.where(admin);
    policy.localGatePlain.read.where(member);
    policy.localGateLink.read.where(member);
    policy.localGateLink.read.where(rowOnly);
    policy.localGateLink.read.where(fieldOnly);
    policy.localGateTagged.read.where(member);
    policy.localGateTagged.read.where(admin);
    policy.localGateTagged.read.where(fieldOnly);
    policy.localGateTagged.fields.label.read.where(member);
    policy.localGateTagged.fields.label.read.where(admin);
    policy.localGateTagged.fields.label.read.denyWhere(fieldOnly);

    policy.localGateVisible.operations.create.where(member);
    policy.localGateHidden.operations.create.where(admin);
    policy.localGatePlain.operations.create.where(member);
    policy.localGateLink.operations.create.where(member);
    policy.localGateLink.operations.deleteThenLink.where(member);
    policy.localGateTagged.operations.retag.where(member);
  },
);

export const graphPathCatalogDeployment = Object.freeze({
  root: GraphPathRootSchema,
  deployments: [{ database: GRAPH_PATH_ROOT_DATABASE }],
});

const compatibilityDefinitions = await Effect.runPromise(assembleCatalogDefinitions({
  root: GraphPathRootSchema,
  artifactHash: DigestHex.make("0".repeat(64)),
}));
const compatibilityUnit = (id: string) =>
  Result.getOrThrow(compatibilityDefinitions.require(CatalogId.make(id)));

export const graphPathLeafReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-leaf").unit.catalog),
);

export const graphPathChildReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-child").unit.catalog),
);

export const graphPathRootReadCompatibilityHash = await Effect.runPromise(
  hashReadCompatibility(compatibilityUnit("local-graph-root").unit.catalog),
);
